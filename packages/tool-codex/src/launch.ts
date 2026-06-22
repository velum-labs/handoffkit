import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { LOCAL_MODEL_LABEL, spawnTool } from "@fusionkit/tools";
import type { ToolLaunchContext } from "@fusionkit/tools";

const CATALOG_FILE = "model-catalog.json";
/** A fast non-zero exit within this window is treated as a config-load failure. */
const EARLY_EXIT_MS = 2000;

/** A TOML table key: bare when it is a simple identifier, else quoted. */
function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

/** The fused-plus-native model list, fused first, deduped. */
function modelList(model: string, nativeModels: readonly string[]): string[] {
  return [model, ...nativeModels.filter((native) => native !== model)];
}

/**
 * A single `ModelPreset` from the installed Codex's own catalog, used as a
 * template so our entries always match that version's schema (which changes
 * across Codex releases — e.g. `slug`/`default_reasoning_level` in 0.141).
 */
export type CodexModelPreset = Record<string, unknown>;

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
 * listing the fused model (first/default) plus each native model is what makes
 * in-session switching work. Each entry is cloned from the installed Codex's own
 * `template` preset and only its identity fields are overridden, so the catalog
 * stays valid across Codex schema changes. (Codex still validates the file at
 * startup, so {@link launchCodex} relaunches without it on any mismatch.)
 */
export function codexModelCatalogJson(
  model: string,
  nativeModels: readonly string[],
  template: CodexModelPreset
): string {
  const models = modelList(model, nativeModels).map((id, index) => ({
    ...template,
    slug: id,
    display_name: id === model ? `${id} (fusion)` : id,
    description:
      id === model
        ? "Fused answer across the panel (default)."
        : "Native model, proxied to its real provider via the FusionKit gateway.",
    visibility: "list",
    priority: index,
    availability_nux: null,
    upgrade: null
  }));
  return JSON.stringify({ models }, null, 2);
}

/**
 * Codex config.toml fragment defining the gateway as a Responses provider.
 * Written into an ephemeral CODEX_HOME so the user's own config is untouched.
 * (This is the launcher shim; the harness has its own richer config builder.)
 *
 * The fused model is the default. Native models are surfaced two ways so they
 * are selectable from Codex's own `/model` picker in-session: via
 * `model_catalog_json` (the catalog that drives the picker for a custom
 * provider) and via a `[profiles.*]` entry each (also usable at launch with
 * `--profile <model>`, and a fallback on Codex builds that derive the picker
 * from config).
 */
export function codexLaunchConfigToml(
  gatewayUrl: string,
  model: string,
  nativeModels: readonly string[] = [],
  modelCatalogPath?: string
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
  for (const profile of modelList(model, nativeModels)) {
    lines.push(
      `[profiles.${tomlKey(profile)}]`,
      `model = ${JSON.stringify(profile)}`,
      `model_provider = "${LOCAL_MODEL_LABEL}"`,
      ""
    );
  }
  return lines.join("\n");
}

/** Boot the Codex CLI against the gateway via an ephemeral CODEX_HOME. */
export async function launchCodex(ctx: ToolLaunchContext): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), "fusionkit-codex-"));
  ctx.registerDisposer(() => rmSync(home, { recursive: true, force: true }));
  const nativeModels = ctx.nativeModels ?? [];
  const configPath = join(home, "config.toml");

  // The catalog only adds value when there are native models to surface, and it
  // is built from the installed Codex's own catalog entry so it matches that
  // version's schema. Without that template we skip it and rely on profiles.
  const template = readCodexCatalogTemplate();
  let catalogPath: string | undefined;
  if (nativeModels.length > 0 && template !== undefined) {
    catalogPath = join(home, CATALOG_FILE);
    writeFileSync(catalogPath, codexModelCatalogJson(ctx.modelLabel, nativeModels, template));
  }
  writeFileSync(configPath, codexLaunchConfigToml(ctx.gatewayUrl, ctx.modelLabel, nativeModels, catalogPath));

  ctx.prepareForPassthrough();
  if (ctx.mode === "fusion") {
    ctx.log("fusion: launching codex (each prompt is a coding task fused across the panel)...");
  }
  const startedAt = Date.now();
  const code = await spawnTool("codex", ctx.toolArgs, { CODEX_HOME: home }, ctx.repo);

  // Graceful degradation: Codex validates `model_catalog_json` at startup and
  // exits immediately if its schema has drifted. If that happened, rewrite the
  // config without the catalog (profiles + the fused default still work) and
  // relaunch once so a schema mismatch never bricks `fusionkit codex`.
  if (code !== 0 && catalogPath !== undefined && Date.now() - startedAt < EARLY_EXIT_MS) {
    ctx.log("fusion: codex exited early; retrying without the model catalog (fusion still works)...");
    writeFileSync(configPath, codexLaunchConfigToml(ctx.gatewayUrl, ctx.modelLabel, nativeModels));
    return await spawnTool("codex", ctx.toolArgs, { CODEX_HOME: home }, ctx.repo);
  }
  return code;
}
