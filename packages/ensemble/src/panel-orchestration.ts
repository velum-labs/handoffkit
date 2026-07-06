import type { WireTrajectory } from "@fusionkit/protocol";
import { ATTR } from "@fusionkit/protocol";
import { headersOf, jsonAttr, startFusionSpan } from "@fusionkit/tracing";
import type { FusionTraceCarrier } from "@fusionkit/tracing";
import type { ResumeCursor } from "@fusionkit/harness-core";
import { PanelGenerateOperator } from "./fusion-operators.js";
import { runEnsemble } from "./run.js";
import { FusionRuntime, StaticDAGScheduler, createArtifact } from "./runtime.js";
import type { RuntimeExecutionResult } from "./runtime.js";
import type { EnsembleModel, HarnessEndReason, HarnessTrajectory, TrajectoryStep } from "./harness.js";
import type { JudgeCandidateEvidence, JudgeInput, JudgeSynthesisOutput, JudgeSynthesizer } from "./judge.js";
import { descriptorFor, sideEffectsForHarness } from "./harness-factories.js";
import { normalizeFusionBackendUrl } from "./unified-url.js";
import type { FusedSubagentAccess, FusedSubagentEnsemble, PanelTrust, UnifiedHarnessE2EOptions, UnifiedHarnessKind } from "./unified-types.js";
export type { FusedSubagentAccess, FusedSubagentEnsemble } from "./unified-types.js";

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
const PANEL_CANDIDATE_CONTRACT_BASE =
  "Panel candidate contract: you are one of several independent candidates attempting this " +
  "request in a disposable scratch workspace. The user cannot see your work and cannot reply - " +
  "never ask for permission or clarification, and never end your turn with a question. Act via " +
  "your tools until the request is genuinely complete, then reply with your final result. If " +
  "anything is ambiguous, choose the most reasonable interpretation and proceed. " +
  "Run commands with default sandbox permissions: approvals are disabled, so any request for " +
  "escalated permissions is auto-rejected - reading and editing files in your workspace never " +
  "needs escalation. If a command is rejected or fails, fix the command and retry; do not " +
  "conclude that access is blocked. Never end your turn by describing what you are about to " +
  "do - either call a tool or report what you already did. ";

/** The sub-agent tail when fused ensembles are NOT reachable (the default). */
const PANEL_SUBAGENT_GUARD =
  "If your harness offers sub-agent tools you may use them to parallelize your own work; " +
  "sub-agents always run on your own model. Fusion ensemble models (any \"fusion-*\" id) are " +
  "not reachable from inside the panel - never try to call, spawn on, or boot a server for " +
  "them; if the request mentions them, answer directly with your own analysis instead.";

/** The sub-agent tail when this member can spawn on the fused ensembles. */
function panelSubagentFusedTail(fusedModelIds: readonly string[]): string {
  return (
    "If your harness offers sub-agent tools you may use them to parallelize or delegate " +
    "your own work; sub-agents run on your own model unless you pass one of the fusion " +
    `ensemble model ids (${fusedModelIds.join(", ")}), which are available as sub-agent ` +
    "models - spawn on one by id when the request asks for that ensemble. They are already " +
    "served for you; never try to boot a server or gateway for them yourself."
  );
}

export const PANEL_CANDIDATE_CONTRACT = PANEL_CANDIDATE_CONTRACT_BASE + PANEL_SUBAGENT_GUARD;

/**
 * The candidate contract for one panel run: the fixed base plus the sub-agent
 * tail matching whether this member can reach the fused ensembles.
 */
