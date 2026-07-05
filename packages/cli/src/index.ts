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
import { PreflightError } from "./shared/preflight.js";

async function main(): Promise<void> {
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
}

/** Structured failure for --json mode: `{ error: { code, message, details? } }`. */
function jsonError(code: string, message: string, details?: string[]): never {
  emitJson({ error: { code, message, ...(details !== undefined ? { details } : {}) } });
  process.exit(code === "policy-denied" ? 2 : 1);
}

main().catch((error: unknown) => {
  if (error instanceof PolicyDeniedError) {
    if (isJsonMode()) jsonError("policy-denied", "policy denied (fail closed)", [...error.reasons]);
    uiStream().write(`POLICY DENIED (fail closed):\n`);
    for (const reason of error.reasons) uiStream().write(`  - ${reason}\n`);
    process.exit(2);
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
