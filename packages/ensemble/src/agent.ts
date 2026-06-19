import { runWorktreeAgent } from "@fusionkit/adapter-ai-sdk";
import { artifactHash, emitTrace, newSpanId } from "@fusionkit/protocol";

import type {
  HarnessAdapter,
  HarnessCandidateOutput,
  HarnessTrajectory,
  TrajectoryStep,
  TrajectoryVerification
} from "./harness.js";

/**
 * The uniform panel agent for trajectory-level fusion. Each panel model drives
 * a real AI SDK tool loop (read/list/grep/write/run) over its own git worktree
 * and produces a normalized trajectory. The same agent runs for every model, so
 * trajectories are directly comparable and only the model varies.
 */

/** Wall-clock budget for a single panel model's agent run (model + tools). */
const DEFAULT_MODEL_TIMEOUT_MS = 10 * 60 * 1000;

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
  /** Observability correlation id; when set, each candidate is traced. */
  traceId?: string;
  /** Session root span; candidate spans parent under it for a correct tree. */
  parentSpanId?: string;
  /** User-turn index this panel run belongs to (stamped on candidate events). */
  turn?: number;
};

/**
 * Verification is a signal, not a gate: if the agent ran a command (e.g. tests)
 * the last observed exit code becomes the trajectory's verification status.
 */
function deriveVerification(steps: TrajectoryStep[]): TrajectoryVerification | undefined {
  let lastExitCode: number | undefined;
  for (const step of steps) {
    // The `run` tool always prefixes its observation with `exit_code=<n>`; anchor
    // to the start so unrelated tool output that happens to contain the substring
    // cannot be mistaken for a command result.
    if (step.type === "observation" && typeof step.text === "string") {
      const match = step.text.match(/^exit_code=(-?\d+)/);
      if (match) lastExitCode = Number(match[1]);
    }
  }
  if (lastExitCode === undefined) return undefined;
  return {
    status: lastExitCode === 0 ? "succeeded" : "failed",
    evidence: [`exit_code=${lastExitCode}`],
    exitCode: lastExitCode
  };
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
    run: async ({ descriptor, model, ordinal, worktree }): Promise<HarnessCandidateOutput> => {
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
      const result = await runWorktreeAgent({
        worktree: root,
        prompt: descriptor.prompt,
        baseUrl,
        model: model.id,
        abortSignal: AbortSignal.timeout(modelTimeoutMs),
        ...(options.turn !== undefined ? { turn: options.turn } : {}),
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
        ...(options.timeoutMs !== undefined ? { commandTimeoutMs: options.timeoutMs } : {}),
        ...(traceId !== undefined ? { traceId, candidateId, parentSpanId: candidateSpan } : {})
      });

      const steps: TrajectoryStep[] = result.steps;
      const status: HarnessCandidateOutput["status"] = result.status === "failed" ? "failed" : "succeeded";
      const verification = deriveVerification(steps);
      const trajectory: HarnessTrajectory = {
        trajectoryId: candidateId,
        modelId: model.id,
        model: model.model,
        candidateId,
        harnessKind: "generic",
        status,
        steps,
        finalOutput: result.finalOutput,
        ...(verification !== undefined ? { verification } : {})
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
            ...(verification !== undefined ? { verification_status: verification.status } : {})
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
        verification:
          verification !== undefined
            ? {
                status: verification.status,
                evidence: verification.evidence,
                ...(verification.exitCode !== undefined ? { exitCode: verification.exitCode } : {})
              }
            : { status, evidence: [`final_output_chars=${result.finalOutput.length}`, outputHash] },
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
