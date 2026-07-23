import type { Command } from "commander";

import { registerCompletion as registerCoreCompletion } from "@velum-labs/routekit-cli-core";

export function registerCompletion(program: Command): void {
  registerCoreCompletion(program, "fusionkit");
}
