/**
 * RouteKit bindings for the shared service core in `@velum-labs/routekit-runtime`: the
 * daemon supervisor unit spec (what `routekit start` and `daemon service
 * install` write) and the secrets environment file the systemd unit
 * references.
 */
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  CLIPROXY_API_KEY_ENV,
  cliproxyApiKey
} from "@velum-labs/routekit-accounts";
import { CliError } from "@velum-labs/routekit-cli-core";
import { configuredProviderIds } from "@velum-labs/routekit-config";
import type { RouterConfig } from "@velum-labs/routekit-gateway";
import { PROVIDERS } from "@velum-labs/routekit-registry";
import { serviceLogPath, writeFileAtomic } from "@velum-labs/routekit-runtime";
import type { ServiceUnitSpec } from "@velum-labs/routekit-runtime";

import { routekitHome } from "./config.js";

export const ROUTEKIT_PRODUCT = "routekit";

/**
 * The entry script the current invocation runs from. For a global install
 * this is the stable `routekit` bin shim, so units written with it pick up
 * upgraded code without being rewritten.
 */
export function cliEntryPath(): string {
  const entry = process.argv[1];
  if (entry === undefined) {
    throw new CliError({ message: "cannot resolve the routekit entry script" });
  }
  return entry;
}

/**
 * Environment the service process needs but a supervisor-started process
 * would not inherit from the user's shell: provider credentials and base-URL
 * overrides for the configured providers, plus RouteKit's own knobs.
 */
export function serviceEnvironment(config: RouterConfig): Record<string, string> {
  const names = new Set<string>(["ROUTEKIT_HOME", "ROUTEKIT_PORTLESS", "ROUTEKIT_DRAIN_GRACE", "PORTLESS_STATE_DIR", "PORTLESS_TLD"]);
  for (const provider of configuredProviderIds(config)) {
    const info = PROVIDERS[provider];
    if (info === undefined) continue;
    for (const name of [
      info.keyEnv,
      info.authTokenEnv,
      info.baseUrlEnv,
      ...(info.credentialEnvNames ?? [])
    ]) {
      if (name !== undefined) names.add(name);
    }
  }
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export function missingServiceCredentialVariables(
  config: RouterConfig,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const missing = new Set<string>();
  for (const provider of configuredProviderIds(config)) {
    const info = PROVIDERS[provider];
    if (info === undefined) continue;
    const alternatives = [info.keyEnv, info.authTokenEnv].filter(
      (name): name is string => name !== undefined
    );
    if (
      alternatives.length === 0 ||
      alternatives.some((name) => (env[name] ?? "").trim().length > 0) ||
      (alternatives.includes(CLIPROXY_API_KEY_ENV) &&
        cliproxyApiKey(env) !== undefined)
    ) {
      continue;
    }
    for (const name of alternatives) missing.add(name);
  }
  return [...missing];
}

export function serviceEnvFilePath(kind: string): string {
  return join(routekitHome(), "env", `${kind}.env`);
}

function quoteEnvValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Write the 0600 secrets file a systemd unit references via EnvironmentFile. */
export function writeServiceEnvFile(kind: string, env: Record<string, string>): string {
  const path = serviceEnvFilePath(kind);
  const directory = join(routekitHome(), "env");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const lines = Object.entries(env).map(([name, value]) => `${name}=${quoteEnvValue(value)}`);
  writeFileAtomic(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function removeServiceEnvFile(kind: string): void {
  rmSync(serviceEnvFilePath(kind), { force: true });
}

export function daemonUnitSpec(input: {
  args: readonly string[];
  supervisor: "systemd" | "launchd";
  env: Record<string, string>;
  drainGraceMs: number;
  cwd?: string;
}): ServiceUnitSpec {
  const shared = {
    product: ROUTEKIT_PRODUCT,
    kind: "daemon",
    description: "RouteKit singleton daemon",
    command: {
      execPath: process.execPath,
      args: [cliEntryPath(), ...input.args]
    },
    // Persistent services must not depend on the directory from which the
    // install command happened to be run. That project may later be moved or
    // deleted, preventing launchd/systemd from starting the daemon.
    workingDirectory: input.cwd ?? routekitHome(),
    drainGraceMs: input.drainGraceMs
  };
  if (input.supervisor === "systemd") {
    return {
      ...shared,
      environmentFile: writeServiceEnvFile("daemon", input.env)
    };
  }
  return {
    ...shared,
    env: input.env,
    logFile: serviceLogPath(routekitHome(), "daemon")
  };
}
