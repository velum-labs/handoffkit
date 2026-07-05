/**
 * Fusion Harness Gateway CLI wiring. Builds the front-door runner that turns a
 * single tool prompt into a unified HandoffKit/FusionKit harness ensemble run,
 * and exposes it over the provider wire protocols (Codex Responses, Claude
 * Messages, Cursorkit chat), the generic ACP local agent, and the unified
 * front-door acceptance suite.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  createKernelFuseStepRunner,
  runFusionPanels,
  runUnifiedHarnessE2E
} from "@fusionkit/ensemble";
import type {
  EnsembleModel,
  FusedSubagentAccess,
  PanelTrust,
  UnifiedHarnessE2EResult,
  UnifiedHarnessKind
} from "@fusionkit/ensemble";
import type { ResumeCursor } from "@fusionkit/harness-core";
import {
  emitTrace,
  newSpanId,
  newTraceId,
  normalizeWireTrajectories
} from "@fusionkit/protocol";
import {
  FusionBackend,
  installAcpAdapters,
  runAcpAgent,
  runFrontDoorAcceptance,
  startFusionGateway,
  startGateway
} from "@fusionkit/model-gateway";
import type {
  AcpRunner,
  ChatMessageLike,
  FrontDoorRunner,
  FrontDoorRunnerResult,
  FusionGateway,
  Gateway,
  LocalComputePricing,
  ModelPricing,
  NarrationWriter,
  OnRateLimitPolicy,
  PanelRunner,
  PassthroughModel,
  SessionMetaInput,
  SessionStore,
  WireTrajectory
} from "@fusionkit/model-gateway";
import { uiStream } from "@fusionkit/cli-ui";
import { FUSION_PANEL_MODEL, harnessDriversEnabled, trimTrailingSlashes } from "@fusionkit/tools";
import { buildCursorAcpProducer } from "@fusionkit/tool-cursor";
import { PROMPT_CONFIG_KEY } from "./fusion-config.js";
import type { PromptOverrides } from "./fusion-config.js";
import { toolRegistry } from "./tools.js";

/**
 * One named ensemble as the gateway routes it: the advertised fused model id,
 * the panel members that fan out for it, the judge/synthesizer router endpoint
 * ids sent on the fuse step, the judge's model name (WS7 cost attribution),
 * and its prompt overrides.
 */
export type GatewayEnsembleConfig = {
  name: string;
  /** Advertised gateway model id (`fusion-panel` / `fusion-<name>`). */
  modelId: string;
  models: EnsembleModel[];
  /** Router endpoint id the fuse step's `judge_model` routes to. */
  judgeEndpointId: string;
  /** The judge's provider model name (cost attribution + narration). */
  judgeModelName: string;
  synthesizerEndpointId?: string;
  prompts?: PromptOverrides;
};

