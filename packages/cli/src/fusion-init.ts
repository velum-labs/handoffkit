/**
 * `fusionkit fusion init` — an interactive wizard that scaffolds a committed
 * per-repo `fusionkit.json`. On a non-interactive stdin the prompts fall back to
 * their defaults, so `fusion init` still produces a sensible config in CI.
 */
import { execFileSync } from "node:child_process";

import { MlxCapabilityError } from "@fusionkit/adapter-ai-sdk";
import type { LocalModelInfo } from "@fusionkit/adapter-ai-sdk";

import { DEFAULT_CLOUD_PANEL, defaultKeyEnv, fusionkitPyCommand } from "./fusion-quickstart.js";
import type { FusionTool, PanelModelSpec } from "./fusion-quickstart.js";
import {
  FUSION_CONFIG_VERSION,
  FusionConfigError,
  fusionConfigPath,
  fusionPromptsDir,
  PROMPT_IDS,
  writeFusionConfig,
  writeFusionPrompts
} from "./fusion-config.js";
import type { FusionConfig, PromptOverrides } from "./fusion-config.js";
import {
  catalogEntry,
  detectHost,
  recommendFor,
  usableRamGB
} from "./fusion/local-catalog.js";
import type { HostInfo, LocalCatalogEntry } from "./fusion/local-catalog.js";
import { ownedMlxEnv } from "./fusion/mlx.js";
import { estimateModelSizing } from "./fusion/model-sizing.js";
import type { ModelSizing } from "./fusion/model-sizing.js";
import {
  buildAuthOptions,
  defaultModelForAuthChoice,
  specForAuthChoice
} from "./fusion/panel-auth.js";
import type { AuthChoice } from "./fusion/panel-auth.js";
import { listModelsForAuth } from "./fusion/model-catalog.js";
import type { ModelListResult } from "./fusion/model-catalog.js";
import { ProgressBar, formatBytes } from "./ui/progress.js";
import { confirm, done, note, select, text } from "./ui/prompt.js";
import { Spinner } from "./ui/spinner.js";
import { canPromptInteractively, uiStream } from "./ui/runtime.js";
import { bold, box, brandBanner, cyan, dim, glyph, gray, green, red, yellow } from "./ui/theme.js";

const out = uiStream();

/** Ensure each cloud spec records the env var holding its key (self-documenting). */
function withKeyEnv(spec: PanelModelSpec): PanelModelSpec {
  const provider = spec.provider ?? "mlx";
  // Subscription specs reuse a CLI login, not an env key.
  if (spec.auth !== undefined || spec.keyEnv !== undefined || provider === "mlx") return { ...spec };
  const keyEnv = defaultKeyEnv(provider);
  return keyEnv !== undefined ? { ...spec, keyEnv } : { ...spec };
}

/** Whether every panel member runs locally (drives the config `local` flag). */
function isAllLocal(panel: PanelModelSpec[]): boolean {
  return panel.length > 0 && panel.every((spec) => (spec.provider ?? "mlx") === "mlx" && spec.auth === undefined);
}

const CUSTOM_MODEL = "__custom__";

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

/** Env var that unlocks live discovery for an API-key auth choice (for hinting). */
const LIVE_KEY_ENV: Partial<Record<AuthChoice, string>> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY"
};

/**
 * Offer a model picker for an auth choice: a live list from the provider when a
 * key is present, curated otherwise, plus an "other" custom entry. Results are
 * cached per choice for the session so repeat members do not refetch.
 */
async function pickModel(
  choice: AuthChoice,
  cache: Map<AuthChoice, ModelListResult>
): Promise<string> {
  let result = cache.get(choice);
  if (result === undefined) {
    out.write(dim("  fetching available models...\n"));
    result = await listModelsForAuth(choice, { env: process.env });
    cache.set(choice, result);
  }
  const keyEnv = LIVE_KEY_ENV[choice];
  const sourceNote =
    result.source === "live"
      ? `${choice} live`
      : keyEnv !== undefined
        ? `curated — set ${keyEnv} for the live list`
        : "curated";
  const chosen = await select<string>({
    message: `Model (${sourceNote})`,
    options: [
      ...result.models.map((model) => ({ value: model, label: model })),
      { value: CUSTOM_MODEL, label: "other (type a model name)" }
    ],
    defaultIndex: 0
  });
  if (chosen === CUSTOM_MODEL) {
    return text({ message: "Model name", defaultValue: defaultModelForAuthChoice(choice) });
  }
  return chosen;
}

/**
 * A lazily-populated, memoized snapshot of which curated models are already in
 * the owned MLX cache, so the picker can badge them without re-scanning. Off
 * Apple Silicon (or on any failure) it resolves to an empty map.
 */
class LocalScan {
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
  const chosen = await select<string>({ message: "Local model", options, defaultIndex: 0 });
  if (chosen === CUSTOM_MODEL) {
    return text({ message: "Model repo id", defaultValue: defaultModelForAuthChoice("local") });
  }
  return chosen;
}

