/**
 * Pre-provision ("warm") the pinned `fusionkit` Python engine (WS8 one-install).
 *
 * The CLI spawns the synthesizer via `uvx fusionkit@<pin>`. The very first such
 * run pays a cold-start cost — `uv` resolves the package from PyPI, downloads
 * it (and its deps), and builds an isolated environment — which can be a
 * surprising multi-second/multi-MB stall right when the user expects their
 * coding agent to start. Warming that environment ahead of time (here, via
 * `fusionkit setup`, or on first run) moves that cost to an explicit,
 * progress-reported step.
 */
import { spawn } from "node:child_process";

import { createPresenter, dim, gray, yellow } from "@routekit/cli-ui";
import type { Presenter } from "@routekit/cli-ui";
import { distillLog } from "@routekit/runtime";

import { hasBinary } from "../shared/preflight.js";

import { FUSIONKIT_PYPI_VERSION, fusionkitWarmArgv } from "./env.js";

export type ProvisionOutcome =
  | { kind: "cached"; label: string }
  | { kind: "provisioned"; label: string }
  | { kind: "failed"; label: string; detail: string }
  | { kind: "no-runner"; runner: string };

/** A human label for what we provisioned (pinned PyPI build, or a dev checkout). */
function engineLabel(fusionkitDir?: string): string {
  return fusionkitDir !== undefined
    ? `fusionkit (local checkout ${fusionkitDir})`
    : `fusionkit@${FUSIONKIT_PYPI_VERSION}`;
}

/** The PATH binary the warm/run path will actually spawn for this engine. */
function runnerBinary(fusionkitDir?: string): string {
  return fusionkitDir !== undefined ? "uv" : "uvx";
}

type WarmResult = { code: number | null; output: string };

/** Run a warm argv to completion, streaming output lines to `onLine` (best-effort). */
function runWarm(
  argv: { command: string; args: string[]; cwd?: string },
  options: { onLine?: (line: string) => void; timeoutMs: number }
): Promise<WarmResult> {
  return new Promise<WarmResult>((resolve) => {
    const child = spawn(argv.command, argv.args, {
      ...(argv.cwd !== undefined ? { cwd: argv.cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let settled = false;
    const finish = (result: WarmResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, output: `${output}\n(timed out after ${options.timeoutMs}ms)` });
    }, options.timeoutMs);
    timer.unref();
    const onChunk = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      output += text;
      if (options.onLine !== undefined) {
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length > 0) options.onLine(trimmed);
        }
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.once("error", (error) => finish({ code: null, output: `${output}\n${String(error)}` }));
    child.once("close", (code) => finish({ code, output }));
  });
}

/**
 * Offline probe: is the pinned engine already resolved into the local `uv`
 * cache? A clean (offline) `--help` exits 0 only when nothing needs fetching.
 */
export async function engineCached(fusionkitDir?: string): Promise<boolean> {
  const { code } = await runWarm(fusionkitWarmArgv(fusionkitDir, { offline: true }), {
    timeoutMs: 30_000
  });
  return code === 0;
}

/**
 * Provision the engine headlessly. Returns `cached` immediately when it is
 * already warm (unless `force`), otherwise runs the online warm and reports
 * `provisioned`/`failed`. `no-runner` when `uv`/`uvx` is not on PATH.
 */
export async function provisionFusionEngine(options: {
  fusionkitDir?: string;
  force?: boolean;
  onLine?: (line: string) => void;
}): Promise<ProvisionOutcome> {
  const label = engineLabel(options.fusionkitDir);
  const runner = runnerBinary(options.fusionkitDir);
  if (!hasBinary(runner)) {
    return { kind: "no-runner", runner };
  }
  if (options.force !== true && (await engineCached(options.fusionkitDir))) {
    return { kind: "cached", label };
  }
  const argv = fusionkitWarmArgv(options.fusionkitDir);
  const result = await runWarm(argv, {
    timeoutMs: 600_000,
    ...(options.onLine !== undefined ? { onLine: options.onLine } : {})
  });
  if (result.code === 0) return { kind: "provisioned", label };
  return { kind: "failed", label, detail: distillLog(result.output) };
}

/**
 * Provision with a live task line and human-readable result lines (the
 * `fusionkit setup` warm path). Returns a process exit code (0 ok, 1 on
 * failure / missing runner).
 */
export async function provisionEngineWithProgress(
  options: {
    fusionkitDir?: string;
    force?: boolean;
  },
  presenter: Presenter = createPresenter()
): Promise<number> {
  const runner = runnerBinary(options.fusionkitDir);
  const label = `provisioning the fusion engine (${engineLabel(options.fusionkitDir)})`;
  if (!hasBinary(runner)) {
    const task = presenter.task(label);
    task.fail(`cannot provision: ${runner} is not on PATH`);
    presenter.line(
      `    ${yellow("→")} install uv (ships ${runner}): https://docs.astral.sh/uv/getting-started/installation/`
    );
    return 1;
  }

  const task = presenter.task(label);
  const outcome = await provisionFusionEngine({
    ...(options.fusionkitDir !== undefined ? { fusionkitDir: options.fusionkitDir } : {}),
    ...(options.force === true ? { force: true } : {}),
    onLine: (line) => {
      const tail = line.length > 60 ? `…${line.slice(line.length - 60)}` : line;
      task.update(`provisioning the fusion engine ${dim(`· ${tail}`)}`);
    }
  });

  switch (outcome.kind) {
    case "cached":
      task.succeed(`fusion engine ready ${dim(`(${outcome.label} already cached — offline-fast)`)}`);
      return 0;
    case "provisioned":
      task.succeed(`fusion engine provisioned ${dim(`(${outcome.label} warmed into the uv cache)`)}`);
      return 0;
    case "no-runner":
      task.fail(`cannot provision: ${outcome.runner} is not on PATH`);
      return 1;
    case "failed":
      task.fail(`could not provision ${outcome.label}`);
      presenter.line(`    ${gray(outcome.detail)}`);
      return 1;
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unhandled provision outcome ${JSON.stringify(exhaustive)}`);
    }
  }
}
