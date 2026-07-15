import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { parse as tomlParse, stringify as tomlStringify } from "smol-toml";

import { SUBSCRIPTIONS } from "@routekit/registry";
import { trimTrailingSlashes } from "@routekit/runtime";

import { codexProfileFileToml } from "./launch.js";

export type CodexInstallProfile = {
  modelId: string;
  description?: string;
};

export type CodexInstallOwner = {
  id: string;
  displayName: string;
  providerId: string;
  installCommand: string;
  uninstallCommand: string;
  startCommand: string;
};

export type CodexInstallInput = {
  gatewayUrl: string;
  profiles: readonly CodexInstallProfile[];
  owner: CodexInstallOwner;
  codexHome?: string;
};

export type CodexInstallResult = {
  configPath: string;
  action: "installed" | "updated";
  profiles: string[];
};

function codexConfigPath(codexHome: string | undefined): string {
  if (codexHome !== undefined) return join(codexHome, "config.toml");
  const registryPath = SUBSCRIPTIONS.codex.configPath ?? "~/.codex/config.toml";
  return registryPath.startsWith("~/") ? join(homedir(), registryPath.slice(2)) : registryPath;
}

function marker(ownerId: string, edge: "begin" | "end"): string {
  return `# ${edge === "begin" ? ">>>" : "<<<"} ${ownerId} integration ${edge === "begin" ? ">>>" : "<<<"}`;
}

function profileFilesComment(ownerId: string): string {
  return `# ${ownerId}-profile-files:`;
}

function profileFileName(modelId: string): string {
  return `${modelId}.config.toml`;
}

/** Serialize one additive, owner-marked Codex provider block. */
export function codexIntegrationBlock(input: CodexInstallInput): string {
  const base = trimTrailingSlashes(input.gatewayUrl);
  const begin = marker(input.owner.id, "begin");
  const end = marker(input.owner.id, "end");
  const filesComment = profileFilesComment(input.owner.id);
  const body = tomlStringify({
    model_providers: {
      [input.owner.providerId]: {
        name: `${input.owner.displayName} gateway`,
        base_url: `${base}/v1`,
        wire_api: "responses",
        requires_openai_auth: false
      }
    }
  });
  return [
    begin,
    `# Managed by \`${input.owner.installCommand}\`; do not edit between these markers.`,
    `# Rerun that command to update; use \`${input.owner.uninstallCommand}\` to remove.`,
    `# Start the gateway first: ${input.owner.startCommand}`,
    `# Then launch: codex --profile ${input.profiles[0]?.modelId ?? "gateway-model"}`,
    ...input.profiles.map(
      (profile) =>
        `#   codex --profile ${profile.modelId}${profile.description !== undefined ? `  (${profile.description})` : ""}`
    ),
    `${filesComment} ${input.profiles.map((profile) => profileFileName(profile.modelId)).join(" ")}`,
    "",
    body.trimEnd(),
    "",
    end
  ].join("\n");
}

function ownedProfileFiles(
  managed: string | undefined,
  codexHome: string,
  ownerId: string
): string[] {
  if (managed === undefined) return [];
  const prefix = profileFilesComment(ownerId);
  const line = managed.split("\n").find((entry) => entry.startsWith(prefix));
  if (line === undefined) return [];
  return line
    .slice(prefix.length)
    .split(/\s+/)
    .filter((name) => name.endsWith(".config.toml") && !name.includes("/") && !name.includes("\\"))
    .map((name) => join(codexHome, name));
}

