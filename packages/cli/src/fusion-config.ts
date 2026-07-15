/**
 * Per-repo fusion configuration, stored in a committed `.fusionkit/` folder at
 * the repo root:
 *
 *   .fusionkit/
 *     fusion.json               - all settings (ensembles, default tool, run defaults)
 *     prompts/<id>.md           - default-ensemble system-prompt overrides
 *     prompts/<ensemble>/<id>.md - per-ensemble overrides (fall back to the flat files)
 *
 * The folder is safe to commit: it stores only the env-var *names* that hold API
 * keys (`keyEnv`), never the secret values. A prompt file that exists and is
 * non-empty overrides the matching built-in synthesizer prompt; absent/empty
 * falls back to the built-in default.
 *
 * A repo may define multiple named ensembles (`ensembles`), each with its own
 * panel, judge, synthesizer, and prompts. Every ensemble is registered as its
 * own selectable model (`fusion-<name>`; the `default` ensemble keeps the
 * canonical `fusion-panel` id), and `defaultEnsemble` picks which one a session
 * defaults to.
 *
 * Precedence at run time is: explicit CLI flags > .fusionkit > built-in
 * defaults. CLI flags always win, so the folder is a default layer, not a lock.
 *
 * Legacy `fusionkit.json` files at the repo root are auto-migrated into
 * `.fusionkit/fusion.json` on first load (the original is left intact as a
 * back-compat fallback). Legacy v1/v2 configs (a flat `panel` + `judgeModel`)
 * are upgraded in memory into `ensembles.default`.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  isRecord,
  loadMigratingConfig,
  writeJsonAtomic
} from "@routekit/config-core";
import { writeFileAtomic } from "@routekit/runtime";
import type { OnRateLimitPolicy } from "@fusionkit/model-gateway";
import type {
  SubscriptionAccountSource,
  SubscriptionSelectionStrategy
} from "@fusionkit/model-gateway/subscriptions";
import { DEFAULT_ENSEMBLE_NAME } from "@fusionkit/registry";
import type { SubscriptionMode } from "@routekit/registry";

import type { PanelTrust } from "@fusionkit/ensemble";

import { FUSION_TOOLS } from "./fusion-quickstart.js";
import type { FusionTool, PanelAuthMode, PanelModelSpec, PanelProvider } from "./fusion-quickstart.js";
import { ON_RATE_LIMIT_POLICIES, PANEL_AUTH_MODES, PANEL_PROVIDERS, PANEL_TRUST_LEVELS } from "./shared/options.js";

export const FUSION_CONFIG_DIRNAME = ".fusionkit";
// `fusion.json` (not `config.json`) so the fusion settings never collide with
// the plane home's `.fusionkit/config.json` (`fusionkit.config.v2`).
export const FUSION_CONFIG_BASENAME = "fusion.json";
export const FUSION_PROMPTS_DIRNAME = "prompts";
/** Legacy single-file config at the repo root (pre-`.fusionkit/`). */
export const FUSION_CONFIG_FILENAME = "fusionkit.json";

export const FUSION_CONFIG_VERSION = "fusionkit.fusion.v3";
/** Versions `parseFusionConfig` will load; older versions upgrade to `v3` in memory. */
const SUPPORTED_CONFIG_VERSIONS = [
  "fusionkit.fusion.v1",
  "fusionkit.fusion.v2",
  "fusionkit.fusion.v3"
] as const;

/** Valid ensemble names: lowercase alphanumerics and dashes, starting alphanumeric. */
const ENSEMBLE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/**
 * Reserved ensemble names. `panel` would collide with the default ensemble's
 * canonical `fusion-panel` model id (`fusion-<name>` for every other name).
 */
const RESERVED_ENSEMBLE_NAMES = new Set(["panel"]);

export { DEFAULT_ENSEMBLE_NAME };

