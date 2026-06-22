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
 *      trajectories to FusionKit's `trajectory:step`, whose response (an OpenAI
 *      chat completion, optionally streamed, that may carry `tool_calls`) is
 *      returned verbatim for the server to translate into the caller's dialect.
 *
 * There is no apply/verify/repair here: iteration is the user's harness's job.
 *
 * Failures are surfaced, never swallowed: a panel run that throws or yields no
 * usable candidate, or a `trajectory:step` that errors, produces an explicit
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

import { CLAUDE_ALIAS_PREFIX } from "./adapters/anthropic.js";
import { joinPath } from "./backend.js";
import type { Backend, BackendRequestOptions } from "./backend.js";

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

/** A candidate trajectory in the wire shape FusionKit's `trajectory:step` accepts. */
export type WireTrajectory = {
  trajectory_id: string;
  model_id: string;
  status: string;
  final_output: string;
  steps?: Array<Record<string, unknown>>;
  candidate_id?: string;
  model?: string;
  harness_kind?: string;
  diff?: string;
  verification?: { status: string; evidence?: string[]; exit_code?: number };
  metadata?: Record<string, unknown>;
};

export type ChatMessageLike = {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
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
};

/** Runs the panel once for a session and returns its candidate trajectories. */
export type PanelRunner = (input: PanelRunInput) => Promise<WireTrajectory[]>;

export type FusionBackendOptions = {
  /** FusionKit `POST /v1/fusion/trajectory:step` URL. */
  stepUrl: string;
  /** Produces candidate trajectories for a new session (injected; uses ensemble). */
  runPanels: PanelRunner;
  /** Model id echoed to clients and sent to the judge step. */
  defaultModel?: string;
  /** Judge model id forwarded to FusionKit (defaults to its configured judge). */
  judgeModel?: string;
  /** How long a session's candidate trajectories stay cached. */
  sessionTtlMs?: number;
  /** Wall-clock budget for the panel phase before the turn fails. */
  panelTimeoutMs?: number;
  /** Wall-clock budget for a single `trajectory:step` call. */
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
};

type Session = {
  traceId: string;
  sessionSpan: string;
  /** Candidate trajectories cached per user turn (a follow-up is a new turn). */
  turns: Map<number, Promise<WireTrajectory[]>>;
  createdAt: number;
};

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

/** Combine an optional client-abort signal with a wall-clock timeout. */
function withDeadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** Reject if `promise` does not settle within `timeoutMs` (the work detaches). */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
};

/** Best-effort reassembly of an OpenAI chat SSE stream into content, usage,
 *  tool-call deltas, and finish reason (used to tell terminal from intermediate). */
function assembleSseContent(buffer: string): AssembledStep {
  let content = "";
  let usage: unknown;
  let finishReason: string | undefined;
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
      };
      const choice = json.choices?.[0];
      const delta = choice?.delta?.content;
      if (typeof delta === "string") content += delta;
      if (Array.isArray(choice?.delta?.tool_calls)) toolCalls.push(...choice.delta.tool_calls);
      if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
      if (json.usage !== undefined && json.usage !== null) usage = json.usage;
    } catch {
      // ignore partial/non-JSON lines
    }
  }
  return {
    content,
    toolCalls,
    ...(usage !== undefined ? { usage } : {}),
    ...(finishReason !== undefined ? { finishReason } : {})
  };
}

/** A judge step is terminal (the real answer) only when it requests no tool calls. */
function isTerminalJudgeStep(toolCalls: unknown, finishReason?: string): boolean {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  return calls.length === 0 && finishReason !== "tool_calls";
}