function splitManagedBlock(
  content: string,
  ownerId: string
): { before: string; managed?: string; after: string } {
  const beginMarker = marker(ownerId, "begin");
  const endMarker = marker(ownerId, "end");
  const begin = content.indexOf(beginMarker);
  if (begin === -1) return { before: content, after: "" };
  const end = content.indexOf(endMarker, begin);
  if (end === -1) {
    throw new Error(
      `found the ${ownerId} begin marker but no end marker in the Codex config; ` +
        `remove the "${beginMarker}" line and its managed content, then retry`
    );
  }
  return {
    before: content.slice(0, begin),
    managed: content.slice(begin, end + endMarker.length),
    after: content.slice(end + endMarker.length)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTomlOrThrow(content: string, what: string): Record<string, unknown> {
  try {
    return tomlParse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`${what} is not valid TOML (${detail}); fix it, then rerun the command`);
  }
}

function assertNoConflicts(
  outside: Record<string, unknown>,
  input: Pick<CodexInstallInput, "owner" | "profiles">
): void {
  const providers = outside.model_providers;
  if (isRecord(providers) && providers[input.owner.providerId] !== undefined) {
    throw new Error(
      `your Codex config already defines [model_providers.${input.owner.providerId}] outside the ` +
        `${input.owner.id}-managed block; remove or rename it, then rerun \`${input.owner.installCommand}\``
    );
  }
  const legacyProfiles = outside.profiles;
  for (const profile of input.profiles) {
    if (isRecord(legacyProfiles) && legacyProfiles[profile.modelId] !== undefined) {
      throw new Error(
        `your Codex config already defines [profiles.${profile.modelId}] outside the ` +
          `${input.owner.id}-managed block; remove or rename it, then rerun \`${input.owner.installCommand}\``
      );
    }
  }
}

function normalize(content: string): string {
  const trimmed = content.replace(/\s+$/, "");
  return trimmed.length === 0 ? "" : `${trimmed}\n`;
}

function removeOwnedProfileFile(path: string, ownerId: string): void {
  try {
    if (!existsSync(path)) return;
    if (!readFileSync(path, "utf8").includes(`Managed by ${ownerId}`)) return;
    rmSync(path);
  } catch {
    // Best-effort cleanup; an orphaned profile does not alter the main config.
  }
}

export function installCodexIntegration(input: CodexInstallInput): CodexInstallResult {
  if (input.profiles.length === 0) throw new Error("at least one Codex profile is required");
  const configPath = codexConfigPath(input.codexHome);
  const codexHome = dirname(configPath);
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const { before, managed, after } = splitManagedBlock(existing, input.owner.id);
  const outside = parseTomlOrThrow(
    `${normalize(before)}\n${normalize(after)}`,
    `your Codex config (${configPath})`
  );
  assertNoConflicts(outside, input);
  const block = codexIntegrationBlock(input);
  const head = normalize(before);
  const tail = normalize(after);
  const next = `${head}${head.length > 0 ? "\n" : ""}${block}\n${tail.length > 0 ? `\n${tail}` : ""}`;
  const assembled = parseTomlOrThrow(next, "the updated Codex config");
  const providers = assembled.model_providers;
  if (!isRecord(providers) || providers[input.owner.providerId] === undefined) {
    throw new Error("internal error: the assembled Codex config lost its managed provider block");
  }
  mkdirSync(codexHome, { recursive: true });
  const nextFiles = new Set(
    input.profiles.map((profile) => join(codexHome, profileFileName(profile.modelId)))
  );
  for (const stale of ownedProfileFiles(managed, codexHome, input.owner.id)) {
    if (!nextFiles.has(stale)) removeOwnedProfileFile(stale, input.owner.id);
  }
  writeFileSync(configPath, next);
  for (const profile of input.profiles) {
    writeFileSync(
      join(codexHome, profileFileName(profile.modelId)),
      `# Managed by ${input.owner.id}\n${codexProfileFileToml(profile.modelId, input.owner.providerId)}`
    );
  }
  return {
    configPath,
    action: managed !== undefined ? "updated" : "installed",
    profiles: input.profiles.map((profile) => profile.modelId)
  };
}

export function uninstallCodexIntegration(input: {
  ownerId: string;
  codexHome?: string;
}): { configPath: string; removed: boolean } {
  const configPath = codexConfigPath(input.codexHome);
  if (!existsSync(configPath)) return { configPath, removed: false };
  const existing = readFileSync(configPath, "utf8");
  const { before, managed, after } = splitManagedBlock(existing, input.ownerId);
  if (managed === undefined) return { configPath, removed: false };
  for (const owned of ownedProfileFiles(managed, dirname(configPath), input.ownerId)) {
    removeOwnedProfileFile(owned, input.ownerId);
  }
  const head = normalize(before);
  const tail = normalize(after);
  writeFileSync(configPath, `${head}${head.length > 0 && tail.length > 0 ? "\n" : ""}${tail}`);
  return { configPath, removed: true };
}
