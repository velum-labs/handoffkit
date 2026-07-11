#!/usr/bin/env node
/**
 * Entry point for the FusionKit command line package. The executable itself lives in src/index.ts, while cli.ts builds the Commander command tree.
 */
import "./quiet-warnings.js";
import { PolicyDeniedError } from "@fusionkit/protocol";

import { uiStream } from "@fusionkit/cli-ui";

import { buildProgram } from "./cli.js";
import { runCommandPalette } from "./commands/palette.js";
import { CliError, exitWithCliError } from "./shared/errors.js";
import { emitJson, isJsonMode } from "./shared/context.js";
import { readPackageVersion } from "./shared/package-version.js";
import { PreflightError } from "./shared/preflight.js";
import { captureCommand, initTelemetry, shutdownTelemetry } from "./telemetry/telemetry.js";

/**
 * Opt-in product telemetry, wrapped around the whole invocation: one
 * `cli.command` record per run plus per-session aggregates from the span
 * listener. Every function below is a no-op unless the user opted in
 * (`fusionkit telemetry on`) — see docs/privacy.md.
 */
async function withTelemetry(run: () => Promise<void>): Promise<void> {
  initTelemetry();
  const startedAt = Date.now();
  const argv = process.argv.slice(2);
  const command = argv.find((arg) => !arg.startsWith("-")) ?? "palette";
  const settle = async (exitKind: string): Promise<void> => {
    captureCommand({
      command,
      cliVersion: readPackageVersion(import.meta.url),
      startedAt,
      exitKind,
      observe: argv.includes("--observe"),
      local: argv.includes("--local")
    });
    await shutdownTelemetry();
  };
  try {
    await run();
    await settle(process.exitCode !== undefined && process.exitCode !== 0 ? "error" : "ok");
  } catch (error) {
    await settle(error instanceof Error ? error.constructor.name : "error");
    throw error;
  }
}

async function main(): Promise<void> {
  await withTelemetry(async () => {
    const program = buildProgram();
    // Bare invocation: an interactive command palette on a TTY (pick an action,
    // see the equivalent command); help on stdout otherwise (commander would
    // print to stderr and exit non-zero by default).
    if (process.argv.slice(2).length === 0) {
      const paletteArgv = await runCommandPalette();
      if (paletteArgv === undefined) {
        program.outputHelp();
        return;
      }
      await program.parseAsync([...process.argv.slice(0, 2), ...paletteArgv]);
      return;
    }
    await program.parseAsync(process.argv);
  });
}

/** Structured failure for --json mode: `{ error: { code, message, details? } }`. */
function jsonError(code: string, message: string, details?: string[]): never {
  emitJson({ error: { code, message, ...(details !== undefined ? { details } : {}) } });
  process.exit(code === "policy-denied" ? 2 : 1);
}

main().catch((error: unknown) => {
  if (error instanceof PolicyDeniedError) {
    if (isJsonMode()) jsonError("policy-denied", "policy denied (fail closed)", [...error.reasons]);
    exitWithCliError(
      new CliError({
        code: "policy-denied",
        message: "policy denied (fail closed)",
        details: [...error.reasons],
        exitCode: 2
      })
    );
  }
  if (error instanceof PreflightError) {
    if (isJsonMode()) jsonError("preflight", error.message);
    // "fusionkit preflight failed:" heading + "  - problem" lines: render the
    // problems as panel evidence with doctor as the next command.
    const [first, ...rest] = error.message.split("\n");
    exitWithCliError(
      new CliError({
        code: "preflight",
        message: first ?? error.message,
        ...(rest.length > 0 ? { details: rest.map((line) => line.replace(/^\s+-\s*/, "")) } : {}),
        tryCommand: "fusionkit doctor"
      })
    );
  }
  if (error instanceof CliError) exitWithCliError(error);
  const message = error instanceof Error ? error.message : String(error);
  if (isJsonMode()) jsonError("error", message);
  uiStream().write(`error: ${message}\n`);
  process.exit(1);
});
