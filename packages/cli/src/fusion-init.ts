/**
 * `fusionkit init` — the interactive wizard that scaffolds a committed
 * `.fusionkit/` folder. Prompts render as Ink components on a TTY; on a
 * non-interactive stdin every prompt falls back to its default, so `init`
 * still produces a sensible config in CI.
 *
 * The wizard covers the whole config surface: the default tool, the panel
 * (member-by-member, mixing subscriptions / API keys / local MLX), the judge,
 * an optional extras step (budget, rate-limit policy, panel trust, reasoning),
 * and optional named ensembles — so nothing requires hand-editing JSON after.
 */
import { existsSync } from "node:fs";

import {
  BACK,
  bold,
  canPromptInteractively,
  confirm,
  createPresenter,
  cyan,
  dim,
  done,
  gray,
  green,
  note,
  red,
  runWizard,
  select,
  text,
  uiStream,
  yellow
} from "@fusionkit/cli-ui";
import type { Presenter, WizardStep } from "@fusionkit/cli-ui";

import { MlxCapabilityError } from "@fusionkit/adapter-ai-sdk";

import { formatBytes, glyph } from "@fusionkit/cli-ui";

import { toolSelectOptions } from "./fusion-quickstart.js";
import type { FusionTool, PanelModelSpec } from "./fusion-quickstart.js";
import {
  DEFAULT_ENSEMBLE_NAME,
  FUSION_CONFIG_VERSION,
  FusionConfigError,
  fusionConfigPath,
  fusionPromptsDir,
  validateEnsembleName,
  writeFusionConfig,
  writeFusionPrompts
} from "./fusion-config.js";
import type { EnsembleConfig, FusionConfig } from "./fusion-config.js";
import { catalogEntry, detectHost } from "./fusion/local-catalog.js";
import type { HostInfo } from "./fusion/local-catalog.js";
import { ownedMlxEnv } from "./fusion/mlx.js";
import { buildPanel, isAllLocal, judgeOptions, withKeyEnv } from "./fusion/panel-builder.js";
import { fetchDefaultPrompts } from "./fusion/prompts.js";
import { ON_RATE_LIMIT_OPTIONS, PANEL_TRUST_OPTIONS } from "./shared/options.js";
import { disableTelemetry, enableTelemetry, resolveTelemetry } from "./telemetry/consent.js";

export { defaultMemberId, judgeOptions } from "./fusion/panel-builder.js";

const out = uiStream();

/** The unique local (mlx, non-subscription) model repos across every ensemble. */
function localReposIn(panels: readonly PanelModelSpec[][]): string[] {
  const repos = panels
    .flat()
    .filter((spec) => (spec.provider ?? "mlx") === "mlx" && spec.auth === undefined)
    .map((spec) => spec.model);
  return [...new Set(repos)];
}

/** First line of a (possibly multi-line) error message, trimmed for one-line UI. */
function firstLine(message: string): string {
  return (message.split("\n")[0] ?? message).trim();
}

/** A short tail of a log line for the provisioning task suffix. */
function logTail(line: string, max = 60): string {
  const clean = line.trim();
  return clean.length > max ? `…${clean.slice(clean.length - max)}` : clean;
}

/**
 * The magic local phase: provision the owned MLX runtime (with live phase/log
 * status) and download any not-yet-present panel weights, offering to defer
 * each. Off Apple Silicon or non-interactively it records the choice and defers.
 */
