/**
 * Generic AI SDK harness session backend: drives one vendor agent harness
 * through the AI SDK harness abstraction (`HarnessAgent`) inside a sandbox,
 * under the same governed-session contract as every other backend.
 *
 * What varies between harnesses — which adapter runs, which sandbox provider
 * hosts it, which isolation tier the run is labeled with, and how credentials
 * map into the adapter's explicit auth — is captured by a `HarnessBinding`.
 * Everything that does *not* vary lives here once: workspace staging into the
 * sandbox, the structured transcript artifact, git-based mirror-back, the
 * boundary event, and delegation of non-matching runs to a fallback backend.
 *
 * Concrete bindings live alongside this file: `claudeCodeBinding` (Claude
 * Code in a Vercel Sandbox microVM) and `piBinding` (Pi on a local just-bash
 * sandbox driving a local model). A backend hosts exactly one binding plus a
 * fallback for everything else in its tier — the single sanctioned way to
 * combine behaviors within an isolation tier (see runner `runSession`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HarnessAgent } from "@ai-sdk/harness/agent";
import type { HarnessAgentAdapter, HarnessAgentSettings } from "@ai-sdk/harness/agent";
import type {
  AgentKind,
  NetworkPolicy,
  RunContract,
  SessionIsolation
} from "@fusionkit/protocol";
import { hashCanonical } from "@fusionkit/protocol";
import type { RunEvent } from "@fusionkit/protocol";
import {
  CapabilityMismatchError,
  executionHash,
  executionSpecFor,
  resolveSessionEnv
} from "@fusionkit/runner";
import type {
  BackendExecutionKind,
  SessionBackend,
  SessionBackendResult,
  SessionExecution
} from "@fusionkit/runner";
import {
  SANDBOX_IGNORED_DIRS,
  listWorkspaceFiles,
  shellQuote,
  writeMirroredFile
} from "@fusionkit/session-vercel-sandbox";

import { TranscriptRecorder } from "./transcript.js";

/**
 * The tool-safe sandbox session surface the harness framework hands to
 * `onSandboxSession` (an `Experimental_SandboxSession`). Derived from the
 * agent settings type so this package does not import `@ai-sdk/provider-utils`
 * directly.
 */
type SandboxFsSession = Parameters<
  NonNullable<HarnessAgentSettings["onSandboxSession"]>
>[0]["session"];

/**
 * A harness adapter regardless of its builtin tool set, typed from the agent
 * module itself so the seam always matches what `HarnessAgent` accepts.
 * (`HarnessV1`'s default `ToolSet` parameter rejects concrete adapters like
 * `createClaudeCode()`/`createPi()` because tool input schemas are not
 * assignable across the index signature; the AI SDK's own settings use the
 * same `any`-tools parameterization.)
 */
export type HarnessAdapter = HarnessAgentAdapter<any>;

/**
 * The sandbox provider type `HarnessAgent` expects, derived from its settings
 * rather than imported from `@ai-sdk/harness` directly: pnpm can instantiate
 * that package once per zod peer context, and deriving the type keeps this
 * seam pinned to the agent's own instance.
 */
export type HarnessSandboxProvider = HarnessAgentSettings["sandbox"];

export type CreateHarnessInput = {
  /** Resolved session env: the run's env policy plus released secrets. */
  env: Record<string, string>;
};

export type CreateSandboxProviderInput = {
  timeoutMs: number;
  /** Egress policy applied at the sandbox boundary, when the run declares one. */
  network?: NetworkPolicy;
};

/**
 * Everything a single harness contributes to the generic backend: which agent
 * kind it serves, the isolation tier its runs are labeled with, how to build
 * the adapter and the sandbox provider for a given session, and any
 * session-state directories that are runtime plumbing rather than workspace
 * output (excluded from both staging and mirror-back).
 */
export type HarnessBinding = {
  readonly agentKind: AgentKind;
  readonly isolation: SessionIsolation;
  // The factories may be async: a binding whose adapter or sandbox wrapper
  // eagerly pulls in a heavy, integration-gated host runtime (see the pi
  // binding) loads it lazily here rather than at module import.
  createHarness(input: CreateHarnessInput): HarnessAdapter | Promise<HarnessAdapter>;
  createSandboxProvider(
    input: CreateSandboxProviderInput
  ): HarnessSandboxProvider | Promise<HarnessSandboxProvider>;
  readonly extraIgnores?: readonly string[];
};

function posixJoin(base: string, rel: string): string {
  return `${base}/${rel.split("\\").join("/")}`;
}

/** True when the contract's execution is an agent run of the given kind. */
export function isAgentRunFor(contract: RunContract, kind: AgentKind): boolean {
  const spec = executionSpecFor(contract);
  return spec.kind === "agent" && spec.agent.kind === kind;
}

export class AiSdkHarnessBackend implements SessionBackend {
  readonly isolation: SessionIsolation;
  private readonly binding: HarnessBinding;
  private readonly fallback: SessionBackend;
  private readonly ignoredSegments: ReadonlySet<string>;

  constructor(input: { binding: HarnessBinding; fallback: SessionBackend }) {
    this.binding = input.binding;
    this.fallback = input.fallback;
    this.isolation = input.binding.isolation;
    this.ignoredSegments = new Set([
      ...SANDBOX_IGNORED_DIRS,
      ...(input.binding.extraIgnores ?? [])
    ]);
  }

  private isBindingRun(contract: RunContract): boolean {
    return isAgentRunFor(contract, this.binding.agentKind);
  }

