#!/usr/bin/env node
import "./quiet-warnings.js";
import { PolicyDeniedError } from "@fusionkit/protocol";

import { buildProgram } from "./cli.js";
import { PreflightError } from "./shared/preflight.js";

async function main(): Promise<void> {
  const program = buildProgram();
  // Bare invocation prints help on stdout and exits 0 (commander would
  // otherwise print to stderr and exit non-zero).
  if (process.argv.slice(2).length === 0) {
    program.outputHelp();
    return;
  }
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  if (error instanceof PolicyDeniedError) {
    console.error(`POLICY DENIED (fail closed):`);
    for (const reason of error.reasons) console.error(`  - ${reason}`);
    process.exit(2);
  }
  if (error instanceof PreflightError) {
    console.error(error.message);
    process.exit(1);
  }
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
