import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { stringify as tomlStringify } from "smol-toml";

import { trimTrailingSlashes } from "@velum-labs/routekit-runtime";
import type { AgentProfile, ToolLaunchContext, ToolLaunchSpec } from "@velum-labs/routekit-tools";

const PROVIDER_ID = "routekit";
const CATALOG_FILE = "model-catalog.json";
/** Model-agnostic agent prompt, matching the gateway's synthesized entries. */
const NEUTRAL_INSTRUCTIONS = "You are a coding agent.";
const PROFILE_DIR = "agent-profiles";
const CONFIG_FAILURE_PATTERNS: readonly RegExp[] = [
  /config\.toml/i,
  /model_catalog/i,
  /duplicate agent role/i,
  /error (?:reading|parsing|loading) config/i,
  /invalid config/i,
  /unknown field/i,
  /missing field/i,
  /agent role/i
];

export type CodexModelPreset = Record<string, unknown>;

export function isCodexConfigFailure(code: number, stderr: string): boolean {
  return code !== 0 && CONFIG_FAILURE_PATTERNS.some((pattern) => pattern.test(stderr));
}

export function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

function modelsCachePath(home: string): string {
  return join(home, ".codex", "models_cache.json");
}

export function readCodexModelsCache(home: string = homedir()): CodexModelPreset[] {
  try {
    const parsed = JSON.parse(readFileSync(modelsCachePath(home), "utf8")) as { models?: unknown };
    return Array.isArray(parsed.models)
      ? parsed.models.filter(
          (entry): entry is CodexModelPreset => entry !== null && typeof entry === "object"
        )
      : [];
  } catch {
    return [];
  }
}

export function readCodexCatalogTemplate(home: string = homedir()): CodexModelPreset | undefined {
  return readCodexModelsCache(home)[0];
}

export function codexAuthPath(home: string = homedir()): string {
  return join(home, ".codex", "auth.json");
}

export function hasCodexLogin(home: string = homedir()): boolean {
  return existsSync(codexAuthPath(home));
}

/**
 * Create an isolated Codex home outside the operating-system temp directory.
 *
 * Recent Codex releases refuse to install their process-scoped PATH helpers
 * beneath `tmpdir()`. RouteKit still needs an isolated home so a gateway turn
 * cannot read or mutate the user's real Codex configuration.
 */
export function createIsolatedCodexHome(
  prefix: string,
  env: Record<string, string | undefined> = process.env
): string {
  const userHome = env.HOME ?? env.USERPROFILE ?? homedir();
  const cacheRoot =
    env.XDG_CACHE_HOME ??
    (process.platform === "win32" ? env.LOCALAPPDATA : undefined) ??
    join(userHome, ".cache");
  const parent = join(cacheRoot, "routekit", "codex");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(parent, prefix));
}

function presetSlug(entry: CodexModelPreset): string | undefined {
  return typeof entry.slug === "string" && entry.slug.length > 0 ? entry.slug : undefined;
}

export function codexListedStockSlugs(home: string = homedir()): string[] {
  const seen = new Set<string>();
  return readCodexModelsCache(home).flatMap((entry) => {
    const slug = presetSlug(entry);
    if (slug === undefined || seen.has(slug)) return [];
    seen.add(slug);
    return [slug];
  });
}

function codexModelId(modelId: string): string {
  return modelId.startsWith("codex/")
    ? modelId.slice("codex/".length)
    : modelId;
}

function catalogIds(spec: ToolLaunchSpec): string[] {
  return [
    ...new Set(
      [spec.defaultModel, ...spec.models.flatMap((model) => [
        model.id,
        ...(model.aliases ?? [])
      ])].map(codexModelId)
    )
  ];
}

/** True when a bare catalog id was projected from a `codex/`-namespaced model. */
function isCodexNativeId(
  spec: Pick<ToolLaunchSpec, "defaultModel" | "models">,
  id: string
): boolean {
  const namespaced = `codex/${id}`;
  return (
    spec.defaultModel === namespaced ||
    spec.models.some(
      (model) =>
        model.id === namespaced || model.aliases?.includes(namespaced) === true
    )
  );
}

