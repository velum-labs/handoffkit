import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { stringify as tomlStringify } from "smol-toml";

import { SUBSCRIPTIONS } from "@fusionkit/registry";
import {
  deriveFusedSubagents,
  fusedSubagentDescription,
  fusedSubagentDeveloperInstructions,
  LOCAL_MODEL_LABEL
} from "@fusionkit/tools";
import type { FusedEnsembleInfo, ToolLaunchContext } from "@fusionkit/tools";

const CATALOG_FILE = "model-catalog.json";
/**
 * The CODEX_HOME subdirectory holding one role config per fusion ensemble.
 * Deliberately NOT named "agents": Codex auto-discovers `*.toml` files under
 * `CODEX_HOME/agents/` as role definitions in their own right, so a file there
 * that is *also* referenced by `[agents.<key>].config_file` gets registered
 * twice and Codex rejects it as "duplicate agent role name ... declared in the
 * same config layer". A non-conventional directory name means the file is
 * only ever loaded once, via the explicit config_file reference.
 */
const AGENT_ROLES_DIR = "agent-roles";

/**
 * Stderr signatures of a Codex config-load failure (the catalog schema drifted
 * across releases, a role file collided, the TOML is rejected, ...). Only these
 * trigger a degraded relaunch — a genuine fast failure (bad flag, dead
 * gateway, SIGINT at the prompt) keeps its real exit instead of being
 * relaunched with progressively degraded config.
 */
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

/** Classify a Codex exit as a config-load failure from its stderr. */
export function isCodexConfigFailure(code: number, stderr: string): boolean {
  if (code === 0) return false;
  return CONFIG_FAILURE_PATTERNS.some((pattern) => pattern.test(stderr));
}

/** A TOML table key: bare when it is a simple identifier, else quoted. */
export function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

/** The fused-plus-native model list: the default fused model first, then every
 *  other fused ensemble model, then the natives, deduped. */
function modelList(
  model: string,
  fusedModels: readonly string[],
  nativeModels: readonly string[]
): string[] {
  const ids = [model];
  for (const id of [...fusedModels, ...nativeModels]) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * A single `ModelPreset` from the installed Codex's own catalog, used as a
 * template so our entries always match that version's schema (which changes
 * across Codex releases — e.g. `slug`/`default_reasoning_level` in 0.141).
 */
export type CodexModelPreset = Record<string, unknown>;

/** Expand a registry `~/`-prefixed Codex state path against the given home. */
function codexStatePath(registryPath: string, home: string): string {
  return registryPath.startsWith("~/") ? join(home, registryPath.slice(2)) : registryPath;
}

/** The Codex models-cache path (registry subscription metadata) for a home. */
function codexModelsCachePath(home: string): string {
  return codexStatePath(SUBSCRIPTIONS.codex.modelsCachePath ?? "~/.codex/models_cache.json", home);
}

/**
 * Read every `ModelPreset` from the installed Codex's `~/.codex/models_cache.json`
 * (the catalog it fetched for the current version), in catalog order. Returns
 * `[]` when the cache is absent/unreadable. This is both the schema template
 * source ({@link readCodexCatalogTemplate}) and the stock model list that
 * {@link codexModelCatalogJson} preserves, since Codex's `model_catalog_json`
 * *replaces* its whole catalog rather than appending to it.
 */
export function readCodexModelsCache(home: string = homedir()): CodexModelPreset[] {
  try {
    const parsed = JSON.parse(readFileSync(codexModelsCachePath(home), "utf8")) as {
      models?: unknown;
    };
    if (!Array.isArray(parsed.models)) return [];
    return parsed.models.filter(
      (entry): entry is CodexModelPreset => entry !== null && typeof entry === "object"
    );
  } catch {
    return [];
  }
}

/**
 * Read a real `ModelPreset` from the installed Codex's own catalog cache, used
 * as a template so generated entries always match that version's schema.
 * Returns `undefined` when the cache is absent/unreadable, in which case the
 * launcher skips the catalog and falls back to profiles.
 */
export function readCodexCatalogTemplate(home: string = homedir()): CodexModelPreset | undefined {
  return readCodexModelsCache(home)[0];
}

/** The catalog entry's model slug, or undefined when absent/non-string. */
function presetSlug(entry: CodexModelPreset): string | undefined {
  return typeof entry.slug === "string" && entry.slug.length > 0 ? entry.slug : undefined;
}

