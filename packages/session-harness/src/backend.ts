/**
 * @warrant/session-harness — a session backend that drives the claude-code
 * harness through the AI SDK harness abstraction (`HarnessAgent` +
 * `@ai-sdk/harness-claude-code`) inside a Vercel Sandbox microVM, instead
 * of shelling out to a vendor CLI that would have to pre-exist in the VM.
 *
 * What this buys a governed run, over the plain vercel-sandbox backend:
 *
 *  - The harness adapter bootstraps the Claude Code runtime inside the
 *    sandbox itself (pinned bridge dependencies, frozen lockfile), so the
 *    microVM needs no pre-baked vendor tooling.
 *  - The session log artifact is the harness's *structured* event stream
 *    (tool calls, tool results, file-change notices, finish reasons) as
 *    JSONL — not a merged stdout blob. Boundary evidence stays owned by
 *    the runner: file.changed events still come from the git diff after
 *    mirror-back, and egress policy is still applied at the VM boundary
 *    from the signed contract, exactly as before.
 *  - Credentials flow from the secret broker into the adapter's *explicit*
 *    auth settings (see auth.ts); the adapter's host-environment fallback
 *    is suppressed, so runner-host credentials can never leak into a run.
 *
 * Status: experimental and integration-gated, like the plain vercel-sandbox
 * backend. It compiles against the real canary packages; running the real
 * path needs Vercel credentials plus a contract-released Anthropic or AI
 * Gateway credential. Non-claude-code executions are delegated unchanged to
 * a fallback backend (by default `vercelSandboxBackend()`), so a runner can
 * install this backend as its single "vercel-sandbox" tier.
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { HarnessAgent } from "@ai-sdk/harness/agent";
import type { HarnessAgentSettings } from "@ai-sdk/harness/agent";
import type { HarnessV1, HarnessV1SandboxProvider } from "@ai-sdk/harness";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createVercelSandbox } from "@ai-sdk/sandbox-vercel";
import type { ExecutionSpec, RunContract } from "@warrant/protocol";
import { defaultExecutionForContract, executionHash } from "@warrant/runner";
import type {
  BackendExecutionKind,
  SessionBackend,
  SessionBackendResult,
  SessionExecution
} from "@warrant/runner";
import {
  CapabilityError,
  toVercelNetwork,
  vercelSandboxBackend
} from "@warrant/session-vercel-sandbox";
import { parseWorkspaceRelativePath, resolveInsideWorkspace } from "@warrant/workspace";

import { claudeCodeAuthFromEnv } from "./auth.js";
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
 * A harness adapter regardless of its builtin tool set. The AI SDK's own
 * agent settings type uses the same `any`-tools parameterization
 * (`HarnessAgentAdapter<any>`); `HarnessV1`'s default `ToolSet` parameter
 * rejects concrete adapters like `createClaudeCode()` because tool input
 * schemas are not assignable across the index signature.
 */
export type HarnessAdapter = HarnessV1<any>;

export type CreateHarnessInput = {
  /** Resolved session env: contract env policy plus released secrets. */
  env: Record<string, string>;
  contract: RunContract;
};

export type CreateSandboxProviderInput = {
  contract: RunContract;
  timeoutMs: number;
};

export type AiSdkHarnessBackendOptions = {
  /** Sandbox runtime image for the harness bridge. Defaults to node24. */
  runtime?: string;
  /** Sandbox port the in-VM bridge listens on. Defaults to 4000. */
  bridgePort?: number;
  /** Vercel credentials; fall back to the ambient environment. */
  token?: string;
  teamId?: string;
  projectId?: string;
  /** Anthropic model id passed to the claude-code runtime. */
  model?: string;
  /** Cap on internal harness turns before yielding. */
  maxTurns?: number;
  /** Extended-thinking behavior of the underlying runtime. */
  thinking?: "off" | "on" | "adaptive";
  /** Max milliseconds to wait for the in-sandbox bridge to start. */
  startupTimeoutMs?: number;
  /**
   * Backend that executes everything this one does not (shell/argv
   * executions, other agent kinds). Defaults to `vercelSandboxBackend()`
   * with the same credentials, so installing this backend never narrows
   * what the "vercel-sandbox" tier could already run.
   */
  fallback?: SessionBackend;
  /**
   * Test/extension seam: supply the harness adapter. The default builds
   * `createClaudeCode` with explicit auth from the session env (fail-closed,
   * see auth.ts); overrides take on that responsibility themselves.
   */
  createHarness?: (input: CreateHarnessInput) => HarnessAdapter;
  /**
   * Test/extension seam: supply the sandbox provider. The default builds
   * `createVercelSandbox` with the contract's network policy applied at VM
   * creation; overrides take on that responsibility themselves.
   */
  createSandboxProvider?: (input: CreateSandboxProviderInput) => HarnessV1SandboxProvider;
};

