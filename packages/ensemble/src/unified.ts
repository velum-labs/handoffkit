import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { JsonValue, ModelFusionStatus } from "@fusionkit/protocol";
import type { WireTrajectory } from "@fusionkit/protocol";
import { newSpanId, TRACE_ID_HEADER, TRACE_SPAN_HEADER } from "@fusionkit/protocol";
import { gitText } from "@fusionkit/workspace";

import { createAgentHarness } from "./agent.js";
import { createCommandHarness } from "./command.js";
import { resolveCursorkitCli } from "./cursorkit-path.js";
import { createMockHarness } from "./mock.js";
import { PanelGenerateOperator } from "./fusion-operators.js";
import { runEnsemble } from "./run.js";
import { FusionRuntime, StaticDAGScheduler, createArtifact } from "./runtime.js";
import type { RuntimeExecutionResult } from "./runtime.js";
import type {
  EnsembleDescriptor,
  EnsembleModel,
  EnsembleRunResult,
  HarnessAdapter,
  HarnessArtifact,
  HarnessEndReason,
  HarnessTrajectory,
  TrajectoryStep
} from "./harness.js";
import type {
  JudgeCandidateEvidence,
  JudgeInput,
  JudgeSynthesisOutput,
  JudgeSynthesizer
} from "./judge.js";

export type UnifiedHarnessKind =
  | "mock"
  | "command"
  | "agent"
  | "codex"
  | "claude-code"
  | "cursor-acp"
  | "cursor-desktop";

/**
 * Trust level for unattended panel candidates. `full` (the default) gives each
 * member the highest autonomy its harness offers (e.g. Codex
 * `danger-full-access`); `guarded` keeps the harness's side-effects-derived
 * confinement (e.g. Codex `workspace-write`, fenced to the worktree).
 */
export type PanelTrust = "full" | "guarded";

/**
 * Options the unified runner passes to a tool's harness factory. The per-tool
 * packages map these onto their own harness options (provider base URL, etc.).
 */
export type ToolHarnessResolveOptions = {
  fusionBackendUrl: string;
  fusionApiKey?: string;
  timeoutMs?: number;
  /**
   * Per-model router endpoints keyed by `EnsembleModel.id`. When a candidate's
   * model id is present, its harness is pointed at that endpoint (and requests
   * the endpoint id as its model) instead of the shared `fusionBackendUrl`, so
   * each panel model backs its own routed candidate through the one launched
   * harness.
   */
  modelEndpoints?: Record<string, string>;
  /**
   * Observability correlation passed to the tool harness so it can emit
   * per-candidate trace events (`harness.candidate.*`, `trajectory.step`) under
   * the session, mirroring the agent harness. Unset outside a traced run.
   */
  traceId?: string;
  parentSpanId?: string;
  turn?: number;
  /** When true, the tool harness tells its model which panel member it is. */
  panelIdentity?: boolean;
  /** Panel candidate trust level; unset means `full` (maximum autonomy). */
  panelTrust?: PanelTrust;
};

/**
 * Provides everything ensemble needs about a tool-backed harness kind (codex,
 * claude-code, cursor-*) without ensemble depending on any per-tool package. The
 * fusionkit CLI registers one (built from its tool registry) via
 * {@link setToolHarnessProvider}; without it, requesting a tool harness kind
 * throws a clear error.
 */
export type ToolHarnessProvider = {
  adapter(kind: UnifiedHarnessKind, options: ToolHarnessResolveOptions): HarnessAdapter;
  sideEffects(kind: UnifiedHarnessKind): EnsembleDescriptor["policy"]["sideEffects"];
  responseShape(kind: UnifiedHarnessKind): string;
};

let toolHarnessProvider: ToolHarnessProvider | undefined;

/**
 * Register the provider that resolves tool-backed harness kinds. The fusionkit
 * CLI wires this at startup from its tool registry.
 */
export function setToolHarnessProvider(provider: ToolHarnessProvider | undefined): void {
  toolHarnessProvider = provider;
}

function requireToolHarnessProvider(kind: UnifiedHarnessKind): ToolHarnessProvider {
  if (toolHarnessProvider === undefined) {
    throw new Error(
      `no tool harness provider registered for harness kind "${kind}"; ` +
        "the fusionkit CLI wires this via setToolHarnessProvider (build the tool registry first)."
    );
  }
  return toolHarnessProvider;
}

