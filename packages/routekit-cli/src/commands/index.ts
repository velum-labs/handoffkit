import {
  attachGlobalFlags,
  registerCompletion
} from "@routekit/cli-core";
import type { Command } from "commander";

import { registerDynamicCompletion } from "../completion.js";

import { registerAccounts } from "./accounts.js";
import { registerConfig } from "./config.js";
import { registerDoctor } from "./doctor.js";
import { registerGateway } from "./gateway.js";
import { registerInstall } from "./install.js";
import { registerLaunchers } from "./launchers.js";
import { registerModels } from "./models.js";
import { registerProviders } from "./providers.js";
import { registerStatus } from "./status.js";
import { registerTelemetry } from "./telemetry.js";
import { registerUsage } from "./usage.js";

export function registerCommands(program: Command): void {
  attachGlobalFlags(program);
  program.option("--config <path>", "router config path (overrides project and global config)");
  program.commandsGroup("Setup");
  registerAccounts(program);
  registerProviders(program);
  registerConfig(program);

  program.commandsGroup("Run");
  registerGateway(program);
  registerLaunchers(program);

  program.commandsGroup("Inspect");
  registerStatus(program);
  registerUsage(program);
  registerModels(program);
  registerDoctor(program);

  program.commandsGroup("Maintain");
  registerInstall(program);
  registerTelemetry(program);
  registerCompletion(program, "routekit");
  registerDynamicCompletion(program);
}
