/**
 * `fusionkit install codex` — additive registration of FusionKit into the
 * user's REAL Codex configuration (the inverse of the `fusionkit codex`
 * launcher's ephemeral home): a managed, clearly-marked block appended to
 * `~/.codex/config.toml` that defines the FusionKit gateway as an extra model
 * provider plus one launch profile per fusion ensemble. Nothing outside the
 * markers is ever touched — the user's default model/provider, MCP servers,
 * instructions, and trust settings all stay theirs.
 *
 * Codex sessions are single-provider (the `/model` picker cannot switch
 * providers), so the profiles are the entry point: `codex --profile
 * fusion-panel` starts a session on the fused model. Inside such a session the
 * gateway's Codex backend relay keeps the FULL picker available — Codex
 * fetches the gateway's live merged catalog (fusion + panel + the user's own
 * stock models) and stock picks are relayed verbatim to the Codex backend.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { parse as tomlParse, stringify as tomlStringify } from "smol-toml";

import { SUBSCRIPTIONS } from "@routekit/registry";
import { trimTrailingSlashes } from "@routekit/runtime";

import { codexProfileFileToml } from "./launch.js";

/** Managed-block markers; everything between them is FusionKit-owned. */
export const CODEX_INSTALL_BEGIN = "# >>> fusionkit integration >>>";
export const CODEX_INSTALL_END = "# <<< fusionkit integration <<<";

/** The provider id the managed block registers. */
export const CODEX_INSTALL_PROVIDER = "fusionkit";

/** One fusion ensemble to expose as a Codex launch profile. */
export type CodexInstallProfile = {
  /** The advertised fused model id (= the profile name), e.g. "fusion-panel". */
  modelId: string;
  /** Human-facing ensemble name, for the block's comments. */
  ensembleName: string;
};

export type CodexInstallInput = {
  /** The gateway base URL the provider points at (no `/v1` suffix). */
  gatewayUrl: string;
  /** One profile per fusion ensemble (session default first). */
  profiles: readonly CodexInstallProfile[];
  /** Codex home directory (default `~/.codex`; tests use a temp dir). */
  codexHome?: string;
};

export type CodexInstallResult = {
  configPath: string;
  /** "installed" on first write, "updated" when an existing block was replaced. */
  action: "installed" | "updated";
  /** The profile names now available to `codex --profile <name>`. */
  profiles: string[];
};

function codexConfigPath(codexHome: string | undefined): string {
  if (codexHome !== undefined) return join(codexHome, "config.toml");
  const registryPath = SUBSCRIPTIONS.codex.configPath ?? "~/.codex/config.toml";
  return registryPath.startsWith("~/") ? join(homedir(), registryPath.slice(2)) : registryPath;
}

/** The comment prefix listing the profile files the managed block owns. */
const PROFILE_FILES_COMMENT = "# fusionkit-profile-files:";

/**
 * The managed config block content (markers included). The TOML body is
 * produced by a real TOML serializer (`smol-toml`), so a hostile/unusual
 * gateway URL can never corrupt the document; the surrounding comments carry
 * the human instructions. Profiles live in sibling `<model>.config.toml`
 * PROFILE FILES, not `[profiles.*]` tables — Codex treats those tables as
 * legacy config and rejects `--profile <name>` outright when one exists for
 * that name. The block records which profile files it owns so
 * uninstall/update can clean them up.
 */
