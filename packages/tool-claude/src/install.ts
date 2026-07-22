import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { SUBSCRIPTIONS } from "@routekit/registry";
import { trimTrailingSlashes, writeFileAtomic } from "@routekit/runtime";

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
  modelId?: string;
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

type ClaudeInstallManifest = {
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
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "ANTHROPIC_MODEL"
] as const;

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
  configPath: string;
  manifestPath: string;
} {
  assertSafeOwnerId(input.ownerId);
  const configDirectory = input.claudeConfigDir ?? defaultClaudeConfigDir();
  return {
    configPath: join(configDirectory, "settings.json"),
    manifestPath: join(configDirectory, `.${input.ownerId}-integration.json`)
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

function parseManifest(content: string, manifestPath: string): ClaudeInstallManifest {
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
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Partial<ClaudeInstallManifest>).version !== 1 ||
    typeof (parsed as Partial<ClaudeInstallManifest>).ownerId !== "string" ||
    typeof (parsed as Partial<ClaudeInstallManifest>).managedEnvValues !== "object"
  ) {
    throw new Error(
      `RouteKit's Claude ownership metadata (${manifestPath}) has an unsupported format`
    );
  }
  return parsed as ClaudeInstallManifest;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function managedEnv(input: ClaudeInstallInput): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: trimTrailingSlashes(input.gatewayUrl),
    ANTHROPIC_AUTH_TOKEN: input.authToken ?? "routekit",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    ...(input.modelId !== undefined ? { ANTHROPIC_MODEL: input.modelId } : {})
  };
}

function currentContent(configPath: string): string | null {
  return existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
}

function currentManifest(manifestPath: string): ClaudeInstallManifest | undefined {
  return existsSync(manifestPath)
    ? parseManifest(readFileSync(manifestPath, "utf8"), manifestPath)
    : undefined;
}

function assertManagedValuesUnchanged(
  env: Record<string, unknown>,
  manifest: ClaudeInstallManifest,
  configPath: string
): void {
  for (const [key, accepted] of Object.entries(manifest.managedEnvValues)) {
    if (!accepted.includes(String(env[key]))) {
      throw new Error(
        `your Claude settings changed RouteKit-managed env.${key} in ${configPath}; ` +
          `remove or restore that value before rerunning the install command`
      );
    }
  }
}

export function installClaudeIntegration(input: ClaudeInstallInput): ClaudeInstallResult {
  const { configPath, manifestPath } = paths({
    ownerId: input.owner.id,
    ...(input.claudeConfigDir !== undefined
      ? { claudeConfigDir: input.claudeConfigDir }
      : {})
  });
  const original = currentContent(configPath);
  const previousManifest = currentManifest(manifestPath);
  if (previousManifest !== undefined && previousManifest.ownerId !== input.owner.id) {
    throw new Error(`Claude ownership metadata in ${manifestPath} belongs to another integration`);
  }
  const settings = parseSettings(original ?? "{}\n", configPath);
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
    assertManagedValuesUnchanged(env, previousManifest, configPath);
  }

  for (const key of MANAGED_ENV_KEYS) {
    if (nextManaged[key] === undefined) delete env[key];
  }
  Object.assign(env, nextManaged);
  const nextSettings: ClaudeSettings = { ...settings, env };
  const nextContent = serialize(nextSettings);
  const exactRestoreEligible =
    previousManifest === undefined
      ? true
      : previousManifest.exactRestoreEligible &&
        original !== null &&
        previousManifest.installedContentHashes.includes(hash(original));
  const pendingManifest: ClaudeInstallManifest = {
    version: 1,
    ownerId: input.owner.id,
    originalContent: previousManifest?.originalContent ?? original,
    exactRestoreEligible,
    installedContentHashes: [
      ...(original !== null ? [hash(original)] : []),
      hash(nextContent)
    ],
    managedEnvValues: Object.fromEntries(
      Object.entries(nextManaged).map(([key, value]) => [
        key,
        [
          ...(previousManifest?.managedEnvValues[key] ?? []),
          value
        ].filter((entry, index, all) => all.indexOf(entry) === index)
      ])
    )
  };
  const finalManifest: ClaudeInstallManifest = {
    ...pendingManifest,
    installedContentHashes: [hash(nextContent)],
    managedEnvValues: Object.fromEntries(
      Object.entries(nextManaged).map(([key, value]) => [key, [value]])
    )
  };

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileAtomic(manifestPath, serialize(pendingManifest), { mode: 0o600 });
  writeFileAtomic(configPath, nextContent, { mode: 0o600 });
  writeFileAtomic(manifestPath, serialize(finalManifest), { mode: 0o600 });
  return {
    configPath,
    action: previousManifest === undefined ? "installed" : "updated",
    managedKeys: Object.keys(nextManaged)
  };
}

export function uninstallClaudeIntegration(input: {
  ownerId: string;
  claudeConfigDir?: string;
}): { configPath: string; removed: boolean } {
  const { configPath, manifestPath } = paths(input);
  const manifest = currentManifest(manifestPath);
  if (manifest === undefined) return { configPath, removed: false };
  if (manifest.ownerId !== input.ownerId) {
    throw new Error(`Claude ownership metadata in ${manifestPath} belongs to another integration`);
  }
  const current = currentContent(configPath);

  if (
    manifest.exactRestoreEligible &&
    current !== null &&
    manifest.installedContentHashes.includes(hash(current))
  ) {
    if (manifest.originalContent === null) rmSync(configPath, { force: true });
    else writeFileAtomic(configPath, manifest.originalContent, { mode: 0o600 });
  } else if (current !== null) {
    const settings = parseSettings(current, configPath);
    const env = { ...(settings.env ?? {}) };
    for (const [key, accepted] of Object.entries(manifest.managedEnvValues)) {
      if (accepted.includes(String(env[key]))) delete env[key];
    }
    const next: ClaudeSettings = { ...settings };
    if (Object.keys(env).length === 0) delete next.env;
    else next.env = env;
    writeFileAtomic(configPath, serialize(next), { mode: 0o600 });
  }
  rmSync(manifestPath, { force: true });
  return { configPath, removed: true };
}
