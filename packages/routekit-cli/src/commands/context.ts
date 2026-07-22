import type { Command } from "commander";

import { loadRouterConfig } from "../config.js";

type ConfigGlobalOptions = { config?: string };

export function configOverride(command: Command): string | undefined {
  return command.optsWithGlobals<ConfigGlobalOptions>().config;
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
