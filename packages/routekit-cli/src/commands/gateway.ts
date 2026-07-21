import type { Command } from "commander";

import { registerServe } from "./serve.js";

export function registerGateway(program: Command): void {
  const gateway = program
    .command("gateway")
    .description("run the model gateway in the foreground");
  registerServe(gateway);
}
