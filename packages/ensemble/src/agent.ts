import { runWorktreeAgent } from "@warrant/adapter-ai-sdk";
import { artifactHash } from "@warrant/protocol";

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

export type AgentHarnessOptions = {
  id?: string;
  /** Per-candidate OpenAI-compatible base URL keyed by `EnsembleModel.id`. */
  modelEndpoints: Record<string, string>;
  /** Used when a model has no per-model endpoint. */
  fallbackBaseUrl?: string;
  apiKey?: string;
  maxSteps?: number;
  timeoutMs?: number;
};

/**
 * Verification is a signal, not a gate: if the agent ran a command (e.g. tests)
 * the last observed exit code becomes the trajectory's verification status.
 */
function deriveVerification(steps: TrajectoryStep[]): TrajectoryVerification | undefined {
  let lastExitCode: number | undefined;
  for (const step of steps) {
    if (step.type === "observation" && typeof step.text === "string") {
      const match = step.text.match(/exit_code=(-?\d+)/);
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
      const result = await runWorktreeAgent({
        worktree: root,
        prompt: descriptor.prompt,
        baseUrl,
        model: model.model,
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
        ...(options.timeoutMs !== undefined ? { commandTimeoutMs: options.timeoutMs } : {})
      });

      const steps = result.steps as TrajectoryStep[];
      const candidateId = `${descriptor.id}_${model.id}_${ordinal}`;
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
            execution_id: `exec_${descriptor.id}_${model.id}_${ordinal}`,
            plan_id: `plan_${descriptor.id}_${model.id}_${ordinal}`,
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