/**
 * Build the panel member-by-member. Each member picks a model and, independently,
 * how to authenticate it (subscription / API key / local) - so one panel can
 * freely mix them. On a non-interactive stdin we fall back to the default cloud
 * panel so `fusion init` still writes a sensible config in CI.
 */
async function buildPanel(host: HostInfo): Promise<PanelModelSpec[]> {
  if (!canPromptInteractively()) {
    return DEFAULT_CLOUD_PANEL.map((spec) => withKeyEnv(spec));
  }
  out.write(
    dim("Build your panel — add one or more models, choosing how each one authenticates.\n")
  );
  const authOptions = buildAuthOptions(process.env, host);
  const modelCache = new Map<AuthChoice, ModelListResult>();
  const localScan = new LocalScan(host);
  const taken = new Set<string>();
  const specs: PanelModelSpec[] = [];
  // Local panel members run as separate resident MLX servers, so they share one
  // memory budget; track how much each pick claims so we never over-commit RAM.
  const localBudgetGB = usableRamGB(host);
  let localUsedGB = 0;
  for (let index = 0; index < 16; index++) {
    const choice = await select<AuthChoice>({
      message: `Model ${index + 1}: authenticate with`,
      options: authOptions,
      defaultIndex: 0
    });
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
    const more = await confirm({ message: "Add another model?", defaultValue: index === 0 });
    if (!more) break;
  }
  if (specs.length === 0) return DEFAULT_CLOUD_PANEL.map((spec) => withKeyEnv(spec));
  return specs;
}

/** The unique local (mlx, non-subscription) model repos in a panel. */
function localReposIn(panel: PanelModelSpec[]): string[] {
  const repos = panel
    .filter((spec) => (spec.provider ?? "mlx") === "mlx" && spec.auth === undefined)
    .map((spec) => spec.model);
  return [...new Set(repos)];
}

/** First line of a (possibly multi-line) error message, trimmed for one-line UI. */
function firstLine(message: string): string {
  return (message.split("\n")[0] ?? message).trim();
}

/** A short tail of a log line for the provisioning spinner suffix. */
function logTail(line: string, max = 60): string {
  const clean = line.trim();
  return clean.length > max ? `…${clean.slice(clean.length - max)}` : clean;
}

/**
 * The magic local phase: provision the owned MLX runtime (with live phase/log
 * status) and download any not-yet-present panel weights, offering to defer
 * each. Off Apple Silicon or non-interactively it records the choice and defers.
 */
async function setupLocalModels(panel: PanelModelSpec[], host: HostInfo): Promise<void> {
  const repos = localReposIn(panel);
  if (repos.length === 0) return;

  out.write("\n");
  if (!host.appleSilicon) {
    note(
      `local models need Apple Silicon; on this ${host.platform}/${host.arch} host they're saved to ` +
        "your config but can't run here."
    );
    note(`on a Mac, run ${bold("fusionkit models download <repo>")} to fetch them.`);
    return;
  }
  if (!canPromptInteractively()) {
    note(`local models will download on first run: ${repos.join(", ")}`);
    return;
  }

  const env = ownedMlxEnv();
  const spinner = new Spinner("preparing the local MLX runtime").start();
  let phaseLabel = "preparing the local MLX runtime";
  try {
    await env.ensureProvisioned({
      onEvent: (event) => {
        if (event.type === "phase") {
          phaseLabel = event.label;
          spinner.update(phaseLabel);
        } else if (event.type === "log") {
          spinner.update(`${phaseLabel} ${dim(`· ${logTail(event.line)}`)}`);
        }
      }
    });
    spinner.succeed("local MLX runtime ready");
  } catch (error) {
    if (error instanceof MlxCapabilityError) {
      spinner.warn(`MLX runtime unavailable: ${firstLine(error.message)}`);
      note("models are saved to your config; they'll download on first run once the runtime is set up.");
      return;
    }
    spinner.fail(`could not prepare the MLX runtime: ${firstLine(error instanceof Error ? error.message : String(error))}`);
    return;
  }

  let present = new Set<string>();
  try {
    present = new Set((await env.scanModels()).map((model) => model.repo));
  } catch {
    // best-effort; treat as nothing present and let downloads decide
  }

  const ready: string[] = [];
  const deferred: string[] = [];
  for (const repo of repos) {
    if (present.has(repo)) {
      ready.push(repo);
      continue;
    }
    const entry = catalogEntry(repo);
    const sizeNote = entry !== undefined ? `~${entry.sizeGB} GB` : "size unknown";
    const yes = await confirm({ message: `Download ${cyan(repo)} (${sizeNote}) now?`, defaultValue: true });
    if (!yes) {
      deferred.push(repo);
      continue;
    }
    const bar = new ProgressBar(`  ${cyan(repo)}`).start();
    try {
      await env.downloadModel(repo, { onProgress: (progress) => bar.update(progress) });
      bar.succeed(`  ${cyan(repo)}`);
      ready.push(repo);
    } catch (error) {
      bar.fail(`  ${repo} ${gray(`— ${firstLine(error instanceof Error ? error.message : String(error))}`)}`);
      deferred.push(repo);
    }
  }

  const lines: string[] = [];
  if (ready.length > 0) lines.push(`${green(glyph.tick())} ready now: ${ready.join(", ")}`);
  if (deferred.length > 0) lines.push(`${yellow(glyph.arrow())} on first run: ${deferred.join(", ")}`);
  lines.push(dim(`runtime: ${env.dir} · ${formatBytes(env.info().diskBytes)} on disk`));
  out.write(`\n${box("local models", lines)}\n`);
}

