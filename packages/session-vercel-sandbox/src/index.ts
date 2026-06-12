/**
 * @warrant/session-vercel-sandbox — a session backend that runs each
 * governed session inside a Vercel Sandbox (a Firecracker microVM).
 *
 * This is the strongest isolation tier in the repo: VM-level separation
 * on the same infrastructure that powers Vercel's build system, with
 * domain-based egress policy applied at the VM boundary rather than via
 * environment variables a binary could ignore.
 *
 * Status: experimental and integration-gated. It compiles against the
 * real @vercel/sandbox types, but running it requires Vercel credentials
 * (VERCEL_TOKEN / VERCEL_TEAM_ID / VERCEL_PROJECT_ID, or an OIDC token in
 * a Vercel environment). Without them, `vercelSandboxBackend()` still
 * constructs; `execute` throws a clear capability error. The kernel and
 * the other backends do not depend on it.
 *
 * This module also owns the sandbox-shaped helpers (file listing, shell
 * quoting, mirror-back writes, credential resolution) shared with
 * `@warrant/session-harness`, which drives the same microVM tier through
 * the AI SDK harness bridge.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type { NetworkPolicy as WarrantNetworkPolicy } from "@warrant/protocol";
import type {
  BackendExecutionKind,
  SessionBackend,
  SessionBackendResult,
  SessionExecution
} from "@warrant/runner";
import { CapabilityMismatchError, executionHash, resolveSessionEnv } from "@warrant/runner";
import { parseWorkspaceRelativePath, resolveInsideWorkspace } from "@warrant/workspace";
import { Sandbox } from "@vercel/sandbox";
import type { NetworkPolicy as VercelNetworkPolicy } from "@vercel/sandbox";

export type VercelSandboxOptions = {
  /** Sandbox runtime image. Defaults to node22. */
  runtime?: string;
  /** Working directory inside the VM. Defaults to /warrant/workspace. */
  workdir?: string;
  /** Credentials; falls back to the ambient Vercel environment. */
  token?: string;
  teamId?: string;
  projectId?: string;
};

/**
 * Directory names never staged into a sandbox and never mirrored back:
 * VCS metadata stays local (output is collected as a git diff on the
 * runner side) and dependency trees are reinstalled inside the VM when
 * the task needs them. Backends with runtime-specific state directories
 * extend this set at the call site.
 */
export const SANDBOX_IGNORED_DIRS: ReadonlySet<string> = new Set([".git", "node_modules"]);

/** Defaults for the microVM; both are overridable via VercelSandboxOptions. */
const DEFAULT_WORKDIR = "/warrant/workspace";
const DEFAULT_RUNTIME = "node22";

/**
 * Quote a value for POSIX sh: single quotes, with embedded single quotes
 * rendered as '\''. Unlike double quotes, nothing inside single quotes is
 * expanded, so secret values containing $, backticks, or quotes are inert.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * List a workspace's files as relative paths, skipping the shared ignored
 * directories plus any backend-specific extras. The one walker used to
 * stage workspaces into sandboxes.
 */
