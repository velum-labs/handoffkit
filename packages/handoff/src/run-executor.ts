import { verifyReceiptBundle } from "@warrant/protocol";
import type {
  BundleVerification,
  ExecutionSpec,
  ReceiptBundle,
  RunStatus
} from "@warrant/protocol";
import type { PullResult } from "@warrant/workspace";

import { agents } from "./agents.js";
import type { Handoff } from "./handoff.js";
import type { HandoffRun } from "./run.js";
import type { RuntimeTarget } from "./targets.js";

export type GovernedCommandOptions = {
  command: string;
  target: RuntimeTarget;
  reason: string;
  timeoutMs: number;
  pullResults?: boolean;
  execution?: ExecutionSpec;
};

export type GovernedCommandResult = {
  run: HandoffRun;
  status: RunStatus;
  output: string;
  exitCode: number | undefined;
  receiptBundle: ReceiptBundle;
  verification: BundleVerification;
  pullResult?: PullResult;
};

export async function executeGovernedCommand(
  context: Handoff,
  options: GovernedCommandOptions
): Promise<GovernedCommandResult> {
  const execution = options.execution ?? {
    kind: "shell",
    script: options.command
  };
  const run = await context.continueIn(options.target, {
    task: options.command,
    agent: agents.command(),
    reason: options.reason,
    execution
  });
  const outcome = await run.wait({ timeoutMs: options.timeoutMs });
  if (outcome.status === "awaiting_approval") {
    throw new Error(
      `run ${run.runId} is blocked on consent (${outcome.consentRequirements.join("; ")}); ` +
        `approve it with: warrant approve ${run.runId}`
    );
  }

  const [output, exitCode, receiptBundle] = await Promise.all([
    run.sessionLog(),
    run.commandExitCode(),
    run.receipt()
  ]);
  const verification = verifyReceiptBundle(receiptBundle);
  const pullResult =
    options.pullResults === true && outcome.status === "completed"
      ? await run.pull()
      : undefined;

  return {
    run,
    status: outcome.status,
    output,
    exitCode,
    receiptBundle,
    verification,
    ...(pullResult ? { pullResult } : {})
  };
}
