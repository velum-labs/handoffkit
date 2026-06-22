/**
 * `fusionkit fusion init` — an interactive wizard that scaffolds a committed
 * per-repo `fusionkit.json`. On a non-interactive stdin the prompts fall back to
 * their defaults, so `fusion init` still produces a sensible config in CI.
 */
import { execFileSync } from "node:child_process";

import {
  DEFAULT_CLOUD_PANEL,
  DEFAULT_TRIO,
  defaultKeyEnv,
  fusionkitPyCommand
} from "./fusion-quickstart.js";
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
  DEFAULT_CLAUDE_SUB_MODEL,
  detectCodexModel,
  detectSubscription
} from "./fusion/subscriptions.js";
import type { SubscriptionStatus } from "./fusion/subscriptions.js";
import { parsePanelModelSpec } from "./shared/options.js";
import { confirm, done, note, select, text } from "./ui/prompt.js";
import { uiStream } from "./ui/runtime.js";
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

/** Build a panel from the locally detected subscription logins. */
function subscriptionPanel(claude: SubscriptionStatus, codex: SubscriptionStatus): PanelModelSpec[] {
  const specs: PanelModelSpec[] = [];
  if (claude.available) {
    specs.push({ id: "claude-code", model: DEFAULT_CLAUDE_SUB_MODEL, provider: "anthropic", auth: "claude-code" });
  }
  if (codex.available) {
    specs.push({ id: "codex", model: detectCodexModel(), auth: "codex" });
  }
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

async function buildCustomPanel(): Promise<PanelModelSpec[]> {
  out.write(
    dim(
      "Add panel models as ID=PROVIDER:MODEL (e.g. gpt=openai:gpt-5.5), or a subscription " +
        "as ID=claude-code:MODEL / ID=codex:MODEL. Blank line to finish.\n"
    )
  );
  const specs: PanelModelSpec[] = [];
  for (let index = 0; index < 16; index++) {
    const entry = await text({ message: `model ${index + 1}` });
    if (entry.length === 0) break;
    try {
      specs.push(withKeyEnv(parsePanelModelSpec(entry, {})));
    } catch (error) {
      out.write(`${red("!")} ${error instanceof Error ? error.message : String(error)}\n`);
      index--;
    }
  }
  if (specs.length === 0) {
    out.write(dim("No models entered; using the default cloud panel.\n"));
    return DEFAULT_CLOUD_PANEL.map((spec) => withKeyEnv(spec));
  }
  return specs;
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

  // Detect local subscription logins so we can offer them as a panel (no API
  // keys needed — FusionKit reuses the `claude` / `codex` CLI login read-only).
  const claudeSub = detectSubscription("claude-code");
  const codexSub = detectSubscription("codex");
  const detectedSubs = [
    claudeSub.available ? "claude-code" : undefined,
    codexSub.available ? "codex" : undefined
  ].filter((value): value is string => value !== undefined);

  type Preset = "subscriptions" | "cloud" | "local" | "custom";
  const presetOptions: Array<{ value: Preset; label: string; hint: string }> = [];
  if (detectedSubs.length > 0) {
    presetOptions.push({
      value: "subscriptions",
      label: "subscriptions",
      hint: `reuse your ${detectedSubs.join(" + ")} login (no API keys)`
    });
  }
  presetOptions.push(
    { value: "cloud", label: "cloud", hint: DEFAULT_CLOUD_PANEL.map((s) => s.id).join(" + ") },
    { value: "local", label: "local MLX trio", hint: "Apple Silicon, no API keys" },
    { value: "custom", label: "custom", hint: "pick your own models" }
  );

  const preset = await select<Preset>({ message: "Panel", options: presetOptions, defaultIndex: 0 });

  let panel: PanelModelSpec[];
  switch (preset) {
    case "subscriptions":
      panel = subscriptionPanel(claudeSub, codexSub);
      for (const sub of [claudeSub, codexSub]) {
        if (sub.available && sub.expired) {
          const cmd = sub.mode === "claude-code" ? "claude" : "codex login";
          out.write(`${red("!")} ${sub.mode} login is expired — run ${bold(cmd)} to refresh.\n`);
        }
      }
      break;
    case "cloud":
      panel = DEFAULT_CLOUD_PANEL.map((spec) => withKeyEnv(spec));
      break;
    case "local":
      panel = DEFAULT_TRIO.map((spec) => ({ ...spec }));
      break;
    case "custom":
      panel = await buildCustomPanel();
      break;
    default: {
      const exhaustive: never = preset;
      throw new Error(`unknown panel preset: ${String(exhaustive)}`);
    }
  }

  const judgeDefault = panel[0]?.model ?? "";
  const judgeModel = await text({ message: "Judge model (for synthesis)", defaultValue: judgeDefault });

  const observe = await confirm({ message: "Enable the observability dashboard by default?", defaultValue: false });

  const config: FusionConfig = {
    version: FUSION_CONFIG_VERSION,
    tool,
    panel,
    ...(judgeModel.length > 0 ? { judgeModel } : {}),
    local: preset === "local",
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