/** Whether a stock catalog entry shows in Codex's own picker (schema-tolerant). */
function presetListed(entry: CodexModelPreset): boolean {
  if (entry.visibility !== undefined) return entry.visibility === "list";
  if (entry.show_in_picker !== undefined) return entry.show_in_picker === true;
  return true;
}

/** The Codex login credential path (registry subscription metadata) for a home. */
export function codexAuthPath(home: string = homedir()): string {
  return codexStatePath(SUBSCRIPTIONS.codex.credentialsPath, home);
}

/** Whether a Codex login exists to relay/serve the stock models with. */
export function hasCodexLogin(home: string = homedir()): boolean {
  return existsSync(codexAuthPath(home));
}

/**
 * The picker-listed stock model slugs from the local models cache, in catalog
 * order and deduped. Used for the launch config's `[profiles.*]` entries when
 * the session can actually serve them (a Codex login exists for the gateway
 * relay); the picker itself is driven by the gateway's live merged catalog.
 */
export function codexListedStockSlugs(home: string = homedir()): string[] {
  const seen = new Set<string>();
  return readCodexModelsCache(home).flatMap((entry) => {
    const slug = presetSlug(entry);
    if (slug === undefined || !presetListed(entry) || seen.has(slug)) return [];
    seen.add(slug);
    return [slug];
  });
}

/** The stock-entry description, suffixed with how FusionKit actually serves it. */
function stockDescription(entry: CodexModelPreset): string {
  const note = "Served via your Codex login through the FusionKit gateway.";
  const original = typeof entry.description === "string" ? entry.description.trim() : "";
  if (original.length === 0) return note;
  return `${original}${original.endsWith(".") ? "" : "."} ${note}`;
}

/**
 * Codex `model_catalog_json` contents: a `ModelsResponse` ({ models: [...] }).
 * Codex's `/model` picker for a custom provider is driven by this catalog, so
 * listing the fused model (first/default), every other fused ensemble model,
 * plus each native model is what makes in-session switching work. Each entry is
 * cloned from the installed Codex's own `template` preset and only its identity
 * fields are overridden, so the catalog stays valid across Codex schema changes.
 * (Codex still validates the file at startup, so {@link launchCodex} relaunches
 * without it on any mismatch.)
 *
 * Codex applies `model_catalog_json` as a full catalog *replacement*, so the
 * stock catalog would silently disappear from the picker unless re-listed
 * here. `stockModels` carries the installed Codex's own catalog entries the
 * gateway can serve (via the user's Codex login): they are appended behind the
 * fused/native entries with their original metadata, deduped by slug. When a
 * native panel model shares a slug with a stock entry the two are the same
 * model — the merged entry keeps the stock schema fields (context window,
 * reasoning levels, ...) while its description names the FusionKit gateway as
 * the route, so neither source is silently overwritten.
 */
export function codexModelCatalogJson(
  model: string,
  nativeModels: readonly string[],
  template: CodexModelPreset,
  fusedModels: readonly string[] = [],
  stockModels: readonly CodexModelPreset[] = []
): string {
  return JSON.stringify(
    { models: codexCatalogEntries(model, nativeModels, template, fusedModels, stockModels) },
    null,
    2
  );
}

/**
 * The merged catalog entry list behind {@link codexModelCatalogJson}, also
 * served live by the gateway's Codex backend relay (`GET /v1/models` merges
 * the client's live stock catalog through this same builder, so the static
 * file and the live response can never disagree on merge semantics).
 */
export function codexCatalogEntries(
  model: string,
  nativeModels: readonly string[],
  template: CodexModelPreset,
  fusedModels: readonly string[] = [],
  stockModels: readonly CodexModelPreset[] = []
): Record<string, unknown>[] {
  const fused = new Set([model, ...fusedModels]);
  const stockBySlug = new Map<string, CodexModelPreset>();
  for (const entry of stockModels) {
    const slug = presetSlug(entry);
    if (slug !== undefined && !stockBySlug.has(slug)) stockBySlug.set(slug, entry);
  }
  const ids = modelList(model, fusedModels, nativeModels);
  const listed = new Set(ids);
  const models: Record<string, unknown>[] = ids.map((id, index) => ({
    // A same-slug stock entry is the same model: keep its schema fields so the
    // picker shows real metadata; fall back to the template otherwise.
    ...(fused.has(id) ? template : (stockBySlug.get(id) ?? template)),
    slug: id,
    display_name: fused.has(id) ? `${id} (fusion)` : id,
    description: fused.has(id)
      ? id === model
        ? "Fused answer across the panel (default)."
        : "Fused answer across this ensemble's panel."
      : "Native model, proxied to its real provider via the FusionKit gateway.",
    visibility: "list",
    priority: index,
    availability_nux: null,
    upgrade: null
  }));
  // Preserve the rest of Codex's own catalog behind the fusion entries: cloned
  // verbatim (original display name, visibility, schema fields), renumbered so
  // the fused default stays first, with the gateway route named.
  for (const entry of stockModels) {
    const slug = presetSlug(entry);
    if (slug === undefined || listed.has(slug)) continue;
    listed.add(slug);
    models.push({
      ...entry,
      description: stockDescription(entry),
      priority: models.length
    });
  }
  return models;
}

