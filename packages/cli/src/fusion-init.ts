/**
 * `fusionkit fusion init` — an interactive wizard that scaffolds a committed
 * per-repo `fusionkit.json`. On a non-interactive stdin the prompts fall back to
 * their defaults, so `fusion init` still produces a sensible config in CI.
 */
import { execFileSync } from "node:child_process";

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
  buildAuthOptions,
  defaultModelForAuthChoice,
  specForAuthChoice
} from "./fusion/panel-auth.js";
import type { AuthChoice } from "./fusion/panel-auth.js";
import { listModelsForAuth } from "./fusion/model-catalog.js";
import type { ModelListResult } from "./fusion/model-catalog.js";
import { confirm, done, note, select, text } from "./ui/prompt.js";
import { canPromptInteractively, uiStream } from "./ui/runtime.js";
import { bold, brandHeader, cyan, dim, red } from "./ui/theme.js";

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
 * Build the panel member-by-member. Each member picks a model and, independently,
 * how to authenticate it (subscription / API key / local) - so one panel can
 * freely mix them. On a non-interactive stdin we fall back to the default cloud
 * panel so `fusion init` still writes a sensible config in CI.
 */
async function buildPanel(): Promise<PanelModelSpec[]> {
  if (!canPromptInteractively()) {
    return DEFAULT_CLOUD_PANEL.map((spec) => withKeyEnv(spec));
  }
  out.write(
    dim("Build your panel — add one or more models, choosing how each one authenticates.\n")
  );
  const authOptions = buildAuthOptions();
  const modelCache = new Map<AuthChoice, ModelListResult>();
  const specs: PanelModelSpec[] = [];
  for (let index = 0; index < 16; index++) {
    const id = await text({ message: `Model ${index + 1} id`, defaultValue: `m${index + 1}` });
    const choice = await select<AuthChoice>({
      message: "Authenticate this model with",
      options: authOptions,
      defaultIndex: 0
    });
    const model = await pickModel(choice, modelCache);
    specs.push(specForAuthChoice(choice, id, model));
    const more = await confirm({ message: "Add another model?", defaultValue: index === 0 });
    if (!more) break;
  }
  if (specs.length === 0) return DEFAULT_CLOUD_PANEL.map((spec) => withKeyEnv(spec));
  return specs;
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

  out.write(`\n${brandHeader("let's set up model fusion for this repo")}\n\n`);

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

  const panel = await buildPanel();

  const judgeDefault = panel[0]?.model ?? "";
  const judgeModel = await text({ message: "Judge model (for synthesis)", defaultValue: judgeDefault });

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
  note(`commit ${cyan(".fusionkit/")}, then just run: ${bold(`fusionkit ${tool === "serve" ? "serve" : tool}`)}`);
  return 0;
}
