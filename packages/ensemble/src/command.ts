import { artifactHash } from "@warrant/protocol";

import type { HarnessAdapter, HarnessCandidateOutput } from "./harness.js";
import { runCandidateCommandWithIsolation } from "./isolation.js";

export type CommandHarnessOptions = {
  id?: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
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
      artifact_capture: "supported",
      verification: "supported"
    }),
    verificationProfile: () => ({
      id: `${id}-verification`,
      command: options.command,
      requiredEvidence: ["command output", "exit code", "tool execution record"]
    }),
    run: async ({ descriptor, model, ordinal, worktree }) => {
      const execution = await runCandidateCommandWithIsolation({
        command: options.command,
        cwd: worktree?.path ?? options.cwd ?? process.cwd(),
        timeoutMs: options.timeoutMs ?? descriptor.policy.timeoutMs,
        isolation: descriptor.runtime.isolation
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
        verification: {
          status,
          evidence: [`exit_code=${exitCode}`, outputHash],
          exitCode
        },
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