export function codexCatalogEntries(
  spec: Pick<ToolLaunchSpec, "defaultModel" | "models">,
  template: CodexModelPreset,
  stockModels: readonly CodexModelPreset[] = [],
  options: { appendUnlistedStock?: boolean } = {}
): Record<string, unknown>[] {
  const appendUnlistedStock = options.appendUnlistedStock ?? true;
  const ids = catalogIds({ ...spec, gatewayUrl: "", args: [] });
  const listed = new Set(ids);
  const stockBySlug = new Map(
    stockModels.flatMap((entry) => {
      const slug = presetSlug(entry);
      return slug === undefined ? [] : [[slug, entry] as const];
    })
  );
  // The template (a stock Codex model entry) only exists to satisfy the
  // catalog schema of the installed Codex version. Fields that change how
  // Codex talks to the model must not leak from an unrelated stock model into
  // gateway-routed entries: reasoning tiers are replaced by each model's
  // discovered capabilities; `tool_mode` (e.g. "code_mode_only") and
  // `use_responses_lite` alter (or drop entirely) the tool declarations Codex
  // sends; service tiers are a stock-model billing offer; and
  // `base_instructions` / `model_messages` become the developer message, so a
  // stock prompt ("You are Codex, an agent based on GPT-5...") would tell
  // every routed model it is GPT-5. Fields are reset to neutral values only
  // when the template carries them, so the output still matches the installed
  // Codex version's required fields.
  const {
    supported_reasoning_levels: _templateLevels,
    default_reasoning_level: _templateDefault,
    supports_reasoning_summaries: _templateSummaries,
    tool_mode: _templateToolMode,
    default_service_tier: _templateServiceTier,
    ...neutralTemplate
  } = template;
  for (const [field, neutral] of [
    ["use_responses_lite", false],
    ["additional_speed_tiers", []],
    ["service_tiers", []],
    ["base_instructions", NEUTRAL_INSTRUCTIONS]
  ] as const) {
    if (field in neutralTemplate) neutralTemplate[field] = neutral;
  }
  if (
    typeof neutralTemplate.model_messages === "object" &&
    neutralTemplate.model_messages !== null
  ) {
    neutralTemplate.model_messages = {
      ...neutralTemplate.model_messages,
      instructions_template: NEUTRAL_INSTRUCTIONS
    };
  }
  const entries: Record<string, unknown>[] = ids.map((id, priority) => {
    // A Codex-native model whose real ModelInfo is in the stock cache keeps
    // it verbatim (its tuned prompt, reasoning tiers, tool mode) — through
    // the gateway it still reaches the real Codex backend, so the stock
    // behavior is the correct behavior. This mirrors the gateway's own
    // picker merge. Only the transport hint is pinned to the gateway's HTTP.
    const stock = stockBySlug.get(id);
    if (stock !== undefined && isCodexNativeId(spec, id)) {
      return { ...stock, slug: id, visibility: "list", priority, prefer_websockets: false };
    }
    const model = spec.models.find(
      (candidate) =>
        codexModelId(candidate.id) === id ||
        candidate.aliases?.some((alias) => codexModelId(alias) === id) === true
    );
    const levels = (model?.reasoning?.efforts ?? []).map((effort) => ({
      effort: effort.id,
      description: effort.description ?? effort.label ?? effort.id
    }));
    return {
      ...neutralTemplate,
      prefer_websockets: false,
      slug: id,
      display_name: model?.label ?? id,
      description: "Gateway-routed model.",
      visibility: "list",
      priority,
      availability_nux: null,
      upgrade: null,
      // Codex requires this field on every catalog entry; an empty list means
      // "no discovered effort controls" without fabricating tiers.
      supported_reasoning_levels: levels,
      ...(model?.reasoning?.defaultEffort !== undefined
        ? { default_reasoning_level: model.reasoning.defaultEffort }
        : {}),
      supports_reasoning_summaries:
        model?.reasoning?.status === "supported"
    };
  });
  if (appendUnlistedStock) {
    for (const stock of stockModels) {
      const slug = presetSlug(stock);
      if (slug === undefined || listed.has(slug)) continue;
      listed.add(slug);
      entries.push({ ...stock, priority: entries.length });
    }
  }
  return entries;
}

export function codexModelCatalogJson(
  spec: Pick<ToolLaunchSpec, "defaultModel" | "models">,
  template: CodexModelPreset,
  stockModels: readonly CodexModelPreset[] = [],
  options: { appendUnlistedStock?: boolean } = {}
): string {
  return JSON.stringify(
    { models: codexCatalogEntries(spec, template, stockModels, options) },
    null,
    2
  );
}

export function codexProfileFileToml(model: string, provider: string = PROVIDER_ID): string {
  return `${tomlStringify({ model, model_provider: provider }).trimEnd()}\n`;
}

export function codexProfileFiles(
  home: string,
  models: readonly string[],
  provider: string = PROVIDER_ID
): string[] {
  const written: string[] = [];
  for (const model of models) {
    if (
      model.length === 0 ||
      model.includes("/") ||
      model.includes("\\") ||
      model.startsWith(".") ||
      written.includes(model)
    ) {
      continue;
    }
    writeFileSync(join(home, `${model}.config.toml`), codexProfileFileToml(model, provider));
    written.push(model);
  }
  return written;
}

export type CodexAgentRole = AgentProfile & { configPath: string };

export function codexAgentRoles(home: string, profiles: readonly AgentProfile[]): CodexAgentRole[] {
  return profiles.map((profile) => ({
    ...profile,
    configPath: join(home, PROFILE_DIR, `${profile.id}.toml`)
  }));
}

