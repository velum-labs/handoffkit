import { runWorktreeAgent } from "@fusionkit/adapter-ai-sdk";
import { artifactHash, emitTrace, newSpanId } from "@fusionkit/protocol";
import { RUNTIME_TIMEOUT_MS } from "@fusionkit/runtime-utils";

import {
  panelMemberPreamble,
  type HarnessAdapter,
  type HarnessCandidateOutput,
  type HarnessTrajectory,
  type TrajectoryStep
} from "./harness.js";

/**
 * The uniform panel agent for trajectory-level fusion. Each panel model drives
 * a real AI SDK tool loop (read/list/grep/write/run) over its own git worktree
 * and produces a normalized trajectory. The same agent runs for every model, so
 * trajectories are directly comparable and only the model varies.
 */

/** Wall-clock budget for a single panel model's agent run (model + tools). */
const DEFAULT_MODEL_TIMEOUT_MS = RUNTIME_TIMEOUT_MS.panelModel;

export type AgentHarnessOptions = {
  id?: string;
  /** Per-candidate OpenAI-compatible base URL keyed by `EnsembleModel.id`. */
  modelEndpoints: Record<string, string>;
  /** Used when a model has no per-model endpoint. */
  fallbackBaseUrl?: string;
  apiKey?: string;
  /**
   * Finite step-boundary budget (receding-horizon lookahead): tool-call
   * batches 1..k-1 execute in the worktree; the k-th generation's batch is
   * captured unexecuted as the candidate's terminal proposal. Unset =
   * unbounded rollout (the agent's internal safety cap applies).
   */
  k?: number;
  /** Per-`run` shell-command timeout (ms). */
  timeoutMs?: number;
  /** Overall wall-clock budget for one model's agent run (ms). */
  modelTimeoutMs?: number;
  /** Observability correlation id; when set, each candidate is traced. */
  traceId?: string;
  /** Session root span; candidate spans parent under it for a correct tree. */
  parentSpanId?: string;
  /** User-turn index this panel run belongs to (stamped on candidate events). */
  turn?: number;
  /** When true, prepend a per-member identity line to the prompt (see harness.ts). */
  panelIdentity?: boolean;
};

/**
 * The trajectory's terminal proposal: the trailing `tool_call` steps a bounded
 * rollout (finite k) captured **unexecuted** at its k-th boundary. Trailing
 * empty `output` markers are skipped; an observation or non-empty output after
 * a call means the calls were executed, not proposed. Mirrors the wire-side
 * `terminalProposal` the narrator applies to judge-request candidates, in the
 * pre-wire `TrajectoryStep` shape.
 */
export function terminalProposalFromSteps(
  steps: readonly TrajectoryStep[]
): Array<{ name?: string; arguments_preview: string }> {
  const batch: Array<{ name?: string; arguments_preview: string }> = [];
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index] as TrajectoryStep;
    if (step.type === "output" && batch.length === 0) {
      if ((step.text ?? "").trim().length === 0) continue; // trailing empty marker
      break;
    }
    if (step.type === "tool_call") {
      batch.unshift({
        ...(step.tool_name !== undefined ? { name: step.tool_name } : {}),
        arguments_preview: (step.tool_input ?? "").slice(0, 160)
      });
      continue;
    }
    break;
  }
  return batch;
}

