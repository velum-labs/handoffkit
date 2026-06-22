/**
 * Per-repo fusion configuration, stored in a committed `.fusionkit/` folder at
 * the repo root:
 *
 *   .fusionkit/
 *     fusion.json        - all settings (panel, judge, default tool, run defaults)
 *     prompts/<id>.md    - optional system-prompt overrides (one file per prompt)
 *
 * The folder is safe to commit: it stores only the env-var *names* that hold API
 * keys (`keyEnv`), never the secret values. A prompt file that exists and is
 * non-empty overrides the matching built-in synthesizer prompt; absent/empty
 * falls back to the built-in default.
 *
 * Precedence at run time is: explicit CLI flags > .fusionkit > built-in
 * defaults. CLI flags always win, so the folder is a default layer, not a lock.
 *
 * Legacy `fusionkit.json` files at the repo root are auto-migrated into
 * `.fusionkit/fusion.json` on first load (the original is left intact as a
 * back-compat fallback).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FUSION_TOOLS } from "./fusion-quickstart.js";
import type { FusionTool, PanelAuthMode, PanelModelSpec, PanelProvider } from "./fusion-quickstart.js";
import { PANEL_AUTH_MODES, PANEL_PROVIDERS } from "./shared/options.js";
import type { RoutingProviderSpec, ScenarioRoutes } from "@fusionkit/model-gateway";
import { parseRoutingProviderSpec, parseScenarioRoutes, RoutingConfigError, RoutingProviderError } from "@fusionkit/model-gateway";

export const FUSION_CONFIG_DIRNAME = ".fusionkit";
// `fusion.json` (not `config.json`) so the fusion settings never collide with
// the plane home's `.fusionkit/config.json` (`warrant.config.v2`).
export const FUSION_CONFIG_BASENAME = "fusion.json";
export const FUSION_PROMPTS_DIRNAME = "prompts";
/** Legacy single-file config at the repo root (pre-`.fusionkit/`). */
export const FUSION_CONFIG_FILENAME = "fusionkit.json";

export const FUSION_CONFIG_VERSION = "fusionkit.fusion.v2";
/** Versions `parseFusionConfig` will load; `v1` is upgraded to `v2` in memory. */
const SUPPORTED_CONFIG_VERSIONS = ["fusionkit.fusion.v1", "fusionkit.fusion.v2"] as const;

/**
 * The committable system-prompt override ids. Each maps to a
 * `.fusionkit/prompts/<id>.md` file and to a `FusionConfig.prompts` key in the
 * Python synthesizer (see {@link PROMPT_CONFIG_KEY}).
 */
export const PROMPT_IDS = [
  "judge",
  "synthesizer",
  "trajectory-synthesizer",
  "trajectory-step",
  "verifier",
  "panel"
] as const;
export type PromptId = (typeof PROMPT_IDS)[number];

/** Map each prompt override id to the `prompts:` key fusionkit's config expects. */
export const PROMPT_CONFIG_KEY: Record<PromptId, string> = {
  judge: "judge_system",
  synthesizer: "synthesizer_system",
  "trajectory-synthesizer": "trajectory_synthesizer_system",
  "trajectory-step": "trajectory_step_system",
  verifier: "verifier_system",
  panel: "panel_system"
};

export type PromptOverrides = Partial<Record<PromptId, string>>;

export type FusionRoutingConfig = {
  /** Per-scenario route table. */
  routes: ScenarioRoutes;
  /** Provider backends referenced by route targets. */
  providers: RoutingProviderSpec[];
};

export type FusionConfig = {
  version: typeof FUSION_CONFIG_VERSION;
  tool?: FusionTool;
  panel?: PanelModelSpec[];
  judgeModel?: string;
  local?: boolean;
  observe?: boolean;
  portless?: boolean;
  port?: number | null;
  /**
   * Claude Code smart routing (claude-code-router semantics). When present,
   * `fusionkit claude --route` starts a routing gateway instead of the fusion
   * panel gateway.
   */
  routing?: FusionRoutingConfig;
  /**
   * System-prompt overrides, loaded from `.fusionkit/prompts/*.md`. Not stored
   * inline in `config.json` — it is hydrated from the prompt files on load.
   */
  prompts?: PromptOverrides;
};

export class FusionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FusionConfigError";
  }
}

/** The `.fusionkit/` directory at the repo root. */
export function fusionConfigDir(repoRoot: string): string {
  return join(repoRoot, FUSION_CONFIG_DIRNAME);
}

/** The `.fusionkit/fusion.json` settings file. */
export function fusionConfigPath(repoRoot: string): string {
  return join(fusionConfigDir(repoRoot), FUSION_CONFIG_BASENAME);
}

/** The legacy `fusionkit.json` at the repo root (pre-`.fusionkit/`). */
export function legacyFusionConfigPath(repoRoot: string): string {
  return join(repoRoot, FUSION_CONFIG_FILENAME);
}

/** The `.fusionkit/prompts/` directory holding the override files. */
export function fusionPromptsDir(repoRoot: string): string {
  return join(fusionConfigDir(repoRoot), FUSION_PROMPTS_DIRNAME);
}

