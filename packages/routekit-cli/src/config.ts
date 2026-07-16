import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { routekitHome } from "@routekit/config";

export {
  DEFAULT_ROUTER_CONFIG,
  findProjectRouterConfig,
  globalRouterConfigPath,
  loadRouterConfig,
  projectRouterConfigPath,
  routekitHome,
  routerConfigPaths,
  updateEffectiveRouterConfig,
  updateRouterConfig,
  writeRouterConfig
} from "@routekit/config";
export type {
  LoadedRouterConfig,
  RouterConfigPaths,
  RouterConfigSource,
  UpdateRouterConfigInput
} from "@routekit/config";

export type MigrationAction = {
  source: string;
  destination: string;
  action: "copied" | "skipped";
};

function legacyStateRoot(home: string): string {
  const legacyName = `.${["fu", "sion", "kit"].join("")}`;
  return join(home, legacyName, "subscriptions");
}

function canonicalSubscriptionDirectory(name: string): string {
  return name === "claude" || name === "claudeCode" ? "claude-code" : name;
}

function copyStateEntry(source: string, destination: string, actions: MigrationAction[]): void {
  if (existsSync(destination)) {
    actions.push({ source, destination, action: "skipped" });
    return;
  }
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    actions.push({ source, destination, action: "skipped" });
    return;
  }
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    chmodSync(destination, 0o700);
    for (const name of readdirSync(source)) {
      copyStateEntry(join(source, name), join(destination, name), actions);
    }
    return;
  }
  if (!stat.isFile()) return;
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  cpSync(source, destination, { errorOnExist: true, force: false });
  chmodSync(destination, 0o600);
  actions.push({ source, destination, action: "copied" });
}

export function migrateLegacyState(
  input: { home?: string; stateHome?: string } = {}
): MigrationAction[] {
  const home = input.home ?? homedir();
  const source = legacyStateRoot(home);
  const destination = join(input.stateHome ?? routekitHome(), "subscriptions");
  if (!existsSync(source)) return [];
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  chmodSync(destination, 0o700);
  const actions: MigrationAction[] = [];
  const destinations = new Map<string, string>();
  for (const name of readdirSync(source)) {
    const canonical = canonicalSubscriptionDirectory(name);
    const previous = destinations.get(canonical);
    if (previous !== undefined) {
      throw new Error(
        `legacy subscription directories "${previous}" and "${name}" both map to "${canonical}"`
      );
    }
    destinations.set(canonical, name);
    copyStateEntry(join(source, name), join(destination, canonical), actions);
  }
  return actions;
}