export function createAgentHarness(options: AgentHarnessOptions): HarnessAdapter {
  const id = options.id ?? "agent";
  // The base URL is shared across panel models (one `fusionkit serve` router),
  // which routes by the request `model` field. So the request model is the panel
  // *endpoint id* (what the router's passthrough matches), not the provider model
  // name. With a dedicated per-model endpoint the id is ignored, so this is safe
  // either way.
  return {
    id,
    harnessKind: "generic",
    prepare: () => ({ id, timeoutMs: options.timeoutMs }),
    capabilities: () => ({
      shell_command: "supported",
      artifact_capture: "supported",
      verification: "supported",
      tool_call_loop: "supported"
    }),
    verificationProfile: () => ({
      id: `${id}-verification`,
      requiredEvidence: ["agent trajectory", "final output"]
    }),
    run: async ({ descriptor, model, ordinal, worktree, signal }): Promise<HarnessCandidateOutput> => {
      const baseUrl = options.modelEndpoints[model.id] ?? options.fallbackBaseUrl;
      if (baseUrl === undefined) {
        throw new Error(`no model endpoint configured for panel model "${model.id}"`);
      }
      const root = worktree?.path ?? process.cwd();
      const candidateId = `${descriptor.id}_${model.id}_${ordinal}`;
      const executionId = `exec_${candidateId}`;
      const planId = `plan_${candidateId}`;
      const traceId = options.traceId;
      const candidateSpan = newSpanId();
      if (traceId !== undefined) {
        emitTrace({
          component: "panel-model",
          event_type: "harness.candidate.started",
          traceId,
          spanId: candidateSpan,
          ...(options.parentSpanId !== undefined ? { parentSpanId: options.parentSpanId } : {}),
          candidateId,
          modelId: model.id,
          payload: {
            model: model.model,
            ...(options.turn !== undefined ? { turn: options.turn } : {}),
            ...(worktree ? { branch_name: worktree.branchName, worktree_path: worktree.path } : {})
          }
        });
      }
      // Bound the whole agent run so a hung model HTTP call cannot wedge a
      // candidate forever (the per-command timeout only bounds `run`).
      const modelTimeoutMs = options.modelTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
      const prompt =
        options.panelIdentity === true
          ? `${panelMemberPreamble(model.id, ordinal, descriptor.models.length)}\n\n${descriptor.prompt}`
          : descriptor.prompt;
      const result = await runWorktreeAgent({
        worktree: root,
        prompt,
        baseUrl,
        model: model.id,
        // The candidate stops on whichever fires first: its own model-call
        // budget or the ensemble's cancellation (panel timeout / straggler drop).
        abortSignal:
          signal !== undefined
            ? AbortSignal.any([signal, AbortSignal.timeout(modelTimeoutMs)])
            : AbortSignal.timeout(modelTimeoutMs),
        ...(options.turn !== undefined ? { turn: options.turn } : {}),
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        ...(options.k !== undefined ? { k: options.k } : {}),
        ...(options.timeoutMs !== undefined ? { commandTimeoutMs: options.timeoutMs } : {}),
        ...(traceId !== undefined ? { traceId, candidateId, parentSpanId: candidateSpan } : {})
      });

      const steps: TrajectoryStep[] = result.steps;
      const status: HarnessCandidateOutput["status"] = result.status === "failed" ? "failed" : "succeeded";
      const trajectory: HarnessTrajectory = {
        trajectoryId: candidateId,
        modelId: model.id,
        model: model.model,
        candidateId,
        harnessKind: "generic",
        status,
        steps,
        finalOutput: result.finalOutput
      };

      const transcript = JSON.stringify(steps, null, 2);
      const outputHash = artifactHash(transcript);
      if (traceId !== undefined) {
        emitTrace({
          component: "panel-model",
          event_type: "harness.candidate.finished",
          traceId,
          spanId: candidateSpan,
          candidateId,
          modelId: model.id,
          payload: {
            status,
            ...(options.turn !== undefined ? { turn: options.turn } : {}),
            tool_call_count: result.toolCallCount,
            finish_reason: result.finishReason,
            step_count: steps.length,
            final_output_preview: result.finalOutput.slice(0, 400),
            // A bounded rollout's captured k-th batch (empty for completed
            // rollouts): what the narrator renders as the candidate's proposal.
            proposed_calls: terminalProposalFromSteps(steps)
          }
        });
        emitTrace({
          component: "panel-model",
          event_type: "tool.execution",
          traceId,
          spanId: candidateSpan,
          candidateId,
          modelId: model.id,
          payload: {
            execution_id: executionId,
            plan_id: planId,
            status,
            ...(options.turn !== undefined ? { turn: options.turn } : {}),
            output_hash: outputHash,
            tool_call_count: result.toolCallCount
          }
        });
      }
      return {
        candidateId,
        model,
        status,
        ...(worktree ? { branchName: worktree.branchName, worktreePath: worktree.path } : {}),
        transcript,
        trajectory,
        diff: "",
        summary: result.finalOutput.slice(0, 280),
        artifacts: [
          {
            artifact_id: `artifact_${descriptor.id}_${model.id}_agent_trajectory`,
            kind: "transcript",
            hash: outputHash,
            redaction_status: "synthetic"
          }
        ],
        toolRecords: [
          {
            execution_id: executionId,
            plan_id: planId,
            status,
            output_hash: outputHash
          }
        ],
        metadata: {
          adapter: "agent",
          model_id: model.id,
          tool_call_count: result.toolCallCount,
          finish_reason: result.finishReason
        }
      };
    },
    collectArtifacts: () => []
  };
}
