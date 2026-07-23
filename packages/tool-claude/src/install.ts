import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import type { Stats } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { SUBSCRIPTIONS } from "@velum-labs/routekit-registry";
import {
  acquireLifecycleLock,
  trimTrailingSlashes,
  writeFileAtomic
} from "@velum-labs/routekit-runtime";

export type ClaudeInstallOwner = {
  id: string;
  displayName: string;
  installCommand: string;
  uninstallCommand: string;
  startCommand: string;
};

export type ClaudeInstallInput = {
  gatewayUrl: string;
  authToken?: string;
  owner: ClaudeInstallOwner;
  claudeConfigDir?: string;
};

export type ClaudeInstallResult = {
  configPath: string;
  action: "installed" | "updated";
  managedKeys: string[];
};

type ClaudeSettings = Record<string, unknown> & {
  env?: Record<string, unknown>;
};

type FileSnapshot = {
  content: string | null;
  mode: number | null;
  hash: string | null;
};

type InstalledManifest = {
  version: 2;
  state: "installed";
  ownerId: string;
  original: FileSnapshot;
  exactRestoreEligible: boolean;
  installedContentHash: string;
  managedEnvValues: Record<string, string>;
};

type InstallPendingManifest = {
  version: 2;
  state: "install-pending";
  ownerId: string;
  beforeSettings: FileSnapshot;
  beforeManifest: InstalledManifest | null;
  targetSettings: FileSnapshot;
  targetManifest: InstalledManifest;
};

type UninstallPendingManifest = {
  version: 2;
  state: "uninstall-pending";
  ownerId: string;
  beforeSettings: FileSnapshot;
  targetSettings: FileSnapshot;
};

type ClaudeInstallManifest =
  | InstalledManifest
  | InstallPendingManifest
  | UninstallPendingManifest;

type LegacyManifest = {
  version: 1;
  ownerId: string;
  originalContent: string | null;
  exactRestoreEligible: boolean;
  installedContentHashes: string[];
  managedEnvValues: Record<string, string[]>;
};

const MANAGED_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"
] as const;

type ClaudeInstallWriteBoundary =
  | "install-pending"
  | "install-settings"
  | "install-committed"
  | "uninstall-pending"
  | "uninstall-settings"
  | "uninstall-committed";

function reached(boundary: ClaudeInstallWriteBoundary): void {
  // Deliberately not part of the package API: tests install a same-process
  // throw hook to model termination immediately after an atomic boundary.
  const testingGlobal = globalThis as typeof globalThis & {
    __routekitClaudeInstallFaultInjector?: (
      reached: ClaudeInstallWriteBoundary
    ) => void;
  };
  testingGlobal.__routekitClaudeInstallFaultInjector?.(boundary);
}

function assertSafeOwnerId(ownerId: string): void {
  if (
    ownerId.length === 0 ||
    ownerId.includes("/") ||
    ownerId.includes("\\") ||
    ownerId === "." ||
    ownerId === ".."
  ) {
    throw new Error(`Claude integration owner id is not path-safe: ${JSON.stringify(ownerId)}`);
  }
}

function defaultClaudeConfigDir(): string {
  const registryPath = SUBSCRIPTIONS["claude-code"].configPath ?? "~/.claude/settings.json";
  const configPath = registryPath.startsWith("~/")
    ? join(homedir(), registryPath.slice(2))
    : registryPath;
  return dirname(configPath);
}