/**
 * One Codex sub-agent role, auto-defined per fusion ensemble so the model can
 * `spawn_agent` on any ensemble (and users can pick roles) out of the box.
 */
export type CodexAgentRole = {
  /** Role key (= the ensemble's fused model id, e.g. "fusion-deep"). */
  name: string;
  /** The gateway model id the role's sub-agents run on. */
  modelId: string;
  /** Human/model-facing description Codex uses to decide delegation. */
  description: string;
  /** Required by Codex role config files: the sub-agent's developer prompt. */
  developerInstructions: string;
  /** Absolute path of the role's config file inside the ephemeral CODEX_HOME. */
  configPath: string;
};

/** Human/model-facing role description for one ensemble. */
export function codexRoleDescription(ensemble: FusedEnsembleInfo, isDefault: boolean): string {
  return fusedSubagentDescription(ensemble, isDefault, "fused-answer");
}

/** Developer instructions for a Codex role config file. */
export function codexRoleDeveloperInstructions(ensemble: FusedEnsembleInfo): string {
  return fusedSubagentDeveloperInstructions(ensemble);
}

/** Build the per-ensemble sub-agent roles for an ephemeral CODEX_HOME. */
export function codexAgentRoles(
  home: string,
  ensembles: readonly FusedEnsembleInfo[],
  defaultModelId: string
): CodexAgentRole[] {
  return deriveFusedSubagents(ensembles, defaultModelId, "fused-answer").map((subagent) => ({
    name: subagent.name,
    modelId: subagent.modelId,
    description: subagent.description,
    developerInstructions: subagent.developerInstructions,
    configPath: join(home, AGENT_ROLES_DIR, `${subagent.modelId}.toml`)
  }));
}

/**
 * The role config file: pins the sub-agent to the ensemble's gateway model.
 * Codex requires the file to name itself (`name`, non-empty) in addition to
 * `developer_instructions`.
 */
export function codexAgentRoleToml(name: string, modelId: string, developerInstructions: string): string {
  return [
    `name = ${JSON.stringify(name)}`,
    `model = ${JSON.stringify(modelId)}`,
    `model_provider = "${LOCAL_MODEL_LABEL}"`,
    `developer_instructions = ${JSON.stringify(developerInstructions)}`,
    ""
  ].join("\n");
}

/**
 * Codex config.toml fragment defining the gateway as a Responses provider.
 * Written into an ephemeral CODEX_HOME so the user's own config is untouched.
 * (This is the launcher shim; the harness has its own richer config builder.)
 * The two TOML builders intentionally stay separate because launch config is a
 * temporary user-facing Codex home, while harness config is per-candidate
 * execution policy.
 *
 * The session-default fused model is the default. Every other fused ensemble
 * model and the native models are surfaced two ways so they are selectable from
 * Codex's own `/model` picker in-session: via the model catalog (static file or
 * the gateway's live merged `/v1/models`) and via a per-model profile config
 * FILE each (see {@link codexProfileFiles} — usable at launch with
 * `--profile <model>`, e.g. `--profile fusion-deep` to spawn a Codex
 * session/sub-agent on another ensemble). Profiles are deliberately NOT
 * `[profiles.*]` tables: current Codex treats those as legacy config and
 * rejects `--profile <name>` outright when one exists for that name.
 *
 * With `agentRoles`, Codex's multi-agent tools are pinned on (`[features]
 * multi_agent = true` — stable-on upstream, pinned so a managed/older default
 * cannot silently disable the OOTB sub-agent story) and one `[agents.<role>]`
 * table per fusion ensemble is emitted so `spawn_agent` can delegate to any
 * ensemble by role.
 */