function resolveToolAdapter(
  kind: UnifiedHarnessKind,
  options: UnifiedHarnessE2EOptions
): HarnessAdapter {
  return requireToolHarnessProvider(kind).adapter(kind, {
    fusionBackendUrl: normalizeFusionBackendUrl(options.fusionBackendUrl),
    ...(options.fusionApiKey !== undefined ? { fusionApiKey: options.fusionApiKey } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.modelEndpoints !== undefined ? { modelEndpoints: options.modelEndpoints } : {}),
    ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
    ...(options.parentSpanId !== undefined ? { parentSpanId: options.parentSpanId } : {}),
    ...(options.turn !== undefined ? { turn: options.turn } : {}),
    ...(options.panelIdentity !== undefined ? { panelIdentity: options.panelIdentity } : {}),
    ...(options.panelTrust !== undefined ? { panelTrust: options.panelTrust } : {})
  });
}

export type UnifiedHarnessMatrixResult = {
  harness: UnifiedHarnessKind;
  modelIds: string[];
  status: ModelFusionStatus;
  message: string;
  ensemble?: EnsembleRunResult;
  artifacts: Record<string, string>;
  details: Record<string, JsonValue>;
};

export type UnifiedHarnessE2EResult = {
  id: string;
  generatedAt: string;
  fusionBackendUrl: string;
  repo: string;
  results: UnifiedHarnessMatrixResult[];
  reportPath?: string;
};

export type CursorHarnessRunnerInput = {
  kind: Extract<UnifiedHarnessKind, "cursor-acp" | "cursor-desktop">;
  model: EnsembleModel;
  fusionBackendUrl: string;
  repo: string;
  outDir: string;
  timeoutMs?: number;
};

export type CursorHarnessRunnerResult = {
  status: ModelFusionStatus;
  message: string;
  artifacts?: Record<string, string>;
  details?: Record<string, JsonValue>;
};

export type UnifiedHarnessE2EOptions = {
  id?: string;
  fusionBackendUrl: string;
  fusionApiKey?: string;
  repo: string;
  outputRoot: string;
  prompt: string;
  harnesses: UnifiedHarnessKind[];
  models: EnsembleModel[];
  command?: string;
  timeoutMs?: number;
  /** Aborts the whole run (all candidates); see EnsembleDescriptor.signal. */
  signal?: AbortSignal;
  /** Straggler grace window after the first success; see EnsemblePolicy.stragglerGraceMs. */
  stragglerGraceMs?: number;
  judgeModel?: string;
  cursorRunner?: (input: CursorHarnessRunnerInput) => Promise<CursorHarnessRunnerResult>;
  /**
   * Per-candidate model backend URLs keyed by `EnsembleModel.id`. When a
   * candidate's model id is present, its command harness is pointed at that
   * endpoint instead of the shared `fusionBackendUrl`, so each panel model can
   * back its own real candidate (e.g. a local MLX trio).
   */
  modelEndpoints?: Record<string, string>;
  /**
   * Observability correlation id. When set, the agent harness, panel-model
   * calls, and the FusionKit trajectory synthesis are all tagged with this
   * trace so the companion app can reconstruct one session.
   */
  traceId?: string;
  /** Session root span; panel candidate spans parent under it. */
  parentSpanId?: string;
  /** User-turn index this panel run belongs to (stamped on candidate events). */
  turn?: number;
  /** When true, each harness tells its model which panel member it is (see FusionPanelOptions). */
  panelIdentity?: boolean;
  /** Panel candidate trust level; unset means `full` (maximum autonomy). */
  panelTrust?: PanelTrust;
};

