/**
 * The interactive panel builder shared by `fusionkit init` and
 * `fusionkit ensemble add/edit`: build a panel member-by-member, each member
 * independently picking how it authenticates (subscription / API key / local
 * MLX) and which model it runs. Local picks are hardware-aware (RAM budget,
 * real Hub-measured sizing, downloaded-first ranking). On a non-interactive
 * stdin the builder falls back to the default cloud panel.
 */
import type { LocalModelInfo } from "@fusionkit/adapter-ai-sdk";
import { defaultKeyEnv as registryDefaultKeyEnv, providerDiscovery } from "@fusionkit/registry";

import {
  autocompleteText,
  BACK,
  canPromptInteractively,
  confirm,
  dim,
  formatBytes,
  fuzzySelect,
  note,
  select,
  text,
  uiStream
} from "@fusionkit/cli-ui";
import type { Back } from "@fusionkit/cli-ui";

import { DEFAULT_CLOUD_PANEL, defaultKeyEnv } from "./env.js";
import type { PanelModelSpec } from "./env.js";
import { catalogEntry, recommendFor, usableRamGB } from "./local-catalog.js";
import type { HostInfo, LocalCatalogEntry } from "./local-catalog.js";
import { ownedMlxEnv } from "./mlx.js";
import { estimateModelSizing } from "./model-sizing.js";
import type { ModelSizing } from "./model-sizing.js";
import { buildAuthOptions, defaultModelForAuthChoice, specForAuthChoice } from "./panel-auth.js";
import type { AuthChoice } from "./panel-auth.js";
import { listModelsForAuth } from "./model-catalog.js";
import type { ModelListResult } from "./model-catalog.js";

const out = uiStream();

const CUSTOM_MODEL = "__custom__";

/** Ensure each cloud spec records the env var holding its key (self-documenting). */
export function withKeyEnv(spec: PanelModelSpec): PanelModelSpec {
  const provider = spec.provider ?? "mlx";
  // Subscription specs reuse a CLI login, not an env key.
  if (spec.auth !== undefined || spec.keyEnv !== undefined || provider === "mlx") return { ...spec };
  const keyEnv = defaultKeyEnv(provider);
  return keyEnv !== undefined ? { ...spec, keyEnv } : { ...spec };
}

/** Whether every panel member runs locally (drives the config `local` flag). */
export function isAllLocal(panel: PanelModelSpec[]): boolean {
  return panel.length > 0 && panel.every((spec) => (spec.provider ?? "mlx") === "mlx" && spec.auth === undefined);
}

/** Judge picker options: one per panel member (value = model), deduped by model. */
export function judgeOptions(panel: PanelModelSpec[]): Array<{ value: string; label: string }> {
  const seen = new Set<string>();
  const options: Array<{ value: string; label: string }> = [];
  for (const spec of panel) {
    if (seen.has(spec.model)) continue;
    seen.add(spec.model);
    options.push({ value: spec.model, label: `${spec.id} (${spec.model})` });
  }
  return options;
}