/**
 * The committable system-prompt override ids. Each maps to a
 * `.fusionkit/prompts/<id>.md` file (default ensemble) or
 * `.fusionkit/prompts/<ensemble>/<id>.md`, and to a `FusionConfig.prompts` key
 * in the Python synthesizer (see {@link PROMPT_CONFIG_KEY}).
 */
export const PROMPT_IDS = ["judge", "synthesizer"] as const;
export type PromptId = (typeof PROMPT_IDS)[number];

/** Map each prompt override id to the `prompts:` key fusionkit's config expects. */
export const PROMPT_CONFIG_KEY: Record<PromptId, string> = {
  judge: "judge_system",
  synthesizer: "synthesizer_system"
};

export type PromptOverrides = Partial<Record<PromptId, string>>;

export type SubscriptionAccountConfig = {
  source?: SubscriptionAccountSource;
  strategy?: SubscriptionSelectionStrategy;
  switchThreshold?: number;
  probeIntervalMs?: number;
};


/**
 * One named ensemble: its panel, judge, synthesizer, and (hydrated at load
 * time, never stored inline) its prompt overrides. A missing/empty `panel` on
 * the default ensemble means "use the built-in trio"; every other ensemble must
 * declare a non-empty panel.
 */
export type EnsembleConfig = {
  panel?: PanelModelSpec[];
  judgeModel?: string;
  /** Synthesizer model; defaults to the judge on the Python side. */
  synthesizerModel?: string;
  /**
   * Step boundaries per panel member before aggregation. `1` runs members as
   * single-completion proposers over the caller's exact messages+tools; a
   * finite value > 1 bounds the managed-harness rollout (lookahead); unset
   * means unbounded (today's behavior: aggregate at final answers).
   */
  k?: number;
  /**
   * Per-ensemble system-prompt overrides, hydrated from
   * `.fusionkit/prompts/<ensemble>/*.md` with the flat `.fusionkit/prompts/*.md`
   * files as the per-id fallback. Not stored inline in `fusion.json`.
   */
  prompts?: PromptOverrides;
};

export type FusionConfig = {
  version: typeof FUSION_CONFIG_VERSION;
  tool?: FusionTool;
  /** Named ensembles, each registered as its own `fusion-<name>` model. */
  ensembles?: Record<string, EnsembleConfig>;
  /** Which ensemble a session defaults to (default: `default`, else first). */
  defaultEnsemble?: string;
  local?: boolean;
  observe?: boolean;
  portless?: boolean;
  port?: number | null;
  /** WS5 rate-limit / credit handoff policy for vendor passthrough models. */
  onRateLimit?: OnRateLimitPolicy;
  /** Optional provider-native subscription account sets consumed by the gateway. */
  subscriptionAccounts?: Partial<Record<SubscriptionMode, SubscriptionAccountConfig>>;
  /** WS7 budget cap (USD) for the session's gateway-observed cost. */
  budgetUsd?: number;
  /** Panel candidate trust level; unset means `full` (maximum autonomy). */
  panelTrust?: PanelTrust;
  /** Default step boundaries per panel member (per-ensemble `k` overrides). */
  k?: number;
  /** Reasoning traces: narrate panel/judge progress in the tool's thinking UI. */
  reasoning?: boolean;
  /**
   * Model that writes the narration prose: a panel member, `provider/model`
   * (any supported provider), or a local MLX model path (Apple Silicon only).
   */
  reasoningModel?: string;
  /**
   * Auto-provision one native sub-agent per ensemble in the launched tool
   * (Codex roles, Claude --agents, Cursor/opencode agent files). Default on.
   */
  subagents?: boolean;
  /**
   * Default-ensemble prompt overrides, loaded from the flat
   * `.fusionkit/prompts/*.md` files. Not stored inline in `fusion.json` — it is
   * hydrated from the prompt files on load. Per-ensemble overrides live on each
   * {@link EnsembleConfig.prompts}.
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

/**
 * The prompts directory: the flat `.fusionkit/prompts/` (default ensemble)
 * or `.fusionkit/prompts/<ensemble>/` for a named ensemble.
 */
export function fusionPromptsDir(repoRoot: string, ensemble?: string): string {
  const base = join(fusionConfigDir(repoRoot), FUSION_PROMPTS_DIRNAME);
  return ensemble === undefined || ensemble === DEFAULT_ENSEMBLE_NAME ? base : join(base, ensemble);
}

/** The prompt override file for a single prompt id (optionally per-ensemble). */
export function fusionPromptPath(repoRoot: string, id: PromptId, ensemble?: string): string {
  return join(fusionPromptsDir(repoRoot, ensemble), `${id}.md`);
}

function optionalNonNegativeNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new FusionConfigError(`${path} must be a non-negative number`);
  }
  return value;
}

