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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { SUBSCRIPTIONS } from "@fusionkit/registry";

import { tomlKey } from "./launch.js";

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

/** The managed config block content (markers included). */
export function codexIntegrationBlock(gatewayUrl: string, profiles: readonly CodexInstallProfile[]): string {
  const base = gatewayUrl.replace(/\/+$/, "");
  const lines = [
    CODEX_INSTALL_BEGIN,
    "# Managed by `fusionkit install codex` — do not edit between these markers;",
    "# rerun the command to update, `fusionkit uninstall codex` to remove.",
    "# Adds the FusionKit fusion gateway as an EXTRA model provider and one",
    "# launch profile per fusion ensemble. Your default model/provider and the",
    "# rest of this file are untouched.",
    "#",
    `# Start the gateway first:  fusionkit serve --port <the port in base_url>`,
    `# Then launch fused:        codex --profile ${profiles[0] !== undefined ? tomlKey(profiles[0].modelId) : "fusion-panel"}`,
    "",
    `[model_providers.${CODEX_INSTALL_PROVIDER}]`,
    `name = "FusionKit fusion gateway"`,
    `base_url = "${base}/v1"`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`,
    ""
  ];
  for (const profile of profiles) {
    lines.push(
      `# Fused "${profile.ensembleName}" ensemble.`,
      `[profiles.${tomlKey(profile.modelId)}]`,
      `model = ${JSON.stringify(profile.modelId)}`,
      `model_provider = "${CODEX_INSTALL_PROVIDER}"`,
      ""
    );
  }
  lines.push(CODEX_INSTALL_END);
  return lines.join("\n");
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

/**
 * Keys the managed block owns. If the user (or another tool) already defines
 * one of them OUTSIDE the block, appending ours would produce a duplicate TOML
 * table and Codex would reject the whole config — abort with the exact
 * conflicting key named instead.
 */
function assertNoConflicts(outside: string, profiles: readonly CodexInstallProfile[]): void {
  const owned = [
    `[model_providers.${CODEX_INSTALL_PROVIDER}]`,
    ...profiles.map((profile) => `[profiles.${tomlKey(profile.modelId)}]`)
  ];
  for (const key of owned) {
    if (outside.includes(key)) {
      throw new Error(
        `your Codex config already defines ${key} outside the fusionkit-managed block; ` +
          `remove or rename it, then rerun \`fusionkit install codex\``
      );
    }
  }
}

/** Trim trailing blank lines and guarantee exactly one trailing newline. */
function normalize(content: string): string {
  const trimmed = content.replace(/\s+$/, "");
  return trimmed.length === 0 ? "" : `${trimmed}\n`;
}

/**
 * Install (or update) the managed FusionKit block in the user's Codex config.
 * Idempotent: an existing block is replaced in place; everything outside it is
 * preserved byte-for-byte.
 */
export function installCodexIntegration(input: CodexInstallInput): CodexInstallResult {
  if (input.profiles.length === 0) throw new Error("at least one fusion ensemble profile is required");
  const configPath = codexConfigPath(input.codexHome);
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const { before, managed, after } = splitManagedBlock(existing);
  assertNoConflicts(before + after, input.profiles);
  const block = codexIntegrationBlock(input.gatewayUrl, input.profiles);
  const head = normalize(before);
  const tail = normalize(after);
  const next = `${head}${head.length > 0 ? "\n" : ""}${block}\n${tail.length > 0 ? `\n${tail}` : ""}`;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, next);
  return {
    configPath,
    action: managed !== undefined ? "updated" : "installed",
    profiles: input.profiles.map((profile) => profile.modelId)
  };
}

/**
 * Remove the managed FusionKit block from the user's Codex config. Everything
 * outside the markers is preserved. Returns `removed: false` when there was
 * nothing to remove.
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
  const head = normalize(before);
  const tail = normalize(after);
  writeFileSync(configPath, `${head}${head.length > 0 && tail.length > 0 ? "\n" : ""}${tail}`);
  return { configPath, removed: true };
}
