import { Command } from "commander";

import { registerServe } from "./serve.js";

export function registerGateway(program: Command): void {
  const gateway = new Command("gateway")
    .description("run the model gateway in the foreground");
  registerServe(gateway);
  program.addCommand(gateway, { hidden: true });
}