export function panelCandidateContract(fusedModelIds?: readonly string[]): string {
  return (
    PANEL_CANDIDATE_CONTRACT_BASE +
    (fusedModelIds !== undefined && fusedModelIds.length > 0
      ? panelSubagentFusedTail(fusedModelIds)
      : PANEL_SUBAGENT_GUARD)
  );
}

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
  /** Fused model ids this member can spawn sub-agents on (see FusedSubagentAccess). */
  fusedModelIds?: readonly string[];
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
  parts.push(panelCandidateContract(input.fusedModelIds));
  return parts.join("\n\n");
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
  /** Trace carrier of the enclosing run; each synthesize() runs in a fusion.judge span. */
  trace?: FusionTraceCarrier;
  turn?: number;
}): JudgeSynthesizer {
  const authHeaders: Record<string, string> = input.apiKey
    ? { authorization: `Bearer ${input.apiKey}` }
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
      const wires = trajectories.map(trajectoryToWire);
      const messages = [{ role: "user", content: judgeInput.descriptor.prompt }];
      const judgeSpan =
        input.trace !== undefined
          ? startFusionSpan("judge", "fusion.judge", input.trace, {
              [ATTR.FUSION_JUDGE_MODEL]: input.model,
              [ATTR.FUSION_TURN]: input.turn
            })
          : undefined;
      judgeSpan?.marker("judge", "fusion.judge.request", {
        [ATTR.FUSION_JUDGE_MODEL]: input.model,
        [ATTR.FUSION_TURN]: input.turn,
        [ATTR.FUSION_MESSAGES]: jsonAttr(messages),
        [ATTR.FUSION_TRAJECTORIES]: jsonAttr(wires),
        [ATTR.FUSION_TRAJECTORY_IDS]: wires.map((wire) => String(wire.trajectory_id))
      });
      const fuseResponse = await fetch(trajectoryFuseUrl(input.fusionBackendUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders,
          ...(judgeSpan !== undefined ? headersOf(judgeSpan.carrier) : {})
        },
        body: JSON.stringify({
          model: input.model,
          messages,
          trajectories: wires
        })
      });
      if (!fuseResponse.ok) {
        const failureBody = (await fuseResponse.text()).slice(0, 500);
        judgeSpan?.end({
          status: "failed",
          error: `trajectory fusion failed: ${fuseResponse.status}`,
          attributes: { "http.response.status_code": fuseResponse.status }
        });
        throw new Error(`FusionKit trajectory fusion failed: ${fuseResponse.status} ${failureBody}`);
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
      judgeSpan?.end({
        status: "succeeded",
        attributes: {
          [ATTR.FUSION_DECISION]:
            synthesis?.decision === "select_trajectory" ? "select_trajectory" : "synthesize",
          [ATTR.FUSION_SELECTED_TRAJECTORY_ID]: synthesis?.selected_trajectory_id ?? undefined,
          [ATTR.FUSION_RATIONALE]: synthesis?.rationale ?? undefined,
          [ATTR.FUSION_FINAL_OUTPUT]: finalOutput,
          [ATTR.FUSION_SYNTHESIS]: jsonAttr(synthesis)
        }
      });
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
  /** Trace carrier of the enclosing run/turn; panel candidate spans nest under it. */
  trace?: FusionTraceCarrier;
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
  /** Enable native sub-agents inside panel members (see ToolHarnessResolveOptions). */
  subagents?: boolean;
  /** Fused sub-agent access for panel members (see FusedSubagentAccess). */
  fusedSubagents?: FusedSubagentAccess;
  /** Finite step-boundary budget per member (see UnifiedHarnessE2EOptions.k). */
  k?: number;
  /** Native-session resume cursors keyed by model id (see UnifiedHarnessE2EOptions). */
  resumeCursors?: Map<string, ResumeCursor>;
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
      ...(options.panelIdentity !== undefined ? { panelIdentity: options.panelIdentity } : {}),
      ...(options.fusedSubagents !== undefined
        ? { fusedModelIds: options.fusedSubagents.ensembles.map((ensemble) => ensemble.modelId) }
        : {})
    }),
    harnesses: [harness],
    models: options.models,
    ...(options.modelEndpoints !== undefined ? { modelEndpoints: options.modelEndpoints } : {}),
    ...(options.fusionApiKey !== undefined ? { fusionApiKey: options.fusionApiKey } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.stragglerGraceMs !== undefined ? { stragglerGraceMs: options.stragglerGraceMs } : {}),
    ...(options.trace !== undefined ? { trace: options.trace } : {}),
    ...(options.turn !== undefined ? { turn: options.turn } : {}),
    ...(options.panelIdentity !== undefined ? { panelIdentity: options.panelIdentity } : {}),
    ...(options.panelTrust !== undefined ? { panelTrust: options.panelTrust } : {}),
    ...(options.subagents !== undefined ? { subagents: options.subagents } : {}),
    ...(options.fusedSubagents !== undefined ? { fusedSubagents: options.fusedSubagents } : {}),
    ...(options.k !== undefined ? { k: options.k } : {}),
    ...(options.resumeCursors !== undefined ? { resumeCursors: options.resumeCursors } : {})
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
