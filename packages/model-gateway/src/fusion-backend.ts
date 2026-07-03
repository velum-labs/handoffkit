/**
 * The fusion front-door backend.
 *
 * This is the clean abstraction behind "the judge streams a trajectory the
 * user's harness executes". It implements the gateway {@link Backend} contract
 * (an OpenAI Chat Completions surface) so it slots into the existing
 * `startGateway` server and reuses every dialect adapter (chat / responses /
 * anthropic) — including their full tool-call, tool-result, and streaming
 * support — for free.
 *
 * Per front-door turn it:
 *   1. derives a stable session key from the conversation prefix,
 *   2. runs the panel **once** per session (injected `runPanels`, so this
 *      package keeps no dependency on `@fusionkit/ensemble`) to produce the
 *      candidate trajectories,
 *   3. forwards the live conversation + the harness tools + the candidate
 *      trajectories to FusionKit's `trajectories:fuse`, whose response (an OpenAI
 *      chat completion, optionally streamed, that may carry `tool_calls`) is
 *      returned verbatim for the server to translate into the caller's dialect.
 *
 * There is no apply/verify/repair here: iteration is the user's harness's job.
 *
 * Failures are surfaced, never swallowed: a panel run that throws or yields no
 * usable candidate, or a `trajectories:fuse` that errors, produces an explicit
 * error (a non-2xx response when nothing has streamed yet, or a terminal error
 * event with `finish_reason: "error"` once the SSE has started) and the failed
 * session is evicted so the next turn retries instead of replaying the failure.
 */

import { createHash } from "node:crypto";

import {
  emitTrace,
  getTraceEmitter,
  judgeFinalPayload,
  judgeRequestPayload,
  judgeThinkingPayload,
  newSpanId,
  newTraceId,
  TRACE_ID_HEADER
} from "@fusionkit/protocol";
import type { WireTrajectory } from "@fusionkit/protocol";
import { FUSION_PANEL_MODEL } from "@fusionkit/registry";
import { withDeadline, withTimeout } from "@fusionkit/runtime-utils";

import { CLAUDE_ALIAS_PREFIX } from "./adapters/anthropic.js";
import { joinPath } from "./backend.js";
import type { Backend, BackendRequestOptions } from "./backend.js";
import { createTurnNarrator } from "./frontdoor/narration.js";
import type { NarrationWriter, TurnNarration } from "./frontdoor/narration.js";
import { runFrontdoorRequest } from "./frontdoor/request.js";
import { FRONTDOOR_SIGNAL } from "./frontdoor/types.js";
import type { FrontdoorRequestValue, FrontdoorServices, VendorProxyOutcome } from "./frontdoor/types.js";
import {
  addLedgerEntry,
  emptySessionCost,
  formatUsd,
  localComputeFromLatency,
  meterCall,
  parseUsage,
  parseUsageFromSse,
  turnCostLine
} from "./cost.js";
import type {
  CostLedgerEntry,
  CostStage,
  LocalComputePricing,
  ModelPricing,
  ProviderCostMetadata,
  SessionCost,
  TokenUsage,
  TurnCost
} from "./cost.js";
import type { PersistedSession, SessionStore } from "./session-store.js";

export type { WireTrajectory } from "@fusionkit/protocol";

/**
 * A native (non-fused) model the gateway also exposes in the tool's picker.
 * Selecting it proxies the request to its real provider via the `fusionkit
 * serve` router (which already holds the reused subscription/API credentials),
 * rather than running the panel + judge. This is the "use the vendor model
 * directly, fall back to fusion when rate-limited" path.
 */
export type PassthroughModel = {
  /** Advertised model id the tool sees and selects (e.g. "gpt-5.5"). */
  modelId: string;
  /** Router endpoint id the request's `model` is rewritten to (e.g. "codex"). */
  endpointId: string;
  /** Router base URL (e.g. http://127.0.0.1:PORT) fronting the real provider. */
  endpointUrl: string;
};

export type ChatMessageLike = {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
};

/** The OpenAI Chat Completions request shape this backend reads. */
type ChatBody = {
  model?: string;
  messages?: ChatMessageLike[];
  tools?: unknown;
  tool_choice?: unknown;
  stream?: boolean;
};

export type PanelRunInput = {
  /** The task prompt distilled from the conversation prefix (system + first user). */
  task: string;
  /** The full incoming OpenAI-style message list for the first turn. */
  messages: ChatMessageLike[];
  /** The trace id minted for this fusion session. */
  traceId: string;
  /** The session root span; panel/candidate events parent under it. */
  sessionSpanId: string;
  /** Stable per-session key (hash of the conversation prefix). */
  sessionKey: string;
  /** 1-based user-turn index this panel run belongs to. */
  turn: number;
  /**
   * Panel model ids (the router endpoint ids) to omit from this run. Set on a
   * rate-limit failover turn (WS5) to drop the throttled vendor — it would only
   * hit the same limit again — so the ensemble fuses over the healthy survivors.
   */
  excludeModelIds?: readonly string[];
  /**
   * Aborted when the panel run should stop (the turn's panel deadline fired).
   * Runners must cancel in-flight candidate work — child processes included —
   * instead of letting it burn tokens after the turn has already failed.
   */
  signal?: AbortSignal;
};

/** Runs the panel once for a session and returns its candidate trajectories. */
export type PanelRunner = (input: PanelRunInput) => Promise<WireTrajectory[]>;

export type FuseStepRunInput = {
  stepUrl: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  streaming: boolean;
};

export type FuseStepRunner = (input: FuseStepRunInput) => Promise<Response>;

/**
 * What the gateway does when a vendor passthrough model is rate-limited or out
 * of credits/quota part-way through a turn (WS5):
 *
 *  - `fusion`      — transparently continue the turn on the fusion ensemble
 *                    (pre-stream failover); the headline behaviour and default.
 *  - `passthrough` — return the vendor's response verbatim (including its 429),
 *                    leaving handling to the harness; opt out of failover.
 *  - `fail`        — do not fail over; surface a clear gateway error instead.
 */
export type OnRateLimitPolicy = "fusion" | "passthrough" | "fail";

/**
 * The failover-relevant classification of a vendor egress failure, mirroring
 * FusionKit's `error_category` taxonomy (see `clients.py`): `transient` (429 /
 * 5xx / overloaded) and `quota_exhausted` (out of credits) are failover-worthy;
 * `auth_permanent` (401/403, bad key), `context_overflow` (the payload can
 * never fit as-is) and `unknown` are not (a blind reroute would not help).
 */
type FailoverCategory =
  | "transient"
  | "quota_exhausted"
  | "auth_permanent"
  | "context_overflow"
  | "unknown";

/** A vendor passthrough failure, normalized from the router's error body. */
type ProxyFailure = {
  category: FailoverCategory;
  status?: number;
  retryAfter?: number;
  provider?: string;
  message: string;
};

/** What to do with a detected pre-stream vendor failure, given the policy. */
type FailoverDecision = "failover" | "fail-fast" | "fail-error";

export type FusionBackendOptions = {
  /** FusionKit `POST /v1/fusion/trajectories:fuse` URL. */
  stepUrl: string;
  /** Produces candidate trajectories for a new session (injected; uses ensemble). */
  runPanels: PanelRunner;
  /** Executes the trajectory fuse step; defaults to direct fetch. */
  runFuseStep?: FuseStepRunner;
  /** Model id echoed to clients and sent to the judge step. */
  defaultModel?: string;
  /** Judge model id forwarded to FusionKit (defaults to its configured judge). */
  judgeModel?: string;
  /** How long a session's candidate trajectories stay cached. */
  sessionTtlMs?: number;
  /** Wall-clock budget for the panel phase before the turn fails. */
  panelTimeoutMs?: number;
  /** Wall-clock budget for a single `trajectories:fuse` call. */
  stepTimeoutMs?: number;
  /** Mint a trace id (injectable for tests). */
  mintTraceId?: () => string;
  /**
   * Native models exposed alongside the fused model. A request whose `model`
   * matches one of these is proxied to its real provider (via the router)
   * instead of being fused, so the user can switch to a vendor model — or back
   * to fusion — from the tool's own picker.
   */
  passthrough?: readonly PassthroughModel[];
  /**
   * Rate-limit / credit-exhaustion failover policy for vendor passthrough models
   * (WS5). Defaults to `fusion` (transparently continue the turn on the
   * ensemble).
   */
  onRateLimit?: OnRateLimitPolicy;
  /**
   * Durable session store (WS4). When set, sessions persist to disk and the
   * in-memory map becomes a hot cache in front of it: a turn's resolved
   * candidates are written through, and a cache miss (cold start, or after the
   * in-memory TTL evicts) rehydrates from the store instead of re-running the
   * panel. Omit it for a purely in-memory gateway (the prior behaviour).
   */
  store?: SessionStore;
  /**
   * Resume target (WS4 `--resume`/`--continue`). When set, the first new
   * conversation this process serves is bound to the persisted session of this
   * id: its trace id, span, and per-turn candidate cache are rehydrated so the
   * session id stays stable and already-completed turns are replayed from disk
   * rather than re-run. Requires {@link store}.
   */
  resumeId?: string;
  /** Static metadata persisted into a new session's header (tool, repo, panel). */
  sessionMeta?: SessionMetaInput;
  /**
   * WS7 budget cap (USD). When set, a turn whose session has already accrued at
   * least this much gateway-observed cost is refused with a clear message
   * instead of being run (v1 = stop; a budget-driven panel downshift is a noted
   * follow-up). Omit for no cap.
   */
  budgetUsd?: number;
  /**
   * WS7 per-model price overrides (USD / 1M tokens), merged over the built-in
   * {@link DEFAULT_MODEL_PRICING} table. Lets the caller make cloud cost real for
   * models the table does not know (or correct stale list prices).
   */
  pricing?: Readonly<Record<string, ModelPricing>>;
  /** Optional local-compute rates keyed by model name or endpoint id. */
  localCompute?: Readonly<Record<string, LocalComputePricing>>;
  /**
   * Model names / endpoint ids of panel members that run on local compute
   * (e.g. MLX members), threaded explicitly from the panel spec so cost
   * classification does not rely on model-id string heuristics.
   */
  localModels?: readonly string[];
  /**
   * WS7 model name to attribute a *fused* turn's cost to — the judge/synthesizer
   * model whose `usage` the fused response carries. The gateway only sees this
   * one call's tokens (the panel members are metered inside the Python engine),
   * so this prices the gateway-observed judge step. Defaults to {@link defaultModel}.
   */
  costModel?: string;
  /** Hot kernel session state store for in-process session/turn candidate state. */
  kernelStateStore?: FusionBackendKernelStateStore;
  /**
   * Reasoning traces: narrate panel/judge progress into a streaming fused
   * turn's response as `reasoning_content` deltas (rendered natively by each
   * dialect — Codex reasoning summaries, Claude thinking). Default on; set
   * false to keep the stream silent until the judge's first token.
   */
  reasoningTraces?: boolean;
  /**
   * Optional narration prose writer (e.g. a small local model). Advisory only:
   * the narrator's timeout/sanitize/fallback guardrails apply to every call.
   */
  narrationWriter?: NarrationWriter;
};