/** Validate a `k` value: a positive integer (step boundaries per member). */
function optionalK(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new FusionConfigError(`${path} must be a positive integer (step boundaries per panel member)`);
  }
  return value;
}

function optionalSourcePath(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new FusionConfigError(`${path} must be a non-empty string`);
  }
  return value;
}

function validateSubscriptionAccountSource(
  value: unknown,
  path: string
): SubscriptionAccountSource {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new FusionConfigError(`${path} must be an account source object`);
  }
  switch (value.kind) {
    case "auto":
    case "canonical":
      return {
        kind: value.kind,
        ...(optionalSourcePath(value.directory, `${path}.directory`) !== undefined
          ? { directory: value.directory as string }
          : {}),
        ...(optionalSourcePath(value.canonicalPath, `${path}.canonicalPath`) !== undefined
          ? { canonicalPath: value.canonicalPath as string }
          : {})
      };
    case "directory": {
      const sourcePath = optionalSourcePath(value.path, `${path}.path`);
      if (sourcePath === undefined) {
        throw new FusionConfigError(`${path}.path is required`);
      }
      return { kind: "directory", path: sourcePath };
    }
    case "paths": {
      if (
        !Array.isArray(value.paths) ||
        value.paths.length === 0 ||
        !value.paths.every((entry) => typeof entry === "string" && entry.length > 0)
      ) {
        throw new FusionConfigError(`${path}.paths must be a non-empty string array`);
      }
      const stateDirectory = optionalSourcePath(
        value.stateDirectory,
        `${path}.stateDirectory`
      );
      return {
        kind: "paths",
        paths: value.paths as string[],
        ...(stateDirectory !== undefined ? { stateDirectory } : {})
      };
    }
    default:
      throw new FusionConfigError(
        `${path}.kind must be auto, canonical, directory, or paths`
      );
  }
}

function validateSubscriptionAccounts(
  value: unknown,
  source: string,
  field: "subscriptionAccounts"
): Partial<Record<SubscriptionMode, SubscriptionAccountConfig>> {
  if (!isRecord(value)) {
    throw new FusionConfigError(`${source}: ${field} must be an object`);
  }
  const result: Partial<Record<SubscriptionMode, SubscriptionAccountConfig>> = {};
  for (const [mode, raw] of Object.entries(value)) {
    if (mode !== "claude-code" && mode !== "codex") {
      throw new FusionConfigError(
        `${source}: ${field} key must be claude-code or codex`
      );
    }
    if (!isRecord(raw)) {
      throw new FusionConfigError(`${source}: ${field}.${mode} must be an object`);
    }
    const config: SubscriptionAccountConfig = {};
    if (raw.source !== undefined) {
      config.source = validateSubscriptionAccountSource(
        raw.source,
        `${source}: ${field}.${mode}.source`
      );
    }
    if (raw.strategy !== undefined) {
      if (
        raw.strategy !== "sticky" &&
        raw.strategy !== "round_robin" &&
        raw.strategy !== "capacity_weighted"
      ) {
        throw new FusionConfigError(
          `${source}: ${field}.${mode}.strategy must be sticky, round_robin, or capacity_weighted`
        );
      }
      config.strategy = raw.strategy;
    }
    if (raw.switchThreshold !== undefined) {
      if (
        typeof raw.switchThreshold !== "number" ||
        !Number.isFinite(raw.switchThreshold) ||
        raw.switchThreshold <= 0 ||
        raw.switchThreshold > 1
      ) {
        throw new FusionConfigError(
          `${source}: ${field}.${mode}.switchThreshold must be in (0, 1]`
        );
      }
      config.switchThreshold = raw.switchThreshold;
    }
    if (raw.probeIntervalMs !== undefined) {
      if (
        typeof raw.probeIntervalMs !== "number" ||
        !Number.isFinite(raw.probeIntervalMs) ||
        raw.probeIntervalMs < 60_000
      ) {
        throw new FusionConfigError(
          `${source}: ${field}.${mode}.probeIntervalMs must be at least 60000`
        );
      }
      config.probeIntervalMs = raw.probeIntervalMs;
    }
    result[mode] = config;
  }
  return result;
}

