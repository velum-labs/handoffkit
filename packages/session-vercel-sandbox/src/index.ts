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
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type { NetworkPolicy as WarrantNetworkPolicy } from "@warrant/protocol";
import type {
  BackendExecutionKind,
  SessionBackend,
  SessionBackendResult,
  SessionExecution
} from "@warrant/runner";
import { executionHash } from "@warrant/runner";
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

// Not mirrored into the sandbox: VCS metadata stays local (output is
// collected as a git diff on the runner side) and dependency trees are
// reinstalled inside the VM when the task needs them.
const IGNORED_DIRS = new Set([".git", "node_modules"]);

/** Defaults for the microVM; both are overridable via VercelSandboxOptions. */
const DEFAULT_WORKDIR = "/warrant/workspace";
const DEFAULT_RUNTIME = "node22";

/**
 * Quote a value for POSIX sh: single quotes, with embedded single quotes
 * rendered as '\''. Unlike double quotes, nothing inside single quotes is
 * expanded, so secret values containing $, backticks, or quotes are inert.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

function listFiles(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      listFiles(root, join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(relative(root, join(dir, entry.name)));
    }
  }
  return out;
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

  private credentials(): { token: string; teamId?: string; projectId?: string } {
    const token = this.options.token ?? process.env.VERCEL_TOKEN;
    if (!token) {
      throw new CapabilityError(
        "vercel-sandbox backend requires VERCEL_TOKEN (or an explicit token)"
      );
    }
    return {
      token,
      ...(this.options.teamId ?? process.env.VERCEL_TEAM_ID
        ? { teamId: this.options.teamId ?? process.env.VERCEL_TEAM_ID }
        : {}),
      ...(this.options.projectId ?? process.env.VERCEL_PROJECT_ID
        ? { projectId: this.options.projectId ?? process.env.VERCEL_PROJECT_ID }
        : {})
    };
  }

  async execute(input: SessionExecution): Promise<SessionBackendResult> {
    const { contract, repoDir, secrets, execution, emit } = input;
    const creds = this.credentials();
    const workdir = this.options.workdir ?? DEFAULT_WORKDIR;
    const runtime = this.options.runtime ?? DEFAULT_RUNTIME;

    const sandbox = await Sandbox.create({
      ...creds,
      runtime,
      timeout: execution.timeoutMs,
      networkPolicy: toVercelNetwork(contract.network)
    });

    try {
      const inputFiles = listFiles(repoDir);
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
      const env = { ...execution.env };
      for (const secret of secrets) env[secret.name] = secret.value;
      for (const [key, value] of Object.entries(env)) {
        if (!value.startsWith("__WARRANT_SECRET__:")) continue;
        const secretName = value.slice("__WARRANT_SECRET__:".length);
        const secret = secrets.find((item) => item.name === secretName);
        if (secret) env[key] = secret.value;
      }
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

/** Mirror the sandbox working tree back onto the local workspace. */
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
      if (IGNORED_DIRS.has(name)) continue;
      const remote = `${dir}/${name}`;
      const info = await sandbox.fs.stat(remote);
      if (info.isDirectory()) {
        await walk(remote);
        continue;
      }
      const rel = remote.slice(workdir.length + 1);
      const safeRel = parseWorkspaceRelativePath(rel);
      const target = resolveInsideWorkspace(repoDir, safeRel);
      const buffer = await sandbox.fs.readFile(remote);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buffer);
    }
  };
  await walk(workdir);
}

/** Requested capability (credentials, runtime) is unavailable. */
export class CapabilityError extends Error {
  readonly code = "capability_mismatch" as const;
  constructor(message: string) {
    super(message);
    this.name = "CapabilityError";
  }
}

/** Create a Vercel Sandbox session backend for a Warrant runner. */
export function vercelSandboxBackend(
  options: VercelSandboxOptions = {}
): VercelSandboxBackend {
  return new VercelSandboxBackend(options);
}
