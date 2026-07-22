import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isRecord, writeJsonAtomic } from "@routekit/config-core";
import { writeFileAtomic } from "@routekit/runtime";

export const FUSION_CONFIG_DIRNAME = ".fusionkit";
export const FUSION_CONFIG_BASENAME = "fusion.json";
export const FUSION_PROMPTS_DIRNAME = "prompts";
export const FUSION_CONFIG_VERSION = "fusionkit.fusion.v4";
export const DEFAULT_ENSEMBLE_NAME = "default";

export const FUSION_TOOLS = ["codex", "claude", "cursor", "opencode", "serve"] as const;
export type FusionTool = (typeof FUSION_TOOLS)[number];
export const PROMPT_IDS = ["judge", "synthesizer"] as const;
export type PromptId = (typeof PROMPT_IDS)[number];
export const PROMPT_CONFIG_KEY: Record<PromptId, string> = {
  judge: "judge_system",
  synthesizer: "synthesizer_system"
};
export type PromptOverrides = Partial<Record<PromptId, string>>;
export type OnRateLimitPolicy = "fusion" | "passthrough" | "fail";
export type PanelTrust = "full" | "guarded";

export type EmbeddedRouterConfig = {
  config: string;
  url?: never;
  authEnv?: never;
};

export type ExternalRouterConfig = {
  url: string;
  authEnv?: string;
  config?: never;
};

export type FusionRouterConfig = EmbeddedRouterConfig | ExternalRouterConfig;

export type EnsembleConfig = {
  /** Stable namespaced RouteKit model ids (`provider/model`). */
  members: string[];
  /** Stable namespaced RouteKit model id (`provider/model`). */
  judge: string;
  /** Stable namespaced RouteKit model id; defaults to judge. */
  synthesizer?: string;
  k?: number;
  prompts?: PromptOverrides;
};

export type FusionConfig = {
  version: typeof FUSION_CONFIG_VERSION;
  router: FusionRouterConfig;
  tool?: FusionTool;
  ensembles: Record<string, EnsembleConfig>;
  defaultEnsemble?: string;
  observe?: boolean;
  portless?: boolean;
  port?: number | null;
  onRateLimit?: OnRateLimitPolicy;
  budgetUsd?: number;
  panelTrust?: PanelTrust;
  k?: number;
  reasoning?: boolean;
  subagents?: boolean;
  prompts?: PromptOverrides;
};

const ENSEMBLE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED_ENSEMBLE_NAMES = new Set(["panel"]);
const TOP_LEVEL_KEYS = new Set([
  "version",
  "router",
  "tool",
  "ensembles",
  "defaultEnsemble",
  "observe",
  "portless",
  "port",
  "onRateLimit",
  "budgetUsd",
  "panelTrust",
  "k",
  "reasoning",
  "subagents"
]);
const ENSEMBLE_KEYS = new Set(["members", "judge", "synthesizer", "k"]);

export class FusionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FusionConfigError";
  }
}

export function fusionConfigDir(repoRoot: string): string {
  return join(repoRoot, FUSION_CONFIG_DIRNAME);
}

export function fusionConfigPath(repoRoot: string): string {
  return join(fusionConfigDir(repoRoot), FUSION_CONFIG_BASENAME);
}

export function fusionPromptsDir(repoRoot: string, ensemble?: string): string {
  const base = join(fusionConfigDir(repoRoot), FUSION_PROMPTS_DIRNAME);
  return ensemble === undefined || ensemble === DEFAULT_ENSEMBLE_NAME
    ? base
    : join(base, ensemble);
}

export function fusionPromptPath(repoRoot: string, id: PromptId, ensemble?: string): string {
  return join(fusionPromptsDir(repoRoot, ensemble), `${id}.md`);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  source: string
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new FusionConfigError(
      `${source}: unsupported field${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}`
    );
  }
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FusionConfigError(`${path} must be a non-empty string`);
  }
  return value;
}

const ROUTEKIT_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*\/[^/\s][^\s]*$/;

function routekitModelId(value: unknown, path: string): string {
  const modelId = nonEmptyString(value, path);
  if (!ROUTEKIT_MODEL_ID_PATTERN.test(modelId)) {
    throw new FusionConfigError(
      `${path} must be a namespaced RouteKit model id (provider/model)`
    );
  }
  return modelId;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new FusionConfigError(`${path} must be a boolean`);
  return value;
}

function optionalK(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new FusionConfigError(`${path} must be a positive integer`);
  }
  return value;
}