export type GatewayRunnerConfig = {
  fusionBackendUrl: string;
  repo: string;
  outputRoot: string;
  harnesses: UnifiedHarnessKind[];
  /** The union of panel members across every ensemble. */
  models: EnsembleModel[];
  /**
   * Named ensembles, session-default first. Each registers as its own fused
   * model; a request to it fans out only its members. When unset, `models` is
   * the one implicit ensemble behind the default fused model.
   */
  ensembles?: GatewayEnsembleConfig[];
  command?: string;
  timeoutMs?: number;
  /**
   * Wall-clock budget for the whole panel phase before the turn fails (and the
   * in-flight candidates are aborted). Defaults to the backend's 15 minutes.
   */
  panelTimeoutMs?: number;
  /**
   * Straggler policy: once the first candidate succeeds, still-running siblings
   * get this much longer before being aborted and settled as failed, so one
   * stuck model cannot hold a finished sibling's result hostage until the panel
   * timeout. Default 10 minutes (long-running members are often the strongest
   * ones); set 0 to disable (wait for every candidate).
   */
  stragglerGraceMs?: number;
  judgeModel?: string;
  fusionApiKey?: string;
  modelEndpoints?: Record<string, string>;
  /** WS5 rate-limit / credit failover policy for vendor passthrough models. */
  onRateLimit?: OnRateLimitPolicy;
  /** WS7 budget cap (USD) for the session's gateway-observed cost. */
  budgetUsd?: number;
  /** Per-model token pricing overrides. */
  pricing?: Readonly<Record<string, ModelPricing>>;
  /** Per-model local compute pricing overrides. */
  localCompute?: Readonly<Record<string, LocalComputePricing>>;
  /** Model names / endpoint ids of panel members running on local compute (MLX). */
  localModels?: readonly string[];
  /** WS4 durable session store; when set the gateway persists/resumes sessions. */
  sessionStore?: SessionStore;
  /** WS4 resume target id bound to the first conversation this gateway serves. */
  resumeId?: string;
  /** WS4 static session header (tool/repo/panel) persisted on session creation. */
  sessionMeta?: SessionMetaInput;
  /**
   * When true, panel members are told which member they are and are given the
   * launched tool's own system/custom instructions (not just the bare request).
   * Default off (per-member identity reduces inter-member decorrelation).
   */
  panelIdentity?: boolean;
  /**
   * Panel candidate trust level; unset means `full` (maximum autonomy — e.g.
   * Codex `danger-full-access`). `guarded` keeps each harness's
   * side-effects-derived confinement.
   */
  panelTrust?: PanelTrust;
  /**
   * Enable same-model sub-agents inside panel members (a member may
   * parallelize its own work; children reuse its model/endpoint). Default on;
   * `--no-subagents` / `subagents: false` turns it off.
   */
  subagents?: boolean;
  /**
   * Reasoning traces: narrate panel/judge progress into a streaming fused
   * turn's response (rendered by the tool's native thinking UI). Default on.
   */
  reasoningTraces?: boolean;
  /** Optional narration prose writer (any chat-capable model); advisory only. */
  narrationWriter?: NarrationWriter;
};

/**
 * Default straggler grace window: once the first panel candidate succeeds,
 * still-running siblings get this much longer before they are dropped.
 *
 * Sized generously (10 minutes) because slower panel members are often the
 * stronger ones: a fast, shallow first finisher must not evict a deliberate
 * sibling that is still doing useful work. Real-trace calibration: qwen3
 * answered a docs-analysis turn in 27s while kimi-k2 took 4m to produce the
 * better candidate (and 10m18s for a full implementation turn) — a short
 * window would have dropped kimi. The hard `panelTimeoutMs` (default 15m)
 * still bounds the whole phase, so the grace window only trades tail
 * latency, never unbounded hangs.
 */
const DEFAULT_STRAGGLER_GRACE_MS = 600_000;

/** Join the system-role messages (the launched tool's harness/custom prompt). */
function harnessSystemFromMessages(messages: readonly ChatMessageLike[]): string | undefined {
  const parts = messages
    .filter((message) => message.role === "system")
    .map((message) => messageText(message.content))
    .filter((text) => text.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Flatten OpenAI message content (string or content parts) into plain text. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : ""
      )
      .join("");
  }
  return "";
}

// Once an interactive coding agent owns the terminal, the per-turn panel chatter
// would corrupt its full-screen TUI. The launcher flips this off before handing
// over; trace events (for --observe) keep flowing regardless.
let gatewayChatter = true;

/** Enable/disable the gateway's per-turn stderr chatter (default on). */
export function setGatewayChatter(enabled: boolean): void {
  gatewayChatter = enabled;
}

/**
 * A phase of a fused turn, for out-of-band status (e.g. the terminal title)
 * while a coding agent owns the screen and the line chatter is off. `idle`
 * means the turn's panel phase finished (or failed).
 */
export type GatewayTurnStatus =
  | { phase: "panel"; models: string[]; turn: number }
  | { phase: "judging"; candidates: number; turn: number }
  | { phase: "idle" };

// The launcher installs a sink that renders these somewhere that cannot corrupt
// the agent's TUI (the terminal title). Distinct from `gatewayChatter`, which is
// in-band stderr lines.
let gatewayStatusSink: ((status: GatewayTurnStatus) => void) | undefined;

