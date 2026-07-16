import type { Command } from "commander";

import { registerCompletion as registerCoreCompletion } from "@routekit/cli-core";

export function registerCompletion(program: Command): void {
  registerCoreCompletion(program, "fusionkit");
}