export function codexIntegrationBlock(gatewayUrl: string, profiles: readonly CodexInstallProfile[]): string {
  const base = trimTrailingSlashes(gatewayUrl);
  const body = tomlStringify({
    model_providers: {
      [CODEX_INSTALL_PROVIDER]: {
        name: "FusionKit fusion gateway",
        base_url: `${base}/v1`,
        wire_api: "responses",
        requires_openai_auth: false
      }
    }
  });
  const lines = [
    CODEX_INSTALL_BEGIN,
    "# Managed by `fusionkit install codex` — do not edit between these markers;",
    "# rerun the command to update, `fusionkit uninstall codex` to remove.",
    "# Adds the FusionKit fusion gateway as an EXTRA model provider, plus one",
    "# launch profile file per fusion ensemble (see the list below). Your",
    "# default model/provider and the rest of this file are untouched.",
    "#",
    `# Start the gateway first:  fusionkit serve --port <the port in base_url>`,
    `# Then launch fused:        codex --profile ${profiles[0]?.modelId ?? "fusion-panel"}`,
    ...profiles.map(
      (profile) => `#   codex --profile ${profile.modelId}  (fused "${profile.ensembleName}" ensemble)`
    ),
    `${PROFILE_FILES_COMMENT} ${profiles.map((profile) => profileFileName(profile.modelId)).join(" ")}`,
    "",
    body.trimEnd(),
    "",
    CODEX_INSTALL_END
  ];
  return lines.join("\n");
}

function profileFileName(modelId: string): string {
  return `${modelId}.config.toml`;
}

/** The profile files a managed block declares (absolute paths under the home). */
function ownedProfileFiles(managed: string | undefined, codexHome: string): string[] {
  if (managed === undefined) return [];
  const line = managed.split("\n").find((entry) => entry.startsWith(PROFILE_FILES_COMMENT));
  if (line === undefined) return [];
  return line
    .slice(PROFILE_FILES_COMMENT.length)
    .split(/\s+/)
    .filter((name) => name.endsWith(".config.toml") && !name.includes("/") && !name.includes("\\"))
    .map((name) => join(codexHome, name));
}

