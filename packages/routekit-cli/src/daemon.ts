/**
 * RouteKit bindings for the shared service core in `@routekit/runtime`: the
 * gateway daemon spec (what `gateway start`/`restart`/`upgrade` spawn), the
 * supervisor unit spec (what `gateway service install` writes), and the
 * secrets environment file the systemd unit references.
 */
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { CliError } from "@routekit/cli-core";
import { configuredProviderIds } from "@routekit/config";
import type { RouterConfig } from "@routekit/gateway";
import { PROVIDERS } from "@routekit/registry";
import { serviceLogPath, writeFileAtomic } from "@routekit/runtime";
import type { ServiceDaemonSpec, ServiceUnitSpec } from "@routekit/runtime";

import { routekitHome } from "./config.js";
import { routekitVersion } from "./state.js";

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

export function gatewayDaemonSpec(input: {
  args: readonly string[];
  binPath?: string;
  cwd?: string;
}): ServiceDaemonSpec {
  return {
    product: ROUTEKIT_PRODUCT,
    kind: "gateway",
    home: routekitHome(),
    version: routekitVersion(),
    command: {
      execPath: process.execPath,
      args: [input.binPath ?? cliEntryPath(), ...input.args]
    },
    cwd: input.cwd ?? process.cwd()
  };
}

export function gatewayLogPath(): string {
  return serviceLogPath(routekitHome(), "gateway");
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
    workingDirectory: input.cwd ?? process.cwd(),
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

export function gatewayUnitSpec(input: {
  args: readonly string[];
  supervisor: "systemd" | "launchd";
  env: Record<string, string>;
  drainGraceMs: number;
  cwd?: string;
}): ServiceUnitSpec {
  const command = {
    execPath: process.execPath,
    args: [cliEntryPath(), ...input.args]
  };
  const shared = {
    product: ROUTEKIT_PRODUCT,
    kind: "gateway",
    description: "RouteKit model gateway",
    command,
    workingDirectory: input.cwd ?? process.cwd(),
    drainGraceMs: input.drainGraceMs
  };
  if (input.supervisor === "systemd") {
    // Secrets stay out of the unit file: they live in the 0600 env file.
    return { ...shared, environmentFile: writeServiceEnvFile("gateway", input.env) };
  }
  // launchd has no EnvironmentFile; the plist itself is written 0600.
  return { ...shared, env: input.env, logFile: gatewayLogPath() };
}
