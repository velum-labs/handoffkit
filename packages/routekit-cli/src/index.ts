#!/usr/bin/env node
/** Executable entrypoint for the independent RouteKit router CLI. */
import {
  CliError,
  emitJson,
  isJsonMode,
  renderCliError
} from "@routekit/cli-core";
import { configureBrand, uiStream } from "@routekit/cli-ui";
import { runCleanups } from "@routekit/runtime";
import { CommanderError } from "commander";

import { buildProgram } from "./cli.js";

configureBrand({
  name: "routekit",
  tagline: "model routes for coding tools"
});

function renderError(error: unknown): number {
  if (error instanceof CliError) return renderCliError(error);
  if (error instanceof CommanderError) return error.exitCode;
  const message = error instanceof Error ? error.message : String(error);
  if (isJsonMode()) emitJson({ error: { code: "error", message } });
  else uiStream().write(`error: ${message}\n`);
  return 1;
}

async function main(): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  try {
    if (process.argv.length <= 2) program.outputHelp();
    else await program.parseAsync(process.argv);
  } catch (error) {
    process.exitCode = renderError(error);
  } finally {
    await runCleanups();
  }
}

void main();
