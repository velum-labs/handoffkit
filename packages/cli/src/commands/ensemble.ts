import { Command } from "commander";

import { registerEnsembleConfig } from "./ensemble-config.js";
import { registerPaletteAction } from "./palette.js";

/** Register the named-ensemble configuration commands. */
export function registerEnsemble(program: Command): void {
  registerPaletteAction({
    label: "Manage named ensembles",
    hint: "fusionkit ensemble list",
    argv: ["ensemble", "list"]
  });
  const ensemble = new Command("ensemble").description("manage named ensembles");
  registerEnsembleConfig(ensemble);
  program.addCommand(ensemble);
}