function normalizeFusionBackendUrl(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

/**
 * The minimal text fusionkit adds to a panel run when panel identity is off: a
 * single line telling the model it is one member of a FusionKit panel. Everything
 * else (tools + system context) is pass-through from the launched harness.
 */
const PANEL_MEMBER_SUFFIX =
  "(You are one model in a FusionKit panel answering this task independently.)";

/**
 * Fixed agent-loop contract appended to every panel candidate's prompt. Panel
 * candidates run unattended in disposable worktrees where nobody can answer a
 * question, yet smaller models routinely end their turn by asking the user for
 * permission or direction after a single tool round (the "punt" failure mode
 * documented for sub-10B agents). This is code-side mechanism, not a
 * user-editable prompt: it states the one fact about the candidate's situation
 * that the launched tool's own prompt cannot know. Harmless for models that
 * already behave agentically.
 */
export const PANEL_CANDIDATE_CONTRACT =
  "Panel candidate contract: you are one of several independent candidates attempting this " +
  "request in a disposable scratch workspace. The user cannot see your work and cannot reply - " +
  "never ask for permission or clarification, and never end your turn with a question. Act via " +
  "your tools until the request is genuinely complete, then reply with your final result. If " +
  "anything is ambiguous, choose the most reasonable interpretation and proceed. " +
  "Run commands with default sandbox permissions: approvals are disabled, so any request for " +
  "escalated permissions is auto-rejected - reading and editing files in your workspace never " +
  "needs escalation. If a command is rejected or fails, fix the command and retry; do not " +
  "conclude that access is blocked. Never end your turn by describing what you are about to " +
  "do - either call a tool or report what you already did.";

/**
 * Compose the shared panel-member prompt: optionally pass through the launched
 * coding tool's own system/custom instructions (so panel members follow the
 * user's developer guidance, not just the bare request), the task itself, and a
 * membership suffix, and the fixed candidate contract
 * (`PANEL_CANDIDATE_CONTRACT`). The per-member self-identity line is added
 * separately at the harness `run` (it needs the model id + ordinal).
 */
export function buildPanelPrompt(input: {
  prompt: string;
  panel: EnsembleModel[];
  harnessSystem?: string;
  panelIdentity?: boolean;
}): string {
  const parts: string[] = [];
  const harnessSystem = input.harnessSystem?.trim();
  if (input.panelIdentity && harnessSystem !== undefined && harnessSystem.length > 0) {
    parts.push(
      "Custom instructions for this task (from the launched coding tool; follow them):\n" +
        harnessSystem
    );
  }
  parts.push(input.prompt);
  if (input.panelIdentity) {
    const roster = input.panel.map((model) => model.id).join(", ");
    parts.push(`(You are one model in a FusionKit panel [${roster}] answering this independently.)`);
  } else {
    parts.push(PANEL_MEMBER_SUFFIX);
  }
  parts.push(PANEL_CANDIDATE_CONTRACT);
  return parts.join("\n\n");
}

function chatCompletionsUrl(baseUrl: string): string {
  const normalized = normalizeFusionBackendUrl(baseUrl);
  return normalized.endsWith("/v1")
    ? `${normalized}/chat/completions`
    : `${normalized}/v1/chat/completions`;
}

function sideEffectsForHarness(kind: UnifiedHarnessKind): EnsembleDescriptor["policy"]["sideEffects"] {
  switch (kind) {
    case "mock":
      return "read_only";
    case "command":
      return "tool_execution";
    case "agent":
      return "writes_workspace";
    case "codex":
    case "claude-code":
    case "cursor-acp":
    case "cursor-desktop":
      return requireToolHarnessProvider(kind).sideEffects(kind);
    default: {
      const exhausted: never = kind;
      throw new Error(`unsupported unified harness: ${String(exhausted)}`);
    }
  }
}

function harnessAdapter(kind: UnifiedHarnessKind, options: UnifiedHarnessE2EOptions): HarnessAdapter {
  switch (kind) {
    case "mock":
      return createMockHarness();
    case "agent":
      return createAgentHarness({
        modelEndpoints: options.modelEndpoints ?? {},
        fallbackBaseUrl: normalizeFusionBackendUrl(options.fusionBackendUrl),
        ...(options.fusionApiKey !== undefined ? { apiKey: options.fusionApiKey } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
        ...(options.parentSpanId !== undefined ? { parentSpanId: options.parentSpanId } : {}),
        ...(options.turn !== undefined ? { turn: options.turn } : {}),
        ...(options.panelIdentity !== undefined ? { panelIdentity: options.panelIdentity } : {})
      });
    case "command": {
      if (!options.command) {
        throw new Error("--command is required for the command unified harness");
      }
      return createCommandHarness({
        command: options.command,
        timeoutMs: options.timeoutMs,
        env: ({ model }) => {
          const backend = options.modelEndpoints?.[model.id] ?? options.fusionBackendUrl;
          return {
            FUSIONKIT_BASE_URL: normalizeFusionBackendUrl(backend),
            FUSIONKIT_CHAT_COMPLETIONS_URL: chatCompletionsUrl(backend),
            FUSIONKIT_MODEL: model.model,
            FUSIONKIT_MODEL_ID: model.id,
            ...(options.fusionApiKey ? { FUSIONKIT_API_KEY: options.fusionApiKey } : {}),
            ...(options.traceId ? { FUSION_TRACE_ID: options.traceId } : {})
          };
        }
      });
    }
    case "codex":
    case "claude-code":
    case "cursor-acp":
    case "cursor-desktop":
      return resolveToolAdapter(kind, options);
    default: {
      const exhausted: never = kind;
      throw new Error(`unsupported unified harness: ${String(exhausted)}`);
    }
  }
}

function responseShapeFor(kind: UnifiedHarnessKind): string {
  switch (kind) {
    case "mock":
    case "command":
      return "Return a concise markdown summary and include any final patch guidance.";
    case "agent":
      return (
        "Respond to the user in the natural shape the request calls for: a direct answer, " +
        "a plan, or the concrete code change. Reply in first person as the assistant."
      );
    case "codex":
    case "claude-code":
    case "cursor-acp":
    case "cursor-desktop":
      return requireToolHarnessProvider(kind).responseShape(kind);
    default: {
      const exhausted: never = kind;
      throw new Error(`unsupported unified harness: ${String(exhausted)}`);
    }
  }
}

function trajectoryFuseUrl(baseUrl: string): string {
  return `${normalizeFusionBackendUrl(baseUrl)}/v1/fusion/trajectories:fuse`;
}

/** Map an internal trajectory step to a trajectory.v1 Responses-style item. */
function stepToWireItem(step: TrajectoryStep): Record<string, unknown> {
  const base: Record<string, unknown> = { index: step.index };
  switch (step.type) {
    case "reasoning":
      return { ...base, type: "reasoning", ...(step.text !== undefined ? { text: step.text } : {}) };
    case "tool_call":
      return {
        ...base,
        type: "function_call",
        ...(step.tool_name !== undefined ? { name: step.tool_name } : {}),
        ...(step.tool_call_id !== undefined ? { call_id: step.tool_call_id } : {}),
        ...(step.tool_input !== undefined ? { arguments: step.tool_input } : {})
      };
    case "observation":
      return {
        ...base,
        type: "function_call_output",
        ...(step.tool_call_id !== undefined ? { call_id: step.tool_call_id } : {}),
        ...(step.text !== undefined ? { text: step.text } : {}),
        ...(step.is_error !== undefined ? { is_error: step.is_error } : {})
      };
    case "output":
      return { ...base, type: "message", ...(step.text !== undefined ? { text: step.text } : {}) };
    default: {
      const exhausted: never = step.type;
      throw new Error(`unsupported trajectory step type: ${String(exhausted)}`);
    }
  }
}

function endReasonToWire(endReason: HarnessEndReason): NonNullable<WireTrajectory["end_reason"]> {
  return {
    kind: endReason.kind,
    ...(endReason.exitCode !== undefined ? { exit_code: endReason.exitCode } : {}),
    ...(endReason.timedOut !== undefined ? { timed_out: endReason.timedOut } : {}),
    ...(endReason.detail !== undefined ? { detail: endReason.detail } : {})
  };
}

function trajectoryToWire(trajectory: HarnessTrajectory): WireTrajectory {
  return {
    trajectory_id: trajectory.trajectoryId,
    model_id: trajectory.modelId,
    status: trajectory.status,
    items: trajectory.steps.map(stepToWireItem),
    final_output: trajectory.finalOutput,
    ...(trajectory.usage !== undefined ? { usage: trajectory.usage } : {}),
    ...(trajectory.candidateId !== undefined ? { candidate_id: trajectory.candidateId } : {}),
    ...(trajectory.model !== undefined ? { model: trajectory.model } : {}),
    ...(trajectory.harnessKind !== undefined ? { harness_kind: trajectory.harnessKind } : {}),
    ...(trajectory.diff !== undefined && trajectory.diff.length > 0 ? { diff: trajectory.diff } : {}),
    ...(trajectory.latencyMs !== undefined || trajectory.providerMetadata !== undefined
      ? {
          metadata: {
            ...(trajectory.providerMetadata ?? {}),
            ...(trajectory.latencyMs !== undefined ? { latency_ms: trajectory.latencyMs } : {})
          }
        }
      : {}),
    ...(trajectory.endReason !== undefined ? { end_reason: endReasonToWire(trajectory.endReason) } : {})
  };
}

/**
 * Wire a candidate that ran but captured no trajectory (e.g. its model call
 * failed before producing any output) as an explicit `failed` trajectory. This
 * keeps the candidate visible — with its model id and status — instead of
 * silently dropping it, so a panel where every member failed surfaces as
 * "every model failed" with attribution rather than an opaque "no candidates".
 */
function failedEvidenceToWire(evidence: JudgeCandidateEvidence): WireTrajectory {
  const label = evidence.modelId.length > 0 ? evidence.modelId : evidence.candidateId;
  return {
    trajectory_id: evidence.candidateId,
    model_id: evidence.modelId,
    status: "failed",
    items: [],
    final_output: `panel candidate ${label} produced no trajectory (status: ${evidence.status})`,
    candidate_id: evidence.candidateId,
    ...(evidence.model.length > 0 ? { model: evidence.model } : {}),
    ...(evidence.endReason !== undefined ? { end_reason: endReasonToWire(evidence.endReason) } : {})
  };
}

export function createFusionKitJudgeSynthesizer(input: {
  fusionBackendUrl: string;
  model: string;
  apiKey?: string;
  responseShape: string;
  traceId?: string;
}): JudgeSynthesizer {
  const authHeaders: Record<string, string> = input.apiKey
    ? { authorization: `Bearer ${input.apiKey}` }
    : {};
  const traceHeaders: Record<string, string> =
    input.traceId !== undefined
      ? { [TRACE_ID_HEADER]: input.traceId, [TRACE_SPAN_HEADER]: newSpanId() }
      : {};
  return {
    async synthesize(judgeInput: JudgeInput): Promise<JudgeSynthesisOutput> {
      // The one fusion operation: post the candidate trajectories + the request
      // to FusionKit's unified `trajectories:fuse`. With no tools it is terminal
      // on turn 1 (one-shot text fusion); the response is an OpenAI chat
      // completion whose terminal `fusion.trajectory.synthesis` carries the
      // folded fusion result (decision/selected/rationale/metrics).
      const trajectories = judgeInput.candidates
        .map((candidate) => candidate.trajectory)
        .filter((trajectory): trajectory is HarnessTrajectory => trajectory !== undefined);
      const fuseResponse = await fetch(trajectoryFuseUrl(input.fusionBackendUrl), {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders, ...traceHeaders },
        body: JSON.stringify({
          model: input.model,
          messages: [{ role: "user", content: judgeInput.descriptor.prompt }],
          trajectories: trajectories.map(trajectoryToWire)
        })
      });
      if (!fuseResponse.ok) {
        throw new Error(
          `FusionKit trajectory fusion failed: ${fuseResponse.status} ${(await fuseResponse.text()).slice(0, 500)}`
        );
      }
      const fused = (await fuseResponse.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        fusion?: {
          trajectory?: {
            synthesis?: {
              decision?: string;
              selected_trajectory_id?: string | null;
              rationale?: string | null;
            };
          };
        };
      };
      const finalOutput = fused.choices?.[0]?.message?.content ?? "";
      const synthesis = fused.fusion?.trajectory?.synthesis;
      const output: JudgeSynthesisOutput = {
        decision: synthesis?.decision === "select_trajectory" ? "select_trajectory" : "synthesize",
        finalOutput,
        rationale: synthesis?.rationale ?? "FusionKit trajectory fusion",
        contributions: trajectories.map((trajectory) => ({
          candidateId: trajectory.candidateId ?? trajectory.trajectoryId,
          reason: `fused ${trajectory.status} trajectory`
        }))
      };
      if (synthesis?.selected_trajectory_id) {
        output.selectedCandidateId = synthesis.selected_trajectory_id;
      }
      return output;
    }
  };
}

export type FusionPanelOptions = {
  id?: string;
  repo: string;
  outputRoot: string;
  prompt: string;
  models: EnsembleModel[];
  /**
   * The harness every panel model runs through (the launched tool's harness).
   * Defaults to the generic `agent` when unset.
   */
  harness?: UnifiedHarnessKind;
  modelEndpoints?: Record<string, string>;
  /** Fallback agent backend URL for models without a dedicated endpoint. */
  fusionBackendUrl: string;
  fusionApiKey?: string;
  timeoutMs?: number;
  /** Aborts the whole panel run (all candidates); see EnsembleDescriptor.signal. */
  signal?: AbortSignal;
  /** Straggler grace window after the first success; see EnsemblePolicy.stragglerGraceMs. */
  stragglerGraceMs?: number;
  traceId?: string;
  /** Session root span so panel candidate spans nest under the session. */
  parentSpanId?: string;
  /** User-turn index this panel run belongs to (for per-turn grouping). */
  turn?: number;
  /**
   * The launched coding tool's own system/custom instructions, passed through to
   * panel members (so they follow the user's developer guidance, not just the
   * bare request). Only applied when `panelIdentity` is on.
   */
  harnessSystem?: string;
  /**
   * When true, panel members are told exactly which member they are (model id +
   * peer N of M) and the panel roster, and the harness system instructions are
   * passed through. Default off, because per-member identity makes members'
   * prompts differ from each other (some inter-member decorrelation trade-off).
   */
  panelIdentity?: boolean;
  /** Panel candidate trust level; unset means `full` (maximum autonomy). */
  panelTrust?: PanelTrust;
};

/**
 * Capture one panel run through the existing ensemble harness. This is the leaf
 * effect the runtime `PanelGenerateOperator` wraps, keeping graph scheduling
 * separate from harness mechanics.
 */
async function captureFusionPanelWires(options: FusionPanelOptions): Promise<WireTrajectory[]> {
  let captured: HarnessTrajectory[] = [];
  let evidence: readonly JudgeCandidateEvidence[] = [];
  const harness: UnifiedHarnessKind = options.harness ?? "agent";
  const e2eOptions: UnifiedHarnessE2EOptions = {
    id: options.id ?? `panels_${Date.now()}`,
    fusionBackendUrl: options.fusionBackendUrl,
    repo: options.repo,
    outputRoot: options.outputRoot,
    prompt: buildPanelPrompt({
      prompt: options.prompt,
      panel: options.models,
      ...(options.harnessSystem !== undefined ? { harnessSystem: options.harnessSystem } : {}),
      ...(options.panelIdentity !== undefined ? { panelIdentity: options.panelIdentity } : {})
    }),
    harnesses: [harness],
    models: options.models,
    ...(options.modelEndpoints !== undefined ? { modelEndpoints: options.modelEndpoints } : {}),
    ...(options.fusionApiKey !== undefined ? { fusionApiKey: options.fusionApiKey } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.stragglerGraceMs !== undefined ? { stragglerGraceMs: options.stragglerGraceMs } : {}),
    ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
    ...(options.parentSpanId !== undefined ? { parentSpanId: options.parentSpanId } : {}),
    ...(options.turn !== undefined ? { turn: options.turn } : {}),
    ...(options.panelIdentity !== undefined ? { panelIdentity: options.panelIdentity } : {}),
    ...(options.panelTrust !== undefined ? { panelTrust: options.panelTrust } : {})
  };
  const descriptor = descriptorFor(harness, e2eOptions);
  descriptor.judge = {
    id: "panel-capture",
    synthesizer: {
      synthesize(judgeInput: JudgeInput): JudgeSynthesisOutput {
        evidence = judgeInput.candidates;
        captured = judgeInput.candidates
          .map((candidate) => candidate.trajectory)
          .filter((trajectory): trajectory is HarnessTrajectory => trajectory !== undefined);
        // The trajectories are the product; this output is discarded. A
        // non-empty final_output is required by the synthesis record contract.
        return { decision: "synthesize", finalOutput: `captured ${captured.length} panel trajectories` };
      }
    }
  };
  await runEnsemble(descriptor);
  // Surface every candidate that ran: trajectories where captured, and failed
  // placeholders (with model id, status, and end reason) where a candidate
  // produced none — so a mixed panel never silently drops its failures and
  // the session record can answer "why did this candidate stop?".
  if (evidence.length > 0) {
    return evidence.map((candidate) =>
      candidate.trajectory !== undefined
        ? trajectoryToWire(candidate.trajectory)
        : failedEvidenceToWire(candidate)
    );
  }
  return captured.map(trajectoryToWire);
}

/**
 * Run the panel once: each panel model executes the task as a real coding agent
 * in its own git worktree, and we capture the resulting trajectories (the
 * candidate reference solutions the judge fuses). This is now expressed as a
 * one-node static operator graph so the production entry point uses the same
 * artifact/provenance/budget substrate as richer fusion graphs.
 */
export async function runFusionPanelWorkflow(options: FusionPanelOptions): Promise<RuntimeExecutionResult> {
  const runtime = new FusionRuntime();
  const task = createArtifact({
    id: `${options.id ?? "fusion_panels"}.task`,
    type: "task",
    value: {
      id: options.id,
      prompt: options.prompt,
      metadata: {
        repo: options.repo,
        model_ids: options.models.map((model) => model.id)
      }
    },
    visibility: "runtime",
    leakage: "none"
  });
  const panel = new PanelGenerateOperator({
    id: "fusion.panel.generate",
    models: options.models,
    sideEffects: sideEffectsForHarness(options.harness ?? "agent") === "writes_workspace" ? "write_workspace" : "external_tool",
    runner: async () => {
      const wires = await captureFusionPanelWires(options);
      return wires.map((wire) => ({
        candidateId:
          typeof wire.candidate_id === "string"
            ? wire.candidate_id
            : typeof wire.trajectory_id === "string"
              ? wire.trajectory_id
              : undefined,
        modelId: requiredWireString(wire, "model_id"),
        model: typeof wire.model === "string" ? wire.model : undefined,
        content: requiredWireString(wire, "final_output"),
        raw: wire,
        metadata: {
          status: requiredWireString(wire, "status")
        }
      }));
    }
  });
  return await runtime.run({
    runId: `${options.id ?? "fusion_panels"}_runtime`,
    graph: {
      id: `${options.id ?? "fusion_panels"}_graph`,
      inputArtifactIds: [task.id],
      nodes: [
        {
          id: "panel",
          operator: panel,
          inputs: [{ artifactId: task.id }]
        }
      ]
    },
    scheduler: new StaticDAGScheduler("fusion-panels-static-dag"),
    artifacts: [task],
    budget: {
      id: "fusion-panels",
      maxCandidates: options.models.length,
      maxWorkspaceWriters: 1
    }
  });
}

export async function runFusionPanels(options: FusionPanelOptions): Promise<WireTrajectory[]> {
  const result = await runFusionPanelWorkflow(options);
  return result.finalArtifacts
    .map((artifact) => {
      const value = artifact.value as { raw?: unknown };
      return value.raw;
    })
    .filter((value): value is WireTrajectory => value !== null && typeof value === "object");
}

function requiredWireString(wire: WireTrajectory, field: keyof WireTrajectory): string {
  const value = wire[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`fusion panel wire trajectory missing required string field ${field}`);
  }
  return value;
}

