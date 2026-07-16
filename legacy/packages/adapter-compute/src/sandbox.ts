import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  createCommandContext,
  executeGovernedCommand,
  Handoff,
  targets,
  toGovernedRunRecord
} from "@fusionkit/handoff";
import type { CommandHarnessConfig, GovernedRunRecord } from "@fusionkit/handoff";
import type { RunStatus, SessionIsolation } from "@fusionkit/protocol";
import { DEFAULT_RUNTIME_TIMEOUTS } from "@routekit/runtime";
import { gitText, resolveInsideWorkspace } from "@fusionkit/workspace";

/**
 * The shared command-harness configuration, with one compute-specific
 * default applied at sandbox creation: untracked-file capture allows
 * everything ("**"), because a sandbox is expected to see the files staged
 * into it; secret-pattern denials still apply and are recorded in the
 * manifest.
 */
export type GovernedComputeConfig = CommandHarnessConfig;

export type CommandResult = {
  runId: string;
  status: RunStatus;
  exitCode: number | undefined;
  output: string;
};

export type SandboxRunRecord = GovernedRunRecord & {
  sandboxId: string;
};

export type GovernedCompute = {
  sandbox: {
    create(): Promise<GovernedSandbox>;
  };
};

function git(cwd: string, args: string[]): string {
  return gitText(cwd, args);
}

/** Default per-command wait ceiling for sandbox commands. */
const DEFAULT_SANDBOX_TIMEOUT_MS = DEFAULT_RUNTIME_TIMEOUTS.sandboxCommand;
/** Identity used for the sandbox's staging commits. */
const SANDBOX_COMMITTER = {
  name: "warrant-sandbox",
  email: "sandbox@warrant.local"
};

/** Wiring for a sandbox: a continuation context plus its execution pool. */
export type SandboxBinding = {
  context: Handoff;
  pool: string;
  timeoutMs?: number;
  session?: SessionIsolation;
  committer?: { name: string; email: string };
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
  private readonly session?: SessionIsolation;
  private readonly committer: { name: string; email: string };
  private readonly workspaceDir: string;
  private readonly records: SandboxRunRecord[] = [];
  private destroyed = false;

  constructor(binding: SandboxBinding) {
    this.sandboxId = `sbx_${randomUUID()}`;
    this.context = binding.context;
    this.pool = binding.pool;
    this.timeoutMs = binding.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;
    this.session = binding.session;
    this.committer = binding.committer ?? SANDBOX_COMMITTER;
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
    return resolveInsideWorkspace(this.workspaceDir, path);
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
      `user.name=${this.committer.name}`,
      "-c",
      `user.email=${this.committer.email}`,
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

    const result = await executeGovernedCommand(this.context, {
      command,
      target: targets.pool(this.pool),
      reason: `sandbox ${this.sandboxId} command`,
      timeoutMs: this.timeoutMs,
      pullResults: true,
      ...(this.session ? { session: this.session } : {})
    });

    this.records.push({
      sandboxId: this.sandboxId,
      ...toGovernedRunRecord(command, result)
    });

    return {
      runId: result.run.runId,
      status: result.status,
      exitCode: result.exitCode,
      output: result.output
    };
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
        const context = createCommandContext({
          ...config,
          workspace: resolve(config.workspace),
          allowUntracked: config.allowUntracked ?? ["**"]
        });
        return Promise.resolve(
          new GovernedSandbox({
            context,
            pool: config.pool,
            ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
            ...(config.session ? { session: config.session } : {})
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
  options: { pool: string; timeoutMs?: number; session?: SessionIsolation }
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
              : {}),
            ...(options.session ? { session: options.session } : {})
          })
        )
    }
  };
  return Object.assign(h, { compute });
}