async function setupLocalModels(
  panels: readonly PanelModelSpec[][],
  host: HostInfo,
  presenter: Presenter
): Promise<void> {
  const repos = localReposIn(panels);
  if (repos.length === 0) return;

  presenter.blank();
  if (!host.appleSilicon) {
    note(
      `local models need Apple Silicon; on this ${host.platform}/${host.arch} host they're saved to ` +
        "your config but can't run here."
    );
    note(`on a Mac, run ${bold("fusionkit models download <repo>")} to fetch them.`);
    return;
  }
  if (!canPromptInteractively()) {
    // Non-TTY (CI): no prompts, but still surface the combined download budget so
    // logs record roughly how many GB the first run will pull.
    const budgetGB = repos
      .map((repo) => catalogEntry(repo)?.sizeGB ?? 0)
      .reduce((sum, gb) => sum + gb, 0);
    const budgetNote = budgetGB > 0 ? ` (~${budgetGB.toFixed(1)} GB total)` : "";
    note(`local models will download on first run: ${repos.join(", ")}${budgetNote}`);
    return;
  }

  const env = ownedMlxEnv();
  const task = presenter.task("preparing the local MLX runtime");
  let phaseLabel = "preparing the local MLX runtime";
  try {
    await env.ensureProvisioned({
      onEvent: (event) => {
        if (event.type === "phase") {
          phaseLabel = event.label;
          task.update(phaseLabel);
        } else if (event.type === "log") {
          task.update(`${phaseLabel} ${dim(`· ${logTail(event.line)}`)}`);
        }
      }
    });
    task.succeed("local MLX runtime ready");
  } catch (error) {
    if (error instanceof MlxCapabilityError) {
      task.warn(`MLX runtime unavailable: ${firstLine(error.message)}`);
      note("models are saved to your config; they'll download on first run once the runtime is set up.");
      return;
    }
    task.fail(`could not prepare the MLX runtime: ${firstLine(error instanceof Error ? error.message : String(error))}`);
    return;
  }

  let present = new Set<string>();
  try {
    present = new Set((await env.scanModels()).map((model) => model.repo));
  } catch {
    // best-effort; treat as nothing present and let downloads decide
  }

  const alreadyHave = repos.filter((repo) => present.has(repo));
  const missing = repos.filter((repo) => !present.has(repo));

  // Global download budget: the combined estimated size across the panel's
  // not-yet-present models, shown up front so the user sees the whole-panel cost
  // before agreeing to each download — not just isolated per-file bars.
  if (missing.length > 0) {
    const known = missing
      .map((repo) => catalogEntry(repo)?.sizeGB)
      .filter((gb): gb is number => gb !== undefined);
    const budgetGB = known.reduce((sum, gb) => sum + gb, 0);
    const unknownCount = missing.length - known.length;
    const budget =
      budgetGB > 0
        ? `~${budgetGB.toFixed(1)} GB across ${missing.length} model(s)${unknownCount > 0 ? ` (+${unknownCount} of unknown size)` : ""}`
        : `${missing.length} model(s) of unknown size`;
    presenter.line(dim(`download budget: ${budget}`));
  }

  const ready: string[] = [...alreadyHave];
  const deferred: string[] = [];
  // Track bytes pulled this session so the summary reports a combined total, not
  // just the per-model bars that scrolled past.
  let downloadedBytes = 0;
  for (let index = 0; index < missing.length; index++) {
    const repo = missing[index] as string;
    const entry = catalogEntry(repo);
    const sizeNote = entry !== undefined ? `~${entry.sizeGB} GB` : "size unknown";
    const counter = missing.length > 1 ? `[${index + 1}/${missing.length}] ` : "";
    const yes = await confirm({ message: `Download ${counter}${cyan(repo)} (${sizeNote}) now?`, defaultValue: true });
    if (!yes) {
      deferred.push(repo);
      continue;
    }
    const bar = presenter.progress(`  ${counter}${cyan(repo)}`);
    let modelBytes = 0;
    try {
      await env.downloadModel(repo, {
        onProgress: (progress) => {
          modelBytes = progress.downloaded;
          bar.update(progress);
        }
      });
      bar.succeed(`  ${counter}${cyan(repo)}`);
      downloadedBytes += modelBytes;
      ready.push(repo);
    } catch (error) {
      bar.fail(`  ${repo} ${gray(`— ${firstLine(error instanceof Error ? error.message : String(error))}`)}`);
      deferred.push(repo);
    }
  }

  const lines: string[] = [];
  if (ready.length > 0) lines.push(`${green(glyph.tick())} ready now: ${ready.join(", ")}`);
  if (deferred.length > 0) lines.push(`${yellow(glyph.arrow())} on first run: ${deferred.join(", ")}`);
  if (downloadedBytes > 0) lines.push(dim(`downloaded ${formatBytes(downloadedBytes)} this session`));
  lines.push(dim(`runtime: ${env.dir} · ${formatBytes(env.info().diskBytes)} on disk`));
  presenter.blank();
  presenter.box("local models", lines);
}

export type InitOverwriteResolution =
  | { action: "proceed"; force: boolean }
  | { action: "keep" }
  | { action: "refuse" };

/** Decide whether to overwrite an existing per-repo config before the wizard runs. */
export async function resolveInitOverwrite(opts: {
  configPath: string;
  force: boolean;
}): Promise<InitOverwriteResolution> {
  if (!existsSync(opts.configPath) || opts.force) {
    return { action: "proceed", force: opts.force };
  }
  if (canPromptInteractively()) {
    const update = await confirm({
      message: `${cyan(opts.configPath)} already exists. Update it?`,
      defaultValue: false
    });
    return update ? { action: "proceed", force: true } : { action: "keep" };
  }
  return { action: "refuse" };
}

