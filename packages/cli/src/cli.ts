import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { FUSIONKIT_PYPI_VERSION } from "./fusion-quickstart.js";
import { registerDoctor } from "./commands/doctor.js";
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
function cliVersion(): string {
  // dist/cli.js -> ../package.json is the published package manifest.
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("fusionkit")
    .description("real model fusion behind your coding agent (codex, claude, cursor)")
    .version(
      `@fusionkit/cli ${cliVersion()} (synthesizer: fusionkit@${FUSIONKIT_PYPI_VERSION} from PyPI)`,
      "-v, --version",
      "print the CLI (npm) and pinned synthesizer (PyPI) versions"
    )
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
  registerDoctor(program);

  return program;
}