function descriptorFor(
  kind: UnifiedHarnessKind,
  options: UnifiedHarnessE2EOptions
): EnsembleDescriptor {
  const id = `${options.id ?? "unified_e2e"}_${kind.replace(/-/g, "_")}`;
  return {
    id,
    harness: harnessAdapter(kind, options),
    models: options.models,
    runtime: { id: "unified-local" },
    judge: {
      id: "fusionkit-judge",
      model: options.judgeModel ?? options.models[0]?.model ?? "fusionkit/router",
      synthesizer: createFusionKitJudgeSynthesizer({
        fusionBackendUrl: options.fusionBackendUrl,
        model: options.judgeModel ?? options.models[0]?.model ?? "fusionkit/router",
        apiKey: options.fusionApiKey,
        responseShape: responseShapeFor(kind),
        ...(options.traceId !== undefined ? { traceId: options.traceId } : {})
      })
    },
    policy: {
      id: "unified-e2e",
      allowedTools: ["read_file", "write_file", "apply_patch", "run_tests", "shell_command"],
      sideEffects: sideEffectsForHarness(kind),
      timeoutMs: options.timeoutMs,
      ...(options.stragglerGraceMs !== undefined ? { stragglerGraceMs: options.stragglerGraceMs } : {})
    },
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    prompt: options.prompt,
    sourceRepo: "handoffkit",
    baseGitSha: gitText(options.repo, ["rev-parse", "HEAD"]).trim(),
    workspace: options.repo,
    outputRoot: options.outputRoot,
    cleanupWorktrees: true,
    metadata: {
      unified_harness_e2e: true,
      fusion_backend_url: normalizeFusionBackendUrl(options.fusionBackendUrl),
      response_shape: responseShapeFor(kind)
    }
  };
}

