import { Command } from "commander";

import "./tools.js";
import { FUSIONKIT_PYPI_VERSION } from "./fusion-quickstart.js";
import { registerComplete } from "./commands/complete.js";
import { registerCompletion } from "./commands/completion.js";
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
import { registerTelemetry } from "./commands/telemetry.js";
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

  registerFusion(program);
  registerSetup(program);
  registerDoctor(program);
  registerConfig(program);
  registerPrompts(program);
  registerSessions(program);
  registerModels(program);
  registerEnsemble(program);
  registerLocal(program);
  registerCompletion(program);
  registerComplete(program);
  registerRuntime(program);
  registerTelemetry(program);
  registerVersion(program);

  program.addHelpText(
    "after",
    [
      "",
      "Quickstart:",
      "  fusionkit setup                         # one-time: warm the fusion engine",
      "  cd your-git-repo && fusionkit codex     # fuse a model panel behind Codex",
      "  fusionkit init                          # commit a .fusionkit/ panel config for the repo",
      "Docs: https://fusionkit.velum-labs.com",
      "",
      "Environment variables:",
      "  FUSIONKIT_DIR                  local FusionKit checkout for the Python engine",
      "  FUSIONKIT_NO_TUI               force plain output instead of the TUI",
      "  FUSIONKIT_SESSIONS_DIR         durable session store (default: ~/.fusionkit/sessions)",
      "  FUSIONKIT_CONSENT_PATH         cloud-panel cost consent file override",
      "  FUSIONKIT_SKIP_KEY_VALIDATION  skip live provider-key validation when set to 1",
      "  FUSIONKIT_TELEMETRY            1/0 overrides stored product-telemetry consent",
      "  DO_NOT_TRACK                   force-disables product telemetry (beats everything)",
      "  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT  export trace spans to your own OTLP collector",
      "  PORTLESS                       set to 0 to disable portless routing by default",
      "  PORTLESS_STATE_DIR/TLD         portless proxy state directory and local domain",
      "  WARRANT_*                      deprecated aliases for FUSIONKIT_* are still honored"
    ].join("\n")
  );

  return program;
}
