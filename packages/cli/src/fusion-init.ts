/**
 * `fusionkit fusion init` — an interactive wizard that scaffolds a committed
 * per-repo `fusionkit.json`. On a non-interactive stdin the prompts fall back to
 * their defaults, so `fusion init` still produces a sensible config in CI.
 */
import {
  DEFAULT_CLOUD_PANEL,
  DEFAULT_TRIO,
  defaultKeyEnv,
  FUSION_TOOLS
} from "./fusion-quickstart.js";
import type { FusionTool, PanelModelSpec } from "./fusion-quickstart.js";
import {
  FUSION_CONFIG_VERSION,
  FusionConfigError,
  fusionConfigPath,
  writeFusionConfig
} from "./fusion-config.js";
import type { FusionConfig } from "./fusion-config.js";
import { parsePanelModelSpec } from "./shared/options.js";
import { confirm, done, note, select, text } from "./ui/prompt.js";
import { uiStream } from "./ui/runtime.js";
import { bold, brandHeader, cyan, dim, red } from "./ui/theme.js";

const out = uiStream();

/** Ensure each cloud spec records the env var holding its key (self-documenting). */
function withKeyEnv(spec: PanelModelSpec): PanelModelSpec {
  const provider = spec.provider ?? "mlx";
  if (spec.keyEnv !== undefined || provider === "mlx") return { ...spec };
  const keyEnv = defaultKeyEnv(provider);
  return keyEnv !== undefined ? { ...spec, keyEnv } : { ...spec };
}

async function buildCustomPanel(): Promise<PanelModelSpec[]> {
  out.write(dim("Add panel models as ID=PROVIDER:MODEL (e.g. gpt=openai:gpt-5.5). Blank line to finish.\n"));
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

export async function runFusionInit(input: { repoRoot?: string; force?: boolean }): Promise<number> {
  if (input.repoRoot === undefined) {
    out.write(
      `${red("error:")} not inside a git repository.\n` +
        "  cd into your project (or run from a repo) so fusionkit.json lands at the repo root.\n"
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

  const preset = await select<"cloud" | "local" | "custom">({
    message: "Panel",
    options: [
      { value: "cloud", label: "cloud (default)", hint: DEFAULT_CLOUD_PANEL.map((s) => s.id).join(" + ") },
      { value: "local", label: "local MLX trio", hint: "Apple Silicon, no API keys" },
      { value: "custom", label: "custom", hint: "pick your own models" }
    ],
    defaultIndex: 0
  });

  let panel: PanelModelSpec[];
  switch (preset) {
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

  out.write("\n");
  done(`wrote ${cyan(fusionConfigPath(input.repoRoot))}`);
  note(`commit it, then just run: ${bold(`fusionkit ${tool === "serve" ? "serve" : tool}`)}`);
  return 0;
}