/** Split a config into (before, managed, after); managed is undefined when absent. */
function splitManagedBlock(content: string): { before: string; managed?: string; after: string } {
  const begin = content.indexOf(CODEX_INSTALL_BEGIN);
  if (begin === -1) return { before: content, after: "" };
  const end = content.indexOf(CODEX_INSTALL_END, begin);
  if (end === -1) {
    throw new Error(
      `found the fusionkit begin marker but no end marker in the Codex config; ` +
        `remove the "${CODEX_INSTALL_BEGIN}" line (and anything fusionkit added below it) and retry`
    );
  }
  return {
    before: content.slice(0, begin),
    managed: content.slice(begin, end + CODEX_INSTALL_END.length),
    after: content.slice(end + CODEX_INSTALL_END.length)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a TOML document, failing with a caller-supplied context message. */
function parseTomlOrThrow(content: string, what: string): Record<string, unknown> {
  try {
    return tomlParse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`${what} is not valid TOML (${detail}); fix it, then rerun the command`);
  }
}

/**
 * Keys the managed block owns, checked against the PARSED user config (not
 * substrings, so a mention inside a comment or string never false-positives).
 * If the user (or another tool) already defines one of them OUTSIDE the
 * block, appending ours would produce a duplicate TOML table (or a
 * `--profile`-blocking legacy profile) and Codex would reject the config —
 * abort with the exact conflicting key named instead.
 */
function assertNoConflicts(outside: Record<string, unknown>, profiles: readonly CodexInstallProfile[]): void {
  const providers = outside.model_providers;
  if (isRecord(providers) && providers[CODEX_INSTALL_PROVIDER] !== undefined) {
    throw new Error(
      `your Codex config already defines [model_providers.${CODEX_INSTALL_PROVIDER}] outside the ` +
        `fusionkit-managed block; remove or rename it, then rerun \`fusionkit install codex\``
    );
  }
  // A legacy [profiles.<name>] table anywhere makes Codex reject
  // `--profile <name>`, so a user-owned one for a fused id is a conflict.
  const legacyProfiles = outside.profiles;
  for (const profile of profiles) {
    if (isRecord(legacyProfiles) && legacyProfiles[profile.modelId] !== undefined) {
      throw new Error(
        `your Codex config already defines [profiles.${profile.modelId}] outside the ` +
          `fusionkit-managed block; remove or rename it, then rerun \`fusionkit install codex\``
      );
    }
  }
}

/** Trim trailing blank lines and guarantee exactly one trailing newline. */
function normalize(content: string): string {
  const trimmed = content.replace(/\s+$/, "");
  return trimmed.length === 0 ? "" : `${trimmed}\n`;
}

/** Delete a previously-owned profile file, but only if fusionkit wrote it. */
function removeOwnedProfileFile(path: string): void {
  try {
    if (!existsSync(path)) return;
    if (!readFileSync(path, "utf8").includes("Managed by fusionkit")) return;
    rmSync(path);
  } catch {
    // best-effort cleanup; a leftover profile file is harmless
  }
}

/**
 * Install (or update) the managed FusionKit block in the user's Codex config,
 * plus one `<model>.config.toml` profile file per ensemble. Idempotent: an
 * existing block is replaced in place (stale profile files it owned are
 * removed); everything outside it is preserved byte-for-byte.
 */
export function installCodexIntegration(input: CodexInstallInput): CodexInstallResult {
  if (input.profiles.length === 0) throw new Error("at least one fusion ensemble profile is required");
  const configPath = codexConfigPath(input.codexHome);
  const codexHome = dirname(configPath);
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const { before, managed, after } = splitManagedBlock(existing);
  // The user-owned remainder must be valid TOML (a broken config would make
  // Codex reject everything anyway) and must not already claim our keys.
  const outside = parseTomlOrThrow(`${normalize(before)}\n${normalize(after)}`, `your Codex config (${configPath})`);
  assertNoConflicts(outside, input.profiles);
  const block = codexIntegrationBlock(input.gatewayUrl, input.profiles);
  const head = normalize(before);
  const tail = normalize(after);
  const next = `${head}${head.length > 0 ? "\n" : ""}${block}\n${tail.length > 0 ? `\n${tail}` : ""}`;
  // Never write a config Codex would reject: the assembled document must
  // parse and must actually carry the provider the block registers.
  const assembled = parseTomlOrThrow(next, "the updated Codex config fusionkit assembled");
  const assembledProviders = assembled.model_providers;
  if (!isRecord(assembledProviders) || assembledProviders[CODEX_INSTALL_PROVIDER] === undefined) {
    throw new Error("internal error: the assembled Codex config lost the fusionkit provider block");
  }
  mkdirSync(codexHome, { recursive: true });
  // Profile files dropped from the ensemble set are cleaned up on update.
  const nextFiles = new Set(input.profiles.map((profile) => join(codexHome, profileFileName(profile.modelId))));
  for (const stale of ownedProfileFiles(managed, codexHome)) {
    if (!nextFiles.has(stale)) removeOwnedProfileFile(stale);
  }
  writeFileSync(configPath, next);
  for (const profile of input.profiles) {
    writeFileSync(
      join(codexHome, profileFileName(profile.modelId)),
      codexProfileFileToml(profile.modelId, CODEX_INSTALL_PROVIDER)
    );
  }
  return {
    configPath,
    action: managed !== undefined ? "updated" : "installed",
    profiles: input.profiles.map((profile) => profile.modelId)
  };
}

/**
 * Remove the managed FusionKit block and the profile files it owns from the
 * user's Codex config. Everything outside the markers is preserved. Returns
 * `removed: false` when there was nothing to remove.
 */
export function uninstallCodexIntegration(input: { codexHome?: string } = {}): {
  configPath: string;
  removed: boolean;
} {
  const configPath = codexConfigPath(input.codexHome);
  if (!existsSync(configPath)) return { configPath, removed: false };
  const existing = readFileSync(configPath, "utf8");
  const { before, managed, after } = splitManagedBlock(existing);
  if (managed === undefined) return { configPath, removed: false };
  for (const owned of ownedProfileFiles(managed, dirname(configPath))) {
    removeOwnedProfileFile(owned);
  }
  const head = normalize(before);
  const tail = normalize(after);
  writeFileSync(configPath, `${head}${head.length > 0 && tail.length > 0 ? "\n" : ""}${tail}`);
  return { configPath, removed: true };
}
