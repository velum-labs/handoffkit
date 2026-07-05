import { Command } from "commander";

import "./tools.js";
import { FUSIONKIT_PYPI_VERSION } from "./fusion-quickstart.js";
import { registerConfig } from "./commands/config.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerEnsemble } from "./commands/ensemble.js";
import { registerFusion } from "./commands/fusion.js";
import { registerLocal } from "./commands/local.js";
import { registerModels } from "./commands/models.js";
import { registerPrompts } from "./commands/prompts.js";
import { registerRuntime } from "./commands/runtime.js";
import { registerSessions } from "./commands/sessions.js";
import { registerSetup } from "./commands/setup.js";
import { registerVersion } from "./commands/version.js";
import { attachGlobalFlags } from "./shared/context.js";
import { readPackageVersion } from "./shared/package-version.js";

/**
 * Build the `fusionkit` command tree. `enablePositionalOptions` keeps the
 * launcher commands' passthrough unambiguous (fusionkit's own flags must
 * precede the tool name). Each `register*` helper attaches its command(s).
 */
function cliVersion(): string {
  return readPackageVersion(import.meta.url);
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
  attachGlobalFlags(program);

  registerEnsemble(program);
  registerLocal(program);
  registerFusion(program);
  registerModels(program);
  registerRuntime(program);
  registerSessions(program);
  registerConfig(program);
  registerPrompts(program);
  registerSetup(program);
  registerDoctor(program);
  registerVersion(program);

  return program;
}