const DEFAULT_RUNTIME = "node24";
const DEFAULT_BRIDGE_PORT = 4000;

// Not staged into the sandbox and not mirrored back: VCS metadata stays
// local (output is collected as a git diff on the runner side), dependency
// trees are reinstalled inside the VM when needed, and the harness's own
// session-state directories are runtime plumbing, not workspace output.
const IGNORED_SEGMENTS = new Set([".git", "node_modules", ".claude", ".agent-runs"]);

function listFiles(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_SEGMENTS.has(entry.name)) continue;
    if (entry.isDirectory()) {
      listFiles(root, join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(relative(root, join(dir, entry.name)));
    }
  }
  return out;
}

function posixJoin(base: string, rel: string): string {
  return `${base}/${rel.split("\\").join("/")}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/** The execution intent of the contract, whether explicit or defaulted. */
export function executionSpecFor(contract: RunContract): ExecutionSpec {
  return contract.execution ?? defaultExecutionForContract(contract);
}

/** True when the contract asks for the claude-code agent harness. */
export function isClaudeCodeAgentRun(contract: RunContract): boolean {
  const spec = executionSpecFor(contract);
  return spec.kind === "agent" && spec.agent.kind === "claude-code";
}

export class AiSdkHarnessBackend implements SessionBackend {
  readonly isolation = "vercel-sandbox" as const;
  private readonly options: AiSdkHarnessBackendOptions;
  private readonly fallback: SessionBackend;

  constructor(options: AiSdkHarnessBackendOptions = {}) {
    this.options = options;
    this.fallback =
      options.fallback ??
      vercelSandboxBackend({
        ...(options.token !== undefined ? { token: options.token } : {}),
        ...(options.teamId !== undefined ? { teamId: options.teamId } : {}),
        ...(options.projectId !== undefined ? { projectId: options.projectId } : {})
      });
  }

  supports(kind: BackendExecutionKind, contract: RunContract): boolean {
    if (isClaudeCodeAgentRun(contract)) return true;
    return this.fallback.supports ? this.fallback.supports(kind, contract) : true;
  }

  async execute(input: SessionExecution): Promise<SessionBackendResult> {
    if (!isClaudeCodeAgentRun(input.contract)) {
      return this.fallback.execute(input);
    }
    return this.executeHarness(input);
  }

  private async executeHarness(input: SessionExecution): Promise<SessionBackendResult> {
    const { contract, repoDir, secrets, execution, emit } = input;
    const spec = executionSpecFor(contract);
    if (spec.kind !== "agent") {
      throw new CapabilityError("harness path requires an agent execution spec");
    }

    // Resolve the session env exactly like the other backends: contract env
    // policy first, then released secrets by name, then placeholder
    // substitution for `env.secrets` mappings.
    const env = { ...execution.env };
    for (const secret of secrets) env[secret.name] = secret.value;
    for (const [key, value] of Object.entries(env)) {
      if (!value.startsWith("__WARRANT_SECRET__:")) continue;
      const secretName = value.slice("__WARRANT_SECRET__:".length);
      const secret = secrets.find((item) => item.name === secretName);
      if (secret) env[key] = secret.value;
    }

    const harness = (this.options.createHarness ?? this.defaultHarness)({ env, contract });
    const provider = (this.options.createSandboxProvider ?? this.defaultSandboxProvider)({
      contract,
      timeoutMs: execution.timeoutMs
    });

    // One signal covers session creation, the bridge startup, and the turn.
    const abortSignal = AbortSignal.timeout(execution.timeoutMs);

    let staged: { session: SandboxFsSession; workDir: string } | undefined;
    const agent = new HarnessAgent({
      harness,
      sandbox: provider,
      onSandboxSession: async ({ session, sessionWorkDir }) => {
        staged = { session, workDir: sessionWorkDir };
        for (const rel of listFiles(repoDir)) {
          await session.writeBinaryFile({
            path: posixJoin(sessionWorkDir, rel),
            content: readFileSync(join(repoDir, rel))
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
          prompt: spec.prompt,
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
        await mirrorBack(staged.session, staged.workDir, repoDir);
      }

      const exitCode = transcript.exitCode();
      emit({
        type: "command.executed",
        argvHash: executionHash(execution),
        exitCode
      });
      return { exitCode, log: transcript.toBuffer(execution.logMaxBytes) };
    } finally {
      await session.destroy().catch(() => undefined);
    }
  }

  private readonly defaultHarness = (input: CreateHarnessInput): HarnessAdapter => {
    const auth = claudeCodeAuthFromEnv(input.env);
    return createClaudeCode({
      auth,
      ...(this.options.model !== undefined ? { model: this.options.model } : {}),
      ...(this.options.maxTurns !== undefined ? { maxTurns: this.options.maxTurns } : {}),
      ...(this.options.thinking !== undefined ? { thinking: this.options.thinking } : {}),
      ...(this.options.startupTimeoutMs !== undefined
        ? { startupTimeoutMs: this.options.startupTimeoutMs }
        : {})
    });
  };

  private readonly defaultSandboxProvider = (
    input: CreateSandboxProviderInput
  ): HarnessV1SandboxProvider => {
    const token = this.options.token ?? process.env.VERCEL_TOKEN;
    if (!token) {
      throw new CapabilityError(
        "ai-sdk harness backend requires VERCEL_TOKEN (or an explicit token)"
      );
    }
    const teamId = this.options.teamId ?? process.env.VERCEL_TEAM_ID;
    const projectId = this.options.projectId ?? process.env.VERCEL_PROJECT_ID;
    return createVercelSandbox({
      token,
      ...(teamId !== undefined ? { teamId } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      runtime: this.options.runtime ?? DEFAULT_RUNTIME,
      timeout: input.timeoutMs,
      ports: [this.options.bridgePort ?? DEFAULT_BRIDGE_PORT],
      // Deny-by-default egress from the signed contract, applied at the VM
      // boundary. The bridge bootstrap and the model API are subject to it:
      // a contract that wants this path live must allow the registry and
      // api.anthropic.com (or the gateway host) explicitly.
      networkPolicy: toVercelNetwork(input.contract.network)
    });
  };
}

/**
 * Mirror the session working tree back onto the local checkout so the
 * runner's standard git-based output collection sees the changes. The
 * sandbox FS surface has no directory listing, so the file list comes from
 * one `find` inside the VM; every path is validated before it is written
 * inside the local workspace.
 */
async function mirrorBack(
  session: SandboxFsSession,
  workDir: string,
  repoDir: string
): Promise<void> {
  const listing = await session.run({
    command: `find ${shellQuote(workDir)} -type f`
  });
  if (listing.exitCode !== 0) {
    throw new CapabilityError(
      `harness mirror-back failed to list session files: ${listing.stderr}`
    );
  }
  for (const line of listing.stdout.split("\n")) {
    const remote = line.trim();
    if (!remote.startsWith(`${workDir}/`)) continue;
    const rel = remote.slice(workDir.length + 1);
    if (rel.split("/").some((segment) => IGNORED_SEGMENTS.has(segment))) continue;
    const safeRel = parseWorkspaceRelativePath(rel);
    const target = resolveInsideWorkspace(repoDir, safeRel);
    const content = await session.readBinaryFile({ path: remote });
    if (content === null) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/** Create an AI SDK harness session backend for a Warrant runner. */
export function aiSdkHarnessBackend(
  options: AiSdkHarnessBackendOptions = {}
): AiSdkHarnessBackend {
  return new AiSdkHarnessBackend(options);
}