function paths(input: { ownerId: string; claudeConfigDir?: string }): {
  configDirectory: string;
  configPath: string;
  manifestPath: string;
  lockPath: string;
} {
  assertSafeOwnerId(input.ownerId);
  const configDirectory =
    input.claudeConfigDir ??
    process.env.CLAUDE_CONFIG_DIR ??
    defaultClaudeConfigDir();
  return {
    configDirectory,
    configPath: join(configDirectory, "settings.json"),
    manifestPath: join(configDirectory, `.${input.ownerId}-integration.json`),
    lockPath: join(configDirectory, ".routekit-claude-integration.lock")
  };
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function parseSettings(content: string, configPath: string): ClaudeSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`your Claude settings (${configPath}) are not valid JSON (${detail})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`your Claude settings (${configPath}) must contain a JSON object`);
  }
  const settings = parsed as ClaudeSettings;
  if (
    settings.env !== undefined &&
    (typeof settings.env !== "object" || settings.env === null || Array.isArray(settings.env))
  ) {
    throw new Error(`the "env" field in your Claude settings (${configPath}) must be an object`);
  }
  return settings;
}

function unsupportedManifest(manifestPath: string): Error {
  return new Error(
    `RouteKit's Claude ownership metadata (${manifestPath}) has an unsupported format`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSnapshot(value: unknown): value is FileSnapshot {
  if (!isRecord(value)) return false;
  const validMode =
    value.mode === null ||
    (typeof value.mode === "number" &&
      Number.isInteger(value.mode) &&
      value.mode >= 0 &&
      value.mode <= 0o777);
  return (
    (typeof value.content === "string" || value.content === null) &&
    validMode &&
    (value.content !== null || value.mode === null) &&
    (typeof value.hash === "string" || value.hash === null) &&
    value.hash === (value.content === null ? null : hash(value.content))
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isInstalledManifest(value: unknown): value is InstalledManifest {
  return (
    isRecord(value) &&
    value.version === 2 &&
    value.state === "installed" &&
    typeof value.ownerId === "string" &&
    isSnapshot(value.original) &&
    typeof value.exactRestoreEligible === "boolean" &&
    typeof value.installedContentHash === "string" &&
    isStringRecord(value.managedEnvValues)
  );
}

function parseManifest(
  content: string,
  manifestPath: string
): ClaudeInstallManifest | LegacyManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(
      `RouteKit's Claude ownership metadata (${manifestPath}) is invalid; ` +
        "move it aside and restore settings.json before retrying"
    );
  }
  if (
    isRecord(parsed) &&
    parsed.version === 1 &&
    typeof parsed.ownerId === "string" &&
    (typeof parsed.originalContent === "string" || parsed.originalContent === null) &&
    typeof parsed.exactRestoreEligible === "boolean" &&
    Array.isArray(parsed.installedContentHashes) &&
    parsed.installedContentHashes.every((entry) => typeof entry === "string") &&
    isRecord(parsed.managedEnvValues) &&
    Object.values(parsed.managedEnvValues).every(
      (entry) =>
        Array.isArray(entry) &&
        entry.every((candidate) => typeof candidate === "string")
    )
  ) {
    return parsed as LegacyManifest;
  }
  if (isInstalledManifest(parsed)) return parsed;
  if (
    isRecord(parsed) &&
    parsed.version === 2 &&
    parsed.state === "install-pending" &&
    typeof parsed.ownerId === "string" &&
    isSnapshot(parsed.beforeSettings) &&
    (parsed.beforeManifest === null ||
      isInstalledManifest(parsed.beforeManifest)) &&
    isSnapshot(parsed.targetSettings) &&
    isInstalledManifest(parsed.targetManifest)
  ) {
    const pending = parsed as InstallPendingManifest;
    if (
      pending.targetManifest.ownerId !== pending.ownerId ||
      pending.targetManifest.installedContentHash !==
        pending.targetSettings.hash ||
      (pending.beforeManifest !== null &&
        pending.beforeManifest.ownerId !== pending.ownerId)
    ) {
      throw unsupportedManifest(manifestPath);
    }
    return pending;
  }
  if (
    isRecord(parsed) &&
    parsed.version === 2 &&
    parsed.state === "uninstall-pending" &&
    typeof parsed.ownerId === "string" &&
    isSnapshot(parsed.beforeSettings) &&
    isSnapshot(parsed.targetSettings)
  ) {
    return parsed as UninstallPendingManifest;
  }
  throw unsupportedManifest(manifestPath);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function managedEnv(input: ClaudeInstallInput): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: trimTrailingSlashes(input.gatewayUrl),
    ANTHROPIC_AUTH_TOKEN: input.authToken ?? "routekit",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"
  };
}

function entryIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertConfigDirectory(configDirectory: string): void {
  const entry = entryIfExists(configDirectory);
  if (entry === undefined) return;
  if (entry.isSymbolicLink()) {
    throw new Error(`Claude config directory must not be a symlink: ${configDirectory}`);
  }
  if (!entry.isDirectory()) {
    throw new Error(`Claude config path is not a directory: ${configDirectory}`);
  }
}

function ensureConfigDirectory(configDirectory: string): void {
  assertConfigDirectory(configDirectory);
  if (entryIfExists(configDirectory) !== undefined) return;
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  assertConfigDirectory(configDirectory);
  chmodSync(configDirectory, 0o700);
}