function validatePanelEntry(entry: unknown, path: string): PanelModelSpec {
  if (!isRecord(entry)) {
    throw new FusionConfigError(`${path} must be an object`);
  }
  const { id, model, provider, baseUrl, keyEnv, auth } = entry;
  if (typeof id !== "string" || id.length === 0) {
    throw new FusionConfigError(`${path}.id must be a non-empty string`);
  }
  if (typeof model !== "string" || model.length === 0) {
    throw new FusionConfigError(`${path}.model must be a non-empty string`);
  }
  const spec: PanelModelSpec = { id, model };
  if (provider !== undefined) {
    if (typeof provider !== "string" || !(PANEL_PROVIDERS as readonly string[]).includes(provider)) {
      throw new FusionConfigError(
        `${path}.provider must be one of ${PANEL_PROVIDERS.join(", ")}`
      );
    }
    spec.provider = provider as PanelProvider;
  }
  if (baseUrl !== undefined) {
    if (typeof baseUrl !== "string") throw new FusionConfigError(`${path}.baseUrl must be a string`);
    spec.baseUrl = baseUrl;
  }
  if (keyEnv !== undefined) {
    if (typeof keyEnv !== "string") throw new FusionConfigError(`${path}.keyEnv must be a string`);
    spec.keyEnv = keyEnv;
  }
  if (auth !== undefined) {
    if (typeof auth !== "string" || !(PANEL_AUTH_MODES as readonly string[]).includes(auth)) {
      throw new FusionConfigError(
        `${path}.auth must be one of ${PANEL_AUTH_MODES.join(", ")}`
      );
    }
    spec.auth = auth as PanelAuthMode;
  }
  if (entry.pricing !== undefined) {
    if (!isRecord(entry.pricing)) {
      throw new FusionConfigError(`${path}.pricing must be an object`);
    }
    const inputPer1mTokens = optionalNonNegativeNumber(
      entry.pricing.inputPer1mTokens,
      `${path}.pricing.inputPer1mTokens`
    );
    const outputPer1mTokens = optionalNonNegativeNumber(
      entry.pricing.outputPer1mTokens,
      `${path}.pricing.outputPer1mTokens`
    );
    const currency = entry.pricing.currency;
    if (currency !== undefined && typeof currency !== "string") {
      throw new FusionConfigError(`${path}.pricing.currency must be a string`);
    }
    spec.pricing = {
      ...(inputPer1mTokens !== undefined ? { inputPer1mTokens } : {}),
      ...(outputPer1mTokens !== undefined ? { outputPer1mTokens } : {}),
      ...(currency !== undefined ? { currency } : {})
    };
  }
  if (entry.localCompute !== undefined) {
    if (!isRecord(entry.localCompute)) {
      throw new FusionConfigError(`${path}.localCompute must be an object`);
    }
    const usdPerDeviceHour = optionalNonNegativeNumber(
      entry.localCompute.usdPerDeviceHour,
      `${path}.localCompute.usdPerDeviceHour`
    );
    spec.localCompute = {
      ...(usdPerDeviceHour !== undefined ? { usdPerDeviceHour } : {})
    };
  }
  return spec;
}