/** Interactive extras: budget / rate-limit / trust / reasoning. Defaults skip it. */
async function promptExtras(config: FusionConfig): Promise<void> {
  if (!canPromptInteractively()) return;
  const wantsExtras = await confirm({
    message: "Configure extras (budget, rate-limit policy, panel trust, reasoning)?",
    defaultValue: false
  });
  if (!wantsExtras) return;

  const budgetRaw = await text({
    message: "Session budget in USD (blank = unlimited)",
    defaultValue: ""
  });
  const budget = Number(budgetRaw);
  if (budgetRaw.trim().length > 0 && Number.isFinite(budget) && budget > 0) {
    config.budgetUsd = budget;
  }

  config.onRateLimit = await select({
    message: "When a vendor passthrough model hits a rate limit / credit wall",
    options: ON_RATE_LIMIT_OPTIONS,
    defaultIndex: 0
  });

  const trust = await select({
    message: "Panel candidate autonomy",
    options: PANEL_TRUST_OPTIONS,
    defaultIndex: 0
  });
  if (trust !== undefined) config.panelTrust = trust;

  const reasoning = await confirm({
    message: "Narrate panel/judge progress in the tool's thinking UI?",
    defaultValue: true
  });
  config.reasoning = reasoning;
}

/** Optionally define extra named ensembles (each its own `fusion-<name>` model). */
async function promptNamedEnsembles(host: HostInfo): Promise<Record<string, EnsembleConfig>> {
  const extras: Record<string, EnsembleConfig> = {};
  if (!canPromptInteractively()) return extras;
  for (;;) {
    const more = await confirm({
      message:
        Object.keys(extras).length === 0
          ? "Add a named ensemble (its own fusion-<name> model, e.g. a fast panel)?"
          : "Add another named ensemble?",
      defaultValue: false
    });
    if (!more) return extras;
    const name = (
      await text({ message: "Ensemble name (lowercase letters, digits, dashes)", defaultValue: "" })
    ).trim();
    if (name.length === 0) return extras;
    try {
      validateEnsembleName(name, "init");
      if (name === DEFAULT_ENSEMBLE_NAME || extras[name] !== undefined) {
        note(`"${name}" is taken — pick another name`);
        continue;
      }
    } catch (error) {
      note(error instanceof FusionConfigError ? error.message : String(error));
      continue;
    }
    const panel = await buildPanel(host);
    if (panel.length === 0) {
      note("no members picked — skipped");
      continue;
    }
    const choices = judgeOptions(panel);
    const judgeModel =
      choices.length <= 1
        ? panel[0]?.model
        : await select<string>({
            message: `Judge model for ${name}`,
            options: choices,
            defaultIndex: 0
          });
    extras[name] = { panel, ...(judgeModel !== undefined ? { judgeModel } : {}) };
    done(`ensemble ${bold(name)} ${dim(`→ fusion-${name}`)}`);
  }
}

