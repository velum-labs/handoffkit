import { verifyReceiptBundle } from "@fusionkit/protocol";
import type {
  ActorRef,
  BundleVerification,
  ExecutionSpec,
  ReceiptBundle,
  RunStatus,
  SessionIsolation
} from "@fusionkit/protocol";
import type { PlaneClient } from "@fusionkit/sdk";
import type { PullResult } from "@fusionkit/workspace";

import { agents } from "./agents.js";
import { handoff } from "./handoff.js";
import type { Handoff } from "./handoff.js";
import type { ContinuationPolicy } from "./policy.js";
import type { HandoffRun } from "./run.js";
import type { RuntimeTarget } from "./targets.js";

/**
 * The one configuration shape for adapters that run the "command" harness
 * over governed sessions (the AI SDK remote tools and the compute surface
 * extend this rather than redeclaring it).
 */
export type CommandHarnessConfig = {
  /** Local git workspace whose state the governed session materializes. */
  workspace: string;
  plane: PlaneClient | { url: string; adminToken: string };
  /** Runner pool that executes the commands. */
  pool: string;
  actor?: ActorRef;
  policy?: ContinuationPolicy;
  secrets?: string[];
  allowHosts?: string[];
  allowUntracked?: string[];
  /** Requested session isolation for command runs. Defaults to "process". */
  session?: SessionIsolation;
  /** Per-command wait ceiling. Defaults to 5 minutes. */
  timeoutMs?: number;
};

/**
 * Build the continuation context every command-harness adapter shares:
 * a `handoff(...)` bound to the command agent, with the optional fields
 * spread only when present.
 */
export function createCommandContext(config: CommandHarnessConfig): Handoff {
  return handoff({
    workspace: config.workspace,
    plane: config.plane,
    agent: agents.command(),
    ...(config.actor ? { actor: config.actor } : {}),
    ...(config.policy ? { policy: config.policy } : {}),
    ...(config.secrets ? { secrets: config.secrets } : {}),
    ...(config.allowHosts ? { allowHosts: config.allowHosts } : {}),
    ...(config.allowUntracked ? { allowUntracked: config.allowUntracked } : {})
  });
}

export type GovernedCommandOptions = {
  command: string;
  target: RuntimeTarget;
  reason: string;
  timeoutMs: number;
  pullResults?: boolean;
  execution?: ExecutionSpec;
  session?: SessionIsolation;
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

/**
 * The receipt-backed evidence record adapters keep for every governed
 * command: run id, terminal status, contract hash, and the offline
 * verification verdict. Adapter-specific fields (tool name, sandbox id)
 * are intersected on by the caller.
 */
export type GovernedRunRecord = {
  command: string;
  runId: string;
  status: RunStatus;
  exitCode?: number;
  contractHash: string;
  /** Actual runner isolation recorded in the receipt. */
  isolation?: SessionIsolation;
  /** Offline verification result of the receipt bundle for this command. */
  receiptVerified: boolean;
  pullMode?: PullResult["mode"];
};

/** Distill a governed command result into its evidence record. */
export function toGovernedRunRecord(
  command: string,
  result: GovernedCommandResult
): GovernedRunRecord {
  return {
    command,
    runId: result.run.runId,
    status: result.status,
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    contractHash: result.receiptBundle.receipt.contractHash,
    ...(result.receiptBundle.receipt.runner.isolation
      ? { isolation: result.receiptBundle.receipt.runner.isolation }
      : {}),
    receiptVerified: result.verification.ok,
    ...(result.pullResult ? { pullMode: result.pullResult.mode } : {})
  };
}

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
    execution,
    ...(options.session ? { session: options.session } : {})
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