/**
 * Pull the built-in default prompts from the Python `fusionkit` CLI
 * (`fusionkit prompts dump`) so the scaffolded `.fusionkit/prompts/*.md` files
 * match the synthesizer's source of truth. Returns `undefined` if the CLI is
 * unreachable (e.g. offline) — callers fall back to leaving prompts unset, in
 * which case the built-in defaults are used at run time.
 */
function fetchDefaultPrompts(fusionkitDir?: string): PromptOverrides | undefined {
  const runner = fusionkitPyCommand(fusionkitDir);
  try {
    const stdout = execFileSync(runner.command, [...runner.prefix, "prompts", "dump"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 120_000,
      ...(runner.cwd !== undefined ? { cwd: runner.cwd } : {})
    });
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const prompts: PromptOverrides = {};
    for (const id of PROMPT_IDS) {
      const value = parsed[id];
      if (typeof value === "string" && value.length > 0) prompts[id] = value;
    }
    return Object.keys(prompts).length > 0 ? prompts : undefined;
  } catch {
    return undefined;
  }
}

export async function runFusionInit(input: {
  repoRoot?: string;
  force?: boolean;
  fusionkitDir?: string;
}): Promise<number> {
  if (input.repoRoot === undefined) {
    out.write(
      `${red("error:")} not inside a git repository.\n` +
        "  cd into your project (or run from a repo) so .fusionkit/ lands at the repo root.\n"
    );
    return 1;
  }

  out.write(`\n${brandBanner("let's set up model fusion for this repo")}\n\n`);

  const host = detectHost();

  const tool = await select<FusionTool>({
    message: "Default coding agent",
    options: [
      { value: "codex", label: "codex", hint: "OpenAI Codex CLI" },
      { value: "claude", label: "claude", hint: "Claude Code" },
      { value: "cursor", label: "cursor", hint: "cursor-agent (logged-in CLI)" },
      { value: "serve", label: "serve", hint: "just run the gateway and print setup" }
    ],
    defaultIndex: 0
  });

  const panel = await buildPanel(host);

  // The judge must be one of the panel models (the runtime matches by model and
  // falls back to the first member otherwise), so pick from the members.
  const judgeChoices = judgeOptions(panel);
  const judgeModel =
    judgeChoices.length <= 1
      ? (panel[0]?.model ?? "")
      : await select<string>({
          message: "Judge model (synthesizes the panel)",
          options: judgeChoices,
          defaultIndex: 0
        });

  const observe = await confirm({ message: "Enable the observability dashboard by default?", defaultValue: false });

  const config: FusionConfig = {
    version: FUSION_CONFIG_VERSION,
    tool,
    panel,
    ...(judgeModel.length > 0 ? { judgeModel } : {}),
    local: isAllLocal(panel),
    observe
  };

  let path: string;
  try {
    path = writeFusionConfig(input.repoRoot, config, { force: input.force === true });
  } catch (error) {
    if (error instanceof FusionConfigError) {
      out.write(`${red("error:")} ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  // Scaffold editable prompt overrides from the synthesizer's built-in defaults.
  // If the Python CLI is unreachable, skip silently — unset prompts use the
  // built-in defaults at run time, and the user can eject them later with
  // `fusionkit prompts dump --dir .fusionkit/prompts`.
  const defaultPrompts = fetchDefaultPrompts(input.fusionkitDir);
  const wrotePrompts =
    defaultPrompts !== undefined
      ? writeFusionPrompts(input.repoRoot, defaultPrompts, { force: input.force === true })
      : [];

  out.write("\n");
  done(`wrote ${cyan(fusionConfigPath(input.repoRoot))}`);
  if (wrotePrompts.length > 0) {
    note(`editable prompts in ${cyan(fusionPromptsDir(input.repoRoot))} (empty file = built-in default)`);
  } else if (defaultPrompts === undefined) {
    note(`prompts use built-in defaults; run ${bold("fusionkit prompts dump --dir .fusionkit/prompts")} to customize`);
  }

  // Provision the local runtime and fetch any chosen local weights (with live
  // progress), offering to defer each. No-op when the panel is cloud-only.
  await setupLocalModels(panel, host);

  note(`commit ${cyan(".fusionkit/")}, then just run: ${bold(`fusionkit ${tool === "serve" ? "serve" : tool}`)}`);
  return 0;
}