/** Install (or clear, with undefined) the out-of-band per-turn status sink. */
export function setGatewayStatusSink(sink: ((status: GatewayTurnStatus) => void) | undefined): void {
  gatewayStatusSink = sink;
}

function emitGatewayStatus(status: GatewayTurnStatus): void {
  try {
    gatewayStatusSink?.(status);
  } catch {
    // A broken status sink must never fail a turn.
  }
}

function mapStatus(status: string): FrontDoorRunnerResult["status"] {
  if (status === "succeeded") return "succeeded";
  if (status === "skipped") return "skipped";
  return "failed";
}

function summarize(report: UnifiedHarnessE2EResult, primary: UnifiedHarnessKind): FrontDoorRunnerResult {
  const row = report.results.find((entry) => entry.harness === primary) ?? report.results[0];
  const ensemble = row?.ensemble;
  const finalOutput =
    ensemble?.judgeSynthesisRecord?.final_output ??
    ensemble?.harnessRunResult.output_summary ??
    row?.message ??
    "";
  const evidence: string[] = [];
  if (ensemble !== undefined) {
    if (ensemble.artifacts.some((artifact) => artifact.kind === "patch")) {
      evidence.push("patch_artifact");
    }
    if (ensemble.toolRecords.length > 0) evidence.push("tool_execution");
    if (ensemble.judgeSynthesisRecord !== undefined) evidence.push("judge_synthesis");
  }
  return {
    finalOutput,
    runId: report.id,
    status: mapStatus(row?.status ?? "failed"),
    evidence,
    ...(report.reportPath !== undefined ? { reportPath: report.reportPath } : {})
  };
}

export function buildFrontDoorRunner(config: GatewayRunnerConfig): FrontDoorRunner {
  return async (input) => {
    const traceId = input.traceId;
    const sessionSpan = newSpanId();
    emitTrace({
      component: "gateway",
      event_type: "session.started",
      traceId,
      spanId: sessionSpan,
      payload: {
        request_id: input.requestId,
        dialect: input.dialect,
        prompt_preview: input.prompt.slice(0, 600),
        environment: {
          repo: config.repo,
          fusion_backend_url: config.fusionBackendUrl,
          harnesses: config.harnesses,
          judge_model: config.judgeModel ?? null,
          models: config.models.map((model) => ({
            id: model.id,
            model: model.model,
            ...(model.endpointId !== undefined ? { endpoint_id: model.endpointId } : {})
          })),
          ...(config.modelEndpoints !== undefined ? { model_endpoints: config.modelEndpoints } : {})
        }
      }
    });
    try {
      const report = await runUnifiedHarnessE2E({
        id: `gateway_${input.requestId}`,
        fusionBackendUrl: config.fusionBackendUrl,
        repo: config.repo,
        outputRoot: join(config.outputRoot, input.requestId),
        prompt: input.prompt,
        harnesses: config.harnesses,
        models: config.models,
        traceId,
        ...(config.command !== undefined ? { command: config.command } : {}),
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
        ...(config.judgeModel !== undefined ? { judgeModel: config.judgeModel } : {}),
        ...(config.fusionApiKey !== undefined ? { fusionApiKey: config.fusionApiKey } : {}),
        ...(config.modelEndpoints !== undefined ? { modelEndpoints: config.modelEndpoints } : {})
      });
      const summary = summarize(report, config.harnesses[0] ?? "command");
      emitTrace({
        component: "gateway",
        event_type: "session.finished",
        traceId,
        spanId: sessionSpan,
        payload: {
          status: summary.status,
          run_id: summary.runId,
          evidence: summary.evidence,
          final_output_preview: summary.finalOutput.slice(0, 600),
          ...(summary.reportPath !== undefined ? { report_path: summary.reportPath } : {})
        }
      });
      return summary;
    } catch (error) {
      emitTrace({
        component: "gateway",
        event_type: "session.finished",
        traceId,
        spanId: sessionSpan,
        payload: { status: "failed", error: error instanceof Error ? error.message : String(error) }
      });
      throw error;
    }
  };
}