export function codexLaunchConfigToml(
  gatewayUrl: string,
  model: string,
  modelCatalogPath?: string,
  agentRoles?: readonly CodexAgentRole[]
): string {
  const lines = [`model = "${model}"`, `model_provider = "${LOCAL_MODEL_LABEL}"`];
  if (modelCatalogPath !== undefined) {
    lines.push(`model_catalog_json = ${JSON.stringify(modelCatalogPath)}`);
  }
  lines.push(
    "",
    `[model_providers.${LOCAL_MODEL_LABEL}]`,
    `name = "FusionKit local"`,
    `base_url = "${gatewayUrl}/v1"`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`,
    ""
  );
  if (agentRoles !== undefined && agentRoles.length > 0) {
    lines.push("[features]", "multi_agent = true", "");
    // Conservative fan-out: a fused sub-agent is itself a whole panel run, so
    // one level of delegation is the sane ceiling.
    lines.push("[agents]", "max_depth = 1", "");
    for (const role of agentRoles) {
      lines.push(
        `[agents.${tomlKey(role.name)}]`,
        `description = ${JSON.stringify(role.description)}`,
        `config_file = ${JSON.stringify(role.configPath)}`,
        ""
      );
    }
  }
  return lines.join("\n");
}

/** A model id that can safely name a `<name>.config.toml` profile file, or undefined. */
function profileFileName(model: string): string | undefined {
  if (model.length === 0 || model.includes("/") || model.includes("\\") || model.startsWith(".")) {
    return undefined;
  }
  return `${model}.config.toml`;
}

/** The contents of one per-model profile config file (gateway-backed). */
export function codexProfileFileToml(model: string, provider: string = LOCAL_MODEL_LABEL): string {
  // Serialized with a real TOML writer so hostile model ids (quotes,
  // backslashes, control characters) can never corrupt the document.
  const body = tomlStringify({ model, model_provider: provider });
  return `# Managed by fusionkit — a launch profile for one gateway model.\n${body.trimEnd()}\n`;
}

/**
 * Write one `<model>.config.toml` profile file per gateway model into a
 * CODEX_HOME, so `codex --profile <model>` starts a session on that model.
 * Codex treats `[profiles.*]` tables in config.toml as legacy config and
 * rejects `--profile <name>` when one exists for that name, so profile FILES
 * are the supported layer. Ids that cannot name a file (e.g. MLX repo paths
 * with a `/`) are skipped — they stay reachable via the in-session picker.
 * Returns the profile names written.
 */
export function codexProfileFiles(
  home: string,
  models: readonly string[],
  provider: string = LOCAL_MODEL_LABEL
): string[] {
  const written: string[] = [];
  for (const model of models) {
    const file = profileFileName(model);
    if (file === undefined || written.includes(model)) continue;
    writeFileSync(join(home, file), codexProfileFileToml(model, provider));
    written.push(model);
  }
  return written;
}

/** Bounded stderr tail retained for exit classification. */
const STDERR_TAIL_BYTES = 8192;

/**
 * Spawn Codex interactively (stdin/stdout inherited for the TUI) while teeing
 * stderr through to the terminal and keeping a bounded tail, so a non-zero
 * exit can be classified as a config-load failure vs a genuine one.
 */
function spawnCodexTool(
  args: readonly string[],
  home: string,
  cwd: string | undefined
): Promise<{ code: number; stderrTail: string }> {
  return new Promise((resolveExit, reject) => {
    const child = spawn("codex", args, {
      stdio: ["inherit", "inherit", "pipe"],
      // env-spread-allowed: launching the user's own coding agent, which legitimately needs their full shell env
      env: { ...process.env, CODEX_HOME: home },
      ...(cwd !== undefined ? { cwd } : {})
    });
    let tail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    child.on("error", reject);
    child.on("exit", (code) => resolveExit({ code: code ?? 0, stderrTail: tail }));
  });
}

/** Boot the Codex CLI against the gateway via an ephemeral CODEX_HOME. */
export async function launchCodex(ctx: ToolLaunchContext): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), "fusionkit-codex-"));
  ctx.registerDisposer(() => rmSync(home, { recursive: true, force: true }));
  // The ephemeral home shadows the user's own Codex config for this run. Say
  // so — silently dropping their MCP servers/instructions/trust reads as a bug.
  if (existsSync(join(homedir(), ".codex", "config.toml"))) {
    ctx.log("fusion: your ~/.codex/config.toml (MCP servers, instructions, trust) is bypassed for this run");
  }
  const nativeModels = ctx.nativeModels ?? [];
  const fusedModels = ctx.fusedModels ?? [];
  const configPath = join(home, "config.toml");

  // Live picker mode: when the user has a Codex login (and the gateway needs
  // no bearer token of its own), reuse it in the ephemeral home. Codex then
  // attaches that login to every gateway request, which (a) lets it fetch the
  // gateway's LIVE merged model catalog from `GET /v1/models` — fusion +
  // panel + Codex's own current models — and (b) lets the gateway relay a
  // stock-model pick verbatim to the Codex backend, exactly like plain Codex.
  // No static `model_catalog_json` is written in this mode: writing one would
  // switch Codex to an authoritative static catalog and disable the live
  // fetch entirely.
  const live = ctx.mode === "fusion" && ctx.authToken === undefined && hasCodexLogin();
  if (live) {
    copyFileSync(codexAuthPath(), join(home, "auth.json"));
    ctx.log("fusion: reusing your Codex login — Codex's own models stay in the picker (served via the gateway)");
  }
  // Stock slugs for launch profiles (`--profile <model>` support): only when
  // they are actually servable (login present for the relay).
  const stockSlugs = live ? codexListedStockSlugs() : [];
  const profileModels = modelList(ctx.modelLabel, fusedModels, [...nativeModels, ...stockSlugs]);
  codexProfileFiles(home, profileModels);

  // Static catalog fallback (no login to relay with): the picker is driven by
  // `model_catalog_json`, built from the installed Codex's own catalog entry
  // so it matches that version's schema. Without that template we skip it and
  // rely on profiles.
  const template = readCodexCatalogTemplate();
  const extraModels = nativeModels.length > 0 || fusedModels.some((id) => id !== ctx.modelLabel);
  let catalogPath: string | undefined;
  if (!live && extraModels && template !== undefined) {
    catalogPath = join(home, CATALOG_FILE);
    writeFileSync(catalogPath, codexModelCatalogJson(ctx.modelLabel, nativeModels, template, fusedModels));
  }

  // OOTB sub-agents: one Codex role per fusion ensemble (spawn_agent delegates
  // to `fusion-<name>` roles whose sub-agents run on that ensemble's gateway
  // model). Skipped with --no-subagents / `subagents: false`.
  let agentRoles: CodexAgentRole[] | undefined;
  if (ctx.subagents !== false && ctx.fusedEnsembles !== undefined && ctx.fusedEnsembles.length > 0) {
    agentRoles = codexAgentRoles(home, ctx.fusedEnsembles, ctx.modelLabel);
    mkdirSync(join(home, AGENT_ROLES_DIR), { recursive: true });
    for (const role of agentRoles) {
      writeFileSync(role.configPath, codexAgentRoleToml(role.name, role.modelId, role.developerInstructions));
    }
  }

  const writeConfig = (catalog: string | undefined, roles: readonly CodexAgentRole[] | undefined): void => {
    writeFileSync(configPath, codexLaunchConfigToml(ctx.gatewayUrl, ctx.modelLabel, catalog, roles));
  };
  writeConfig(catalogPath, agentRoles);

  ctx.prepareForPassthrough();
  if (ctx.mode === "fusion") {
    ctx.log("fusion: launching codex (each prompt is a coding task fused across the panel)...");
  }
  const run = async (): Promise<{ code: number; configFailure: boolean }> => {
    const exit = await spawnCodexTool(ctx.toolArgs, home, ctx.repo);
    return { code: exit.code, configFailure: isCodexConfigFailure(exit.code, exit.stderrTail) };
  };

  // Graceful degradation, one optional extra per retry: Codex validates
  // `model_catalog_json` (its schema drifts across releases) and the `[agents]`
  // section at startup and exits immediately on a mismatch. Only an exit whose
  // stderr classifies as a config-load failure degrades — first dropping the
  // catalog (profiles + the fused default still work), then the agent roles —
  // so neither extra can brick `fusionkit codex`, and a genuine failure keeps
  // its real exit code instead of being relaunched with degraded config.
  let result = await run();
  if (result.configFailure && catalogPath !== undefined) {
    ctx.log("fusion: codex rejected its config; retrying without the model catalog (fusion still works)...");
    writeConfig(undefined, agentRoles);
    result = await run();
  }
  if (result.configFailure && agentRoles !== undefined) {
    ctx.log("fusion: codex rejected its config; retrying without the ensemble sub-agent roles (fusion still works)...");
    writeConfig(undefined, undefined);
    result = await run();
  }
  return result.code;
}