export async function runFusionInit(input: {
  repoRoot?: string;
  force?: boolean;
  fusionkitDir?: string;
}): Promise<number> {
  const presenter = createPresenter();
  if (input.repoRoot === undefined) {
    out.write(
      `${red("error:")} not inside a git repository.\n` +
        "  cd into your project (or run from a repo) so .fusionkit/ lands at the repo root.\n"
    );
    return 1;
  }

  presenter.blank();
  presenter.banner("let's set up model fusion for this repo");
  presenter.blank();

  const configPath = fusionConfigPath(input.repoRoot);
  const overwrite = await resolveInitOverwrite({ configPath, force: input.force === true });
  if (overwrite.action === "keep") {
    note("keeping existing config");
    return 0;
  }
  if (overwrite.action === "refuse") {
    out.write(`${red("error:")} ${configPath} already exists (pass --force to overwrite)\n`);
    return 1;
  }
  const force = overwrite.force;

  const host = detectHost();

  // The linear wizard: tool → panel → judge → observe, with Esc going back one
  // step (and step counters framing the journey). The panel builder keeps its
  // own member-by-member loop inside the panel step.
  type InitWizardState = {
    tool: FusionTool;
    panel: PanelModelSpec[];
    judgeModel: string;
    observe: boolean;
  };
  const steps: Array<WizardStep<InitWizardState>> = [
    {
      id: "tool",
      title: "coding agent",
      run: async (state) => {
        const tool = await select<FusionTool>({
          message: "Default coding agent",
          options: toolSelectOptions(),
          defaultIndex: 0
        });
        return { ...state, tool };
      }
    },
    {
      id: "panel",
      title: "model panel",
      run: async (state) => {
        const built = await buildPanel(host, { allowBack: true });
        if (built === BACK) return BACK;
        const panel = built.map((spec) => withKeyEnv(spec));
        return { ...state, panel, judgeModel: panel[0]?.model ?? "" };
      }
    },
    {
      id: "judge",
      title: "judge",
      // The judge must be one of the panel models (the runtime matches by
      // model and falls back to the first member otherwise).
      skip: (state) => judgeOptions(state.panel).length <= 1,
      run: async (state) => {
        const choices = judgeOptions(state.panel);
        const judgeModel = await select<string>({
          message: "Judge model (synthesizes the panel)",
          options: choices,
          defaultIndex: 0,
          allowBack: true
        });
        if (judgeModel === BACK) return BACK;
        return { ...state, judgeModel };
      }
    },
    {
      id: "observe",
      title: "observability",
      run: async (state) => {
        const observe = await confirm({
          message: "Enable the observability dashboard by default?",
          defaultValue: false,
          allowBack: true
        });
        if (observe === BACK) return BACK;
        return { ...state, observe };
      }
    },
    {
      id: "telemetry",
      title: "telemetry",
      run: async (state) => {
        // One-time, opt-in, and never re-asked once decided anywhere (env,
        // kill switch, or a previous answer). Default is no.
        if (resolveTelemetry().source !== "default") return state;
        const optIn = await confirm({
          message:
            "Share anonymous usage telemetry? (never prompts, code, or paths — `fusionkit telemetry status` shows the exact fields)",
          defaultValue: false,
          allowBack: true
        });
        if (optIn === BACK) return BACK;
        if (optIn) enableTelemetry();
        else disableTelemetry();
        return state;
      }
    }
  ];
  const { tool, panel, judgeModel, observe } = await runWizard<InitWizardState>({
    steps,
    initial: { tool: "codex", panel: [], judgeModel: "", observe: false }
  });

  const namedEnsembles = await promptNamedEnsembles(host);

  const config: FusionConfig = {
    version: FUSION_CONFIG_VERSION,
    tool,
    ensembles: {
      [DEFAULT_ENSEMBLE_NAME]: {
        panel,
        ...(judgeModel.length > 0 ? { judgeModel } : {})
      },
      ...namedEnsembles
    },
    local: isAllLocal(panel),
    observe
  };

  await promptExtras(config);

  let path: string;
  try {
    path = writeFusionConfig(input.repoRoot, config, { force });
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
  // `fusionkit prompts edit`.
  const defaultPrompts = fetchDefaultPrompts(input.fusionkitDir);
  const wrotePrompts =
    defaultPrompts !== undefined
      ? writeFusionPrompts(input.repoRoot, defaultPrompts, { force })
      : [];

  presenter.blank();
  done(`wrote ${cyan(path)}`);
  if (wrotePrompts.length > 0) {
    note(`editable prompts in ${cyan(fusionPromptsDir(input.repoRoot))} — manage with ${bold("fusionkit prompts")}`);
  } else if (defaultPrompts === undefined) {
    note(`prompts use built-in defaults; customize any time with ${bold("fusionkit prompts edit <id>")}`);
  }

  // Provision the local runtime and fetch any chosen local weights (with live
  // progress), offering to defer each. No-op when every panel is cloud-only.
  const allPanels = [panel, ...Object.values(namedEnsembles).map((ensemble) => ensemble.panel ?? [])];
  await setupLocalModels(allPanels, host, presenter);

  const summary: string[] = [
    `tool: ${bold(tool)}`,
    `panel: ${panel.map((spec) => spec.id).join(", ")}`,
    ...(judgeModel.length > 0 ? [`judge: ${judgeModel}`] : []),
    ...Object.keys(namedEnsembles).map(
      (name) => `ensemble ${name}: ${(namedEnsembles[name]?.panel ?? []).map((spec) => spec.id).join(", ")}`
    ),
    ...(config.budgetUsd !== undefined ? [`budget: $${config.budgetUsd}`] : []),
    ...(config.panelTrust !== undefined ? [`trust: ${config.panelTrust}`] : []),
    dim(`tune later: fusionkit config edit · fusionkit ensemble list`)
  ];
  presenter.blank();
  presenter.box("model fusion is set up", summary);

  note(`commit ${cyan(".fusionkit/")}, then just run: ${bold(`fusionkit ${tool === "serve" ? "serve" : tool}`)}`);
  return 0;
}