/** Caller-supplied session header fields persisted on session creation. */
export type SessionMetaInput = {
  tool?: string;
  repo?: string;
  models?: Array<{ id: string; model: string }>;
  judgeModel?: string;
};

type Session = {
  /** The persisted session id (the session key; stable across processes). */
  id: string;
  traceId: string;
  sessionSpan: string;
  /** Candidate trajectories cached per user turn (a follow-up is a new turn). */
  turns: Map<number, Promise<WireTrajectory[]>>;
  /**
   * Per-turn panel abort controllers. Owned by the turn (the panel promise is
   * shared across tool-loop continuations of that turn), fired when the panel
   * deadline expires so in-flight candidate work is cancelled instead of
   * detaching, and dropped once the turn's panel promise settles.
   */
  turnAborts: Map<number, AbortController>;
  /** Panel usage is metered once per user turn, even when a tool loop reuses candidates. */
  meteredPanelTurns: Set<number>;
  createdAt: number;
  /** The panel member the judge picked on the most recent fused turn (narration color). */
  lastJudgePick?: string;
};

export type FusionBackendKernelSessionState = Session;

/**
 * The kernel-owned state store for the fusion front door. It is the single home
 * for a conversation's turn state — session identity + per-turn candidate cache
 * (TTL-scoped; swept by the backend so a stale turn re-runs the panel) — and its
 * running cost ledger (process/durable-scoped; seeded from and written through to
 * the durable {@link SessionStore}). Session and cost are distinct concerns with
 * different lifetimes, so the store exposes them separately; the backend keeps no
 * private session/cost maps of its own.
 */
export type FusionBackendKernelStateStore = {
  get(sessionKey: string): FusionBackendKernelSessionState | undefined;
  set(sessionKey: string, state: FusionBackendKernelSessionState): void;
  delete(sessionKey: string): void;
  entries(): IterableIterator<[string, FusionBackendKernelSessionState]>;
  getCost(sessionKey: string): SessionCost | undefined;
  setCost(sessionKey: string, cost: SessionCost): void;
};

export class InMemoryFusionBackendKernelStateStore implements FusionBackendKernelStateStore {
  readonly #sessions = new Map<string, FusionBackendKernelSessionState>();
  readonly #cost = new Map<string, SessionCost>();

  get(sessionKey: string): FusionBackendKernelSessionState | undefined {
    return this.#sessions.get(sessionKey);
  }

  set(sessionKey: string, state: FusionBackendKernelSessionState): void {
    this.#sessions.set(sessionKey, state);
  }

  delete(sessionKey: string): void {
    this.#sessions.delete(sessionKey);
  }

  entries(): IterableIterator<[string, FusionBackendKernelSessionState]> {
    return this.#sessions.entries();
  }

  getCost(sessionKey: string): SessionCost | undefined {
    return this.#cost.get(sessionKey);
  }

  setCost(sessionKey: string, cost: SessionCost): void {
    this.#cost.set(sessionKey, cost);
  }
}

const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
const DEFAULT_PANEL_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_STEP_TIMEOUT_MS = 10 * 60 * 1000;

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A candidate set is usable when at least one trajectory did not fail. */
function hasUsableCandidates(candidates: WireTrajectory[]): boolean {
  return candidates.some((candidate) => candidate.status !== "failed");
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "fusion_error" } }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

type AssembledStep = {
  content: string;
  usage?: unknown;
  toolCalls: unknown[];
  finishReason?: string;
  fusion?: unknown;
};

/** Best-effort reassembly of an OpenAI chat SSE stream into content, usage,
 *  tool-call deltas, finish reason, and the terminal `fusion` extension (the
 *  fused trajectory + its synthesis). */
function assembleSseContent(buffer: string): AssembledStep {
  let content = "";
  let usage: unknown;
  let finishReason: string | undefined;
  let fusion: unknown;
  const toolCalls: unknown[] = [];
  for (const line of buffer.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data.length === 0 || data === "[DONE]") continue;
    try {
      const json = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }>;
        usage?: unknown;
        fusion?: unknown;
      };
      const choice = json.choices?.[0];
      const delta = choice?.delta?.content;
      if (typeof delta === "string") content += delta;
      if (Array.isArray(choice?.delta?.tool_calls)) toolCalls.push(...choice.delta.tool_calls);
      if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
      if (json.usage !== undefined && json.usage !== null) usage = json.usage;
      if (json.fusion !== undefined && json.fusion !== null) fusion = json.fusion;
    } catch {
      // ignore partial/non-JSON lines
    }
  }
  return {
    content,
    toolCalls,
    ...(usage !== undefined ? { usage } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(fusion !== undefined ? { fusion } : {})
  };
}

/** Pull the fused trajectory's synthesis out of a terminal `fusion` extension. */
function synthesisOf(fusion: unknown): unknown {
  if (fusion === null || typeof fusion !== "object") return undefined;
  const trajectory = (fusion as { trajectory?: unknown }).trajectory;
  if (trajectory === null || typeof trajectory !== "object") return undefined;
  return (trajectory as { synthesis?: unknown }).synthesis;
}

/** A judge step is terminal (the real answer) only when it requests no tool calls. */
function isTerminalJudgeStep(toolCalls: unknown, finishReason?: string): boolean {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  return calls.length === 0 && finishReason !== "tool_calls";
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function trajectoryMetadata(trajectory: WireTrajectory): Record<string, unknown> {
  return recordOf(trajectory.metadata) ?? {};
}

function trajectoryUsage(trajectory: WireTrajectory): TokenUsage | undefined {
  const direct = parseUsage((trajectory as { usage?: unknown }).usage);
  if (direct !== undefined) return direct;
  return parseUsage(trajectoryMetadata(trajectory).usage);
}

function providerCostMetadata(value: unknown): ProviderCostMetadata | undefined {
  const record = recordOf(value);
  if (record === undefined) return undefined;
  const rawSource = optionalString(record.source);
  const source = rawSource === "provider" || rawSource === "estimate" ? rawSource : "provider";
  const costUsd =
    optionalFiniteNumber(record.cost_usd) ??
    optionalFiniteNumber(record.costUsd) ??
    optionalFiniteNumber(record.total_cost);
  const generationId = optionalString(record.generation_id) ?? optionalString(record.generationId);
  const providerName = optionalString(record.provider_name) ?? optionalString(record.providerName);
  const upstreamInferenceCost =
    optionalFiniteNumber(record.upstream_inference_cost) ??
    optionalFiniteNumber(record.upstreamInferenceCost);
  const cacheDiscount =
    optionalFiniteNumber(record.cache_discount) ?? optionalFiniteNumber(record.cacheDiscount);
  const lookupStatus = optionalString(record.lookup_status) ?? optionalString(record.lookupStatus);
  const tokensPrompt = optionalNumber(record.tokens_prompt) ?? optionalNumber(record.tokensPrompt);
  const tokensCompletion =
    optionalNumber(record.tokens_completion) ?? optionalNumber(record.tokensCompletion);
  const nativeTokensPrompt =
    optionalNumber(record.native_tokens_prompt) ?? optionalNumber(record.nativeTokensPrompt);
  const nativeTokensCompletion =
    optionalNumber(record.native_tokens_completion) ?? optionalNumber(record.nativeTokensCompletion);
  return {
    source,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(generationId !== undefined ? { generationId } : {}),
    ...(providerName !== undefined ? { providerName } : {}),
    ...(upstreamInferenceCost !== undefined ? { upstreamInferenceCost } : {}),
    ...(cacheDiscount !== undefined ? { cacheDiscount } : {}),
    ...(lookupStatus !== undefined ? { lookupStatus } : {}),
    ...(tokensPrompt !== undefined ? { tokensPrompt } : {}),
    ...(tokensCompletion !== undefined ? { tokensCompletion } : {}),
    ...(nativeTokensPrompt !== undefined ? { nativeTokensPrompt } : {}),
    ...(nativeTokensCompletion !== undefined ? { nativeTokensCompletion } : {})
  };
}

function usageWithProviderCost(
  usage: TokenUsage | undefined,
  providerCost: ProviderCostMetadata | undefined
): TokenUsage | undefined {
  if (providerCost === undefined) return usage;
  const promptTokens = providerCost.tokensPrompt ?? usage?.promptTokens;
  const completionTokens = providerCost.tokensCompletion ?? usage?.completionTokens;
  const totalTokens =
    promptTokens !== undefined && completionTokens !== undefined
      ? promptTokens + completionTokens
      : usage?.totalTokens;
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return usage;
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {})
  };
}