/** A readable, unique default id for a new panel member, derived from its auth choice. */
export function defaultMemberId(choice: AuthChoice, taken: Set<string>): string {
  const base = choice;
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Env var that unlocks live discovery for an auth choice (for hinting). */
function liveKeyEnvFor(choice: AuthChoice): string | undefined {
  return providerDiscovery(choice) !== undefined ? registryDefaultKeyEnv(choice) : undefined;
}

/**
 * Offer a model picker for an auth choice: a live list from the provider when a
 * key is present, curated otherwise, plus an "other" custom entry. Results are
 * cached per choice for the session so repeat members do not refetch.
 */
async function pickModel(
  choice: AuthChoice,
  cache: Map<AuthChoice, ModelListResult>
): Promise<string> {
  const keyEnv = liveKeyEnvFor(choice);
  const toOptions = (result: ModelListResult): Array<{ value: string; label: string; hint?: string }> => [
    ...result.models.map((model) => ({ value: model, label: model })),
    { value: CUSTOM_MODEL, label: "other (type a model name)" }
  ];
  const fetchList = async (): Promise<ModelListResult> => {
    let result = cache.get(choice);
    if (result === undefined) {
      result = await listModelsForAuth(choice, { env: process.env });
      cache.set(choice, result);
    }
    return result;
  };

  // The picker opens instantly on the cached list (when a member already
  // fetched it) and otherwise live-loads the provider catalog while the user
  // can already type — stale-while-revalidate instead of a blocking fetch.
  const cached = cache.get(choice);
  const sourceNote = (result: ModelListResult | undefined): string => {
    if (result?.source === "live") return `${choice} live`;
    if (keyEnv !== undefined && process.env[keyEnv] === undefined) {
      return `curated — set ${keyEnv} for the live list`;
    }
    return `${choice} models`;
  };
  const chosen = await fuzzySelect<string>({
    message: `Model (${sourceNote(cached ?? undefined)})`,
    placeholder: "type to filter",
    options: cached !== undefined ? toOptions(cached) : [],
    ...(cached === undefined
      ? {
          refresh: async () => toOptions(await fetchList()),
          refreshNote: `fetching ${choice} models…`
        }
      : {})
  });
  if (chosen === CUSTOM_MODEL) {
    const suggestions = (cache.get(choice)?.models ?? []).slice();
    const custom = await autocompleteText({
      message: "Model name",
      suggestions,
      defaultValue: defaultModelForAuthChoice(choice)
    });
    return String(custom);
  }
  return chosen;
}

/**
 * A lazily-populated, memoized snapshot of which curated models are already in
 * the owned MLX cache, so the picker can badge them without re-scanning. Off
 * Apple Silicon (or on any failure) it resolves to an empty map.
 */
export class LocalScan {
  private cache: Map<string, LocalModelInfo> | undefined;
  private sizingPrinted = false;

  constructor(readonly host: HostInfo) {}

  async downloaded(): Promise<Map<string, LocalModelInfo>> {
    if (this.cache !== undefined) return this.cache;
    if (!this.host.appleSilicon) {
      this.cache = new Map();
      return this.cache;
    }
    out.write(dim("  checking local model cache...\n"));
    try {
      const models = await ownedMlxEnv().scanModels();
      this.cache = new Map(models.map((model) => [model.repo, model]));
    } catch {
      this.cache = new Map();
    }
    return this.cache;
  }

  /**
   * Real per-model sizing (weights + KV + overhead), measured from the Hub with
   * the static catalog as the offline fallback. Memoized via the sizing cache;
   * prints a one-time "sizing" note since the first call hits the network.
   */
  async sizings(entries: readonly LocalCatalogEntry[]): Promise<Map<string, ModelSizing>> {
    if (!this.sizingPrinted) {
      out.write(dim("  sizing models for your hardware...\n"));
      this.sizingPrinted = true;
    }
    const pairs = await Promise.all(
      entries.map(
        async (entry) =>
          [entry.repo, await estimateModelSizing(entry.repo, { catalogFallbackGB: entry.minRamGB })] as const
      )
    );
    return new Map(pairs);
  }
}

/**
 * Local model picker: the hardware-aware curated catalog, restricted to models
 * that fit the memory still unclaimed by earlier local panel members
 * (`remainingGB`). Already-downloaded models sort first; oversized models are
 * hidden (with a count) rather than offered. An "other" escape hatch accepts any
 * mlx-community repo. Returns `null` when nothing in the catalog fits — the
 * caller then steers the user to a smaller/cloud choice.
 */
async function pickLocalModel(scan: LocalScan, remainingGB: number): Promise<string | null> {
  const downloaded = await scan.downloaded();
  const catalog = recommendFor(scan.host);
  const sizings = await scan.sizings(catalog);
  const required = (repo: string, fallbackGB: number): number =>
    sizings.get(repo)?.requiredGB ?? fallbackGB;

  const ranked = [...catalog].sort((a, b) => {
    const aDown = downloaded.has(a.repo) ? 0 : 1;
    const bDown = downloaded.has(b.repo) ? 0 : 1;
    if (aDown !== bDown) return aDown - bDown;
    return required(a.repo, a.minRamGB) - required(b.repo, b.minRamGB);
  });
  const affordableEntries = ranked.filter((entry) => required(entry.repo, entry.minRamGB) <= remainingGB);
  const hidden = ranked.length - affordableEntries.length;

  if (affordableEntries.length === 0) {
    note(
      `no catalog model fits the ~${Math.floor(remainingGB)}GB of memory left for local models; ` +
        "pick a cloud model, or type a smaller repo."
    );
    // Still allow an explicit custom repo (the user may know a tiny one).
    const custom = await text({ message: "Local model repo id (or leave blank to skip)", defaultValue: "" });
    return custom.length > 0 ? custom : null;
  }

  if (hidden > 0) {
    out.write(dim(`  ${hidden} larger model(s) hidden — they exceed the memory left for local models.\n`));
  }
  const options = affordableEntries.map((entry) => {
    const info = downloaded.get(entry.repo);
    const weightGB = sizings.get(entry.repo)?.weightGB;
    const downloadLabel = weightGB !== undefined ? `~${weightGB.toFixed(1)} GB download` : `~${entry.sizeGB} GB download`;
    const status = info ? `downloaded ${formatBytes(info.sizeBytes)}` : downloadLabel;
    return {
      value: entry.repo,
      label: entry.label,
      hint: `${entry.params} ${entry.quant} · ${status} · ${entry.blurb}`
    };
  });
  options.push({ value: CUSTOM_MODEL, label: "other (type a repo id)", hint: "any mlx-community model" });
  const chosen = await fuzzySelect<string>({ message: "Local model", placeholder: "type to filter", options });
  if (chosen === CUSTOM_MODEL) {
    return text({ message: "Model repo id", defaultValue: defaultModelForAuthChoice("local") });
  }
  return chosen;
}

/**
 * Build a panel member-by-member. Each member picks a model and, independently,
 * how to authenticate it — so one panel can freely mix them. On a
 * non-interactive stdin we fall back to the default cloud panel so callers
 * still produce a sensible config in CI. `existing` seeds the taken-id set and
 * the shared local memory budget (for `ensemble edit`'s add-member flow).
 * With `allowBack`, Esc on the very first prompt returns {@link BACK} so a
 * wizard can step back instead of trapping the user in the builder.
 */
export async function buildPanel(
  host: HostInfo,
  options: { existing?: readonly PanelModelSpec[]; maxMembers?: number; allowBack: true }
): Promise<PanelModelSpec[] | Back>;
export async function buildPanel(
  host: HostInfo,
  options?: { existing?: readonly PanelModelSpec[]; maxMembers?: number }
): Promise<PanelModelSpec[]>;
export async function buildPanel(
  host: HostInfo,
  options: { existing?: readonly PanelModelSpec[]; maxMembers?: number; allowBack?: boolean } = {}
): Promise<PanelModelSpec[] | Back> {
  if (!canPromptInteractively()) {
    return DEFAULT_CLOUD_PANEL.map((spec) => withKeyEnv(spec));
  }
  out.write(
    dim("Build your panel — add one or more models, choosing how each one authenticates.\n")
  );
  const authOptions = buildAuthOptions(process.env, host);
  const modelCache = new Map<AuthChoice, ModelListResult>();
  const localScan = new LocalScan(host);
  const taken = new Set<string>((options.existing ?? []).map((spec) => spec.id));
  const specs: PanelModelSpec[] = [];
  // Local panel members run as separate resident MLX servers, so they share one
  // memory budget; track how much each pick claims so we never over-commit RAM.
  const localBudgetGB = usableRamGB(host);
  let localUsedGB = 0;
  for (const spec of options.existing ?? []) {
    if ((spec.provider ?? "mlx") === "mlx" && spec.auth === undefined) {
      const sizing = await estimateModelSizing(spec.model, { catalogFallbackGB: catalogEntry(spec.model)?.minRamGB });
      localUsedGB += sizing.requiredGB;
    }
  }
  const max = options.maxMembers ?? 16;
  for (let index = 0; index < max; index++) {
    const message = `Model ${taken.size + 1}: authenticate with`;
    // Only the very first prompt can back out of the builder: once a member
    // exists, Esc would silently discard picks, so it stays inert instead.
    const choice =
      options.allowBack === true && specs.length === 0
        ? await select<AuthChoice>({ message, options: authOptions, defaultIndex: 0, allowBack: true })
        : await select<AuthChoice>({ message, options: authOptions, defaultIndex: 0 });
    if (choice === BACK) return BACK;
    let model: string;
    if (choice === "local") {
      const picked = await pickLocalModel(localScan, localBudgetGB - localUsedGB);
      if (picked === null) {
        // Nothing fit the remaining budget; let the user choose differently.
        continue;
      }
      model = picked;
      // Reserve this model's real footprint against the shared local budget
      // (measured from the Hub, catalog floor offline). Unsized unknown repos
      // don't decrement the budget.
      const sizing = await estimateModelSizing(model, { catalogFallbackGB: catalogEntry(model)?.minRamGB });
      localUsedGB += sizing.requiredGB;
    } else {
      model = await pickModel(choice, modelCache);
    }
    const id = await text({ message: "Name for this panel member", defaultValue: defaultMemberId(choice, taken) });
    taken.add(id);
    specs.push(specForAuthChoice(choice, id, model));
    const more = await confirm({ message: "Add another model?", defaultValue: index === 0 && taken.size <= 1 });
    if (!more) break;
  }
  if (specs.length === 0 && (options.existing ?? []).length === 0) {
    return DEFAULT_CLOUD_PANEL.map((spec) => withKeyEnv(spec));
  }
  return specs;
}
