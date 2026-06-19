import type { RunContract, RunEvent, SessionIsolation } from "@fusionkit/protocol";
import { collectOutput } from "@fusionkit/workspace";
import type { WorkspaceOutput } from "@fusionkit/workspace";

import type { SessionBackend } from "./backend.js";
import { prepareExecution } from "./execution.js";
import { ProcessSessionBackend } from "./process-backend.js";

export type SessionResult = {
  exitCode: number;
  log: Buffer;
  output: WorkspaceOutput;
  isolation: SessionIsolation;
};

/**
 * Run the agent harness inside a governed session. The runner owns the
 * boundary plumbing (workspace materialization, output capture, events);
 * the selected backend owns only how the harness is isolated. An event is
 * emitted for every observable boundary action regardless of backend.
 */
export async function runSession(input: {
  contract: RunContract;
  repoDir: string;
  secrets: { name: string; value: string }[];
  mockScriptPath: string;
  emit: (event: RunEvent) => void;
  backends: SessionBackend[];
}): Promise<SessionResult> {
  const { contract, repoDir, secrets, mockScriptPath, emit, backends } = input;

  const requested = contract.isolation ?? "process";
  const matching = backends.filter((b) => b.isolation === requested);
  if (matching.length > 1) {
    // Fail fast instead of silently letting the first registration shadow
    // the rest: composite backends (e.g. the AI SDK harness driver, which
    // embeds the plain vercel-sandbox backend as its fallback) are the one
    // sanctioned way to combine behaviors within a tier.
    throw new CapabilityMismatchError(
      `runner has ${matching.length} backends for isolation "${requested}"; register exactly one per tier`
    );
  }
  const backend: SessionBackend | undefined =
    matching[0] ?? (requested === "process" ? new ProcessSessionBackend() : undefined);
  if (!backend) {
    throw new CapabilityMismatchError(
      `runner has no backend for isolation "${requested}"`
    );
  }
  const execution = prepareExecution({ contract, mockScriptPath });
  if (backend.supports && !backend.supports(execution.kind, contract)) {
    throw new CapabilityMismatchError(
      `backend "${requested}" cannot run ${execution.kind} execution for agent "${contract.agent.kind}"`
    );
  }

  const result = await backend.execute({
    contract,
    repoDir,
    secrets,
    execution,
    emit
  });

  const output = collectOutput(repoDir, contract.workspace.baseRef);
  for (const file of output.changedFiles) {
    emit({ type: "file.changed", path: file.path, contentHash: file.contentHash });
  }

  return {
    exitCode: result.exitCode,
    log: result.log,
    output,
    isolation: backend.isolation
  };
}

/** A requested isolation tier or agent is not available on this runner. */
export class CapabilityMismatchError extends Error {
  readonly code = "capability_mismatch" as const;
  constructor(message: string) {
    super(message);
    this.name = "CapabilityMismatchError";
  }
}
