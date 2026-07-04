import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { LOCAL_MODEL_LABEL, spawnTool } from "@fusionkit/tools";
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
/** A fast non-zero exit within this window is treated as a config-load failure. */
const EARLY_EXIT_MS = 2000;

/** A TOML table key: bare when it is a simple identifier, else quoted. */
function tomlKey(name: string): string {
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

// TODO(@000alen): why is the Codex model catalog cache path hardcoded here? share Codex CLI state paths with subscription credential/config metadata.
/**
 * Read a real `ModelPreset` from the installed Codex's `~/.codex/models_cache.json`
 * (the catalog it fetched for the current version). Returns `undefined` when the
 * cache is absent/unreadable, in which case the launcher skips the catalog and
 * falls back to profiles.
 */
export function readCodexCatalogTemplate(home: string = homedir()): CodexModelPreset | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(home, ".codex", "models_cache.json"), "utf8")) as {
      models?: unknown;
    };
    const first = Array.isArray(parsed.models) ? parsed.models[0] : undefined;
    return first !== null && typeof first === "object" ? (first as CodexModelPreset) : undefined;
  } catch {
    return undefined;
  }
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
 */
export function codexModelCatalogJson(
  model: string,
  nativeModels: readonly string[],
  template: CodexModelPreset,
  fusedModels: readonly string[] = []
): string {
  const fused = new Set([model, ...fusedModels]);
  const models = modelList(model, fusedModels, nativeModels).map((id, index) => ({
    ...template,
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
  return JSON.stringify({ models }, null, 2);
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
  const members = ensemble.memberIds.join(", ");
  return isDefault
    ? `Fused answer from the default "${ensemble.name}" ensemble (${members}).`
    : `Fused answer from the "${ensemble.name}" ensemble (${members}).`;
}

/** Developer instructions for a Codex role config file. */
export function codexRoleDeveloperInstructions(ensemble: FusedEnsembleInfo): string {
  return (
    `You run on the fused "${ensemble.name}" ensemble. Every reply is already a ` +
    "panel-and-judge fusion. Answer the delegated task directly and completely."
  );
}

/** Build the per-ensemble sub-agent roles for an ephemeral CODEX_HOME. */
export function codexAgentRoles(
  home: string,
  ensembles: readonly FusedEnsembleInfo[],
  defaultModelId: string
): CodexAgentRole[] {
  return ensembles.map((ensemble) => ({
    name: ensemble.modelId,
    modelId: ensemble.modelId,
    description: codexRoleDescription(ensemble, ensemble.modelId === defaultModelId),
    developerInstructions: codexRoleDeveloperInstructions(ensemble),
    configPath: join(home, AGENT_ROLES_DIR, `${ensemble.modelId}.toml`)
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

// TODO(@000alen): why does Codex launch config duplicate harness provider config generation? share CodexProvider/Codex TOML metadata across launcher and harness.
/**
 * Codex config.toml fragment defining the gateway as a Responses provider.
 * Written into an ephemeral CODEX_HOME so the user's own config is untouched.
 * (This is the launcher shim; the harness has its own richer config builder.)
 *
 * The session-default fused model is the default. Every other fused ensemble
 * model and the native models are surfaced two ways so they are selectable from
 * Codex's own `/model` picker in-session: via `model_catalog_json` (the catalog
 * that drives the picker for a custom provider) and via a `[profiles.*]` entry
 * each (also usable at launch with `--profile <model>` — e.g.
 * `--profile fusion-deep` to spawn a Codex session/sub-agent on another
 * ensemble — and a fallback on Codex builds that derive the picker from config).
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
  nativeModels: readonly string[] = [],
  modelCatalogPath?: string,
  fusedModels: readonly string[] = [],
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
  for (const profile of modelList(model, fusedModels, nativeModels)) {
    lines.push(
      `[profiles.${tomlKey(profile)}]`,
      `model = ${JSON.stringify(profile)}`,
      `model_provider = "${LOCAL_MODEL_LABEL}"`,
      ""
    );
  }
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

/** Boot the Codex CLI against the gateway via an ephemeral CODEX_HOME. */
export async function launchCodex(ctx: ToolLaunchContext): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), "fusionkit-codex-"));
  ctx.registerDisposer(() => rmSync(home, { recursive: true, force: true }));
  const nativeModels = ctx.nativeModels ?? [];
  const fusedModels = ctx.fusedModels ?? [];
  const configPath = join(home, "config.toml");

  // The catalog only adds value when there are extra models to surface (other
  // fused ensembles and/or natives), and it is built from the installed Codex's
  // own catalog entry so it matches that version's schema. Without that
  // template we skip it and rely on profiles.
  const template = readCodexCatalogTemplate();
  const extraModels = nativeModels.length > 0 || fusedModels.some((id) => id !== ctx.modelLabel);
  let catalogPath: string | undefined;
  if (extraModels && template !== undefined) {
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
    writeFileSync(
      configPath,
      codexLaunchConfigToml(ctx.gatewayUrl, ctx.modelLabel, nativeModels, catalog, fusedModels, roles)
    );
  };
  writeConfig(catalogPath, agentRoles);

  ctx.prepareForPassthrough();
  if (ctx.mode === "fusion") {
    ctx.log("fusion: launching codex (each prompt is a coding task fused across the panel)...");
  }
  const run = async (): Promise<{ code: number; early: boolean }> => {
    const startedAt = Date.now();
    const code = await spawnTool("codex", ctx.toolArgs, { CODEX_HOME: home }, ctx.repo);
    return { code, early: code !== 0 && Date.now() - startedAt < EARLY_EXIT_MS };
  };

  // Graceful degradation, one optional extra per retry: Codex validates
  // `model_catalog_json` (its schema drifts across releases) and the `[agents]`
  // section at startup and exits immediately on a mismatch. A fast failure
  // first drops the catalog (profiles + the fused default still work), then the
  // agent roles — so neither extra can brick `fusionkit codex`.
  let result = await run();
  if (result.early && catalogPath !== undefined) {
    ctx.log("fusion: codex exited early; retrying without the model catalog (fusion still works)...");
    writeConfig(undefined, agentRoles);
    result = await run();
  }
  if (result.early && agentRoles !== undefined) {
    ctx.log("fusion: codex exited early; retrying without the ensemble sub-agent roles (fusion still works)...");
    writeConfig(undefined, undefined);
    result = await run();
  }
  return result.code;
}