export function buildAcpRunner(config: GatewayRunnerConfig): AcpRunner {
  const front = buildFrontDoorRunner(config);
  return async (input) => {
    const result = await front({
      dialect: "openai-chat",
      prompt: input.prompt,
      requestedModel: undefined,
      requestId: input.requestId,
      traceId: newTraceId()
    });
    return {
      finalOutput: result.finalOutput,
      runId: result.runId,
      status: result.status,
      evidence: result.evidence
    };
  };
}

export function codexConfigSnippet(gatewayUrl: string): string {
  const setup = toolRegistry.get("codex")?.setupSnippet?.({ gatewayUrl });
  if (setup === undefined) {
    throw new Error("codex tool integration does not expose a setup snippet");
  }
  return setup.split("\n").slice(1).join("\n");
}

export function gatewaySetupSnippets(gatewayUrl: string, cursorKitNote: string): string {
  const toolSnippets = toolRegistry
    .list()
    .flatMap((tool) => {
      const snippet = tool.setupSnippet?.({
        gatewayUrl,
        ...(tool.id === "cursor" ? { note: cursorKitNote } : {})
      });
      return snippet === undefined ? [] : [snippet];
    });
  const acpAdapterIds = toolRegistry
    .list()
    .map((tool) => tool.acpAdapterId)
    .filter((id): id is string => id !== undefined);
  return [
    "Front-door setup:",
    "",
    ...toolSnippets.flatMap((snippet) => [snippet, ""]),
    "",
    "Generic ACP local agent:",
    "  fusionkit ensemble gateway acp --fusion-backend <fusion-backend>",
    "",
    "ACP registry adapters:",
    `  fusionkit ensemble gateway acp-registry install ${acpAdapterIds.join(" ")}`
  ].join("\n");
}

/**
 * The judge-streamed-trajectory front door: the panel runs once per session to
 * produce candidate trajectories, then the judge acts as a streaming tool-calling
 * agent (FusionKit `trajectories:fuse`) whose trajectory the user's harness executes.
 * Built on the dialect-aware `startGateway` + a {@link FusionBackend}; iteration is
 * the harness's job (no verify/repair here).
 */