function statusForResult(result: EnsembleRunResult): ModelFusionStatus {
  return result.failureSummary ? "failed" : result.harnessRunResult.status;
}

async function defaultCursorRunner(input: CursorHarnessRunnerInput): Promise<CursorHarnessRunnerResult> {
  const { harnessCli } = resolveCursorkitCli();
  const suite = input.kind === "cursor-acp" ? "acp" : "desktop-route";
  const args = [
    harnessCli,
    "--suite",
    suite,
    "--base-url",
    normalizeFusionBackendUrl(input.fusionBackendUrl),
    "--model",
    input.model.id,
    "--provider-model",
    input.model.model,
    "--timeout-ms",
    String(input.timeoutMs ?? 60_000)
  ];
  mkdirSync(input.outDir, { recursive: true });
  return await new Promise((resolveResult) => {
    const child = spawn(process.execPath, args, {
      cwd: input.outDir,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      const logPath = join(input.outDir, `${input.kind}-${input.model.id}.log`);
      writeFileSync(logPath, [stdout, stderr].filter(Boolean).join("\n"));
      resolveResult({
        status: code === 0 ? "succeeded" : "failed",
        message: code === 0 ? `${input.kind} completed` : `${input.kind} failed`,
        artifacts: { log: logPath },
        details: { exitCode: code ?? 1 }
      });
    });
  });
}