function assertRegularFileIfExists(path: string, label: string): void {
  const entry = entryIfExists(path);
  if (entry === undefined) return;
  if (entry.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${path}`);
  }
  if (!entry.isFile()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
}

function readSnapshot(path: string, label: string): FileSnapshot {
  assertRegularFileIfExists(path, label);
  const entry = entryIfExists(path);
  if (entry === undefined) return { content: null, mode: null, hash: null };
  const content = readFileSync(path, "utf8");
  return {
    content,
    mode: entry.mode & 0o777,
    hash: hash(content)
  };
}

function snapshot(content: string | null, mode: number | null): FileSnapshot {
  return {
    content,
    mode,
    hash: content === null ? null : hash(content)
  };
}

function writePrivateFile(path: string, content: string, label: string): void {
  assertRegularFileIfExists(path, label);
  writeFileAtomic(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function applySnapshot(path: string, target: FileSnapshot, label: string): void {
  assertRegularFileIfExists(path, label);
  if (target.content === null) {
    rmSync(path, { force: true });
    return;
  }
  const mode = target.mode ?? 0o600;
  writeFileAtomic(path, target.content, { mode });
  chmodSync(path, mode);
}

function writeManifest(
  manifestPath: string,
  manifest: ClaudeInstallManifest
): void {
  writePrivateFile(
    manifestPath,
    serialize(manifest),
    "Claude ownership metadata"
  );
}

function currentManifest(
  manifestPath: string
): ClaudeInstallManifest | LegacyManifest | undefined {
  assertRegularFileIfExists(manifestPath, "Claude ownership metadata");
  return entryIfExists(manifestPath) === undefined
    ? undefined
    : parseManifest(readFileSync(manifestPath, "utf8"), manifestPath);
}

function assertExpectedSnapshot(
  current: FileSnapshot,
  expected: readonly FileSnapshot[],
  configPath: string,
  operation: string
): void {
  if (expected.some((candidate) => candidate.hash === current.hash)) return;
  throw new Error(
    `your Claude settings changed unexpectedly during ${operation} recovery (${configPath}); ` +
      "RouteKit refused to overwrite the external edit"
  );
}

function recoverPending(
  manifest: InstallPendingManifest | UninstallPendingManifest,
  configPath: string,
  manifestPath: string
): void {
  const current = readSnapshot(configPath, "Claude settings");
  if (manifest.state === "install-pending") {
    assertExpectedSnapshot(
      current,
      [manifest.beforeSettings, manifest.targetSettings],
      configPath,
      "install"
    );
    if (current.hash !== manifest.beforeSettings.hash) {
      applySnapshot(configPath, manifest.beforeSettings, "Claude settings");
    } else if (
      current.content !== null &&
      manifest.beforeSettings.mode !== null &&
      current.mode !== manifest.beforeSettings.mode
    ) {
      chmodSync(configPath, manifest.beforeSettings.mode);
    }
    if (manifest.beforeManifest === null) {
      assertRegularFileIfExists(manifestPath, "Claude ownership metadata");
      rmSync(manifestPath, { force: true });
    } else {
      writeManifest(manifestPath, manifest.beforeManifest);
    }
    return;
  }

  assertExpectedSnapshot(
    current,
    [manifest.beforeSettings, manifest.targetSettings],
    configPath,
    "uninstall"
  );
  if (current.hash !== manifest.targetSettings.hash) {
    applySnapshot(configPath, manifest.targetSettings, "Claude settings");
  } else if (
    current.content !== null &&
    manifest.targetSettings.mode !== null &&
    current.mode !== manifest.targetSettings.mode
  ) {
    chmodSync(configPath, manifest.targetSettings.mode);
  }
  assertRegularFileIfExists(manifestPath, "Claude ownership metadata");
  rmSync(manifestPath, { force: true });
}

function assertManagedValuesUnchanged(
  env: Record<string, unknown>,
  managedEnvValues: Record<string, string | string[]>,
  configPath: string
): void {
  for (const [key, expected] of Object.entries(managedEnvValues)) {
    const accepted = Array.isArray(expected) ? expected : [expected];
    if (!accepted.includes(String(env[key]))) {
      throw new Error(
        `your Claude settings changed RouteKit-managed env.${key} in ${configPath}; ` +
          `remove or restore that value before rerunning the install command`
      );
    }
  }
}

const CLAUDE_LOCK_TIMEOUT_MS = 5_000;

async function withConfigLock<T>(
  resolved: ReturnType<typeof paths>,
  operation: () => T | Promise<T>
): Promise<T> {
  ensureConfigDirectory(resolved.configDirectory);
  assertRegularFileIfExists(resolved.lockPath, "Claude integration lock");
  assertRegularFileIfExists(
    `${resolved.lockPath}.reap`,
    "Claude integration reaper lock"
  );
  const lock = await acquireLifecycleLock(resolved.lockPath, {
    timeoutMs: CLAUDE_LOCK_TIMEOUT_MS,
    pollMs: 50
  });
  try {
    assertConfigDirectory(resolved.configDirectory);
    assertRegularFileIfExists(resolved.lockPath, "Claude integration lock");
    return await operation();
  } finally {
    lock.release();
  }
}

function migrateLegacyManifest(
  manifest: LegacyManifest,
  current: FileSnapshot,
  configPath: string,
  manifestPath: string
): InstalledManifest | undefined {
  const settings = parseSettings(current.content ?? "{}\n", configPath);
  const env = { ...(settings.env ?? {}) };
  const hasNoManagedValues = Object.keys(manifest.managedEnvValues).every(
    (key) => env[key] === undefined
  );
  if (
    current.content === manifest.originalContent &&
    hasNoManagedValues
  ) {
    assertRegularFileIfExists(manifestPath, "Claude ownership metadata");
    rmSync(manifestPath, { force: true });
    return undefined;
  }

  if (
    current.hash === null ||
    !manifest.installedContentHashes.includes(current.hash)
  ) {
    throw new Error(
      `RouteKit's legacy Claude ownership metadata (${manifestPath}) does not ` +
        "match the current settings; refusing to overwrite them"
    );
  }
  const selectedValues: Record<string, string> = {};
  for (const [key, accepted] of Object.entries(manifest.managedEnvValues)) {
    const value = env[key];
    if (value === undefined || !accepted.includes(String(value))) {
      throw new Error(
        `RouteKit's legacy Claude ownership metadata (${manifestPath}) cannot ` +
          `safely identify the current env.${key} value; refusing to overwrite settings`
      );
    }
    selectedValues[key] = String(value);
  }
  const migrated: InstalledManifest = {
    version: 2,
    state: "installed",
    ownerId: manifest.ownerId,
    original: snapshot(manifest.originalContent, null),
    exactRestoreEligible: manifest.exactRestoreEligible,
    installedContentHash: current.hash,
    managedEnvValues: selectedValues
  };
  writeManifest(manifestPath, migrated);
  return migrated;
}