export async function startFusionStepGateway(input: {
  config: GatewayRunnerConfig;
  host: string;
  port: number;
  authToken?: string;
  defaultModel?: string;
}): Promise<Gateway> {
  const { config } = input;
  const base = trimTrailingSlashes(config.fusionBackendUrl);
  const stepUrl = `${base}/v1/fusion/trajectories:fuse`;
  const ensembles = config.ensembles ?? [];
  const defaultModel = input.defaultModel ?? ensembles[0]?.modelId ?? FUSION_PANEL_MODEL;
  // Per-ensemble member lookup for the panel runner, keyed by the advertised
  // fused model id the backend resolved the request to.
  const ensemblesByModelId = new Map(ensembles.map((ensemble) => [ensemble.modelId, ensemble]));

  // This gateway's own URL, known once it is listening (below). Panel members
  // get it as their fused sub-agent door: their harnesses route `fusion-*`
  // requests back here (stamped with the panel depth) so a member can spawn
  // sub-agents on any registered ensemble.
  let selfGatewayUrl: string | undefined;
  const fusedSubagentsFor = (panelDepth: number): FusedSubagentAccess | undefined => {
    // One level of fused delegation only: a member's fused sub-agent turn
    // (depth >= 1) fans out a plain panel whose members are same-model-only.
    if (panelDepth > 0) return undefined;
    if (config.subagents === false) return undefined;
    if (selfGatewayUrl === undefined || ensembles.length === 0) return undefined;
    return {
      gatewayUrl: selfGatewayUrl,
      ensembles: ensembles.map((ensemble) => ({
        name: ensemble.name,
        modelId: ensemble.modelId,
        memberIds: ensemble.models.map((model) => model.id),
        ...(ensemble.judgeModelName !== undefined ? { judgeModel: ensemble.judgeModelName } : {})
      })),
      defaultModelId: defaultModel,
      ...(input.authToken !== undefined ? { authToken: input.authToken } : {}),
      depth: panelDepth + 1
    };
  };

  // Native multi-turn: one resume-cursor map per conversation (keyed by
  // session), each holding a cursor per panel model. When the harness-driver
  // cutover flag is on, a follow-up turn resumes each member's native session
  // from these instead of re-prompting a fresh process. Legacy harnesses
  // ignore the map, so it is a no-op with the flag off.
  const driversEnabled = harnessDriversEnabled();
  const resumeCursorsBySession = new Map<string, Map<string, ResumeCursor>>();
  const resumeCursorsFor = (sessionKey: string): Map<string, ResumeCursor> => {
    let map = resumeCursorsBySession.get(sessionKey);
    if (map === undefined) {
      map = new Map<string, ResumeCursor>();
      resumeCursorsBySession.set(sessionKey, map);
    }
    return map;
  };

  const runPanels: PanelRunner = async ({
    task,
    messages,
    traceId,
    sessionSpanId,
    sessionKey,
    turn,
    ensembleModelId,
    excludeModelIds,
    panelDepth,
    signal
  }) => {
    // The resolved ensemble's members fan out (the union is only the router
    // surface); an unknown/absent ensemble id falls back to the full model list.
    const ensembleModels =
      ensembleModelId !== undefined
        ? (ensemblesByModelId.get(ensembleModelId)?.models ?? config.models)
        : config.models;
    // WS5 failover excludes the throttled vendor (by router endpoint id == panel
    // model id) so the ensemble fuses over the healthy survivors this turn.
    const panelModels =
      excludeModelIds === undefined || excludeModelIds.length === 0
        ? ensembleModels
        : ensembleModels.filter((model) => !excludeModelIds.includes(model.id));
    const ensembleJudge =
      ensembleModelId !== undefined
        ? ensemblesByModelId.get(ensembleModelId)?.judgeModelName
        : undefined;
    emitTrace({
      component: "gateway",
      event_type: "session.started",
      traceId,
      spanId: sessionSpanId,
      payload: {
        dialect: "fusion-step",
        prompt_preview: task.slice(0, 600),
        environment: {
          repo: config.repo,
          fusion_backend_url: config.fusionBackendUrl,
          harnesses: config.harnesses,
          ...(ensembleModelId !== undefined ? { ensemble_model_id: ensembleModelId } : {}),
          judge_model: ensembleJudge ?? config.judgeModel ?? null,
          models: panelModels.map((model) => ({
            id: model.id,
            model: model.model,
            ...(model.endpointId !== undefined ? { endpoint_id: model.endpointId } : {})
          })),
          ...(config.modelEndpoints !== undefined ? { model_endpoints: config.modelEndpoints } : {})
        }
      }
    });
    if (gatewayChatter) {
      const excluded =
        excludeModelIds !== undefined && excludeModelIds.length > 0
          ? ` (excluding ${excludeModelIds.join(", ")} after a vendor rate-limit)`
          : "";
      uiStream().write(
        `fusion: running panel (${panelModels.map((m) => m.id).join(", ")}) for session ${sessionKey}${excluded}...\n`
      );
    }
    emitGatewayStatus({ phase: "panel", models: panelModels.map((m) => m.id), turn });
    try {
      const harnessSystem =
        config.panelIdentity === true ? harnessSystemFromMessages(messages) : undefined;
      const wire = await runFusionPanels({
        id: `panels_${sessionKey}_t${turn}`,
        repo: config.repo,
        outputRoot: join(config.outputRoot, sessionKey, `t${turn}`),
        prompt: task,
        models: panelModels,
        harness: config.harnesses[0] ?? "agent",
        fusionBackendUrl: config.fusionBackendUrl,
        traceId,
        parentSpanId: sessionSpanId,
        turn,
        ...(config.modelEndpoints !== undefined ? { modelEndpoints: config.modelEndpoints } : {}),
        ...(config.fusionApiKey !== undefined ? { fusionApiKey: config.fusionApiKey } : {}),
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
        ...(signal !== undefined ? { signal } : {}),
        stragglerGraceMs: config.stragglerGraceMs ?? DEFAULT_STRAGGLER_GRACE_MS,
        ...(config.panelIdentity !== undefined ? { panelIdentity: config.panelIdentity } : {}),
        ...(config.panelTrust !== undefined ? { panelTrust: config.panelTrust } : {}),
        ...(config.subagents !== undefined ? { subagents: config.subagents } : {}),
        ...((): { fusedSubagents?: FusedSubagentAccess } => {
          const fusedSubagents = fusedSubagentsFor(panelDepth ?? 0);
          return fusedSubagents !== undefined ? { fusedSubagents } : {};
        })(),
        ...(harnessSystem !== undefined ? { harnessSystem } : {}),
        ...(driversEnabled ? { resumeCursors: resumeCursorsFor(sessionKey) } : {})
      });
      const trajectories = normalizeWireTrajectories(wire);
      if (gatewayChatter) {
        uiStream().write(
          `fusion: panel produced ${trajectories.length} candidate trajectories ` +
            `(${trajectories.map((t) => `${t.model_id}:${t.status}`).join(", ")})\n`
        );
      }
      emitGatewayStatus({ phase: "judging", candidates: trajectories.length, turn });
      return trajectories;
    } catch (error) {
      uiStream().write(`fusion: panel run failed: ${error instanceof Error ? error.message : String(error)}\n`);
      emitGatewayStatus({ phase: "idle" });
      throw error;
    }
  };

  // Expose every panel model as a native passthrough alongside the fused model,
  // so the tool's picker can switch to a vendor model (and back to fusion). Each
  // routes to its `fusionkit serve` router endpoint, which already calls the
  // real provider with the reused subscription/API credentials.
  const passthrough: PassthroughModel[] =
    config.modelEndpoints === undefined
      ? []
      : config.models.flatMap((model) => {
          const endpointUrl = config.modelEndpoints?.[model.id];
          return endpointUrl === undefined
            ? []
            : [{ modelId: model.model, endpointId: model.id, endpointUrl }];
        });

  // Each named ensemble is advertised as its own fused model. The route carries
  // what a fused turn for it needs: which members fan out (checked by the panel
  // runner above), the judge/synthesizer router endpoint ids for the fuse step,
  // the judge model name for cost/narration, and its prompt overrides (wire keys
  // per PROMPT_CONFIG_KEY, ready to POST).
  const fusedModels = ensembles.map((ensemble) => ({
    modelId: ensemble.modelId,
    name: ensemble.name,
    memberEndpointIds: ensemble.models.map((model) => model.id),
    judgeEndpointId: ensemble.judgeEndpointId,
    judgeModelName: ensemble.judgeModelName,
    ...(ensemble.synthesizerEndpointId !== undefined
      ? { synthesizerEndpointId: ensemble.synthesizerEndpointId }
      : {}),
    ...(ensemble.prompts !== undefined
      ? {
          prompts: Object.fromEntries(
            Object.entries(ensemble.prompts).map(([id, text]) => [
              PROMPT_CONFIG_KEY[id as keyof typeof PROMPT_CONFIG_KEY],
              text
            ])
          )
        }
      : {})
  }));

  // FusionBackend is itself kernel-native: every request is dispatched through
  // `FusionRuntime` as the `fusion-frontdoor-request` graph (routing into the
  // `fusion-frontdoor-turn` graph), and the fuse step runs through
  // `createKernelFuseStepRunner`. No outer `KernelBackend` wrapper is needed here
  // (that would only re-wrap the already-kernel-owned turn in a redundant single node).
  const backend = new FusionBackend({
    stepUrl,
    runPanels,
    runFuseStep: createKernelFuseStepRunner(),
    defaultModel,
    ...(fusedModels.length > 0 ? { fusedModels } : {}),
    passthrough,
    ...(config.onRateLimit !== undefined ? { onRateLimit: config.onRateLimit } : {}),
    ...(config.panelTimeoutMs !== undefined ? { panelTimeoutMs: config.panelTimeoutMs } : {}),
    ...(config.budgetUsd !== undefined ? { budgetUsd: config.budgetUsd } : {}),
    ...(config.pricing !== undefined ? { pricing: config.pricing } : {}),
    ...(config.localCompute !== undefined ? { localCompute: config.localCompute } : {}),
    ...(config.localModels !== undefined ? { localModels: config.localModels } : {}),
    ...(config.reasoningTraces !== undefined ? { reasoningTraces: config.reasoningTraces } : {}),
    ...(config.narrationWriter !== undefined ? { narrationWriter: config.narrationWriter } : {}),
    // WS7 cost attribution: a fused turn's gateway-observed `usage` is the
    // judge/synthesis call's, so price it against the configured judge model
    // name (distinct from routing — see the judge_model note below). Where the
    // judge is unset/unpriced the fused turn is reported `unknown_cost`.
    ...(config.judgeModel !== undefined ? { costModel: config.judgeModel } : {}),
    ...(config.sessionStore !== undefined ? { store: config.sessionStore } : {}),
    ...(config.resumeId !== undefined ? { resumeId: config.resumeId } : {}),
    ...(config.sessionMeta !== undefined ? { sessionMeta: config.sessionMeta } : {})
    // judge_model is intentionally NOT forwarded here: `config.judgeModel` is the
    // provider model name, but the router (and trajectories:fuse) route by endpoint
    // id. The Python fuse path already resolves the configured judge endpoint via
    // config.resolved_judge_model, so omitting this keeps routing correct while
    // the judge gap-analysis still runs on the configured judge.
  });
  const gateway = await startGateway({
    backend,
    host: input.host,
    port: input.port,
    ...(input.authToken !== undefined ? { authToken: input.authToken } : {})
  });
  selfGatewayUrl = gateway.url();
  return gateway;
}

