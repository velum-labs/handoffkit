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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { stringify as tomlStringify } from "smol-toml";

import type { AgentProfile, ToolLaunchContext, ToolLaunchSpec } from "@routekit/tools";

const PROVIDER_ID = "routekit";
const CATALOG_FILE = "model-catalog.json";
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

function catalogIds(spec: ToolLaunchSpec): string[] {
  return [...new Set([spec.defaultModel, ...spec.models.flatMap((model) => [model.id, ...(model.aliases ?? [])])])];
}

export function codexCatalogEntries(
  spec: Pick<ToolLaunchSpec, "defaultModel" | "models">,
  template: CodexModelPreset,
  stockModels: readonly CodexModelPreset[] = []
): Record<string, unknown>[] {
  const ids = catalogIds({ ...spec, gatewayUrl: "", args: [] });
  const listed = new Set(ids);
  const entries: Record<string, unknown>[] = ids.map((id, priority) => ({
    ...template,
    slug: id,
    display_name: spec.models.find((model) => model.id === id)?.label ?? id,
    description: "Gateway-routed model.",
    visibility: "list",
    priority,
    availability_nux: null,
    upgrade: null
  }));
  for (const stock of stockModels) {
    const slug = presetSlug(stock);
    if (slug === undefined || listed.has(slug)) continue;
    listed.add(slug);
    entries.push({ ...stock, priority: entries.length });
  }
  return entries;
}

export function codexModelCatalogJson(
  spec: Pick<ToolLaunchSpec, "defaultModel" | "models">,
  template: CodexModelPreset,
  stockModels: readonly CodexModelPreset[] = []
): string {
  return JSON.stringify({ models: codexCatalogEntries(spec, template, stockModels) }, null, 2);
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
    `model = ${JSON.stringify(profile.model)}`,
    `model_provider = ${JSON.stringify(PROVIDER_ID)}`,
    `developer_instructions = ${JSON.stringify(profile.instructions)}`,
    ""
  ].join("\n");
}

export function codexLaunchConfigToml(
  spec: Pick<ToolLaunchSpec, "gatewayUrl" | "defaultModel">,
  modelCatalogPath?: string,
  roles: readonly CodexAgentRole[] = []
): string {
  const lines = [
    `model = ${JSON.stringify(spec.defaultModel)}`,
    `model_provider = ${JSON.stringify(PROVIDER_ID)}`
  ];
  if (modelCatalogPath !== undefined) {
    lines.push(`model_catalog_json = ${JSON.stringify(modelCatalogPath)}`);
  }
  lines.push(
    "",
    `[model_providers.${PROVIDER_ID}]`,
    `name = "RouteKit gateway"`,
    `base_url = ${JSON.stringify(`${spec.gatewayUrl.replace(/\/+$/, "")}/v1`)}`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`,
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
  cwd: string | undefined
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      stdio: ["inherit", "inherit", "pipe"],
      // env-spread-allowed: interactive user tool inherits the user's shell configuration
      env: { ...process.env, CODEX_HOME: home },
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
  const home = mkdtempSync(join(tmpdir(), "routekit-codex-"));
  ctx.registerDisposer(() => rmSync(home, { recursive: true, force: true }));
  if (hasCodexLogin() && spec.auth?.token === undefined) {
    copyFileSync(codexAuthPath(), join(home, "auth.json"));
  }
  const ids = [...catalogIds(spec), ...codexListedStockSlugs()];
  codexProfileFiles(home, ids);
  const template = readCodexCatalogTemplate();
  const catalogPath = template === undefined ? undefined : join(home, CATALOG_FILE);
  if (catalogPath !== undefined && template !== undefined) {
    writeFileSync(catalogPath, codexModelCatalogJson(spec, template));
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
  let result = await spawnCodex(spec.args, home, spec.cwd);
  if (catalogPath !== undefined && isCodexConfigFailure(result.code, result.stderr)) {
    writeConfig(undefined, roles);
    result = await spawnCodex(spec.args, home, spec.cwd);
  }
  if (roles.length > 0 && isCodexConfigFailure(result.code, result.stderr)) {
    writeConfig(undefined, []);
    result = await spawnCodex(spec.args, home, spec.cwd);
  }
  return result.code;
}
