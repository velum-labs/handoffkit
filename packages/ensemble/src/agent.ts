import { runWorktreeAgent } from "@fusionkit/adapter-ai-sdk";
import { artifactHash, ATTR } from "@fusionkit/protocol";
import { RUNTIME_TIMEOUT_MS } from "@fusionkit/runtime-utils";
import { emitFusionMarker } from "@fusionkit/tracing";
import type { FusionTraceCarrier } from "@fusionkit/tracing";

import { traceCandidate } from "./candidate-trace.js";
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
  maxSteps?: number;
  /** Per-`run` shell-command timeout (ms). */
  timeoutMs?: number;
  /** Overall wall-clock budget for one model's agent run (ms). */
  modelTimeoutMs?: number;
  /** Trace carrier of the enclosing run/turn; when set, each candidate is traced. */
  trace?: FusionTraceCarrier;
  /** User-turn index this panel run belongs to (stamped on candidate spans). */
  turn?: number;
  /** When true, prepend a per-member identity line to the prompt (see harness.ts). */
  panelIdentity?: boolean;
};

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
      const tracer = traceCandidate(
        { ...(options.trace !== undefined ? { trace: options.trace } : {}), ...(options.turn !== undefined ? { turn: options.turn } : {}) },
        {
          candidateId,
          modelId: model.id,
          model: model.model,
          ...(worktree ? { branchName: worktree.branchName, worktreePath: worktree.path } : {})
        }
      );
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
        ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
        ...(options.timeoutMs !== undefined ? { commandTimeoutMs: options.timeoutMs } : {}),
        ...(tracer.carrier !== undefined
          ? { trace: tracer.carrier, candidateId, modelId: model.id, onStep: tracer.step }
          : {})
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
      emitFusionMarker("ensemble", "fusion.tool.execution", tracer.carrier, {
        [ATTR.FUSION_CANDIDATE_ID]: candidateId,
        [ATTR.FUSION_MODEL_ID]: model.id,
        [ATTR.FUSION_TURN]: options.turn,
        [ATTR.FUSION_EXECUTION_ID]: executionId,
        [ATTR.FUSION_PLAN_ID]: planId,
        [ATTR.FUSION_STATUS]: status,
        [ATTR.FUSION_OUTPUT_HASH]: outputHash,
        [ATTR.FUSION_TOOL_CALL_COUNT]: result.toolCallCount
      });
      tracer.finished({
        status,
        steps,
        finalOutput: result.finalOutput,
        toolCallCount: result.toolCallCount,
        finishReason: result.finishReason
      });
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