export async function startConfiguredGateway(input: {
  config: GatewayRunnerConfig;
  host: string;
  port: number;
  authToken?: string;
  defaultModel?: string;
}): Promise<FusionGateway> {
  return await startFusionGateway({
    runner: buildFrontDoorRunner(input.config),
    host: input.host,
    port: input.port,
    ...(input.authToken !== undefined ? { authToken: input.authToken } : {}),
    ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel } : {})
  });
}

export async function runGatewayAcp(config: GatewayRunnerConfig): Promise<void> {
  await runAcpAgent({ runner: buildAcpRunner(config) });
}

export type GatewayAcceptanceInput = {
  config: GatewayRunnerConfig;
  sentinel: string;
  host: string;
  outPath: string;
};

export async function runGatewayAcceptance(input: GatewayAcceptanceInput): Promise<{
  reportPath: string;
  failed: boolean;
}> {
  const gateway = await startConfiguredGateway({
    config: input.config,
    host: input.host,
    port: 0
  });
  try {
    const cursorAcp = buildCursorAcpProducer({
      gatewayUrl: gateway.url(),
      sentinel: input.sentinel,
      repo: input.config.repo,
      ...(input.config.models[0]?.id !== undefined
        ? { modelName: input.config.models[0].id }
        : {}),
      ...(input.config.timeoutMs !== undefined ? { timeoutMs: input.config.timeoutMs } : {})
    });
    const report = await runFrontDoorAcceptance({
      gatewayUrl: gateway.url(),
      sentinel: input.sentinel,
      acpRunner: buildAcpRunner(input.config),
      ...(cursorAcp !== undefined ? { cursorAcp } : {})
    });
    mkdirSync(resolve(input.outPath, ".."), { recursive: true });
    writeFileSync(input.outPath, JSON.stringify(report, null, 2) + "\n");
    const failed = report.front_doors.some((door) => door.status === "failed");
    return { reportPath: input.outPath, failed };
  } finally {
    await gateway.close();
  }
}

export async function installRegistryAdapters(input: {
  agentIds: string[];
  installDir: string;
}): Promise<string[]> {
  const installed = await installAcpAdapters({
    agentIds: input.agentIds,
    installDir: input.installDir
  });
  return installed.map((adapter) => `${adapter.id}@${adapter.version} -> ${adapter.metadataPath}`);
}
