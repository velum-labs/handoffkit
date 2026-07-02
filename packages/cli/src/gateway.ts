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
  UnifiedHarnessE2EResult,
  UnifiedHarnessKind
} from "@fusionkit/ensemble";
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
  OnRateLimitPolicy,
  PanelRunner,
  PassthroughModel,
  SessionMetaInput,
  SessionStore,
  WireTrajectory
} from "@fusionkit/model-gateway";

import { buildCursorAcpProducer } from "./cursor-acp.js";

export type GatewayRunnerConfig = {
  fusionBackendUrl: string;
  repo: string;
  outputRoot: string;
  harnesses: UnifiedHarnessKind[];
  models: EnsembleModel[];
  command?: string;
  timeoutMs?: number;
  judgeModel?: string;
  fusionApiKey?: string;
  modelEndpoints?: Record<string, string>;
  /** WS5 rate-limit / credit failover policy for vendor passthrough models. */
  onRateLimit?: OnRateLimitPolicy;
  /** WS7 budget cap (USD) for the session's gateway-observed cost. */
  budgetUsd?: number;
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
   * Reasoning traces: narrate panel/judge progress into a streaming fused
   * turn's response (rendered by the tool's native thinking UI). Default on.
   */
  reasoningTraces?: boolean;
};

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
  const base = gatewayUrl.replace(/\/+$/, "");
  return [
    "# ~/.codex/config.toml (or a temporary CODEX_HOME)",
    `model = "fusion-panel"`,
    `model_provider = "fusion-gateway"`,
    "",
    "[model_providers.fusion-gateway]",
    `name = "Fusion Harness Gateway"`,
    `base_url = "${base}/v1"`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`
  ].join("\n");
}

export function gatewaySetupSnippets(gatewayUrl: string, cursorKitNote: string): string {
  const base = gatewayUrl.replace(/\/+$/, "");
  return [
    "Front-door setup:",
    "",
    "Codex (OpenAI Responses):",
    codexConfigSnippet(gatewayUrl),
    "",
    "Claude Code (Anthropic Messages); Claude appends /v1/messages, so use the gateway root:",
    `  ANTHROPIC_BASE_URL=${base}`,
    `  ANTHROPIC_AUTH_TOKEN=local`,
    "",
    "Cursor (via Cursorkit backend):",
    `  cursor-agent --endpoint ${cursorKitNote} --model fusion-panel`,
    `  Cursorkit model backend: ${base}/v1/chat/completions`,
    "",
    "Generic ACP local agent:",
    "  fusionkit ensemble gateway acp --fusion-backend <fusion-backend>",
    "",
    "ACP registry adapters:",
    "  fusionkit ensemble gateway acp-registry install codex-cli claude-agent"
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
  const base = config.fusionBackendUrl.replace(/\/+$/, "");
  const stepUrl = `${base}/v1/fusion/trajectories:fuse`;
  const defaultModel = input.defaultModel ?? "fusion-panel";

  const runPanels: PanelRunner = async ({
    task,
    messages,
    traceId,
    sessionSpanId,
    sessionKey,
    turn,
    excludeModelIds
  }) => {
    // WS5 failover excludes the throttled vendor (by router endpoint id == panel
    // model id) so the ensemble fuses over the healthy survivors this turn.
    const panelModels =
      excludeModelIds === undefined || excludeModelIds.length === 0
        ? config.models
        : config.models.filter((model) => !excludeModelIds.includes(model.id));
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
          judge_model: config.judgeModel ?? null,
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
      console.error(
        `fusion: running panel (${panelModels.map((m) => m.id).join(", ")}) for session ${sessionKey}${excluded}...`
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
        ...(config.panelIdentity !== undefined ? { panelIdentity: config.panelIdentity } : {}),
        ...(harnessSystem !== undefined ? { harnessSystem } : {})
      });
      const trajectories = normalizeWireTrajectories(wire);
      if (gatewayChatter) {
        console.error(
          `fusion: panel produced ${trajectories.length} candidate trajectories ` +
            `(${trajectories.map((t) => `${t.model_id}:${t.status}`).join(", ")})`
        );
      }
      emitGatewayStatus({ phase: "judging", candidates: trajectories.length, turn });
      return trajectories;
    } catch (error) {
      console.error(`fusion: panel run failed: ${error instanceof Error ? error.message : String(error)}`);
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
    passthrough,
    ...(config.onRateLimit !== undefined ? { onRateLimit: config.onRateLimit } : {}),
    ...(config.budgetUsd !== undefined ? { budgetUsd: config.budgetUsd } : {}),
    ...(config.reasoningTraces !== undefined ? { reasoningTraces: config.reasoningTraces } : {}),
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
  return await startGateway({
    backend,
    host: input.host,
    port: input.port,
    ...(input.authToken !== undefined ? { authToken: input.authToken } : {})
  });
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