function validatePanel(raw: unknown, path: string): PanelModelSpec[] {
  if (!Array.isArray(raw)) throw new FusionConfigError(`${path} must be an array`);
  return raw.map((entry, index) => validatePanelEntry(entry, `${path}[${index}]`));
}

/** Validate an ensemble name: shape, reserved names. */
export function validateEnsembleName(name: string, source: string): void {
  if (!ENSEMBLE_NAME_PATTERN.test(name)) {
    throw new FusionConfigError(
      `${source}: ensemble name ${JSON.stringify(name)} must match ${ENSEMBLE_NAME_PATTERN} ` +
        `(lowercase letters, digits, dashes)`
    );
  }
  if (RESERVED_ENSEMBLE_NAMES.has(name)) {
    throw new FusionConfigError(
      `${source}: ensemble name ${JSON.stringify(name)} is reserved ` +
        `(it would collide with the "fusion-${name}" model id)`
    );
  }
}

function validateEnsembleEntry(
  name: string,
  raw: unknown,
  source: string
): EnsembleConfig {
  const path = `ensembles.${name}`;
  if (!isRecord(raw)) throw new FusionConfigError(`${source}: ${path} must be an object`);
  const ensemble: EnsembleConfig = {};
  if (raw.panel !== undefined) {
    ensemble.panel = validatePanel(raw.panel, `${path}.panel`);
  }
  if (name !== DEFAULT_ENSEMBLE_NAME && (ensemble.panel === undefined || ensemble.panel.length === 0)) {
    throw new FusionConfigError(
      `${source}: ${path}.panel must be a non-empty array (only the "${DEFAULT_ENSEMBLE_NAME}" ensemble may omit it)`
    );
  }
  if (raw.judgeModel !== undefined) {
    if (typeof raw.judgeModel !== "string" || raw.judgeModel.length === 0) {
      throw new FusionConfigError(`${source}: ${path}.judgeModel must be a non-empty string`);
    }
    ensemble.judgeModel = raw.judgeModel;
  }
  if (raw.synthesizerModel !== undefined) {
    if (typeof raw.synthesizerModel !== "string" || raw.synthesizerModel.length === 0) {
      throw new FusionConfigError(`${source}: ${path}.synthesizerModel must be a non-empty string`);
    }
    ensemble.synthesizerModel = raw.synthesizerModel;
  }
  const k = optionalK(raw.k, `${source}: ${path}.k`);
  if (k !== undefined) ensemble.k = k;
  return ensemble;
}

