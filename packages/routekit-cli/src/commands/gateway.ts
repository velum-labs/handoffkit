import type { Command } from "commander";

import { registerServe } from "./serve.js";
import { registerStop } from "./stop.js";

export function registerGateway(program: Command): void {
  const gateway = program
    .command("gateway")
    .description("run and manage the model gateway");
  registerServe(gateway);
  registerStop(gateway);
}
