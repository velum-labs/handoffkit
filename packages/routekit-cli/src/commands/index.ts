import {
  attachGlobalFlags,
  registerCompletion
} from "@velum-labs/routekit-cli-core";
import type { Command } from "commander";

import { registerDynamicCompletion } from "../completion.js";

import { registerAccounts } from "./accounts.js";
import { registerCalls } from "./calls.js";
import { registerConfig } from "./config.js";
import { registerDaemon } from "./daemon.js";
import { registerDoctor } from "./doctor.js";
import { registerLaunchers } from "./launchers.js";
import { registerModels } from "./models.js";
import { registerProviders } from "./providers.js";
import { registerStart } from "./start.js";
import { registerStatus } from "./status.js";
import { registerStop } from "./stop.js";
import { registerTelemetry } from "./telemetry.js";
import { registerUsage } from "./usage.js";
import { configOverride } from "./context.js";

const EXPLICIT_CONFIG_COMMANDS = new Set([
  "doctor",
  "config migrate"
]);
const CONFIG_INDEPENDENT_COMMANDS = new Set([
  "version",
  "completion",
  "__complete",
  "daemon run"
]);

function commandPath(command: Command): string {
  const names: string[] = [];
  let current: Command | null = command;
  while (current.parent !== null) {
    names.unshift(current.name());
    current = current.parent;
  }
  return names.join(" ");
}

export function registerCommands(program: Command): void {
  attachGlobalFlags(program);
  program.option(
    "--config <path>",
    "router config path for doctor and migration recovery only"
  );
  program.hook("preAction", (_root, actionCommand) => {
    const override = configOverride(actionCommand) ?? process.env.ROUTEKIT_CONFIG;
    const path = commandPath(actionCommand);
    if (
      override !== undefined &&
      override.length > 0 &&
      !EXPLICIT_CONFIG_COMMANDS.has(path) &&
      !CONFIG_INDEPENDENT_COMMANDS.has(path)
    ) {
      throw new Error(
        "--config / ROUTEKIT_CONFIG are not supported by singleton daemon operations; " +
          "use `routekit config import --from <path>`"
      );
    }
  });
  program.commandsGroup("Setup");
  registerAccounts(program);
  registerProviders(program);
  registerConfig(program);

  program.commandsGroup("Run");
  registerStart(program);
  registerStop(program);
  registerDaemon(program);
  registerLaunchers(program);

  program.commandsGroup("Inspect");
  registerStatus(program);
  registerUsage(program);
  registerCalls(program);
  registerModels(program);
  registerDoctor(program);

  program.commandsGroup("Maintain");
  registerTelemetry(program);
  registerCompletion(program, "routekit");
  registerDynamicCompletion(program);
}