/**
 * Validate a parsed settings object as a {@link FusionConfig}, throwing on any
 * problem. Prompt overrides are loaded separately from `.fusionkit/prompts/`,
 * not from this object. `v1`/`v2` versions are accepted and upgraded to `v3` in
 * memory (a flat `panel`/`judgeModel` becomes `ensembles.default`); a `v3`
 * config may still use the flat keys as shorthand for the default ensemble
 * when no `ensembles` map is present.
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

  // Ensembles: the v3 map, with the legacy/shorthand flat `panel`/`judgeModel`
  // upgrading into `ensembles.default` when no map is present.
  if (raw.ensembles !== undefined) {
    if (!isRecord(raw.ensembles)) {
      throw new FusionConfigError(`${source}: ensembles must be an object mapping name -> ensemble`);
    }
    if (raw.panel !== undefined || raw.judgeModel !== undefined) {
      throw new FusionConfigError(
        `${source}: flat panel/judgeModel cannot be combined with ensembles; move them into ensembles.${DEFAULT_ENSEMBLE_NAME}`
      );
    }
    const ensembles: Record<string, EnsembleConfig> = {};
    for (const [name, entry] of Object.entries(raw.ensembles)) {
      validateEnsembleName(name, source);
      ensembles[name] = validateEnsembleEntry(name, entry, source);
    }
    if (Object.keys(ensembles).length === 0) {
      throw new FusionConfigError(`${source}: ensembles must define at least one ensemble`);
    }
    config.ensembles = ensembles;
  } else if (raw.panel !== undefined || raw.judgeModel !== undefined) {
    const legacy: EnsembleConfig = {};
    if (raw.panel !== undefined) legacy.panel = validatePanel(raw.panel, "panel");
    if (raw.judgeModel !== undefined) {
      if (typeof raw.judgeModel !== "string") throw new FusionConfigError(`${source}: judgeModel must be a string`);
      legacy.judgeModel = raw.judgeModel;
    }
    config.ensembles = { [DEFAULT_ENSEMBLE_NAME]: legacy };
  }

  if (raw.defaultEnsemble !== undefined) {
    if (typeof raw.defaultEnsemble !== "string" || raw.defaultEnsemble.length === 0) {
      throw new FusionConfigError(`${source}: defaultEnsemble must be a non-empty string`);
    }
    if (config.ensembles === undefined || config.ensembles[raw.defaultEnsemble] === undefined) {
      throw new FusionConfigError(
        `${source}: defaultEnsemble ${JSON.stringify(raw.defaultEnsemble)} does not name a defined ensemble ` +
          `(have: ${Object.keys(config.ensembles ?? {}).join(", ") || "none"})`
      );
    }
    config.defaultEnsemble = raw.defaultEnsemble;
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
  if (raw.onRateLimit !== undefined) {
    if (
      typeof raw.onRateLimit !== "string" ||
      !(ON_RATE_LIMIT_POLICIES as readonly string[]).includes(raw.onRateLimit)
    ) {
      throw new FusionConfigError(
        `${source}: onRateLimit must be one of ${ON_RATE_LIMIT_POLICIES.join(", ")}`
      );
    }
    config.onRateLimit = raw.onRateLimit as OnRateLimitPolicy;
  }
  if (raw.subscriptionAccounts !== undefined) {
    config.subscriptionAccounts = validateSubscriptionAccounts(
      raw.subscriptionAccounts,
      source,
      "subscriptionAccounts"
    );
  }
  if (raw.budgetUsd !== undefined) {
    if (typeof raw.budgetUsd !== "number" || !Number.isFinite(raw.budgetUsd) || raw.budgetUsd <= 0) {
      throw new FusionConfigError(`${source}: budgetUsd must be a positive number of USD`);
    }
    config.budgetUsd = raw.budgetUsd;
  }
  if (raw.panelTrust !== undefined) {
    if (
      typeof raw.panelTrust !== "string" ||
      !(PANEL_TRUST_LEVELS as readonly string[]).includes(raw.panelTrust)
    ) {
      throw new FusionConfigError(
        `${source}: panelTrust must be one of ${PANEL_TRUST_LEVELS.join(", ")}`
      );
    }
    config.panelTrust = raw.panelTrust as PanelTrust;
  }
  const topLevelK = optionalK(raw.k, `${source}: k`);
  if (topLevelK !== undefined) config.k = topLevelK;
  if (raw.reasoning !== undefined) {
    if (typeof raw.reasoning !== "boolean") {
      throw new FusionConfigError(`${source}: reasoning must be a boolean`);
    }
    config.reasoning = raw.reasoning;
  }
  if (raw.reasoningModel !== undefined) {
    if (typeof raw.reasoningModel !== "string" || raw.reasoningModel.length === 0) {
      throw new FusionConfigError(`${source}: reasoningModel must be a non-empty string`);
    }
    config.reasoningModel = raw.reasoningModel;
  }
  if (raw.subagents !== undefined) {
    if (typeof raw.subagents !== "boolean") {
      throw new FusionConfigError(`${source}: subagents must be a boolean`);
    }
    config.subagents = raw.subagents;
  }
  return config;
}

/**
 * Read the committed prompt overrides for one ensemble. The flat
 * `.fusionkit/prompts/*.md` files are the default ensemble's prompts; a named
 * ensemble reads `.fusionkit/prompts/<ensemble>/*.md`. Only files that exist
 * and are non-empty (after trimming) become overrides.
 */
