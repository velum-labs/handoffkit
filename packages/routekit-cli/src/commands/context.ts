import { resolve } from "node:path";

import type { Command } from "commander";

import {
  findProjectRouterConfig,
  globalRouterConfigPath,
  loadRouterConfig,
  projectRouterConfigPath
} from "../config.js";

type ConfigGlobalOptions = { config?: string };

export function configOverride(command: Command): string | undefined {
  return command.optsWithGlobals<ConfigGlobalOptions>().config;
}

export function editableConfigPath(input: {
  command: Command;
  global?: boolean;
  cwd?: string;
}): string {
  const override = configOverride(input.command) ?? process.env.ROUTEKIT_CONFIG;
  if (override !== undefined && override.length > 0) return resolve(override);
  if (input.global === true) return globalRouterConfigPath();
  return findProjectRouterConfig(input.cwd) ?? projectRouterConfigPath(input.cwd);
}

export function loaded(command: Command) {
  return loadRouterConfig({ configPath: configOverride(command) });
}

export function numberOption(
  value: string,
  label: string,
  input: { min: number; max: number }
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < input.min || parsed > input.max) {
    throw new Error(`${label} must be between ${input.min} and ${input.max}`);
  }
  return parsed;
}