/** A terminal SSE chunk that marks the turn as failed (not a normal stop). */
function errorEvent(message: string): string {
  return (
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: message }, finish_reason: "error" }]
    })}\n\n` + "data: [DONE]\n\n"
  );
}

export class FusionBackend implements Backend {
  readonly defaultModel: string | undefined;

  readonly #stepUrl: string;
  readonly #runPanels: PanelRunner;
  readonly #judgeModel: string | undefined;
  readonly #ttlMs: number;
  readonly #panelTimeoutMs: number;
  readonly #stepTimeoutMs: number;
  readonly #mintTraceId: () => string;
  readonly #sessions = new Map<string, Session>();
  readonly #passthrough: readonly PassthroughModel[];

  constructor(options: FusionBackendOptions) {
    this.#stepUrl = options.stepUrl;
    this.#runPanels = options.runPanels;
    this.defaultModel = options.defaultModel;
    this.#judgeModel = options.judgeModel;
    this.#ttlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#panelTimeoutMs = options.panelTimeoutMs ?? DEFAULT_PANEL_TIMEOUT_MS;
    this.#stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    this.#mintTraceId = options.mintTraceId ?? newTraceId;
    this.#passthrough = options.passthrough ?? [];
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
    const fusion = this.defaultModel ?? "fusion-panel";
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
   */
  async #proxyNative(
    target: PassthroughModel,
    chat: Record<string, unknown>,
    signal: AbortSignal | undefined,
    options: BackendRequestOptions
  ): Promise<Response> {
    const traceId = this.#mintTraceId();
    const spanId = newSpanId();
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
    if (options.modelCallId) headers["x-velum-model-call-id"] = options.modelCallId;
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
    return response;
  }

  async chat(body: unknown, signal?: AbortSignal, options: BackendRequestOptions = {}): Promise<Response> {
    const chat = (body ?? {}) as {
      model?: string;
      messages?: ChatMessageLike[];
      tools?: unknown;
      tool_choice?: unknown;
      stream?: boolean;
    };
    // Native model selected from the picker: proxy straight to its real provider
    // (the fusion panel + judge are skipped). Falling back to fusion is just
    // selecting the fused model again.
    const native = this.#passthroughFor(chat.model);
    if (native !== undefined) {
      return this.#proxyNative(native, chat as Record<string, unknown>, signal, options);
    }
    const messages = Array.isArray(chat.messages) ? chat.messages : [];
    const sessionKey = this.#sessionKey(messages);
    const session = this.#ensureSession(sessionKey);
    const streaming = chat.stream === true;

    const buildStepBody = (candidates: WireTrajectory[]): string => {
      const stepBody: Record<string, unknown> = {
        model: chat.model ?? this.defaultModel ?? "fusion-panel",
        messages,
        trajectories: candidates,
        stream: streaming
      };
      if (chat.tools !== undefined) stepBody.tools = chat.tools;
      if (chat.tool_choice !== undefined) stepBody.tool_choice = chat.tool_choice;
      if (this.#judgeModel !== undefined) stepBody.judge_model = this.#judgeModel;
      return JSON.stringify(stepBody);
    };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [TRACE_ID_HEADER]: session.traceId
    };
    if (options.modelCallId) headers["x-velum-model-call-id"] = options.modelCallId;

    // The judge step is a child span of the session: emit the full prompt sent to
    // the judge (the live conversation + candidate trajectories + tools) and the
    // judge's final output, so the companion app can show exactly what the judge
    // saw and produced.
    const judgeSpan = newSpanId();
    const traceEnabled = getTraceEmitter().isEnabled();
    const sessionTraceId = session.traceId;
    const sessionSpan = session.sessionSpan;
    const judgeModel = this.#judgeModel;
    // The user-turn index: a follow-up user message is a new turn, while the
    // harness's internal tool-loop continuations (which append assistant/tool
    // messages, not user ones) keep the same count and thus the same turn. The
    // panel runs once per turn, so each new user request is fused over fresh
    // candidates; the tool loop within a turn reuses them.
    const turn = messages.filter((message) => message.role === "user").length;
    const turnCandidates = this.#ensureTurnCandidates(session, sessionKey, turn, messages);
    const emitJudgeRequest = (candidates: WireTrajectory[]): void => {
      if (!traceEnabled) return;
      emitTrace({
        component: "judge",
        event_type: "judge.request",
        traceId: sessionTraceId,
        spanId: judgeSpan,
        parentSpanId: sessionSpan,
        payload: judgeRequestPayload({
          ...(judgeModel !== undefined ? { judgeModel } : {}),
          messages,
          trajectories: candidates,
          ...(chat.tools !== undefined ? { tools: chat.tools } : {}),
          ...(chat.tool_choice !== undefined ? { toolChoice: chat.tool_choice } : {}),
          trajectoryIds: candidates.map((candidate) => candidate.trajectory_id),
          turn
        })
      });
    };
    const emitJudgeFinal = (input: Parameters<typeof judgeFinalPayload>[0]): void => {
      if (!traceEnabled) return;
      emitTrace({
        component: "judge",
        event_type: "judge.final",
        traceId: sessionTraceId,
        spanId: judgeSpan,
        parentSpanId: sessionSpan,
        payload: judgeFinalPayload({ ...input, turn })
      });
    };
    // An intermediate tool-calling turn is NOT the final answer: the harness will
    // execute the tool calls and call back. Emit it as `judge.thinking` so the
    // companion app shows it as in-progress instead of marking the session done.
    const emitJudgeStep = (input: { content?: string; toolCalls?: unknown[]; usage?: unknown }): void => {
      if (!traceEnabled) return;
      const toolCallCount = input.toolCalls?.length ?? 0;
      const rawAnalysis =
        input.content !== undefined && input.content.length > 0
          ? input.content
          : `judge requested ${toolCallCount} tool call(s)`;
      emitTrace({
        component: "judge",
        event_type: "judge.thinking",
        traceId: sessionTraceId,
        spanId: judgeSpan,
        parentSpanId: sessionSpan,
        payload: judgeThinkingPayload({
          rawAnalysis,
          ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
          ...(input.usage !== undefined ? { usage: input.usage } : {}),
          turn
        })
      });
    };

    // Resolve the panel candidates (bounded), failing loudly so a panel crash or
    // an empty/all-failed candidate set never silently fuses into a blank answer.
    const resolveCandidates = async (): Promise<WireTrajectory[]> => {
      const candidates = await withTimeout(turnCandidates, this.#panelTimeoutMs, "fusion panel");
      if (!hasUsableCandidates(candidates)) {
        throw new Error(
          candidates.length === 0
            ? "fusion panel produced no candidates"
            : "fusion panel produced no usable candidates (every model failed)"
        );
      }
      return candidates;
    };

    // Non-streaming: the panel phase can block before the single JSON reply.
    if (!streaming) {
      let candidates: WireTrajectory[];
      try {
        candidates = await resolveCandidates();
      } catch (error) {
        this.#evictTurn(session, turn);
        console.error(`fusion: panel phase failed: ${errorText(error)}`);
        return jsonError(502, errorText(error));
      }
      emitJudgeRequest(candidates);
      const response = await fetch(this.#stepUrl, {
        method: "POST",
        headers,
        body: buildStepBody(candidates),
        signal: withDeadline(signal, this.#stepTimeoutMs)
      });
      if (traceEnabled) {
        // Capture the judge's output without consuming the piped response.
        const clone = response.clone();
        void (async () => {
          try {
            if (!clone.ok) {
              emitJudgeFinal({ httpStatus: clone.status, error: (await clone.text()).slice(0, 2000) });
              return;
            }
            const judged = (await clone.json()) as {
              choices?: Array<{ message?: { content?: string; tool_calls?: unknown }; finish_reason?: string }>;
              usage?: unknown;
            };
            const choice = judged.choices?.[0];
            const message = choice?.message;
            const content = typeof message?.content === "string" ? message.content : undefined;
            const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
            if (isTerminalJudgeStep(toolCalls, choice?.finish_reason)) {
              emitJudgeFinal({
                httpStatus: clone.status,
                ...(content !== undefined ? { content } : {}),
                ...(judged.usage !== undefined ? { usage: judged.usage } : {})
              });
            } else {
              emitJudgeStep({
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
      return response;
    }

    // Streaming: return immediately with a live SSE stream so the caller's HTTP
    // client sees the response start right away. The (potentially slow) panel
    // phase runs inside the stream behind keepalive comments, then the judge
    // step's SSE is piped through. This avoids first-byte timeouts in real CLIs
    // (e.g. codex) while the panel solves the task once. Because the 200 + SSE
    // headers are already sent, failures surface as a terminal error event.
    const stepUrl = this.#stepUrl;
    const stepSignal = withDeadline(signal, this.#stepTimeoutMs);
    const evictOnFailure = (): void => this.#evictTurn(session, turn);
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        let alive = true;
        let sseBuffer = "";
        const keepalive = setInterval(() => {
          if (alive) {
            try {
              controller.enqueue(encoder.encode(": keepalive\n\n"));
            } catch {
              alive = false;
            }
          }
        }, 3000);
        const fail = (message: string): void => {
          console.error(`fusion: ${message}`);
          evictOnFailure();
          controller.enqueue(encoder.encode(errorEvent(`fusion error: ${message}`)));
        };
        try {
          let candidates: WireTrajectory[];
          try {
            candidates = await resolveCandidates();
          } catch (error) {
            fail(errorText(error));
            return;
          }
          emitJudgeRequest(candidates);
          if (process.env.FUSION_DEBUG) {
            const toolNames = Array.isArray(chat.tools)
              ? chat.tools.map((t) => {
                  const tool = t as { type?: string; name?: string; function?: { name?: string } };
                  return tool.function?.name ?? tool.name ?? tool.type ?? "?";
                })
              : [];
            console.error(
              `[fusion-debug] step: messages=${messages.length} roles=${messages.map((m) => m.role).join(",")} ` +
                `candidates=${candidates.length} tools=[${toolNames.join(", ")}]`
            );
          }
          const upstream = await fetch(stepUrl, {
            method: "POST",
            headers,
            body: buildStepBody(candidates),
            signal: stepSignal
          });
          if (!upstream.ok || upstream.body === null) {
            const detail = upstream.body === null ? "no stream" : (await upstream.text()).slice(0, 800);
            emitJudgeFinal({ httpStatus: upstream.status, error: detail });
            fail(`trajectory:step ${upstream.status}: ${detail}`);
            return;
          }
          const reader = upstream.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value !== undefined) {
              controller.enqueue(value);
              if (traceEnabled) sseBuffer += decoder.decode(value, { stream: true });
            }
          }
          if (traceEnabled) {
            const assembled = assembleSseContent(sseBuffer);
            if (isTerminalJudgeStep(assembled.toolCalls, assembled.finishReason)) {
              emitJudgeFinal({
                httpStatus: upstream.status,
                ...(assembled.content.length > 0 ? { content: assembled.content } : {}),
                ...(assembled.usage !== undefined ? { usage: assembled.usage } : {})
              });
            } else {
              emitJudgeStep({
                ...(assembled.content.length > 0 ? { content: assembled.content } : {}),
                toolCalls: assembled.toolCalls,
                ...(assembled.usage !== undefined ? { usage: assembled.usage } : {})
              });
            }
          }
        } catch (error) {
          emitJudgeFinal({ error: errorText(error) });
          fail(errorText(error));
        } finally {
          alive = false;
          clearInterval(keepalive);
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
    for (const [key, session] of this.#sessions) {
      if (now - session.createdAt >= this.#ttlMs) this.#sessions.delete(key);
    }
  }

  /** Establish (or reuse) the per-conversation session identity. No panel runs here. */
  #ensureSession(sessionKey: string): Session {
    const now = Date.now();
    this.#sweepExpired(now);
    const existing = this.#sessions.get(sessionKey);
    if (existing !== undefined && now - existing.createdAt < this.#ttlMs) return existing;

    const session: Session = {
      traceId: this.#mintTraceId(),
      sessionSpan: newSpanId(),
      turns: new Map(),
      createdAt: now
    };
    this.#sessions.set(sessionKey, session);
    return session;
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
    messages: ChatMessageLike[]
  ): Promise<WireTrajectory[]> {
    const existing = session.turns.get(turn);
    if (existing !== undefined) return existing;

    const candidates = this.#runPanels({
      task: this.#task(messages),
      messages,
      traceId: session.traceId,
      sessionSpanId: session.sessionSpan,
      sessionKey,
      turn
    });
    session.turns.set(turn, candidates);
    candidates.catch((error: unknown) => {
      console.error(`fusion: panel run failed for session ${sessionKey} turn ${turn}: ${errorText(error)}`);
      if (session.turns.get(turn) === candidates) session.turns.delete(turn);
    });
    return candidates;
  }
}