function providerCostFromPayload(payload: unknown): ProviderCostMetadata | undefined {
  const record = recordOf(payload);
  if (record === undefined) return undefined;
  return providerCostMetadata(record.provider_cost ?? record.providerCost);
}

function providerCostFromSse(text: string): ProviderCostMetadata | undefined {
  let providerCost: ProviderCostMetadata | undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as unknown;
      const candidate = providerCostFromPayload(parsed);
      if (candidate !== undefined) providerCost = candidate;
    } catch {
      // partial / non-JSON line
    }
  }
  return providerCost;
}

function trajectoryLatencyMs(trajectory: WireTrajectory): number | undefined {
  const metadata = trajectoryMetadata(trajectory);
  const latencyMs = optionalNumber(metadata.latency_ms);
  if (latencyMs !== undefined) return latencyMs;
  const latencyS = optionalNumber(metadata.latency_s);
  return latencyS !== undefined ? latencyS * 1000 : undefined;
}

/** A terminal SSE chunk that marks the turn as failed (not a normal stop). */
function errorEvent(message: string): string {
  return (
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: message }, finish_reason: "error" }]
    })}\n\n` + "data: [DONE]\n\n"
  );
}

// --- WS5: rate-limit / credit failover ------------------------------------

/** An OpenAI chat content-delta SSE chunk (used to splice a notice into a stream). */
function noticeChunk(text: string): string {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
  })}\n\n`;
}