function parseRouter(value: unknown, source: string): FusionRouterConfig {
  if (!isRecord(value)) throw new FusionConfigError(`${source}: router must be an object`);
  rejectUnknownKeys(value, new Set(["config", "url", "authEnv"]), `${source}: router`);
  const hasConfig = value.config !== undefined;
  const hasUrl = value.url !== undefined;
  if (hasConfig === hasUrl) {
    throw new FusionConfigError(
      `${source}: router must set exactly one of config (embedded RouteKit) or url (external RouteKit)`
    );
  }
  if (hasConfig) return { config: nonEmptyString(value.config, `${source}: router.config`) };
  const url = nonEmptyString(value.url, `${source}: router.url`);
  try {
    new URL(url);
  } catch {
    throw new FusionConfigError(`${source}: router.url must be an absolute URL`);
  }
  const authEnv =
    value.authEnv === undefined
      ? undefined
      : nonEmptyString(value.authEnv, `${source}: router.authEnv`);
  return { url, ...(authEnv !== undefined ? { authEnv } : {}) };
}

export function validateEnsembleName(name: string, source: string): void {
  if (!ENSEMBLE_NAME_PATTERN.test(name)) {
    throw new FusionConfigError(
      `${source}: ensemble name ${JSON.stringify(name)} must match ${ENSEMBLE_NAME_PATTERN}`
    );
  }
  if (RESERVED_ENSEMBLE_NAMES.has(name)) {
    throw new FusionConfigError(`${source}: ensemble name ${JSON.stringify(name)} is reserved`);
  }
}

function parseEnsemble(name: string, value: unknown, source: string): EnsembleConfig {
  if (!isRecord(value)) {
    throw new FusionConfigError(`${source}: ensembles.${name} must be an object`);
  }
  rejectUnknownKeys(value, ENSEMBLE_KEYS, `${source}: ensembles.${name}`);
  if (
    !Array.isArray(value.members) ||
    value.members.length === 0 ||
    !value.members.every(
      (member) => typeof member === "string" && ROUTEKIT_MODEL_ID_PATTERN.test(member)
    )
  ) {
    throw new FusionConfigError(
      `${source}: ensembles.${name}.members must be a non-empty array of namespaced RouteKit model ids (provider/model)`
    );
  }
  if (new Set(value.members).size !== value.members.length) {
    throw new FusionConfigError(`${source}: ensembles.${name}.members must not contain duplicates`);
  }
  const judge = routekitModelId(value.judge, `${source}: ensembles.${name}.judge`);
  const synthesizer =
    value.synthesizer === undefined
      ? undefined
      : routekitModelId(value.synthesizer, `${source}: ensembles.${name}.synthesizer`);
  const k = optionalK(value.k, `${source}: ensembles.${name}.k`);
  return {
    members: [...value.members],
    judge,
    ...(synthesizer !== undefined ? { synthesizer } : {}),
    ...(k !== undefined ? { k } : {})
  };
}

