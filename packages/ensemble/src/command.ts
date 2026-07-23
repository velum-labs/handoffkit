import { artifactHash } from "@velum-labs/routekit-contracts";

import type { HarnessAdapter, HarnessCandidateOutput, HarnessCapabilities } from "./harness.js";
import type { EnsembleModel } from "./harness.js";
import { runCandidateCommandWithIsolation } from "./isolation.js";

/**
 * Dashboard capability profile for the command harness, owned here next to the
 * implementation so the dashboard never re-declares (or contradicts) it. The
 * command harness runs one model-agnostic shell command per candidate:
 * - `diff_capture` is unsupported because the command's stdout is the product;
 *   no git worktree diff is produced or collected.
 * - `patch_apply_visibility` is unsupported because the harness never applies
 *   patches — there is no apply step to observe.
 * - `route_model_observation` is unsupported because the command does not call
 *   a model at all, so no served-model identity can be captured.
 */
export const COMMAND_DASHBOARD_CAPABILITIES: HarnessCapabilities = {
  model_override: "supported",
  transcript_capture: "supported",
  diff_capture: "unsupported",
  tool_loop_capture: "supported",
  patch_apply_visibility: "unsupported",
  route_model_observation: "unsupported",
  verification_hint: "supported",
  replay_support: "supported"
};

export type CommandHarnessEnvInput = {
  model: EnsembleModel;
  ordinal: number;
  descriptorId: string;
};

export type CommandHarnessOptions = {
  id?: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined> | ((input: CommandHarnessEnvInput) => Record<string, string | undefined>);
};

export function createCommandHarness(options: CommandHarnessOptions): HarnessAdapter {
  const id = options.id ?? "command";
  return {
    id,
    prepare: () => ({
      command: options.command,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs
    }),
    capabilities: () => ({
      shell_command: "supported",
      artifact_capture: "supported"
    }),
    verificationProfile: () => ({
      id: `${id}-evidence`,
      command: options.command,
      requiredEvidence: ["command output", "exit code", "tool execution record"]
    }),
    run: async ({ descriptor, model, ordinal, worktree, signal }) => {
      const env =
        typeof options.env === "function"
          ? options.env({ model, ordinal, descriptorId: descriptor.id })
          : options.env;
      const execution = await runCandidateCommandWithIsolation({
        command: options.command,
        cwd: worktree?.path ?? options.cwd ?? process.cwd(),
        timeoutMs: options.timeoutMs ?? descriptor.policy.timeoutMs,
        isolation: descriptor.runtime.isolation,
        // Honor the per-candidate abort (panel cancel / straggler drop): without
        // this a stuck command candidate keeps running past the straggler grace
        // and holds a finished sibling's result hostage until the hard timeout.
        ...(signal !== undefined ? { signal } : {}),
        env: {
          HARNESS_MODEL_ID: model.id,
          HARNESS_MODEL: model.model,
          HARNESS_PROMPT: descriptor.prompt,
          ...(model.endpointId !== undefined ? { HARNESS_ENDPOINT_ID: model.endpointId } : {}),
          ...env
        }
      });
      const { stdout, stderr, exitCode } = execution;
      const transcript = [stdout, stderr].filter(Boolean).join("\n");
      const status: HarnessCandidateOutput["status"] =
        exitCode === 0 ? "succeeded" : "failed";
      const outputHash = artifactHash(transcript);
      return {
        candidateId: `${descriptor.id}_${model.id}_${ordinal}`,
        model,
        status,
        ...(worktree ? { branchName: worktree.branchName, worktreePath: worktree.path } : {}),
        transcript,
        diff: "",
        artifacts: [
          {
            artifact_id: `artifact_${descriptor.id}_${model.id}_command_output`,
            kind: "log",
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
        metadata: {
          command: options.command,
          stdout_bytes: Buffer.byteLength(stdout),
          stderr_bytes: Buffer.byteLength(stderr),
          timed_out: execution.timedOut,
          hardening: execution.hardening
        }
      };
    },
    collectArtifacts: () => []
  };
}
