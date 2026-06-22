import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import "./tools.js";
import { FUSIONKIT_PYPI_VERSION } from "./fusion-quickstart.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerEnsemble } from "./commands/ensemble.js";
import { registerFusion } from "./commands/fusion.js";
import { registerLocal } from "./commands/local.js";
import { registerModels } from "./commands/models.js";

/**
 * Build the `fusionkit` command tree. `enablePositionalOptions` keeps the
 * launcher commands' passthrough unambiguous (fusionkit's own flags must
 * precede the tool name). Each `register*` helper attaches its command(s).
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
    .enablePositionalOptions();

  registerEnsemble(program);
  registerLocal(program);
  registerFusion(program);
  registerModels(program);
  registerDoctor(program);

  return program;
}