export function readFusionPrompts(repoRoot: string, ensemble?: string): PromptOverrides {
  const dir = fusionPromptsDir(repoRoot, ensemble);
  const prompts: PromptOverrides = {};
  if (!existsSync(dir)) return prompts;
  for (const id of PROMPT_IDS) {
    const path = fusionPromptPath(repoRoot, id, ensemble);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8").trim();
    if (text.length > 0) prompts[id] = text;
  }
  return prompts;
}

/**
 * Hydrate prompt overrides: the flat files become the config's top-level
 * `prompts` (the default ensemble's, and the per-id fallback for every named
 * ensemble), and each named ensemble's directory overrides them per id.
 */
function withPrompts(repoRoot: string, config: FusionConfig): FusionConfig {
  const flat = readFusionPrompts(repoRoot);
  const hydrated: FusionConfig = { ...config };
  if (Object.keys(flat).length > 0) hydrated.prompts = flat;
  if (config.ensembles !== undefined) {
    const ensembles: Record<string, EnsembleConfig> = {};
    for (const [name, ensemble] of Object.entries(config.ensembles)) {
      const own = name === DEFAULT_ENSEMBLE_NAME ? {} : readFusionPrompts(repoRoot, name);
      const merged: PromptOverrides = { ...flat, ...own };
      ensembles[name] = {
        ...ensemble,
        ...(Object.keys(merged).length > 0 ? { prompts: merged } : {})
      };
    }
    hydrated.ensembles = ensembles;
  }
  return hydrated;
}

/**
 * Load the per-repo config. Prefers `.fusionkit/fusion.json`; if it is absent
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
  const currentPath = fusionConfigPath(repoRoot);
  const config = loadMigratingConfig({
    currentPath,
    legacyPaths: [legacyFusionConfigPath(repoRoot)],
    parse: parseFusionConfig,
    serialize: persistedFusionConfig,
    writeError: (message) => new FusionConfigError(message),
    onMigration: (legacyPath, migratedPath) =>
      onNotice?.(`migrated ${legacyPath} into ${migratedPath}`)
  });
  return config === undefined ? undefined : withPrompts(repoRoot, config);
}

function persistedFusionConfig(config: FusionConfig): Record<string, unknown> {
  const { prompts: _prompts, ensembles, ...persisted } = config;
  const output: Record<string, unknown> = { ...persisted };
  if (ensembles !== undefined) {
    output.ensembles = Object.fromEntries(
      Object.entries(ensembles).map(([name, ensemble]) => {
        const { prompts: _ensemblePrompts, ...rest } = ensemble;
        return [name, rest];
      })
    );
  }
  return output;
}

/**
 * Write `.fusionkit/fusion.json` (creating the folder), refusing to clobber
 * unless `force`. Prompt overrides are stored as files, not inline, so any
 * `prompts` on the config object (or on any ensemble) is omitted here.
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
  try {
    return writeJsonAtomic(path, persistedFusionConfig(config), options);
  } catch (error) {
    throw new FusionConfigError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Write prompt override files into `.fusionkit/prompts/` (or the ensemble's
 * subdirectory). Existing files are left untouched unless `force`. Returns the
 * paths actually written.
 */
export function writeFusionPrompts(
  repoRoot: string,
  prompts: PromptOverrides,
  options: { force?: boolean; ensemble?: string } = {}
): string[] {
  mkdirSync(fusionPromptsDir(repoRoot, options.ensemble), { recursive: true });
  const written: string[] = [];
  for (const id of PROMPT_IDS) {
    const text = prompts[id];
    if (text === undefined) continue;
    const path = fusionPromptPath(repoRoot, id, options.ensemble);
    if (existsSync(path) && options.force !== true) continue;
    writeFileAtomic(path, text.endsWith("\n") ? text : `${text}\n`);
    written.push(path);
  }
  return written;
}