/** A terminal SSE chunk carrying a normal finish reason (no content). */
function finishChunk(reason: string): string {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta: {}, finish_reason: reason }]
  })}\n\n`;
}

/** The in-stream notice shown when a turn is transparently handed off. */
function failoverNotice(modelId: string, failure: ProxyFailure): string {
  const reason = failure.category === "quota_exhausted" ? "is out of credits/quota" : "was rate-limited";
  return `> _${modelId} ${reason}; handed off to the ensemble for this turn._\n\n`;
}

/** The terminal notice shown when a vendor fails mid-stream (one-tap resume). */
function resumeNotice(modelId: string, fusedModel: string): string {
  return (
    `\n\n> _${modelId} was rate-limited mid-response, so this turn could not be ` +
    `continued transparently. Re-run on the "${fusedModel}" model to continue on the ensemble._`
  );
}

/** Coerce a router `error_category` (or bare HTTP status) into the failover taxonomy. */
function normalizeFailoverCategory(raw: unknown, status: number | undefined): FailoverCategory {
  if (
    raw === "transient" ||
    raw === "quota_exhausted" ||
    raw === "auth_permanent" ||
    raw === "context_overflow" ||
    raw === "unknown"
  ) {
    return raw;
  }
  if (status === 401 || status === 403) return "auth_permanent";
  if (status === 429) return "transient";
  if (status !== undefined && status >= 500) return "transient";
  return "unknown";
}

/** Whether a classified failure should reroute to the ensemble (vs fail fast). */
function isFailoverWorthy(category: FailoverCategory): boolean {
  switch (category) {
    case "transient":
    case "quota_exhausted":
      return true;
    case "auth_permanent":
    case "context_overflow":
    case "unknown":
      return false;
    default: {
      const unreachable: never = category;
      throw new Error(`unhandled failover category: ${String(unreachable)}`);
    }
  }
}

/** Build a {@link ProxyFailure} from a router error object + the HTTP status. */
function failureFromErrorObject(err: Record<string, unknown>, status: number | undefined): ProxyFailure {
  const raw = err.error_category ?? err.category ?? err.code;
  const failure: ProxyFailure = {
    category: normalizeFailoverCategory(raw, status),
    message: typeof err.message === "string" ? err.message : "vendor error"
  };
  if (status !== undefined) failure.status = status;
  if (typeof err.retry_after === "number") failure.retryAfter = err.retry_after;
  if (typeof err.provider === "string") failure.provider = err.provider;
  return failure;
}

/** Parse the JSON object(s) carried on an SSE event's `data:` line(s). */
function sseDataObjects(event: string): Array<Record<string, unknown>> {
  const objects: Array<Record<string, unknown>> = [];
  for (const line of event.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data.length === 0 || data === "[DONE]") continue;
    try {
      const json = JSON.parse(data);
      if (json !== null && typeof json === "object") objects.push(json as Record<string, unknown>);
    } catch {
      // partial / non-JSON line
    }
  }
  return objects;
}

/** The classified failure carried by an SSE error event, if any. */
function sseEventError(event: string): ProxyFailure | undefined {
  for (const object of sseDataObjects(event)) {
    const err = object.error;
    if (err !== null && typeof err === "object") {
      return failureFromErrorObject(err as Record<string, unknown>, undefined);
    }
  }
  return undefined;
}

/** Whether an SSE event carries a real (non-empty) assistant content delta. */
function sseEventHasContent(event: string): boolean {
  for (const object of sseDataObjects(event)) {
    if (!Array.isArray(object.choices)) continue;
    const delta = (object.choices[0] as { delta?: { content?: unknown } } | undefined)?.delta;
    if (delta !== undefined && typeof delta.content === "string" && delta.content.length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Find whether the first *significant* SSE event in `text` is a content delta or
 * a terminal error (so the proxy can tell a pre-stream failure — failover-able —
 * from a mid-stream one). Role-only deltas and keepalive comments are ignored.
 */
function firstSseSignal(text: string): { kind: "content" | "error" | "none"; error?: ProxyFailure } {
  let rest = text;
  for (;;) {
    const idx = rest.indexOf("\n\n");
    if (idx === -1) break;
    const event = rest.slice(0, idx + 2);
    rest = rest.slice(idx + 2);
    const failure = sseEventError(event);
    if (failure !== undefined) return { kind: "error", error: failure };
    if (sseEventHasContent(event)) return { kind: "content" };
  }
  return { kind: "none" };
}

/** Re-emit a buffered/consumed error body as a fresh non-2xx response (verbatim). */
function rebuildErrorResponse(status: number, contentType: string | null, bodyText: string): Response {
  return new Response(bodyText, {
    status,
    headers: { "content-type": contentType ?? "application/json" }
  });
}

/** Wrap a static SSE string as a `text/event-stream` response. */
function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
  });
}

/**
 * The fusion front-door backend is a kernel-native surface adapter: it maps the
 * gateway {@link Backend} contract onto data-driven `FusionRuntime` graphs. Every
 * request is dispatched as the `fusion-frontdoor-request` graph, whose
 * `frontdoor.budget-gate` / `frontdoor.resolve-model` / `frontdoor.vendor-proxy`
 * operators + `FrontdoorRequestScheduler` route to budget-stop, the
 * `fusion-frontdoor-turn` graph (panel -> fuse -> finalize, streaming or
 * buffered), or the vendor proxy (whose pre-stream failover re-enters the fusion
 * turn). All per-turn inputs travel as a {@link FrontdoorRequestValue} artifact;
 * this backend owns only the stable {@link FrontdoorServices} the operators invoke
 * (session identity, panel/fuse implementations, cost/trace/persistence, vendor
 * proxy), while the runtime owns admission, provenance, budget, trace, and replay.
 */
export class FusionBackend implements Backend {
  readonly defaultModel: string | undefined;

  readonly #stepUrl: string;
  readonly #runPanels: PanelRunner;
  readonly #runFuseStep: FuseStepRunner;
  readonly #judgeModel: string | undefined;
  readonly #ttlMs: number;
  readonly #panelTimeoutMs: number;
  readonly #stepTimeoutMs: number;
  readonly #mintTraceId: () => string;
  readonly #kernelStateStore: FusionBackendKernelStateStore;
  readonly #passthrough: readonly PassthroughModel[];
  readonly #onRateLimit: OnRateLimitPolicy;
  readonly #store: SessionStore | undefined;
  readonly #sessionMeta: SessionMetaInput;
  readonly #budgetUsd: number | undefined;
  readonly #pricing: Readonly<Record<string, ModelPricing>>;
  readonly #localCompute: Readonly<Record<string, LocalComputePricing>>;
  readonly #localModels: ReadonlySet<string>;
  readonly #costModel: string | undefined;
  readonly #reasoningTraces: boolean;
  readonly #narrationWriter: NarrationWriter | undefined;
  /** The stable front-door services the request/turn operators invoke. */
  readonly #services: FrontdoorServices;
  /** Explicit resume target; consumed (cleared) when bound to the first session. */
  #resumeId: string | undefined;

  constructor(options: FusionBackendOptions) {
    this.#stepUrl = options.stepUrl;
    this.#runPanels = options.runPanels;
    this.#runFuseStep =
      options.runFuseStep ??
      ((request) =>
        fetch(request.stepUrl, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          ...(request.signal ? { signal: request.signal } : {})
        }));
    this.defaultModel = options.defaultModel;
    this.#judgeModel = options.judgeModel;
    this.#ttlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#panelTimeoutMs = options.panelTimeoutMs ?? DEFAULT_PANEL_TIMEOUT_MS;
    this.#stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    this.#mintTraceId = options.mintTraceId ?? newTraceId;
    this.#passthrough = options.passthrough ?? [];
    this.#onRateLimit = options.onRateLimit ?? "fusion";
    this.#store = options.store;
    this.#kernelStateStore = options.kernelStateStore ?? new InMemoryFusionBackendKernelStateStore();
    this.#sessionMeta = options.sessionMeta ?? {};
    this.#budgetUsd = options.budgetUsd;
    this.#pricing = options.pricing ?? {};
    this.#localCompute = options.localCompute ?? {};
    this.#localModels = new Set(options.localModels ?? []);
    this.#costModel = options.costModel;
    this.#reasoningTraces = options.reasoningTraces ?? true;
    this.#narrationWriter = options.narrationWriter;
    this.#resumeId = options.resumeId;
    // Built once, after all fields are set: the stable wire the front-door
    // request/turn operators invoke with per-turn data.
    this.#services = this.#buildServices();
  }

  /**
   * The native model (if any) a requested id selects — by advertised id, router
   * endpoint id, or the `claude-`prefixed alias Claude Code's picker sends (see
   * `claudeModelAlias`), so a vendor model chosen inside Claude routes correctly.
   */
  #passthroughFor(requested: string | undefined): PassthroughModel | undefined {
    if (requested === undefined || requested.length === 0) return undefined;
    const direct = this.#passthrough.find(
      (entry) => entry.modelId === requested || entry.endpointId === requested
    );
    if (direct !== undefined) return direct;
    if (requested.startsWith(CLAUDE_ALIAS_PREFIX)) {
      const stripped = requested.slice(CLAUDE_ALIAS_PREFIX.length);
      return this.#passthrough.find(
        (entry) => entry.modelId === stripped || entry.endpointId === stripped
      );
    }
    return undefined;
  }

  /** Discovery list: the fused model first, then each native passthrough model. */
  listModelIds(): readonly string[] {
    const fusion = this.defaultModel ?? FUSION_PANEL_MODEL;
    const ids = [fusion];
    for (const entry of this.#passthrough) {
      if (!ids.includes(entry.modelId)) ids.push(entry.modelId);
    }
    return ids;
  }

  /**
   * Map a requested model to the upstream id the backend runs. A native model
   * keeps its own id (so {@link chat} proxies it to the real provider); anything
   * else — including the fused model and unrecognised ids — resolves to the
   * fused default so the panel + judge handle it.
   */
  resolveModel(requested: string | undefined): string | undefined {
    const native = this.#passthroughFor(requested);
    if (native !== undefined) return native.modelId;
    return this.defaultModel;
  }

  /**
   * Proxy a chat request to a native model's real provider via the router,
   * preserving streaming and tool-calling. Emits a trace marker so the call is
   * visible on the dashboard like a fusion turn.
   *
   * WS5 rate-limit / credit handoff: rather than returning a vendor 429 / quota
   * error verbatim, this detects the router's classified `error_category` and —
   * for failover-worthy failures (`transient` / `quota_exhausted`) under the
   * default `fusion` policy — transparently continues the *same* turn on the
   * fusion ensemble (excluding the throttled vendor). Detection runs before any
   * bytes reach the harness: non-2xx replies are pre-stream by construction, and
   * for streaming replies the proxy peeks the SSE head to tell a pre-stream
   * failure (failover-able) from a mid-stream one (one-tap resume notice only —
   * a transparent cut-over is a deliberate follow-up). `auth_permanent` /
   * `unknown` failures always surface verbatim (a blind reroute would not help).
   */
  async #proxyVendor(req: FrontdoorRequestValue): Promise<VendorProxyOutcome> {
    const target = this.#passthroughFor(req.chat.model);
    if (target === undefined) throw new Error("vendor proxy invoked without a native model");
    const chat = req.chat;
    const signal = this.#signalFor(req);
    const traceId = this.#mintTraceId();
    const spanId = newSpanId();
    // WS7: a passthrough turn is metered against the vendor model, accumulated
    // under the same conversation key the fused path uses (so cost is continuous
    // across a mid-conversation switch between a vendor model and the ensemble).
    const costSessionId = req.sessionKey;
    const traceEnabled = getTraceEmitter().isEnabled();
    if (traceEnabled) {
      emitTrace({
        component: "gateway",
        event_type: "session.started",
        traceId,
        spanId,
        payload: { dialect: "native-passthrough", model: target.modelId, endpoint_id: target.endpointId }
      });
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (req.modelCallId) headers["x-velum-model-call-id"] = req.modelCallId;
    // The router routes by endpoint id, so rewrite `model` to it; everything
    // else (messages, tools, tool results, stream flag) passes through verbatim.
    const body = JSON.stringify({ ...chat, model: target.endpointId });
    const response = await fetch(joinPath(target.endpointUrl, "/v1/chat/completions"), {
      method: "POST",
      headers,
      body,
      ...(signal ? { signal } : {})
    });
    if (traceEnabled) {
      emitTrace({
        component: "gateway",
        event_type: "session.finished",
        traceId,
        spanId,
        payload: {
          status: response.ok ? "succeeded" : "failed",
          model: target.modelId,
          endpoint_id: target.endpointId,
          http_status: response.status
        }
      });
    }

    // `passthrough` opts out of failover entirely: the harness sees the vendor's
    // response (including its 429) exactly as before WS5.
    if (this.#onRateLimit === "passthrough") {
      await this.#meterResponseClone(response, costSessionId, target.modelId, traceId, spanId);
      return { kind: "response", response };
    }

    if (!response.ok) {
      // A non-2xx is delivered before any byte streams to the harness, so this
      // is always a pre-stream failure.
      const { failure, bodyText } = await this.#readErrorBody(response);
      return this.#classifyPreStreamFailure(target, failure, req.streaming, () =>
        rebuildErrorResponse(response.status, response.headers.get("content-type"), bodyText)
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (chat.stream === true && contentType.includes("text/event-stream") && response.body !== null) {
      return this.#proxyVendorStream(response.body, target, req, costSessionId);
    }
    await this.#meterResponseClone(response, costSessionId, target.modelId, traceId, spanId);
    return { kind: "response", response };
  }

  /** Read a non-2xx router reply into a classified {@link ProxyFailure} + its raw body. */
  async #readErrorBody(response: Response): Promise<{ failure: ProxyFailure; bodyText: string }> {
    const bodyText = await response.text();
    try {
      const json = JSON.parse(bodyText) as Record<string, unknown>;
      const err =
        json.error !== null && typeof json.error === "object"
          ? (json.error as Record<string, unknown>)
          : json;
      return { failure: failureFromErrorObject(err, response.status), bodyText };
    } catch {
      return {
        failure: {
          category: normalizeFailoverCategory(undefined, response.status),
          status: response.status,
          message: bodyText.slice(0, 300)
        },
        bodyText
      };
    }
  }

  /** Decide what to do with a detected pre-stream failure under the active policy. */
  #decideFailover(category: FailoverCategory): FailoverDecision {
    // `passthrough` is short-circuited before any detection runs.
    if (!isFailoverWorthy(category)) return "fail-fast";
    return this.#onRateLimit === "fail" ? "fail-error" : "failover";
  }

  /**
   * Branch a detected pre-stream vendor failure: reroute to the ensemble, surface
   * the vendor error verbatim, or emit a clear gateway error (per policy).
   * `verbatim` rebuilds the original vendor response (its body was consumed for
   * classification).
   */
  /**
   * Classify a detected pre-stream vendor failure into a {@link VendorProxyOutcome}:
   * surface the vendor error verbatim, emit a clear gateway error (per policy), or
   * signal a `failover` so the request scheduler re-enters the fusion turn with the
   * throttled vendor excluded. `verbatim` rebuilds the original vendor response
   * (its body was consumed for classification). The failover *control* now lives in
   * the scheduler, not in a recursive proxy call.
   */
  #classifyPreStreamFailure(
    target: PassthroughModel,
    failure: ProxyFailure,
    streaming: boolean,
    verbatim: () => Response
  ): VendorProxyOutcome {
    const decision = this.#decideFailover(failure.category);
    switch (decision) {
      case "fail-fast":
        console.error(
          `fusion: ${target.modelId} failed (${failure.category}); not failing over to the ensemble.`
        );
        return { kind: "response", response: verbatim() };
      case "fail-error": {
        const message =
          `${target.modelId} ${failure.category} (${failure.message}); ` +
          `failover disabled by --on-rate-limit fail`;
        console.error(`fusion: ${message}`);
        return {
          kind: "response",
          response: streaming
            ? sseResponse(errorEvent(`fusion error: ${message}`))
            : jsonError(failure.status ?? 429, message)
        };
      }
      case "failover":
        console.error(
          `fusion: ${target.modelId} ${failure.category}; handing the turn off to the ensemble.`
        );
        return {
          kind: "failover",
          excludeModelIds: [target.endpointId],
          notice: failoverNotice(target.modelId, failure)
        };
      default: {
        const unreachable: never = decision;
        throw new Error(`unhandled failover decision: ${String(unreachable)}`);
      }
    }
  }

  /**
   * Peek a streaming vendor reply to classify a pre-stream failure (failover-able)
   * vs a mid-stream one. A pre-stream error (the first significant SSE event is
   * an error) branches like the non-streaming path. Once a content delta has
   * reached the harness we cannot transparently cut over, so any later error is
   * rewritten into a one-tap resume notice (re-run on the fused model).
   */
  async #proxyVendorStream(
    upstream: ReadableStream<Uint8Array>,
    target: PassthroughModel,
    req: FrontdoorRequestValue,
    sessionId: string
  ): Promise<VendorProxyOutcome> {
    const reader = upstream.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let signalKind: "content" | "error" | "none" = "none";
    let preFailure: ProxyFailure | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) buffered += decoder.decode(value, { stream: true });
      const signalSeen = firstSseSignal(buffered);
      if (signalSeen.kind === "error") {
        signalKind = "error";
        preFailure = signalSeen.error;
        break;
      }
      if (signalSeen.kind === "content") {
        signalKind = "content";
        break;
      }
    }

    if (signalKind === "error" && preFailure !== undefined) {
      const decision = this.#decideFailover(preFailure.category);
      if (decision === "failover") {
        void reader.cancel().catch(() => undefined);
        return this.#classifyPreStreamFailure(target, preFailure, req.streaming, () => sseResponse(buffered));
      }
      if (decision === "fail-error") {
        const captured = buffered;
        void reader.cancel().catch(() => undefined);
        return this.#classifyPreStreamFailure(target, preFailure, req.streaming, () => sseResponse(captured));
      }
      // fail-fast: replay the verbatim vendor stream (buffered head + the rest).
      return {
        kind: "response",
        response: this.#reconstructStream(buffered, reader, decoder, target, "verbatim", sessionId)
      };
    }

    // Content already streamed (mid-stream) or a clean short stream: replay and
    // continue, converting any later vendor error into a resume notice.
    return {
      kind: "response",
      response: this.#reconstructStream(buffered, reader, decoder, target, "resume-notice", sessionId)
    };
  }

  /**
   * Re-emit a partially-consumed vendor SSE stream: flush the buffered head, then
   * pipe the remainder. In `resume-notice` mode a later error event is replaced
   * by a one-tap resume notice + a clean finish (WS5 mid-stream: no transparent
   * cut-over); in `verbatim` mode the stream passes through untouched.
   */
  #reconstructStream(
    buffered: string,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: InstanceType<typeof TextDecoder>,
    target: PassthroughModel,
    onError: "verbatim" | "resume-notice",
    sessionId: string
  ): Response {
    const encoder = new TextEncoder();
    const fusedModel = this.defaultModel ?? FUSION_PANEL_MODEL;
    // WS7: meter the vendor stream from the `usage` block riding its SSE tail.
    const meter = (text: string): void => {
      const providerCost = providerCostFromSse(text);
      this.#meterEntry(sessionId, {
        model: target.modelId,
        usage: usageWithProviderCost(parseUsageFromSse(text), providerCost),
        stage: "passthrough",
        ...(providerCost !== undefined ? { providerCost } : {})
      });
    };
    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        let pending = buffered;
        let meteredText = buffered;
        let terminated = false;
        // Emit every complete SSE event in `pending`; in resume-notice mode an
        // error event short-circuits the stream with the resume notice instead.
        const flush = (final: boolean): void => {
          for (;;) {
            const idx = pending.indexOf("\n\n");
            if (idx === -1) break;
            const event = pending.slice(0, idx + 2);
            pending = pending.slice(idx + 2);
            if (onError === "resume-notice" && sseEventError(event) !== undefined) {
              controller.enqueue(encoder.encode(noticeChunk(resumeNotice(target.modelId, fusedModel))));
              controller.enqueue(encoder.encode(finishChunk("stop")));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              terminated = true;
              return;
            }
            controller.enqueue(encoder.encode(event));
          }
          if (final && pending.length > 0) {
            controller.enqueue(encoder.encode(pending));
            pending = "";
          }
        };
        try {
          flush(false);
          while (!terminated) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value !== undefined) {
              const decoded = decoder.decode(value, { stream: true });
              pending += decoded;
              meteredText += decoded;
            }
            flush(false);
          }
          if (!terminated) flush(true);
        } catch (error) {
          controller.enqueue(encoder.encode(errorEvent(`fusion error: ${errorText(error)}`)));
        } finally {
          meter(meteredText);
          void reader.cancel().catch(() => undefined);
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      }
    });
    return new Response(readable, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
    });
  }

  async chat(body: unknown, signal?: AbortSignal, options: BackendRequestOptions = {}): Promise<Response> {
    const chat = (body ?? {}) as ChatBody;
    const messages = Array.isArray(chat.messages) ? chat.messages : [];
    // The whole request runs as the `fusion-frontdoor-request` kernel graph: the
    // budget gate, requested-model resolution, and rate-limit failover are
    // first-class operators + a routing scheduler decision. This backend supplies
    // only the stable services (session/panel/fuse/cost/trace/vendor wire) those
    // operators invoke; every per-turn input travels as the request artifact.
    const req: FrontdoorRequestValue = {
      requestId: newSpanId(),
      chat,
      sessionKey: this.#sessionKey(messages),
      // The user-turn index: a follow-up user message is a new turn, while a
      // harness tool-loop continuation keeps the count (and reuses candidates).
      turn: messages.filter((message) => message.role === "user").length,
      // Minted once so this turn's judge.request and judge.final share a span.
      judgeSpanId: newSpanId(),
      streaming: chat.stream === true,
      ...(options.modelCallId !== undefined ? { modelCallId: options.modelCallId } : {}),
      ...(signal !== undefined ? { [FRONTDOOR_SIGNAL]: signal } : {})
    };
    return runFrontdoorRequest(this.#services, req);
  }

  // --- front-door services: the stable wire the operators invoke ------------
  //
  // Built once (see the constructor). Every method takes the request as data and
  // derives session identity, spans, headers, and cost from the request + the
  // kernel state store. No per-turn closures.

  #buildServices(): FrontdoorServices {
    return {
      budgetUsd: this.#budgetUsd,
      costTotalUsd: (sessionKey) => this.#costFor(sessionKey).totalUsd,
      budgetStopResponse: (req) => this.#budgetStop(req.streaming, req.sessionKey),
      isNativeModel: (model) => this.#passthroughFor(model) !== undefined,
      resolvePanelCandidates: (req) => this.#resolvePanelCandidates(req),
      runFuseStep: (req, candidates) => this.#runFuseStepBuffered(req, candidates),
      openFuseStream: (req, candidates) => this.#openFuseStream(req, candidates),
      finalizeFused: (req, response) => this.#finalizeFused(req, response),
      meterAndTraceStream: (req, buffer) => this.#meterAndTraceStream(req, buffer),
      onFuseUpstreamError: (req, status, detail) => this.#onFuseUpstreamError(req, status, detail),
      onFuseException: (req, message) => this.#onFuseException(req, message),
      proxyVendor: (req) => this.#proxyVendor(req),
      evictTurn: (req) => this.#evictTurnFor(req),
      openTurnNarration: (req) => this.#openTurnNarration(req)
    };
  }

  /**
   * Reasoning traces: open the narration channel for one streaming fused turn.
   * The narrator subscribes to the in-process trace stream filtered by this
   * session's trace id, so the harnesses' candidate events and the judge
   * kickoff surface live in the client's reasoning channel.
   */
  #openTurnNarration(req: FrontdoorRequestValue): TurnNarration | undefined {
    if (!this.#reasoningTraces) return undefined;
    const session = this.#ensureSession(req.sessionKey);
    return createTurnNarrator({
      traceId: session.traceId,
      turn: req.turn,
      ...(this.#judgeModel !== undefined ? { judgeModel: this.#judgeModel } : {}),
      ...(session.lastJudgePick !== undefined ? { lastPick: session.lastJudgePick } : {}),
      ...(this.#narrationWriter !== undefined ? { writer: this.#narrationWriter } : {})
    });
  }

  /**
   * Remember which panel member the judge picked (narration opener color for
   * the next turn). The synthesis carries a trajectory id; map it to the
   * member's model id via this turn's (already-settled) candidate cache.
   */
  #stashJudgePick(session: Session, turn: number, synthesis: unknown): void {
    if (synthesis === null || typeof synthesis !== "object") return;
    const selected = (synthesis as { selected_trajectory_id?: unknown }).selected_trajectory_id;
    if (typeof selected !== "string" || selected.length === 0) return;
    const candidates = session.turns.get(turn);
    if (candidates === undefined) return;
    void candidates.then(
      (resolved) => {
        const match = resolved.find((candidate) => candidate.trajectory_id === selected);
        if (match !== undefined && typeof match.model_id === "string" && match.model_id.length > 0) {
          session.lastJudgePick = match.model_id;
        }
      },
      () => undefined
    );
  }

  #signalFor(req: FrontdoorRequestValue): AbortSignal | undefined {
    return req[FRONTDOOR_SIGNAL];
  }

  #fusedCostModel(): string {
    // WS7: a fused turn's gateway-observed usage is the judge/synthesis call's,
    // priced against the configured judge model (falling back to the advertised
    // fused id, whose cost is reported unknown).
    return this.#costModel ?? this.defaultModel ?? FUSION_PANEL_MODEL;
  }

  #buildStepBody(req: FrontdoorRequestValue, candidates: readonly WireTrajectory[]): string {
    const stepBody: Record<string, unknown> = {
      model: req.chat.model ?? this.defaultModel ?? FUSION_PANEL_MODEL,
      messages: req.chat.messages ?? [],
      trajectories: candidates,
      stream: req.streaming
    };
    if (req.chat.tools !== undefined) stepBody.tools = req.chat.tools;
    if (req.chat.tool_choice !== undefined) stepBody.tool_choice = req.chat.tool_choice;
    if (this.#judgeModel !== undefined) stepBody.judge_model = this.#judgeModel;
    return JSON.stringify(stepBody);
  }

  #buildHeaders(req: FrontdoorRequestValue, session: Session): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [TRACE_ID_HEADER]: session.traceId
    };
    if (req.modelCallId) headers["x-velum-model-call-id"] = req.modelCallId;
    return headers;
  }

  #emitJudgeRequest(req: FrontdoorRequestValue, session: Session, candidates: readonly WireTrajectory[]): void {
    if (!getTraceEmitter().isEnabled()) return;
    emitTrace({
      component: "judge",
      event_type: "judge.request",
      traceId: session.traceId,
      spanId: req.judgeSpanId,
      parentSpanId: session.sessionSpan,
      payload: judgeRequestPayload({
        ...(this.#judgeModel !== undefined ? { judgeModel: this.#judgeModel } : {}),
        messages: req.chat.messages ?? [],
        trajectories: [...candidates],
        ...(req.chat.tools !== undefined ? { tools: req.chat.tools } : {}),
        ...(req.chat.tool_choice !== undefined ? { toolChoice: req.chat.tool_choice } : {}),
        trajectoryIds: candidates.map((candidate) => candidate.trajectory_id),
        turn: req.turn
      })
    });
  }

  #emitJudgeFinal(
    req: FrontdoorRequestValue,
    session: Session,
    input: Parameters<typeof judgeFinalPayload>[0]
  ): void {
    if (!getTraceEmitter().isEnabled()) return;
    emitTrace({
      component: "judge",
      event_type: "judge.final",
      traceId: session.traceId,
      spanId: req.judgeSpanId,
      parentSpanId: session.sessionSpan,
      payload: judgeFinalPayload({ ...input, turn: req.turn })
    });
  }

  #emitJudgeStep(
    req: FrontdoorRequestValue,
    session: Session,
    input: { content?: string; toolCalls?: unknown[]; usage?: unknown }
  ): void {
    if (!getTraceEmitter().isEnabled()) return;
    const toolCallCount = input.toolCalls?.length ?? 0;
    const rawAnalysis =
      input.content !== undefined && input.content.length > 0
        ? input.content
        : `judge requested ${toolCallCount} tool call(s)`;
    emitTrace({
      component: "judge",
      event_type: "judge.thinking",
      traceId: session.traceId,
      spanId: req.judgeSpanId,
      parentSpanId: session.sessionSpan,
      payload: judgeThinkingPayload({
        rawAnalysis,
        ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
        ...(input.usage !== undefined ? { usage: input.usage } : {}),
        turn: req.turn
      })
    });
  }

  #localComputeFor(input: {
    model: string;
    endpointId: string;
    provider?: string;
    latencyMs?: number;
  }): ReturnType<typeof localComputeFromLatency> {
    const pricing = this.#localCompute[input.model] ?? this.#localCompute[input.endpointId];
    // Local classification is explicit: panel members threaded via
    // `localModels` (the CLI marks its mlx members), or true local provider
    // metadata from the engine (`mlx-lm`). No model-id string heuristics.
    const looksLocal =
      this.#localModels.has(input.model) ||
      this.#localModels.has(input.endpointId) ||
      input.provider === "mlx-lm";
    if (pricing === undefined && !looksLocal) return undefined;
    return localComputeFromLatency({
      latencyMs: input.latencyMs,
      modelRepo: input.model,
      deviceKind: looksLocal ? "local" : undefined,
      ...(pricing !== undefined ? { pricing } : {})
    });
  }

  #meterPanelCandidates(
    req: FrontdoorRequestValue,
    session: Session,
    candidates: readonly WireTrajectory[]
  ): void {
    if (session.meteredPanelTurns.has(req.turn)) return;
    session.meteredPanelTurns.add(req.turn);
    for (const candidate of candidates) {
      const metadata = trajectoryMetadata(candidate);
      const model = optionalString(candidate.model) ?? candidate.model_id;
      const endpointId = candidate.model_id;
      const provider = optionalString(metadata.provider);
      const latencyMs = trajectoryLatencyMs(candidate);
      const providerCost = providerCostMetadata(metadata.provider_cost ?? metadata.providerCost);
      const usage = usageWithProviderCost(trajectoryUsage(candidate), providerCost);
      const localCompute = this.#localComputeFor({
        model,
        endpointId,
        ...(provider !== undefined ? { provider } : {}),
        ...(latencyMs !== undefined ? { latencyMs } : {})
      });
      this.#meterEntry(
        session.id,
        {
          model,
          usage,
          stage: "panel",
          turn: req.turn,
          ...(provider !== undefined ? { provider } : {}),
          endpointId,
          ...(latencyMs !== undefined ? { latencyMs } : {}),
          ...(providerCost !== undefined ? { providerCost } : {}),
          ...(localCompute !== undefined ? { localCompute } : {})
        },
        session.traceId,
        session.sessionSpan
      );
    }
  }

  async #resolvePanelCandidates(req: FrontdoorRequestValue): Promise<readonly WireTrajectory[]> {
    const session = this.#ensureSession(req.sessionKey);
    const turnCandidates = this.#ensureTurnCandidates(
      session,
      req.sessionKey,
      req.turn,
      req.chat.messages ?? [],
      req.excludeModelIds
    );
    // Bounded, failing loudly so a panel crash or an empty/all-failed candidate
    // set never silently fuses into a blank answer. When the deadline fires the
    // turn's abort controller cancels the in-flight candidates (child processes
    // included) instead of leaving them running after the turn has failed.
    const candidates = await withTimeout(turnCandidates, this.#panelTimeoutMs, "fusion panel", (error) =>
      session.turnAborts.get(req.turn)?.abort(error)
    );
    this.#meterPanelCandidates(req, session, candidates);
    if (!hasUsableCandidates(candidates)) {
      if (candidates.length === 0) throw new Error("fusion panel produced no candidates");
      const breakdown = candidates
        .map((candidate) => `${candidate.model_id || candidate.trajectory_id}: ${candidate.status}`)
        .join(", ");
      throw new Error(`fusion panel produced no usable candidates (every model failed) — ${breakdown}`);
    }
    return candidates;
  }

  #runFuseStepBuffered(req: FrontdoorRequestValue, candidates: readonly WireTrajectory[]): Promise<Response> {
    const session = this.#ensureSession(req.sessionKey);
    this.#emitJudgeRequest(req, session, candidates);
    return this.#runFuseStep({
      stepUrl: this.#stepUrl,
      headers: this.#buildHeaders(req, session),
      body: this.#buildStepBody(req, candidates),
      signal: withDeadline(this.#signalFor(req), this.#stepTimeoutMs),
      streaming: false
    });
  }

  #openFuseStream(req: FrontdoorRequestValue, candidates: readonly WireTrajectory[]): Promise<Response> {
    const session = this.#ensureSession(req.sessionKey);
    this.#emitJudgeRequest(req, session, candidates);
    if (process.env.FUSION_DEBUG) {
      const messages = req.chat.messages ?? [];
      const toolNames = Array.isArray(req.chat.tools)
        ? req.chat.tools.map((t) => {
            const tool = t as { type?: string; name?: string; function?: { name?: string } };
            return tool.function?.name ?? tool.name ?? tool.type ?? "?";
          })
        : [];
      console.error(
        `[fusion-debug] step: messages=${messages.length} roles=${messages.map((m) => m.role).join(",")} ` +
          `candidates=${candidates.length} tools=[${toolNames.join(", ")}]`
      );
    }
    return this.#runFuseStep({
      stepUrl: this.#stepUrl,
      headers: this.#buildHeaders(req, session),
      body: this.#buildStepBody(req, candidates),
      signal: withDeadline(this.#signalFor(req), this.#stepTimeoutMs),
      streaming: true
    });
  }

  async #finalizeFused(req: FrontdoorRequestValue, response: Response): Promise<Response> {
    const session = this.#ensureSession(req.sessionKey);
    const fusedCostModel = this.#fusedCostModel();
    // Failover handoff: prepend the notice to the single fused answer so the user
    // sees why the turn moved to the ensemble. Consumes the body, so this returns
    // before the (clone-based) trace capture below.
    if (req.notice !== undefined) {
      if (!response.ok) return response;
      let payload: Record<string, unknown>;
      try {
        payload = (await response.json()) as Record<string, unknown>;
      } catch {
        return jsonError(502, "fusion failover produced an unreadable response");
      }
      const choice = (Array.isArray(payload.choices) ? payload.choices[0] : undefined) as
        | { message?: { content?: unknown } }
        | undefined;
      if (choice?.message !== undefined) {
        const existing = typeof choice.message.content === "string" ? choice.message.content : "";
        const merged = `${req.notice}${existing}`;
        choice.message.content = merged;
        this.#emitJudgeFinal(req, session, { httpStatus: 200, content: merged });
      }
      const providerCost = providerCostFromPayload(payload);
      this.#meterEntry(
        req.sessionKey,
        {
          model: fusedCostModel,
          usage: usageWithProviderCost(parseUsage(payload.usage), providerCost),
          stage: "judge_synth",
          turn: req.turn,
          ...(providerCost !== undefined ? { providerCost } : {})
        },
        session.traceId,
        req.judgeSpanId
      );
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (getTraceEmitter().isEnabled()) {
      // Capture the judge's output without consuming the piped response.
      const clone = response.clone();
      void (async () => {
        try {
          if (!clone.ok) {
            this.#emitJudgeFinal(req, session, {
              httpStatus: clone.status,
              error: (await clone.text()).slice(0, 2000)
            });
            return;
          }
          const judged = (await clone.json()) as {
            choices?: Array<{ message?: { content?: string; tool_calls?: unknown }; finish_reason?: string }>;
            usage?: unknown;
            fusion?: unknown;
          };
          const choice = judged.choices?.[0];
          const message = choice?.message;
          const content = typeof message?.content === "string" ? message.content : undefined;
          const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
          if (isTerminalJudgeStep(toolCalls, choice?.finish_reason)) {
            const synthesis = synthesisOf(judged.fusion);
            this.#emitJudgeFinal(req, session, {
              httpStatus: clone.status,
              ...(content !== undefined ? { content } : {}),
              ...(synthesis !== undefined ? { synthesis } : {}),
              ...(judged.usage !== undefined ? { usage: judged.usage } : {})
            });
          } else {
            this.#emitJudgeStep(req, session, {
              ...(content !== undefined ? { content } : {}),
              toolCalls,
              ...(judged.usage !== undefined ? { usage: judged.usage } : {})
            });
          }
        } catch {
          // best-effort judge.final
        }
      })();
    }
    await this.#meterResponseClone(
      response,
      req.sessionKey,
      fusedCostModel,
      session.traceId,
      req.judgeSpanId,
      "judge_synth",
      req.turn
    );
    return response;
  }

  #meterAndTraceStream(req: FrontdoorRequestValue, sseBuffer: string): void {
    const session = this.#ensureSession(req.sessionKey);
    // WS7: meter the fused turn from the judge step's `usage` (rides the SSE tail).
    const providerCost = providerCostFromSse(sseBuffer);
    this.#meterEntry(
      req.sessionKey,
      {
        model: this.#fusedCostModel(),
        usage: usageWithProviderCost(parseUsageFromSse(sseBuffer), providerCost),
        stage: "judge_synth",
        turn: req.turn,
        ...(providerCost !== undefined ? { providerCost } : {})
      },
      session.traceId,
      req.judgeSpanId
    );
    const assembled = assembleSseContent(sseBuffer);
    // Narration color for the next turn, independent of the trace-emitter gate
    // (the narrator's own listener detaches when the judge starts streaming).
    this.#stashJudgePick(session, req.turn, synthesisOf(assembled.fusion));
    if (!getTraceEmitter().isEnabled()) return;
    if (isTerminalJudgeStep(assembled.toolCalls, assembled.finishReason)) {
      const synthesis = synthesisOf(assembled.fusion);
      this.#emitJudgeFinal(req, session, {
        httpStatus: 200,
        ...(assembled.content.length > 0 ? { content: assembled.content } : {}),
        ...(synthesis !== undefined ? { synthesis } : {}),
        ...(assembled.usage !== undefined ? { usage: assembled.usage } : {})
      });
    } else {
      this.#emitJudgeStep(req, session, {
        ...(assembled.content.length > 0 ? { content: assembled.content } : {}),
        toolCalls: assembled.toolCalls,
        ...(assembled.usage !== undefined ? { usage: assembled.usage } : {})
      });
    }
  }

  #onFuseUpstreamError(req: FrontdoorRequestValue, status: number, detail: string): void {
    this.#emitJudgeFinal(req, this.#ensureSession(req.sessionKey), { httpStatus: status, error: detail });
  }

  #onFuseException(req: FrontdoorRequestValue, message: string): void {
    this.#emitJudgeFinal(req, this.#ensureSession(req.sessionKey), { error: message });
  }

  #evictTurnFor(req: FrontdoorRequestValue): void {
    const session = this.#kernelStateStore.get(req.sessionKey);
    if (session !== undefined) this.#evictTurn(session, req.turn);
  }

  models(): Promise<Response> {
    const data = this.listModelIds().map((id) => ({
      id,
      object: "model",
      owned_by: "fusion-gateway"
    }));
    return Promise.resolve(
      new Response(JSON.stringify({ object: "list", data }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
  }

  embeddings(): Promise<Response> {
    return Promise.resolve(
      new Response(JSON.stringify({ error: { message: "embeddings are not supported by the fusion gateway" } }), {
        status: 501,
        headers: { "content-type": "application/json" }
      })
    );
  }

  /** A stable key for the conversation: system text + first user message. */
  #sessionKey(messages: ChatMessageLike[]): string {
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => textOfContent(message.content))
      .join("\n");
    const firstUser = messages.find((message) => message.role === "user");
    const seed = JSON.stringify([system, firstUser ? textOfContent(firstUser.content) : ""]);
    return createHash("sha256").update(seed).digest("hex").slice(0, 16);
  }

  #task(messages: ChatMessageLike[]): string {
    // The panel task is the *current* request: the most recent user message.
    // Real CLIs (codex/claude/cursor) put their large agent harness prompt in
    // the system message and may prepend an <environment_context> user message,
    // so take the latest user turn (the active instruction) and fall back to
    // system text only if there is no user content at all. Using the latest
    // user message means a follow-up turn's panel solves the follow-up request.
    const userText = messages
      .filter((message) => message.role === "user")
      .map((message) => textOfContent(message.content).trim())
      .filter((text) => text.length > 0);
    const latest = userText.at(-1);
    if (latest !== undefined && latest.length > 0) return latest;
    return messages
      .filter((message) => message.role === "system")
      .map((message) => textOfContent(message.content))
      .join("\n\n")
      .trim();
  }

  /** Drop a turn's cached candidates so the next call for that turn re-runs the panel. */
  #evictTurn(session: Session, turn: number): void {
    session.turns.delete(turn);
  }

  /** Remove expired sessions so a long-lived gateway does not grow unbounded. */
  #sweepExpired(now: number): void {
    for (const [key, session] of this.#kernelStateStore.entries()) {
      if (now - session.createdAt >= this.#ttlMs) this.#kernelStateStore.delete(key);
    }
  }

  /**
   * Establish (or reuse) the per-conversation session identity. No panel runs
   * here. The in-memory map is the hot cache; the durable {@link SessionStore}
   * (when configured) is the backing layer. On a cache miss this resolves, in
   * order: (1) an explicit `--resume` target bound to the first conversation,
   * (2) a stored session whose id equals this conversation's key (durable
   * rehydrate after a TTL eviction or a fresh process), else (3) a brand-new
   * session whose header is written through immediately.
   */
  #ensureSession(sessionKey: string): Session {
    const now = Date.now();
    this.#sweepExpired(now);
    const existing = this.#kernelStateStore.get(sessionKey);
    if (existing !== undefined && now - existing.createdAt < this.#ttlMs) return existing;

    if (this.#store !== undefined) {
      // Explicit resume: bind the persisted session to the FIRST conversation
      // this process serves, regardless of its derived key (the relaunched
      // harness may open with a different prefix). One-shot.
      if (this.#resumeId !== undefined) {
        const resumeId = this.#resumeId;
        this.#resumeId = undefined;
        const persisted = this.#store.load(resumeId);
        if (persisted !== undefined) {
          const session = this.#hydrate(persisted, now);
          this.#kernelStateStore.set(sessionKey, session);
          return session;
        }
        console.error(`fusion: --resume target ${resumeId} not found; starting a fresh session.`);
      }
      // Durable rehydrate: a stored session for this exact conversation key
      // (cold start or post-TTL) is reloaded rather than re-running the panel.
      const stored = this.#store.load(sessionKey);
      if (stored !== undefined) {
        const session = this.#hydrate(stored, now);
        this.#kernelStateStore.set(sessionKey, session);
        return session;
      }
    }

    const session: Session = {
      id: sessionKey,
      traceId: this.#mintTraceId(),
      sessionSpan: newSpanId(),
      turns: new Map(),
      turnAborts: new Map(),
      meteredPanelTurns: new Set(),
      createdAt: now
    };
    this.#kernelStateStore.set(sessionKey, session);
    this.#persistMeta(session);
    return session;
  }

  /** Rebuild an in-memory session from a persisted one (its turn candidates
   *  become already-resolved promises, so completed turns are not re-run). */
  #hydrate(persisted: PersistedSession, now: number): Session {
    const turns = new Map<number, Promise<WireTrajectory[]>>();
    for (const record of persisted.turns) {
      turns.set(record.turn, Promise.resolve(record.candidates));
    }
    const meteredPanelTurns = new Set(
      persisted.costLedger
        .filter((entry) => entry.stage === "panel" && entry.turn !== undefined)
        .map((entry) => entry.turn as number)
    );
    return {
      id: persisted.meta.id,
      traceId: persisted.meta.traceId,
      sessionSpan: persisted.meta.sessionSpan,
      turns,
      turnAborts: new Map(),
      meteredPanelTurns,
      // Reset the in-memory TTL clock so a freshly rehydrated session is hot.
      createdAt: now
    };
  }

  /** Write a new session's header to the store (best-effort; never fails a turn). */
  #persistMeta(session: Session): void {
    if (this.#store === undefined) return;
    try {
      const now = Date.now();
      this.#store.saveMeta({
        id: session.id,
        traceId: session.traceId,
        sessionSpan: session.sessionSpan,
        createdAt: session.createdAt,
        updatedAt: now,
        ...(this.defaultModel !== undefined ? { defaultModel: this.defaultModel } : {}),
        ...(this.#sessionMeta.tool !== undefined ? { tool: this.#sessionMeta.tool } : {}),
        ...(this.#sessionMeta.repo !== undefined ? { repo: this.#sessionMeta.repo } : {}),
        ...(this.#sessionMeta.models !== undefined ? { models: this.#sessionMeta.models } : {}),
        ...(this.#sessionMeta.judgeModel !== undefined ? { judgeModel: this.#sessionMeta.judgeModel } : {})
      });
    } catch (error) {
      console.error(`fusion: could not persist session ${session.id}: ${errorText(error)}`);
    }
  }

  /** Append a resolved turn's conversation + candidates to the store (best-effort). */
  #persistTurn(session: Session, turn: number, messages: ChatMessageLike[], candidates: WireTrajectory[]): void {
    if (this.#store === undefined) return;
    try {
      this.#store.appendTurn(session.id, { turn, messages, candidates, recordedAt: Date.now() });
    } catch (error) {
      console.error(`fusion: could not persist turn ${turn} of session ${session.id}: ${errorText(error)}`);
    }
  }

  // --- WS7: cost + token metering -------------------------------------------

  /** The running cost for a conversation, seeded once from the durable store. */
  #costFor(sessionId: string): SessionCost {
    const cached = this.#kernelStateStore.getCost(sessionId);
    if (cached !== undefined) return cached;
    const stored = this.#store?.load(sessionId)?.meta.cost;
    const seeded = stored ?? emptySessionCost();
    this.#kernelStateStore.setCost(sessionId, seeded);
    return seeded;
  }

  /**
   * Meter one turn's gateway-observed usage: compute its token/cost, fold it into
   * the session total, persist the total, and surface a concise per-turn line
   * (stderr + a trace `log` event). `usageRaw` is the response's `usage` block;
   * `model` is what to price it against (the vendor for passthrough, the judge
   * for a fused turn). Best-effort: metering never fails a turn.
   */
  #meterEntry(
    sessionId: string,
    input: {
      model: string;
      usage: TokenUsage | undefined;
      stage: CostStage;
      turn?: number;
      provider?: string;
      endpointId?: string;
      latencyMs?: number;
      providerCost?: ProviderCostMetadata;
      localCompute?: ReturnType<typeof localComputeFromLatency>;
    },
    traceId?: string,
    parentSpanId?: string
  ): CostLedgerEntry {
    const entry = meterCall({
      model: input.model,
      usage: input.usage,
      stage: input.stage,
      pricing: this.#pricing,
      ...(input.turn !== undefined ? { turn: input.turn } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.endpointId !== undefined ? { endpointId: input.endpointId } : {}),
      ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
      ...(input.providerCost !== undefined ? { providerCost: input.providerCost } : {}),
      ...(input.localCompute !== undefined ? { localCompute: input.localCompute } : {})
    });
    const total = addLedgerEntry(this.#costFor(sessionId), entry);
    this.#kernelStateStore.setCost(sessionId, total);
    try {
      this.#store?.recordCostEntry(sessionId, entry, total);
    } catch (error) {
      console.error(`fusion: could not persist cost for session ${sessionId}: ${errorText(error)}`);
    }
    const line = turnCostLine(entry, total.totalUsd);
    console.error(`fusion: ${input.stage} ${line}`);
    if (getTraceEmitter().isEnabled()) {
      emitTrace({
        component: "gateway",
        event_type: "log",
        ...(traceId !== undefined ? { traceId } : {}),
        spanId: newSpanId(),
        ...(parentSpanId !== undefined ? { parentSpanId } : {}),
        sessionId,
        payload: {
          kind: "cost.metered",
          stage: input.stage,
          model: entry.model,
          usage: entry.usage,
          turn_cost_usd: entry.costUsd ?? null,
          provider_cost_usd: entry.providerCostUsd ?? null,
          provider_cost: entry.providerCost ?? null,
          local_compute_cost_usd: entry.localComputeCostUsd ?? null,
          local_compute: entry.localCompute ?? null,
          unknown_cost: entry.unknownCost,
          unknown_usage: entry.unknownUsage,
          session_total_usd: total.totalUsd,
          provider_total_usd: total.providerUsd ?? total.totalUsd,
          local_compute_total_usd: total.localComputeUsd ?? 0,
          currency: total.currency
        }
      });
    }
    return entry;
  }

  #meter(
    sessionId: string,
    model: string,
    usage: TokenUsage | undefined,
    traceId?: string,
    parentSpanId?: string,
    stage: CostStage = "passthrough",
    turn?: number
  ): TurnCost {
    return this.#meterEntry(
      sessionId,
      { model, usage, stage, ...(turn !== undefined ? { turn } : {}) },
      traceId,
      parentSpanId
    );
  }

  /**
   * Meter a single-JSON (non-streamed) response without consuming the body the
   * caller pipes: clone it, read its `usage`, and meter. Awaited (not detached)
   * so the session total is recorded before the turn returns — a following
   * turn's budget check then sees this turn's cost. Best-effort: a 4xx/5xx or
   * unreadable body simply leaves the turn unmetered.
   */
  async #meterResponseClone(
    response: Response,
    sessionId: string,
    model: string,
    traceId?: string,
    parentSpanId?: string,
    stage: CostStage = "passthrough",
    turn?: number
  ): Promise<void> {
    if (!response.ok) return;
    const clone = response.clone();
    try {
      const json = (await clone.json()) as { usage?: unknown };
      const providerCost = providerCostFromPayload(json);
      this.#meterEntry(
        sessionId,
        {
          model,
          usage: usageWithProviderCost(parseUsage(json.usage), providerCost),
          stage,
          ...(turn !== undefined ? { turn } : {}),
          ...(providerCost !== undefined ? { providerCost } : {})
        },
        traceId,
        parentSpanId
      );
    } catch {
      // best-effort: an unreadable body means the turn is left unmetered.
    }
  }

  /** Whether `sessionId` has already accrued at least the configured budget. */
  #budgetExceeded(sessionId: string): boolean {
    if (this.#budgetUsd === undefined) return false;
    return this.#costFor(sessionId).totalUsd >= this.#budgetUsd;
  }

  /** The clear stop response returned when a turn is refused for exceeding the budget. */
  #budgetStop(streaming: boolean, sessionId: string): Response {
    const total = this.#costFor(sessionId);
    const message =
      `budget cap reached: this session has spent ${formatUsd(total.totalUsd, total.currency)} ` +
      `of the ${formatUsd(this.#budgetUsd ?? 0, total.currency)} --budget. ` +
      `Raise or remove --budget to continue.`;
    console.error(`fusion: ${message}`);
    if (streaming) return sseResponse(errorEvent(`fusion error: ${message}`));
    return jsonError(402, message);
  }

  /**
   * Run the panel once per user turn and cache its candidates on the session.
   * Internal tool-loop continuations keep the same `turn` and reuse the result;
   * a follow-up user message is a new `turn` and triggers a fresh panel run.
   * A failed turn is evicted so a retry re-runs it (failures are never cached).
   */
  #ensureTurnCandidates(
    session: Session,
    sessionKey: string,
    turn: number,
    messages: ChatMessageLike[],
    excludeModelIds?: readonly string[]
  ): Promise<WireTrajectory[]> {
    const existing = session.turns.get(turn);
    if (existing !== undefined) return existing;

    // Turn-owned panel cancellation: aborted when this turn's panel deadline
    // fires (see #resolvePanelCandidates). Owned by the turn — not any single
    // request — because tool-loop continuations share the same panel promise.
    const abort = new AbortController();
    session.turnAborts.set(turn, abort);
    const candidates = this.#runPanels({
      task: this.#task(messages),
      messages,
      traceId: session.traceId,
      sessionSpanId: session.sessionSpan,
      sessionKey,
      turn,
      signal: abort.signal,
      ...(excludeModelIds !== undefined && excludeModelIds.length > 0 ? { excludeModelIds } : {})
    });
    session.turns.set(turn, candidates);
    // Write a usable turn through to the durable store; evict a failed turn so a
    // retry re-runs it (failures are never cached or persisted). A single
    // settle handler keeps both paths and avoids an unhandled rejection.
    void candidates.then(
      (resolved) => {
        if (session.turnAborts.get(turn) === abort) session.turnAborts.delete(turn);
        if (hasUsableCandidates(resolved)) this.#persistTurn(session, turn, messages, resolved);
      },
      (error: unknown) => {
        if (session.turnAborts.get(turn) === abort) session.turnAborts.delete(turn);
        console.error(`fusion: panel run failed for session ${sessionKey} turn ${turn}: ${errorText(error)}`);
        if (session.turns.get(turn) === candidates) session.turns.delete(turn);
      }
    );
    return candidates;
  }
}