async function runCursorHarness(
  kind: Extract<UnifiedHarnessKind, "cursor-acp" | "cursor-desktop">,
  options: UnifiedHarnessE2EOptions
): Promise<UnifiedHarnessMatrixResult> {
  const runner = options.cursorRunner ?? defaultCursorRunner;
  const perModel = await Promise.all(
    options.models.map((model) =>
      runner({
        kind,
        model,
        fusionBackendUrl: options.fusionBackendUrl,
        repo: options.repo,
        outDir: join(options.outputRoot, `${kind}-${model.id}`),
        timeoutMs: options.timeoutMs
      })
    )
  );
  const failed = perModel.find((result) => result.status === "failed");
  const skipped = perModel.every((result) => result.status === "skipped");
  return {
    harness: kind,
    modelIds: options.models.map((model) => model.id),
    status: failed ? "failed" : skipped ? "skipped" : "succeeded",
    message: failed?.message ?? (skipped ? "all Cursor model probes skipped" : "Cursor probes completed"),
    artifacts: Object.assign({}, ...perModel.map((result) => result.artifacts ?? {})),
    details: {
      perModel: perModel.map((result) => ({
        status: result.status,
        message: result.message,
        ...(result.details ?? {})
      })) as JsonValue
    }
  };
}

export async function runUnifiedHarnessE2E(
  options: UnifiedHarnessE2EOptions
): Promise<UnifiedHarnessE2EResult> {
  const outputRoot = resolve(options.outputRoot);
  mkdirSync(outputRoot, { recursive: true });
  const results: UnifiedHarnessMatrixResult[] = [];
  for (const kind of options.harnesses) {
    if (
      (kind === "cursor-acp" || kind === "cursor-desktop") &&
      options.cursorRunner !== undefined
    ) {
      // Explicit probe runner: drive the Cursorkit harness suite and record a
      // route/transcript probe instead of producing real ensemble candidates.
      results.push(await runCursorHarness(kind, options));
      continue;
    }
    const descriptor = descriptorFor(kind, options);
    const ensembleResult = await runEnsemble(descriptor);
    results.push({
      harness: kind,
      modelIds: options.models.map((model) => model.id),
      status: statusForResult(ensembleResult),
      message: ensembleResult.harnessRunResult.output_summary ?? "",
      ensemble: ensembleResult,
      artifacts: {
        ...(ensembleResult.summaryPath ? { summary: ensembleResult.summaryPath } : {})
      },
      details: {
        candidateCount: ensembleResult.candidates.length,
        artifactCount: ensembleResult.artifacts.length,
        toolRecordCount: ensembleResult.toolRecords.length,
        modelCallRecordCount: ensembleResult.modelCallRecords.length,
        judgeSynthesis: ensembleResult.judgeSynthesisRecord !== undefined
      }
    });
  }
  const report: UnifiedHarnessE2EResult = {
    id: options.id ?? "unified_e2e",
    generatedAt: new Date().toISOString(),
    fusionBackendUrl: normalizeFusionBackendUrl(options.fusionBackendUrl),
    repo: resolve(options.repo),
    results
  };
  const reportPath = join(outputRoot, "unified-e2e-report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  return { ...report, reportPath };
}
