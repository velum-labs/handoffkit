import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { agents, Handoff, handoff, targets } from "@warrant/handoff";
import type { ContinuationPolicy } from "@warrant/handoff";
import { verifyReceiptBundle } from "@warrant/protocol";
import type { ActorRef, RunStatus } from "@warrant/protocol";
import { PlaneClient } from "@warrant/sdk";

export type GovernedComputeConfig = {
  /** Local git workspace that backs the sandbox. The adapter commits to it. */
  workspace: string;
  plane: PlaneClient | { url: string; adminToken: string };
  /** Runner pool that executes commands. */
  pool: string;
  actor?: ActorRef;
  policy?: ContinuationPolicy;
  secrets?: string[];
  allowHosts?: string[];
  /**
   * Untracked-file capture allowlist. Defaults to everything ("**"), because
   * a sandbox is expected to see the files staged into it; secret-pattern
   * denials still apply and are recorded in the manifest.
   */
  allowUntracked?: string[];
  /** Per-command wait ceiling. Defaults to 5 minutes. */
  timeoutMs?: number;
};

export type CommandResult = {
  runId: string;
  status: RunStatus;
  exitCode: number | undefined;
  output: string;
};

export type SandboxRunRecord = {
  sandboxId: string;
  command: string;
  runId: string;
  status: RunStatus;
  exitCode?: number;
  contractHash: string;
  receiptVerified: boolean;
};

export type GovernedCompute = {
  sandbox: {
    create(): Promise<GovernedSandbox>;
  };
};

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/** Wiring for a sandbox: a continuation context plus its execution pool. */
export type SandboxBinding = {
  context: Handoff;
  pool: string;
  timeoutMs?: number;
};

export class GovernedSandbox {
  readonly sandboxId: string;
  readonly filesystem: {
    writeFile(path: string, content: string): Promise<void>;
    readFile(path: string): Promise<string>;
    exists(path: string): Promise<boolean>;
  };
  private readonly context: Handoff;
  private readonly pool: string;
  private readonly timeoutMs: number;
  private readonly workspaceDir: string;
  private readonly records: SandboxRunRecord[] = [];
  private destroyed = false;

  constructor(binding: SandboxBinding) {
    this.sandboxId = `sbx_${randomUUID()}`;
    this.context = binding.context;
    this.pool = binding.pool;
    this.timeoutMs = binding.timeoutMs ?? 5 * 60 * 1000;
    this.workspaceDir = binding.context.workspacePath;
    this.filesystem = {
      writeFile: async (path, content) => {
        this.assertLive();
        const target = this.resolveInside(path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      },
      readFile: async (path) => {
        this.assertLive();
        return readFileSync(this.resolveInside(path), "utf8");
      },
      exists: async (path) => {
        this.assertLive();
        return existsSync(this.resolveInside(path));
      }
    };
  }

  private assertLive(): void {
    if (this.destroyed) {
      throw new Error(`sandbox ${this.sandboxId} has been destroyed`);
    }
  }

  private resolveInside(path: string): string {
    const target = resolve(this.workspaceDir, path);
    if (target !== this.workspaceDir && !target.startsWith(this.workspaceDir + sep)) {
      throw new Error(`path escapes the sandbox workspace: ${path}`);
    }
    return target;
  }

  /**
   * Commit staged inputs (and prior outputs) so the next capture is clean at
   * a fresh base ref; that lets the post-run pull apply on the fast path.
   */
  private commitIfDirty(message: string): void {
    git(this.workspaceDir, ["add", "-A"]);
    const dirty = git(this.workspaceDir, ["status", "--porcelain"]).trim();
    if (dirty.length === 0) return;
    git(this.workspaceDir, [
      "-c",
      "user.name=warrant-sandbox",
      "-c",
      "user.email=sandbox@warrant.local",
      "commit",
      "--quiet",
      "-m",
      message
    ]);
  }

  /** Execute one command in a fresh governed session and pull its output. */
  async runCommand(command: string): Promise<CommandResult> {
    this.assertLive();
    this.commitIfDirty(`sandbox ${this.sandboxId}: stage state`);

    const run = await this.context.continueIn(targets.pool(this.pool), {
      task: command,
      agent: agents.command(),
      reason: `sandbox ${this.sandboxId} command`
    });
    const outcome = await run.wait({ timeoutMs: this.timeoutMs });
    if (outcome.status === "awaiting_approval") {
      throw new Error(
        `run ${run.runId} is blocked on consent (${outcome.consentRequirements.join("; ")}); ` +
          `approve it with: warrant approve ${run.runId}`
      );
    }

    const [output, exitCode, bundle] = await Promise.all([
      run.sessionLog(),
      run.commandExitCode(),
      run.receipt()
    ]);
    const verification = verifyReceiptBundle(bundle);
    if (outcome.status === "completed") {
      await run.pull();
    }

    this.records.push({
      sandboxId: this.sandboxId,
      command,
      runId: run.runId,
      status: outcome.status,
      ...(exitCode !== undefined ? { exitCode } : {}),
      contractHash: bundle.receipt.contractHash,
      receiptVerified: verification.ok
    });

    return { runId: run.runId, status: outcome.status, exitCode, output };
  }

  /** One record per executed command, each backed by a signed receipt. */
  runs(): SandboxRunRecord[] {
    return [...this.records];
  }

  /** The underlying continuation context (trace, lastEnvelope, …). */
  get handoffContext(): Handoff {
    return this.context;
  }

  /**
   * Stop accepting operations. Sessions are already ephemeral; what remains
   * is the workspace state and the receipts, which is the point.
   */
  destroy(): Promise<void> {
    this.destroyed = true;
    return Promise.resolve();
  }
}

/** Create a ComputeSDK-shaped compute surface over governed sessions. */
export function governedCompute(config: GovernedComputeConfig): GovernedCompute {
  return {
    sandbox: {
      create: () => {
        const context = handoff({
          workspace: resolve(config.workspace),
          plane: config.plane,
          agent: agents.command(),
          allowUntracked: config.allowUntracked ?? ["**"],
          ...(config.actor ? { actor: config.actor } : {}),
          ...(config.policy ? { policy: config.policy } : {}),
          ...(config.secrets ? { secrets: config.secrets } : {}),
          ...(config.allowHosts ? { allowHosts: config.allowHosts } : {})
        });
        return Promise.resolve(
          new GovernedSandbox({
            context,
            pool: config.pool,
            ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {})
          })
        );
      }
    }
  };
}

/**
 * Attach the compute surface to an existing continuation context — the
 * golden-shape composition. Sandboxes created here share the context's
 * workspace, policy, and trace, so tool calls, continuations, and sandbox
 * commands all land in one explainable history:
 *
 *   const h = withCompute(handoff({ workspace, plane, policy }), { pool });
 *   const sandbox = await h.compute.sandbox.create();
 */
export function withCompute<H extends Handoff>(
  h: H,
  options: { pool: string; timeoutMs?: number }
): H & { compute: GovernedCompute } {
  const compute: GovernedCompute = {
    sandbox: {
      create: () =>
        Promise.resolve(
          new GovernedSandbox({
            context: h,
            pool: options.pool,
            ...(options.timeoutMs !== undefined
              ? { timeoutMs: options.timeoutMs }
              : {})
          })
        )
    }
  };
  return Object.assign(h, { compute });
}
