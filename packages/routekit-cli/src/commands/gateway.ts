import type { Command } from "commander";

import { registerGatewayService, registerLogs } from "./gateway-service.js";
import { registerServe } from "./serve.js";
import { registerRestart, registerStart } from "./start.js";
import { registerStop } from "./stop.js";
import { registerUpgrade } from "./upgrade.js";

export function registerGateway(program: Command): void {
  const gateway = program
    .command("gateway")
    .description("run and manage the model gateway");
  registerServe(gateway);
  registerStart(gateway);
  registerStop(gateway);
  registerRestart(gateway);
  registerUpgrade(gateway);
  registerLogs(gateway);
  registerGatewayService(gateway);
}