export async function installClaudeIntegration(
  input: ClaudeInstallInput
): Promise<ClaudeInstallResult> {
  const resolved = paths({
    ownerId: input.owner.id,
    ...(input.claudeConfigDir !== undefined
      ? { claudeConfigDir: input.claudeConfigDir }
      : {})
  });
  return await withConfigLock(resolved, () => {
    const { configPath, manifestPath } = resolved;
    let manifest = currentManifest(manifestPath);
    if (
      manifest !== undefined &&
      manifest.ownerId !== input.owner.id
    ) {
      throw new Error(
        `Claude ownership metadata in ${manifestPath} belongs to another integration`
      );
    }
    if (
      manifest?.version === 2 &&
      manifest.state !== "installed"
    ) {
      recoverPending(manifest, configPath, manifestPath);
      manifest = currentManifest(manifestPath);
    }

    const beforeSettings = readSnapshot(configPath, "Claude settings");
    let previousManifest: InstalledManifest | undefined;
    if (manifest?.version === 1) {
      previousManifest = migrateLegacyManifest(
        manifest,
        beforeSettings,
        configPath,
        manifestPath
      );
    } else if (manifest?.state === "installed") {
      previousManifest = manifest;
    } else if (manifest !== undefined) {
      throw unsupportedManifest(manifestPath);
    }
    const settings = parseSettings(beforeSettings.content ?? "{}\n", configPath);
    const env = { ...(settings.env ?? {}) };
    const nextManaged = managedEnv(input);

    if (previousManifest === undefined) {
      for (const key of MANAGED_ENV_KEYS) {
        if (env[key] !== undefined) {
          throw new Error(
            `your Claude settings already define env.${key} in ${configPath}; ` +
              `remove it or use \`${input.owner.uninstallCommand}\` only after configuring RouteKit`
          );
        }
      }
    } else {
      assertManagedValuesUnchanged(
        env,
        previousManifest.managedEnvValues,
        configPath
      );
    }

    for (const key of Object.keys(previousManifest?.managedEnvValues ?? {})) {
      delete env[key];
    }
    Object.assign(env, nextManaged);
    const nextSettings: ClaudeSettings = { ...settings, env };
    const nextContent = serialize(nextSettings);
    const targetSettings = snapshot(nextContent, 0o600);
    const exactRestoreEligible =
      previousManifest === undefined
        ? true
        : previousManifest.exactRestoreEligible &&
          beforeSettings.hash === previousManifest.installedContentHash;
    const targetManifest: InstalledManifest = {
      version: 2,
      state: "installed",
      ownerId: input.owner.id,
      original: previousManifest?.original ?? beforeSettings,
      exactRestoreEligible,
      installedContentHash: targetSettings.hash as string,
      managedEnvValues: nextManaged
    };
    const pendingManifest: InstallPendingManifest = {
      version: 2,
      state: "install-pending",
      ownerId: input.owner.id,
      beforeSettings,
      beforeManifest: previousManifest ?? null,
      targetSettings,
      targetManifest
    };

    writeManifest(manifestPath, pendingManifest);
    reached("install-pending");
    const unchanged = readSnapshot(configPath, "Claude settings");
    assertExpectedSnapshot(
      unchanged,
      [beforeSettings],
      configPath,
      "install"
    );
    applySnapshot(configPath, targetSettings, "Claude settings");
    reached("install-settings");
    const pending = currentManifest(manifestPath);
    if (
      pending?.version !== 2 ||
      pending.state !== "install-pending"
    ) {
      throw new Error(
        `Claude ownership metadata changed unexpectedly during install (${manifestPath})`
      );
    }
    writeManifest(manifestPath, targetManifest);
    reached("install-committed");
    return {
      configPath,
      action: previousManifest === undefined ? "installed" : "updated",
      managedKeys: Object.keys(nextManaged)
    };
  });
}