export function parseFusionConfig(raw: unknown, source: string): FusionConfig {
  if (!isRecord(raw)) throw new FusionConfigError(`${source}: must be a JSON object`);
  if (raw.version !== FUSION_CONFIG_VERSION) {
    const migration =
      typeof raw.version === "string" && /^fusionkit\.fusion\.v[123]$/.test(raw.version)
        ? " v4 uses namespaced RouteKit model ids: move provider settings to .routekit/router.yaml, then replace each panel with provider/model members, judge, and synthesizer ids."
        : "";
    throw new FusionConfigError(
      `${source}: unsupported version ${JSON.stringify(raw.version)}; expected ${FUSION_CONFIG_VERSION}.${migration}`
    );
  }
  rejectUnknownKeys(raw, TOP_LEVEL_KEYS, source);
  const router = parseRouter(raw.router, source);
  if (!isRecord(raw.ensembles) || Object.keys(raw.ensembles).length === 0) {
    throw new FusionConfigError(`${source}: ensembles must define at least one ensemble`);
  }
  const ensembles: Record<string, EnsembleConfig> = {};
  for (const [name, value] of Object.entries(raw.ensembles)) {
    validateEnsembleName(name, source);
    ensembles[name] = parseEnsemble(name, value, source);
  }
  const config: FusionConfig = {
    version: FUSION_CONFIG_VERSION,
    router,
    ensembles
  };
  if (raw.tool !== undefined) {
    if (
      typeof raw.tool !== "string" ||
      !(FUSION_TOOLS as readonly string[]).includes(raw.tool)
    ) {
      throw new FusionConfigError(`${source}: tool must be one of ${FUSION_TOOLS.join(", ")}`);
    }
    config.tool = raw.tool as FusionTool;
  }
  if (raw.defaultEnsemble !== undefined) {
    const name = nonEmptyString(raw.defaultEnsemble, `${source}: defaultEnsemble`);
    if (ensembles[name] === undefined) {
      throw new FusionConfigError(
        `${source}: defaultEnsemble ${JSON.stringify(name)} does not name a defined ensemble`
      );
    }
    config.defaultEnsemble = name;
  }
  const observe = optionalBoolean(raw.observe, `${source}: observe`);
  if (observe !== undefined) config.observe = observe;
  const portless = optionalBoolean(raw.portless, `${source}: portless`);
  if (portless !== undefined) config.portless = portless;
  const reasoning = optionalBoolean(raw.reasoning, `${source}: reasoning`);
  if (reasoning !== undefined) config.reasoning = reasoning;
  const subagents = optionalBoolean(raw.subagents, `${source}: subagents`);
  if (subagents !== undefined) config.subagents = subagents;
  if (raw.port !== undefined) {
    if (
      raw.port !== null &&
      (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 0)
    ) {
      throw new FusionConfigError(`${source}: port must be a non-negative integer or null`);
    }
    config.port = raw.port as number | null;
  }
  if (raw.onRateLimit !== undefined) {
    if (
      raw.onRateLimit !== "fusion" &&
      raw.onRateLimit !== "passthrough" &&
      raw.onRateLimit !== "fail"
    ) {
      throw new FusionConfigError(
        `${source}: onRateLimit must be fusion, passthrough, or fail`
      );
    }
    config.onRateLimit = raw.onRateLimit;
  }
  if (raw.budgetUsd !== undefined) {
    if (
      typeof raw.budgetUsd !== "number" ||
      !Number.isFinite(raw.budgetUsd) ||
      raw.budgetUsd <= 0
    ) {
      throw new FusionConfigError(`${source}: budgetUsd must be a positive number`);
    }
    config.budgetUsd = raw.budgetUsd;
  }
  if (raw.panelTrust !== undefined) {
    if (raw.panelTrust !== "full" && raw.panelTrust !== "guarded") {
      throw new FusionConfigError(`${source}: panelTrust must be full or guarded`);
    }
    config.panelTrust = raw.panelTrust;
  }
  const k = optionalK(raw.k, `${source}: k`);
  if (k !== undefined) config.k = k;
  return config;
}

export function readFusionPrompts(repoRoot: string, ensemble?: string): PromptOverrides {
  const prompts: PromptOverrides = {};
  for (const id of PROMPT_IDS) {
    const path = fusionPromptPath(repoRoot, id, ensemble);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8").trim();
    if (text.length > 0) prompts[id] = text;
  }
  return prompts;
}

function withPrompts(repoRoot: string, config: FusionConfig): FusionConfig {
  const flat = readFusionPrompts(repoRoot);
  const ensembles = Object.fromEntries(
    Object.entries(config.ensembles).map(([name, ensemble]) => {
      const own =
        name === DEFAULT_ENSEMBLE_NAME ? {} : readFusionPrompts(repoRoot, name);
      const prompts = { ...flat, ...own };
      return [
        name,
        {
          ...ensemble,
          ...(Object.keys(prompts).length > 0 ? { prompts } : {})
        }
      ];
    })
  );
  return {
    ...config,
    ensembles,
    ...(Object.keys(flat).length > 0 ? { prompts: flat } : {})
  };
}

export function loadFusionConfig(repoRoot: string): FusionConfig | undefined {
  const path = fusionConfigPath(repoRoot);
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new FusionConfigError(
      `${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`
    );
  }
  return withPrompts(repoRoot, parseFusionConfig(raw, path));
}

export function persistedFusionConfig(config: FusionConfig): Record<string, unknown> {
  const { prompts: _prompts, ensembles, ...rest } = config;
  return {
    ...rest,
    ensembles: Object.fromEntries(
      Object.entries(ensembles).map(([name, ensemble]) => {
        const { prompts: _ensemblePrompts, ...persisted } = ensemble;
        return [name, persisted];
      })
    )
  };
}

export function writeFusionConfig(
  repoRoot: string,
  config: FusionConfig,
  options: { force?: boolean } = {}
): string {
  const path = fusionConfigPath(repoRoot);
  if (existsSync(path) && options.force !== true) {
    throw new FusionConfigError(`${path} already exists (pass --force to overwrite)`);
  }
  const validated = parseFusionConfig(persistedFusionConfig(config), path);
  return writeJsonAtomic(path, persistedFusionConfig(validated), options);
}

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