export function listWorkspaceFiles(
  root: string,
  extraIgnores: Iterable<string> = []
): string[] {
  const ignored = new Set([...SANDBOX_IGNORED_DIRS, ...extraIgnores]);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(relative(root, join(dir, entry.name)));
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Write one mirrored-back sandbox file into the local checkout, with the
 * path validated against escape before anything touches the filesystem.
 * Shared by every sandbox-shaped backend so mirror-back path safety lives
 * in exactly one place.
 */
export function writeMirroredFile(
  repoDir: string,
  rel: string,
  content: Uint8Array
): void {
  const safeRel = parseWorkspaceRelativePath(rel);
  const target = resolveInsideWorkspace(repoDir, safeRel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/**
 * Resolve Vercel credentials from explicit options or the ambient
 * environment, failing closed (capability error) when no token exists.
 */
export function vercelCredentialsFromEnv(
  options: { token?: string; teamId?: string; projectId?: string } = {}
): { token: string; teamId?: string; projectId?: string } {
  const token = options.token ?? process.env.VERCEL_TOKEN;
  if (!token) {
    throw new CapabilityMismatchError(
      "vercel sandbox requires VERCEL_TOKEN (or an explicit token)"
    );
  }
  const teamId = options.teamId ?? process.env.VERCEL_TEAM_ID;
  const projectId = options.projectId ?? process.env.VERCEL_PROJECT_ID;
  return {
    token,
    ...(teamId !== undefined ? { teamId } : {}),
    ...(projectId !== undefined ? { projectId } : {})
  };
}

/** Map a Warrant network policy to a Vercel Sandbox network policy. */
export function toVercelNetwork(
  policy: WarrantNetworkPolicy
): VercelNetworkPolicy {
  if (!policy.defaultDeny) return "allow-all";
  if (policy.allowHosts.length === 0) return "deny-all";
  // Domain allowlist; everything else is denied by default.
  return { allow: policy.allowHosts };
}

export class VercelSandboxBackend implements SessionBackend {
  readonly isolation = "vercel-sandbox" as const;
  private readonly options: VercelSandboxOptions;

  constructor(options: VercelSandboxOptions = {}) {
    this.options = options;
  }

  supports(
    _kind: BackendExecutionKind,
    contract: SessionExecution["contract"]
  ): boolean {
    // The microVM has a real OS, so it can host real vendor CLIs and the
    // command harness. (The node-based mock is for the in-process tests.)
    return contract.agent.kind !== "mock";
  }

  async execute(input: SessionExecution): Promise<SessionBackendResult> {
    const { contract, repoDir, secrets, execution, emit } = input;
    const creds = vercelCredentialsFromEnv(this.options);
    const workdir = this.options.workdir ?? DEFAULT_WORKDIR;
    const runtime = this.options.runtime ?? DEFAULT_RUNTIME;

    const sandbox = await Sandbox.create({
      ...creds,
      runtime,
      timeout: execution.timeoutMs,
      networkPolicy: toVercelNetwork(contract.network)
    });

    try {
      const inputFiles = listWorkspaceFiles(repoDir);
      if (inputFiles.length > 0) {
        await sandbox.writeFiles(
          inputFiles.map((rel) => ({
            path: join(workdir, rel),
            content: readFileSync(join(repoDir, rel))
          }))
        );
      }

      // Secrets are injected as single-quoted exports: shellQuote renders
      // values inert to expansion, so $, backticks, and quotes pass through.
      const env = resolveSessionEnv(execution.env, secrets);
      const envPrefix = Object.entries(env)
        .map(([name, value]) => `export ${name}=${shellQuote(value)}; `)
        .join("");
      const script =
        execution.kind === "shell"
          ? execution.script
          : `${shellQuote(execution.cmd)} ${execution.args.map(shellQuote).join(" ")}`;
      const result = await sandbox.runCommand("sh", [
        "-c",
        `cd ${shellQuote(workdir)} && ${envPrefix}${script}`
      ]);

      emit({
        type: "command.executed",
        argvHash: executionHash(execution),
        exitCode: result.exitCode
      });

      await mirrorBack(sandbox, workdir, repoDir);

      const [stdout, stderr] = await Promise.all([
        result.stdout(),
        result.stderr()
      ]);
      const log = Buffer.from(stdout + stderr, "utf8");
      return { exitCode: result.exitCode, log };
    } finally {
      await sandbox.stop().catch(() => undefined);
    }
  }
}

/**
 * Mirror the sandbox workdir back onto the local checkout so the runner's
 * standard git-based output collection sees the changes. A per-file walk is
 * the operation the sandbox FS API supports (there is no bulk download),
 * and the file count is bounded by the workspace that was staged in.
 */
async function mirrorBack(
  sandbox: Sandbox,
  workdir: string,
  repoDir: string
): Promise<void> {
  const walk = async (dir: string): Promise<void> => {
    const names = await sandbox.fs.readdir(dir);
    for (const name of names) {
      if (SANDBOX_IGNORED_DIRS.has(name)) continue;
      const remote = `${dir}/${name}`;
      const info = await sandbox.fs.stat(remote);
      if (info.isDirectory()) {
        await walk(remote);
        continue;
      }
      const rel = remote.slice(workdir.length + 1);
      const buffer = await sandbox.fs.readFile(remote);
      writeMirroredFile(repoDir, rel, buffer);
    }
  };
  await walk(workdir);
}

/** Create a Vercel Sandbox session backend for a Warrant runner. */
export function vercelSandboxBackend(
  options: VercelSandboxOptions = {}
): VercelSandboxBackend {
  return new VercelSandboxBackend(options);
}