export async function uninstallClaudeIntegration(input: {
  ownerId: string;
  claudeConfigDir?: string;
}): Promise<{ configPath: string; removed: boolean }> {
  const resolved = paths(input);
  return await withConfigLock(resolved, () => {
    const { configPath, manifestPath } = resolved;
    let manifest = currentManifest(manifestPath);
    if (manifest === undefined) return { configPath, removed: false };
    if (manifest.ownerId !== input.ownerId) {
      throw new Error(
        `Claude ownership metadata in ${manifestPath} belongs to another integration`
      );
    }
    if (manifest.version === 2 && manifest.state !== "installed") {
      recoverPending(manifest, configPath, manifestPath);
      if (manifest.state === "uninstall-pending") {
        reached("uninstall-committed");
        return { configPath, removed: true };
      }
      manifest = currentManifest(manifestPath);
      if (manifest === undefined) return { configPath, removed: false };
    }

    const beforeSettings = readSnapshot(configPath, "Claude settings");
    let installed: InstalledManifest | undefined;
    if (manifest.version === 1) {
      installed = migrateLegacyManifest(
        manifest,
        beforeSettings,
        configPath,
        manifestPath
      );
    } else if (manifest.state === "installed") {
      installed = manifest;
    } else {
      throw unsupportedManifest(manifestPath);
    }
    if (installed === undefined) return { configPath, removed: false };
    let targetSettings: FileSnapshot;
    if (
      installed.exactRestoreEligible &&
      beforeSettings.hash === installed.installedContentHash
    ) {
      targetSettings = installed.original;
    } else if (beforeSettings.content !== null) {
      const settings = parseSettings(beforeSettings.content, configPath);
      const env = { ...(settings.env ?? {}) };
      for (const [key, accepted] of Object.entries(installed.managedEnvValues)) {
        if (String(env[key]) === accepted) delete env[key];
      }
      const next: ClaudeSettings = { ...settings };
      if (Object.keys(env).length === 0) delete next.env;
      else next.env = env;
      targetSettings = snapshot(serialize(next), beforeSettings.mode);
    } else {
      targetSettings = beforeSettings;
    }

    const pendingManifest: UninstallPendingManifest = {
      version: 2,
      state: "uninstall-pending",
      ownerId: input.ownerId,
      beforeSettings,
      targetSettings
    };
    writeManifest(manifestPath, pendingManifest);
    reached("uninstall-pending");
    const unchanged = readSnapshot(configPath, "Claude settings");
    assertExpectedSnapshot(
      unchanged,
      [beforeSettings],
      configPath,
      "uninstall"
    );
    applySnapshot(configPath, targetSettings, "Claude settings");
    reached("uninstall-settings");
    const pending = currentManifest(manifestPath);
    if (
      pending?.version !== 2 ||
      pending.state !== "uninstall-pending"
    ) {
      throw new Error(
        `Claude ownership metadata changed unexpectedly during uninstall (${manifestPath})`
      );
    }
    rmSync(manifestPath, { force: true });
    reached("uninstall-committed");
    return { configPath, removed: true };
  });
}