export function codexAgentRoleToml(profile: AgentProfile): string {
  return [
    `name = ${JSON.stringify(profile.id)}`,
    `model = ${JSON.stringify(codexModelId(profile.model))}`,
    `model_provider = ${JSON.stringify(PROVIDER_ID)}`,
    `developer_instructions = ${JSON.stringify(profile.instructions)}`,
    ""
  ].join("\n");
}

export function codexLaunchConfigToml(
  spec: Pick<ToolLaunchSpec, "gatewayUrl" | "defaultModel" | "reasoning" | "auth">,
  modelCatalogPath?: string,
  roles: readonly CodexAgentRole[] = []
): string {
  const lines = [
    `model = ${JSON.stringify(codexModelId(spec.defaultModel))}`,
    `model_provider = ${JSON.stringify(PROVIDER_ID)}`
  ];
  if (spec.reasoning?.mode === "effort") {
    lines.push(`model_reasoning_effort = ${JSON.stringify(spec.reasoning.effort)}`);
  }
  if (modelCatalogPath !== undefined) {
    lines.push(`model_catalog_json = ${JSON.stringify(modelCatalogPath)}`);
  }
  lines.push(
    "",
    `[model_providers.${PROVIDER_ID}]`,
    `name = "RouteKit gateway"`,
    `base_url = ${JSON.stringify(`${trimTrailingSlashes(spec.gatewayUrl)}/v1`)}`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`,
    ...(spec.auth?.token !== undefined
      ? [`env_key = "ROUTEKIT_GATEWAY_TOKEN"`]
      : []),
    ""
  );
  if (roles.length > 0) {
    lines.push("[features]", "multi_agent = true", "", "[agents]", "max_depth = 1", "");
    for (const role of roles) {
      lines.push(
        `[agents.${tomlKey(role.id)}]`,
        `description = ${JSON.stringify(role.description)}`,
        `config_file = ${JSON.stringify(role.configPath)}`,
        ""
      );
    }
  }
  return lines.join("\n");
}

function spawnCodex(
  args: readonly string[],
  home: string,
  cwd: string | undefined,
  token?: string
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      stdio: ["inherit", "inherit", "pipe"],
      // env-spread-allowed: interactive user tool inherits the user's shell configuration
      env: {
        ...process.env,
        CODEX_HOME: home,
        ...(token !== undefined ? { ROUTEKIT_GATEWAY_TOKEN: token } : {})
      },
      ...(cwd !== undefined ? { cwd } : {})
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderr = (stderr + chunk.toString("utf8")).slice(-8192);
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 0, stderr }));
  });
}

export async function launchCodex(ctx: ToolLaunchContext): Promise<number> {
  const { spec } = ctx;
  const home = createIsolatedCodexHome("routekit-codex-");
  ctx.registerDisposer(() => rmSync(home, { recursive: true, force: true }));
  if (hasCodexLogin() && spec.auth?.token === undefined) {
    copyFileSync(codexAuthPath(), join(home, "auth.json"));
  }
  const ids = [...catalogIds(spec), ...codexListedStockSlugs()];
  codexProfileFiles(home, ids);
  const template = readCodexCatalogTemplate();
  const catalogPath = template === undefined ? undefined : join(home, CATALOG_FILE);
  if (catalogPath !== undefined && template !== undefined) {
    // The stock cache supplies verbatim ModelInfo for gateway models that are
    // Codex-native. Unlisted stock models are not appended: without a codex
    // route in the gateway catalog they would not resolve.
    writeFileSync(
      catalogPath,
      codexModelCatalogJson(spec, template, readCodexModelsCache(), {
        appendUnlistedStock: false
      })
    );
  }
  const roles = codexAgentRoles(home, spec.agentProfiles ?? []);
  if (roles.length > 0) {
    mkdirSync(join(home, PROFILE_DIR), { recursive: true });
    for (const role of roles) writeFileSync(role.configPath, codexAgentRoleToml(role));
  }
  const configPath = join(home, "config.toml");
  const writeConfig = (catalog: string | undefined, activeRoles: readonly CodexAgentRole[]): void => {
    writeFileSync(configPath, codexLaunchConfigToml(spec, catalog, activeRoles));
  };
  writeConfig(catalogPath, roles);
  ctx.prepareForPassthrough();
  let result = await spawnCodex(spec.args, home, spec.cwd, spec.auth?.token);
  if (catalogPath !== undefined && isCodexConfigFailure(result.code, result.stderr)) {
    writeConfig(undefined, roles);
    result = await spawnCodex(spec.args, home, spec.cwd, spec.auth?.token);
  }
  if (roles.length > 0 && isCodexConfigFailure(result.code, result.stderr)) {
    writeConfig(undefined, []);
    result = await spawnCodex(spec.args, home, spec.cwd, spec.auth?.token);
  }
  return result.code;
}
