/**
 * Per-repo fusion configuration (`fusionkit.json`, committed at the repo root).
 *
 * Captures the panel, judge, default tool, and run defaults so a contributor can
 * just run `fusionkit codex` instead of retyping a long flag line. The file is
 * safe to commit: it stores only the env-var *names* that hold API keys
 * (`keyEnv`), never the secret values.
 *
 * Precedence at run time is: explicit CLI flags > fusionkit.json > built-in
 * defaults. CLI flags always win, so the file is a default layer, not a lock.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FUSION_TOOLS } from "./fusion-quickstart.js";
import type { FusionTool, PanelModelSpec, PanelProvider } from "./fusion-quickstart.js";
import { PANEL_PROVIDERS } from "./shared/options.js";

export const FUSION_CONFIG_FILENAME = "fusionkit.json";
export const FUSION_CONFIG_VERSION = "fusionkit.fusion.v1";

export type FusionConfig = {
  version: typeof FUSION_CONFIG_VERSION;
  tool?: FusionTool;
  panel?: PanelModelSpec[];
  judgeModel?: string;
  local?: boolean;
  observe?: boolean;
  cursorKitDir?: string | null;
  port?: number | null;
};

export class FusionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FusionConfigError";
  }
}

export function fusionConfigPath(repoRoot: string): string {
  return join(repoRoot, FUSION_CONFIG_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePanelEntry(entry: unknown, index: number): PanelModelSpec {
  if (!isRecord(entry)) {
    throw new FusionConfigError(`panel[${index}] must be an object`);
  }
  const { id, model, provider, baseUrl, keyEnv } = entry;
  if (typeof id !== "string" || id.length === 0) {
    throw new FusionConfigError(`panel[${index}].id must be a non-empty string`);
  }
  if (typeof model !== "string" || model.length === 0) {
    throw new FusionConfigError(`panel[${index}].model must be a non-empty string`);
  }
  const spec: PanelModelSpec = { id, model };
  if (provider !== undefined) {
    if (typeof provider !== "string" || !(PANEL_PROVIDERS as readonly string[]).includes(provider)) {
      throw new FusionConfigError(
        `panel[${index}].provider must be one of ${PANEL_PROVIDERS.join(", ")}`
      );
    }
    spec.provider = provider as PanelProvider;
  }
  if (baseUrl !== undefined) {
    if (typeof baseUrl !== "string") throw new FusionConfigError(`panel[${index}].baseUrl must be a string`);
    spec.baseUrl = baseUrl;
  }
  if (keyEnv !== undefined) {
    if (typeof keyEnv !== "string") throw new FusionConfigError(`panel[${index}].keyEnv must be a string`);
    spec.keyEnv = keyEnv;
  }
  return spec;
}

/** Validate a parsed object as a {@link FusionConfig}, throwing on any problem. */
export function parseFusionConfig(raw: unknown, source: string): FusionConfig {
  if (!isRecord(raw)) throw new FusionConfigError(`${source}: must be a JSON object`);
  if (raw.version !== FUSION_CONFIG_VERSION) {
    throw new FusionConfigError(
      `${source}: unsupported version ${JSON.stringify(raw.version)} (expected "${FUSION_CONFIG_VERSION}")`
    );
  }
  const config: FusionConfig = { version: FUSION_CONFIG_VERSION };

  if (raw.tool !== undefined) {
    if (typeof raw.tool !== "string" || !(FUSION_TOOLS as readonly string[]).includes(raw.tool)) {
      throw new FusionConfigError(`${source}: tool must be one of ${FUSION_TOOLS.join(", ")}`);
    }
    config.tool = raw.tool as FusionTool;
  }
  if (raw.panel !== undefined) {
    if (!Array.isArray(raw.panel)) throw new FusionConfigError(`${source}: panel must be an array`);
    config.panel = raw.panel.map((entry, index) => validatePanelEntry(entry, index));
  }
  if (raw.judgeModel !== undefined) {
    if (typeof raw.judgeModel !== "string") throw new FusionConfigError(`${source}: judgeModel must be a string`);
    config.judgeModel = raw.judgeModel;
  }
  if (raw.local !== undefined) {
    if (typeof raw.local !== "boolean") throw new FusionConfigError(`${source}: local must be a boolean`);
    config.local = raw.local;
  }
  if (raw.observe !== undefined) {
    if (typeof raw.observe !== "boolean") throw new FusionConfigError(`${source}: observe must be a boolean`);
    config.observe = raw.observe;
  }
  if (raw.cursorKitDir !== undefined && raw.cursorKitDir !== null) {
    if (typeof raw.cursorKitDir !== "string") {
      throw new FusionConfigError(`${source}: cursorKitDir must be a string or null`);
    }
    config.cursorKitDir = raw.cursorKitDir;
  }
  if (raw.port !== undefined && raw.port !== null) {
    if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 0) {
      throw new FusionConfigError(`${source}: port must be a non-negative integer or null`);
    }
    config.port = raw.port;
  }
  return config;
}

/**
 * Load `<repoRoot>/fusionkit.json` if present. Returns `undefined` when the file
 * does not exist; throws {@link FusionConfigError} on malformed content.
 */
export function loadFusionConfig(repoRoot: string): FusionConfig | undefined {
  const path = fusionConfigPath(repoRoot);
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new FusionConfigError(
      `${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`
    );
  }
  return parseFusionConfig(raw, path);
}

/** Write `fusionkit.json` at the repo root, refusing to clobber unless `force`. */
export function writeFusionConfig(repoRoot: string, config: FusionConfig, options: { force?: boolean } = {}): string {
  const path = fusionConfigPath(repoRoot);
  if (existsSync(path) && options.force !== true) {
    throw new FusionConfigError(`${path} already exists (pass --force to overwrite)`);
  }
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return path;
}