  supports(kind: BackendExecutionKind, contract: RunContract): boolean {
    if (this.isBindingRun(contract)) return true;
    return this.fallback.supports ? this.fallback.supports(kind, contract) : true;
  }

  async execute(input: SessionExecution): Promise<SessionBackendResult> {
    if (!this.isBindingRun(input.contract)) {
      return this.fallback.execute(input);
    }
    return this.executeHarness(input);
  }

  private async executeHarness(input: SessionExecution): Promise<SessionBackendResult> {
    const { contract, repoDir, secrets, execution, emit } = input;
    const spec = executionSpecFor(contract);
    if (spec.kind !== "agent") {
      throw new CapabilityMismatchError("harness path requires an agent execution spec");
    }

    const env = resolveSessionEnv(execution.env, secrets);
    return runHarnessSession({
      binding: this.binding,
      prompt: spec.prompt,
      env,
      timeoutMs: execution.timeoutMs,
      ...(execution.logMaxBytes !== undefined ? { logMaxBytes: execution.logMaxBytes } : {}),
      network: contract.network,
      repoDir,
      emit,
      executionHash: executionHash(execution)
    });
  }
}

/**
 * One honest harness run: exactly what the execution needs, stated directly.
 * Callers holding a signed governance `RunContract` go through
 * {@link AiSdkHarnessBackend}, which extracts these values from it; callers
 * that have no contract (the fusion panel) pass the values here instead of
 * fabricating a contract document to satisfy the schema.
 */
export type HarnessSessionRun = {
  binding: HarnessBinding;
  prompt: string;
  /** Resolved session env delivered to the harness adapter (fail-closed). */
  env: Record<string, string>;
  timeoutMs: number;
  logMaxBytes?: number;
  /** Egress policy applied at the sandbox boundary, when the run declares one. */
  network?: NetworkPolicy;
  /** Materialized workspace on the host; the session tree is mirrored back onto it. */
  repoDir: string;
  emit?: (event: RunEvent) => void;
  /** Overrides the boundary event's argv hash (contract-backed callers). */
  executionHash?: string;
};

/** Execute one harness turn against a binding, without a governance contract. */
export async function runHarnessSession(run: HarnessSessionRun): Promise<SessionBackendResult> {
  const extraIgnores = run.binding.extraIgnores ?? [];
  const ignoredSegments = new Set([...SANDBOX_IGNORED_DIRS, ...extraIgnores]);
  const harness = await run.binding.createHarness({ env: run.env });
  const provider = await run.binding.createSandboxProvider({
    timeoutMs: run.timeoutMs,
    ...(run.network !== undefined ? { network: run.network } : {})
  });

  // One signal covers session creation, sandbox startup, and the turn.
  const abortSignal = AbortSignal.timeout(run.timeoutMs);

  let staged: { session: SandboxFsSession; workDir: string } | undefined;
  const agent = new HarnessAgent({
    harness,
    sandbox: provider,
    onSandboxSession: async ({ session, sessionWorkDir }) => {
      staged = { session, workDir: sessionWorkDir };
      for (const rel of listWorkspaceFiles(run.repoDir, extraIgnores)) {
        await session.writeBinaryFile({
          path: posixJoin(sessionWorkDir, rel),
          content: readFileSync(join(run.repoDir, rel))
        });
      }
    }
  });

  const transcript = new TranscriptRecorder();
  const session = await agent.createSession({ abortSignal });
  try {
    try {
      const result = await agent.stream({
        session,
        prompt: run.prompt,
        abortSignal
      });
      for await (const part of result.fullStream) {
        transcript.ingest(part);
      }
    } catch (error) {
      // A failed turn is still evidence: record it, mirror back whatever
      // the harness already changed, and report a non-zero exit code.
      transcript.fail(error);
    }

    if (staged) {
      await mirrorBack(staged.session, staged.workDir, run.repoDir, ignoredSegments);
    }

    const exitCode = transcript.exitCode();
    run.emit?.({
      type: "command.executed",
      argvHash:
        run.executionHash ??
        hashCanonical({
          kind: "harness",
          agent: run.binding.agentKind,
          prompt: run.prompt
        }),
      exitCode
    });
    return { exitCode, log: transcript.toBuffer(run.logMaxBytes) };
  } finally {
    await session.destroy().catch(() => undefined);
  }
}

/**
 * Mirror the session working tree back onto the local checkout so the runner's
 * standard git-based output collection sees the changes. The sandbox FS
 * surface has no directory listing, so the file list comes from one `find`
 * inside the sandbox; every path is validated before it is written inside the
 * local workspace.
 */
async function mirrorBack(
  session: SandboxFsSession,
  workDir: string,
  repoDir: string,
  ignoredSegments: ReadonlySet<string>
): Promise<void> {
  const listing = await session.run({
    command: `find ${shellQuote(workDir)} -type f`
  });
  if (listing.exitCode !== 0) {
    throw new CapabilityMismatchError(
      `harness mirror-back failed to list session files: ${listing.stderr}`
    );
  }
  for (const line of listing.stdout.split("\n")) {
    const remote = line.trim();
    if (!remote.startsWith(`${workDir}/`)) continue;
    const rel = remote.slice(workDir.length + 1);
    if (rel.split("/").some((segment) => ignoredSegments.has(segment))) continue;
    const content = await session.readBinaryFile({ path: remote });
    if (content === null) continue;
    writeMirroredFile(repoDir, rel, content);
  }
}

/** Host a single harness binding plus a fallback backend for its tier. */
export function harnessBackend(input: {
  binding: HarnessBinding;
  fallback: SessionBackend;
}): AiSdkHarnessBackend {
  return new AiSdkHarnessBackend(input);
}