/** The `.fusionkit/prompts/<id>.md` file for a single prompt override. */
export function fusionPromptPath(repoRoot: string, id: PromptId): string {
  return join(fusionPromptsDir(repoRoot), `${id}.md`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePanelEntry(entry: unknown, index: number): PanelModelSpec {
  if (!isRecord(entry)) {
    throw new FusionConfigError(`panel[${index}] must be an object`);
  }
  const { id, model, provider, baseUrl, keyEnv, auth } = entry;
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
  if (auth !== undefined) {
    if (typeof auth !== "string" || !(PANEL_AUTH_MODES as readonly string[]).includes(auth)) {
      throw new FusionConfigError(
        `panel[${index}].auth must be one of ${PANEL_AUTH_MODES.join(", ")}`
      );
    }
    spec.auth = auth as PanelAuthMode;
  }
  return spec;
}

function validateRouting(raw: unknown, source: string): FusionRoutingConfig {
  if (!isRecord(raw)) throw new FusionConfigError(`${source}: routing must be an object`);
  try {
    const routes = parseScenarioRoutes(isRecord(raw.routes) ? raw.routes : raw, source);
    const providerRaw = raw.providers;
    if (!Array.isArray(providerRaw) || providerRaw.length === 0) {
      throw new FusionConfigError(`${source}: routing.providers must be a non-empty array`);
    }
    const providers = providerRaw.map((entry, index) => parseRoutingProviderSpec(entry, index));
    return { routes, providers };
  } catch (error) {
    if (error instanceof RoutingConfigError || error instanceof RoutingProviderError) {
      throw new FusionConfigError(error.message);
    }
    throw error;
  }
}

/**
 * Validate a parsed settings object as a {@link FusionConfig}, throwing on any
 * problem. Prompt overrides are loaded separately from `.fusionkit/prompts/`,
 * not from this object. A `v1` version is accepted and upgraded to `v2`.
 */
export function parseFusionConfig(raw: unknown, source: string): FusionConfig {
  if (!isRecord(raw)) throw new FusionConfigError(`${source}: must be a JSON object`);
  if (typeof raw.version !== "string" || !(SUPPORTED_CONFIG_VERSIONS as readonly string[]).includes(raw.version)) {
    throw new FusionConfigError(
      `${source}: unsupported version ${JSON.stringify(raw.version)} (expected one of ${SUPPORTED_CONFIG_VERSIONS.join(", ")})`
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
  if (raw.portless !== undefined) {
    if (typeof raw.portless !== "boolean") throw new FusionConfigError(`${source}: portless must be a boolean`);
    config.portless = raw.portless;
  }
  if (raw.port !== undefined && raw.port !== null) {
    if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 0) {
      throw new FusionConfigError(`${source}: port must be a non-negative integer or null`);
    }
    config.port = raw.port;
  }
  if (raw.routing !== undefined) {
    config.routing = validateRouting(raw.routing, source);
  }
  return config;
}

function readAndParse(path: string): FusionConfig {
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

/**
 * Read the committed prompt overrides from `.fusionkit/prompts/*.md`. Only files
 * that exist and are non-empty (after trimming) become overrides.
 */
export function readFusionPrompts(repoRoot: string): PromptOverrides {
  const dir = fusionPromptsDir(repoRoot);
  const prompts: PromptOverrides = {};
  if (!existsSync(dir)) return prompts;
  for (const id of PROMPT_IDS) {
    const path = fusionPromptPath(repoRoot, id);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8").trim();
    if (text.length > 0) prompts[id] = text;
  }
  return prompts;
}

function withPrompts(repoRoot: string, config: FusionConfig): FusionConfig {
  const prompts = readFusionPrompts(repoRoot);
  if (Object.keys(prompts).length === 0) return config;
  return { ...config, prompts };
}

/**
 * Load the per-repo config. Prefers `.fusionkit/config.json`; if it is absent
 * but a legacy `fusionkit.json` exists, auto-migrates it into the folder (the
 * original is left intact) and loads from there. Returns `undefined` when no
 * config exists; throws {@link FusionConfigError} on malformed content.
 *
 * `onNotice` receives a one-line message when a migration happens.
 */
export function loadFusionConfig(
  repoRoot: string,
  onNotice?: (message: string) => void
): FusionConfig | undefined {
  const newPath = fusionConfigPath(repoRoot);
  if (existsSync(newPath)) {
    return withPrompts(repoRoot, readAndParse(newPath));
  }

  const legacyPath = legacyFusionConfigPath(repoRoot);
  if (!existsSync(legacyPath)) return undefined;

  const config = readAndParse(legacyPath);
  try {
    writeFusionConfig(repoRoot, config);
    onNotice?.(`migrated ${legacyPath} into ${newPath}`);
  } catch {
    // Could not write the migrated copy (e.g. read-only FS); use the legacy
    // file in place for this run rather than failing.
  }
  return withPrompts(repoRoot, config);
}

/**
 * Write `.fusionkit/config.json` (creating the folder), refusing to clobber
 * unless `force`. Prompt overrides are stored as files, not inline, so any
 * `prompts` on the config object is omitted here.
 */
export function writeFusionConfig(
  repoRoot: string,
  config: FusionConfig,
  options: { force?: boolean } = {}
): string {
  const path = fusionConfigPath(repoRoot);
  if (existsSync(path) && options.force !== true) {
    throw new FusionConfigError(`${path} already exists (pass --force to overwrite)`);
  }
  mkdirSync(fusionConfigDir(repoRoot), { recursive: true });
  const { prompts: _prompts, ...persisted } = config;
  writeFileSync(path, JSON.stringify(persisted, null, 2) + "\n");
  return path;
}

/**
 * Write prompt override files into `.fusionkit/prompts/`. Existing files are
 * left untouched unless `force`. Returns the paths actually written.
 */
export function writeFusionPrompts(
  repoRoot: string,
  prompts: PromptOverrides,
  options: { force?: boolean } = {}
): string[] {
  mkdirSync(fusionPromptsDir(repoRoot), { recursive: true });
  const written: string[] = [];
  for (const id of PROMPT_IDS) {
    const text = prompts[id];
    if (text === undefined) continue;
    const path = fusionPromptPath(repoRoot, id);
    if (existsSync(path) && options.force !== true) continue;
    writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
    written.push(path);
  }
  return written;
}
