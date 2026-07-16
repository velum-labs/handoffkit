import {
  attachGlobalFlags,
  registerCompletion
} from "@routekit/cli-core";
import type { Command } from "commander";

import { registerDynamicCompletion } from "../completion.js";

import { registerAccounts } from "./accounts.js";
import { registerConfig } from "./config.js";
import { registerDoctor } from "./doctor.js";
import { registerInstall } from "./install.js";
import { registerLaunchers } from "./launchers.js";
import { registerModels } from "./models.js";
import { registerProviders } from "./providers.js";
import { registerServe } from "./serve.js";
import { registerStop } from "./stop.js";
import { registerTelemetry } from "./telemetry.js";

export function registerCommands(program: Command): void {
  attachGlobalFlags(program);
  program.option("--config <path>", "router config path (overrides project and global config)");
  registerServe(program);
  registerLaunchers(program);
  registerAccounts(program);
  registerProviders(program);
  registerModels(program);
  registerConfig(program);
  registerDoctor(program);
  registerInstall(program);
  registerStop(program);
  registerTelemetry(program);
  registerCompletion(program, "routekit");
  registerDynamicCompletion(program);
}
