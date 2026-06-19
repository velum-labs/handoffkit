import { Command } from "commander";

import { registerEnsemble } from "./commands/ensemble.js";
import { registerFusion } from "./commands/fusion.js";
import { registerInit } from "./commands/init.js";
import { registerLifecycle } from "./commands/lifecycle.js";
import { registerLocal } from "./commands/local.js";
import { registerPlane } from "./commands/plane.js";
import { registerRun } from "./commands/run.js";
import { registerRunner } from "./commands/runner.js";
import { registerSecrets } from "./commands/secrets.js";

/**
 * Build the `fusionkit` command tree. The global `--dir` option must precede the
 * subcommand (`enablePositionalOptions` keeps the launcher commands' passthrough
 * unambiguous). Each `register*` helper attaches its command(s) and reads the
 * global home directory via `program.opts().dir`.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("fusionkit")
    .description("real model fusion behind your coding agent (codex, claude, cursor)")
    .option("-d, --dir <dir>", "fusionkit home (default: ./.fusionkit)")
    .enablePositionalOptions();

  registerInit(program);
  registerPlane(program);
  registerRunner(program);
  registerSecrets(program);
  registerRun(program);
  registerLifecycle(program);
  registerEnsemble(program);
  registerLocal(program);
  registerFusion(program);

  return program;
}
