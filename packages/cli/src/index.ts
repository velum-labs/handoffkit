#!/usr/bin/env node
/**
 * Entry point for the FusionKit command line package. The executable itself lives in src/index.ts, while cli.ts builds the Commander command tree.
 */
import "./quiet-warnings.js";
import { PolicyDeniedError } from "@fusionkit/protocol";
// Importing the cleanup registry installs the process-wide SIGINT/SIGTERM/exit
// handlers once, so anything registered during a run (worktrees, supervised
// process groups) is torn down on interrupt or normal exit.
import { registerCleanup, runCleanups } from "@velum-labs/routekit-runtime";

import { configureBrand, uiStream } from "@velum-labs/routekit-cli-ui";
import { CommanderError, type Command } from "commander";

import { buildProgram } from "./cli.js";
import {
  configuredDefaultToolArgv,
  runCommandPalette
} from "./commands/palette.js";
import {
  CliError,
  emitJson,
  isJsonMode,
  readPackageVersion,
  renderCliError
} from "@velum-labs/routekit-cli-core";
import { PreflightError } from "./shared/preflight.js";
import { captureCommand, initTelemetry, shutdownTelemetry } from "./telemetry/telemetry.js";

configureBrand({ name: "fusionkit", tagline: "real model fusion behind your coding agent" });
if (process.env.FUSIONKIT_NO_TUI === "1") process.env.ROUTEKIT_NO_TUI = "1";

/** Warn once when legacy WARRANT_* env vars are still set in the shell. */
function warnLegacyWarrantEnv(): void {
  if (Object.keys(process.env).some((key) => key.startsWith("WARRANT_"))) {
    process.stderr.write(
      "warning: WARRANT_* environment variables are no longer read; use FUSIONKIT_*\n"
    );
  }
}

/** Space-joined command path from the root program down to the action command. */
function commandPath(actionCommand: Command): string {
  const parts: string[] = [];
  let cmd: Command | undefined = actionCommand;
  while (cmd !== undefined && cmd.parent != null) {
    parts.unshift(cmd.name());
    cmd = cmd.parent;
  }
  return parts.join(" ");
}

function inferCommandFromArgv(): string {
  const argv = process.argv.slice(2);
  return argv.find((arg) => !arg.startsWith("-")) ?? "palette";
}

function renderJsonError(code: string, message: string, details?: string[]): number {
  emitJson({ error: { code, message, ...(details !== undefined ? { details } : {}) } });
  return code === "policy-denied" ? 2 : 1;
}

function classifyAndRenderError(error: unknown): number {
  if (error instanceof PolicyDeniedError) {
    if (isJsonMode()) return renderJsonError("policy-denied", "policy denied (fail closed)", [...error.reasons]);
    return renderCliError(
      new CliError({
        code: "policy-denied",
        message: "policy denied (fail closed)",
        details: [...error.reasons],
        exitCode: 2
      })
    );
  }
  if (error instanceof PreflightError) {
    if (isJsonMode()) return renderJsonError("preflight", error.message);
    const [first, ...rest] = error.message.split("\n");
    return renderCliError(
      new CliError({
        code: "preflight",
        message: first ?? error.message,
        ...(rest.length > 0 ? { details: rest.map((line) => line.replace(/^\s+-\s*/, "")) } : {}),
        tryCommand: "fusionkit doctor"
      })
    );
  }
  if (error instanceof CliError) return renderCliError(error);
  if (error instanceof CommanderError) return error.exitCode;
  const message = error instanceof Error ? error.message : String(error);
  if (isJsonMode()) return renderJsonError("error", message);
  uiStream().write(`error: ${message}\n`);
  return 1;
}

function exitKindFor(caughtError: unknown | undefined): string {
  const code = process.exitCode;
  if (code === undefined || code === 0) return "ok"; // includes --help/--version
  if (caughtError !== undefined) {
    return caughtError instanceof Error ? caughtError.constructor.name : "error";
  }
  return "error";
}

async function main(): Promise<void> {
  warnLegacyWarrantEnv();
  initTelemetry();
  const startedAt = Date.now();
  const argv = process.argv.slice(2);
  let invokedCommand: string | undefined;
  let caughtError: unknown;

  // The telemetry epilogue must run on BOTH exit paths: the normal return path
  // (main's finally) and the SIGINT/SIGTERM path, where the cleanup registry
  // calls process.exit() directly and main's finally never resumes. Interactive
  // fusion sessions end with Ctrl+C, so without this wiring those runs would
  // ship no events at all. Single-flight: whichever path fires first wins.
  let telemetrySettling: Promise<void> | undefined;
  const settleTelemetry = (exitKind: string): Promise<void> => {
    telemetrySettling ??= (async () => {
      const command = invokedCommand ?? (argv.length === 0 ? "palette" : inferCommandFromArgv());
      captureCommand({
        command,
        cliVersion: readPackageVersion(import.meta.url),
        startedAt,
        exitKind,
        observe: argv.includes("--observe"),
        local: argv.includes("--local")
      });
      await shutdownTelemetry();
    })();
    return telemetrySettling;
  };
  // Registered first so LIFO ordering runs it last, after the fusion stack's
  // own teardown has ended its spans. If the normal path already settled (or
  // is mid-flush when a signal lands), this returns the same single-flight
  // promise, so the registry waits for the flush instead of racing it.
  registerCleanup(() => settleTelemetry("interrupted"));
  // Tests that exercise the real signal path launch the CLI with an IPC
  // channel. A readiness message makes their SIGINT deterministic under CI
  // load without adding timing sleeps or affecting ordinary CLI processes.
  if (typeof process.send === "function") {
    process.send({ type: "fusionkit.cli.signal-ready" });
  }

  const program = buildProgram();
  program.exitOverride();
  program.hook("preAction", (_thisCommand, actionCommand) => {
    invokedCommand = commandPath(actionCommand);
  });

  try {
    try {
      if (argv.length === 0) {
        const defaultToolArgv = configuredDefaultToolArgv();
        const paletteArgv =
          defaultToolArgv === undefined ? await runCommandPalette() : defaultToolArgv;
        if (paletteArgv === undefined) {
          program.outputHelp();
        } else {
          await program.parseAsync([...process.argv.slice(0, 2), ...paletteArgv]);
        }
      } else {
        await program.parseAsync(process.argv);
      }
    } catch (error) {
      caughtError = error;
      process.exitCode = classifyAndRenderError(error);
    }
  } finally {
    await settleTelemetry(exitKindFor(caughtError));
    await runCleanups();
  }
  process.exit(process.exitCode ?? 0);
}

void main();
