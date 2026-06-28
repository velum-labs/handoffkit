/**
 * `fusionkit config` — inspect the one config source of truth.
 *
 *   config show         the effective merged config + where each value came from
 *   config path         the `.fusionkit/fusion.json` location
 *   config export-yaml  the derived `fusionkit serve` router YAML (raw endpoint)
 *
 * Users only ever hand-edit `.fusionkit/fusion.json` (+ `.fusionkit/prompts/*.md`).
 * The Python router YAML is purely *derived* from it — `export-yaml` reuses the
 * exact same generator the live stack writes, so the two can never drift.
 */
import { resolve } from "node:path";
import { existsSync, writeFileSync } from "node:fs";

import type { Command } from "commander";

import {
  FusionConfigError,
  fusionConfigPath,
  loadFusionConfig
} from "../fusion-config.js";
import type { FusionConfig } from "../fusion-config.js";
import { defaultKeyEnv, gitToplevel } from "../fusion-quickstart.js";
import type { PanelModelSpec } from "../fusion-quickstart.js";
import { resolveEffectiveConfig } from "../fusion/effective-config.js";
import type { ConfigSource } from "../fusion/effective-config.js";
import { exportRouterYaml } from "../fusion/stack.js";
import { bold, brandHeader, cyan, dim, glyph, gray, green, yellow } from "../ui/theme.js";

type ConfigOpts = { repo?: string; out?: string };

/** The repo root config is read from: --repo if given, else the cwd's git root. */
function repoRootFor(opts: ConfigOpts): { root: string; inRepo: boolean } {
  const explicit = opts.repo !== undefined ? resolve(opts.repo) : undefined;
  const detected = gitToplevel(process.cwd());
  const root = explicit ?? detected ?? process.cwd();
  return { root, inRepo: explicit !== undefined || detected !== undefined };
}

/** Load the repo config, surfacing a parse error as a fatal one-liner. */
function loadOrExit(root: string): FusionConfig | undefined {
  try {
    return loadFusionConfig(root, (message) => console.error(dim(message)));
  } catch (error) {
    console.error(`${yellow("config error:")} ${error instanceof FusionConfigError ? error.message : String(error)}`);
    process.exit(1);
  }
}

/** A short, self-documenting label for a panel member (provider:model [keyEnv]). */
function panelLabel(spec: PanelModelSpec): string {
  const provider = spec.provider ?? "mlx";
  const flavour = spec.auth !== undefined ? `${provider}:${spec.model} (${spec.auth})` : `${provider}:${spec.model}`;
  const key = spec.keyEnv ?? defaultKeyEnv(provider);
  const keyNote = spec.auth === undefined && key !== undefined ? ` ${gray(`[${key}]`)}` : "";
  return `${spec.id} = ${flavour}${keyNote}`;
}

/** Colourize the provenance tag shown after each effective value. */
function sourceTag(source: ConfigSource): string {
  switch (source) {
    case "flag":
      return yellow("(flag)");
    case "config":
      return cyan("(.fusionkit)");
    case "default":
      return gray("(default)");
    default: {
      const exhaustive: never = source;
      throw new Error(`unknown config source ${String(exhaustive)}`);
    }
  }
}

/** Pad a label column so the value + provenance line up. */
function row(label: string, value: string, source: ConfigSource): string {
  return `  ${label.padEnd(14)} ${value.padEnd(22)} ${sourceTag(source)}`;
}

/** `fusionkit config show` — the effective config with per-field provenance. */
function runShow(opts: ConfigOpts): number {
  const { root, inRepo } = repoRootFor(opts);
  const config = loadOrExit(root);
  const effective = resolveEffectiveConfig(config);

  console.log(`\n${brandHeader("config")}\n`);
  const path = fusionConfigPath(root);
  const where = config !== undefined ? cyan(path) : dim("(no .fusionkit/fusion.json — built-in defaults)");
  console.log(`${dim("source:")} ${where}`);
  console.log(`${dim("repo:")}   ${inRepo ? root : dim(`${root} (not a git repo)`)}`);
  console.log(`${dim("precedence:")} CLI flags ${glyph.arrow()} .fusionkit/fusion.json ${glyph.arrow()} built-in defaults\n`);

  console.log(row("tool", effective.tool.value, effective.tool.source));
  console.log(row("local", effective.local.value ? "on" : "off", effective.local.source));
  console.log(row("judge", effective.judgeModel.value || "(first panel model)", effective.judgeModel.source));
  console.log(row("observe", effective.observe.value ? "on" : "off", effective.observe.source));
  console.log(row("on-rate-limit", effective.onRateLimit.value, effective.onRateLimit.source));
  console.log(row("portless", effective.portless.value ? "on" : "off", effective.portless.source));
  const overrides = Object.keys(effective.prompts.value);
  console.log(row("prompts", overrides.length > 0 ? overrides.join(", ") : "built-in", effective.prompts.source));

  console.log(`\n${row("panel", `${effective.panel.value.length} model(s)`, effective.panel.source)}`);
  for (const spec of effective.panel.value) console.log(`    ${glyph.bullet()} ${panelLabel(spec)}`);

  console.log(`\n${dim("only .fusionkit/fusion.json is hand-edited; the router YAML is derived — see")} ${bold("fusionkit config export-yaml")}`);
  return 0;
}

/** `fusionkit config path` — print the config file location (machine-friendly). */
function runPath(opts: ConfigOpts): number {
  const { root } = repoRootFor(opts);
  const path = fusionConfigPath(root);
  // The path itself goes to stdout (scriptable); the existence note to stderr.
  console.log(path);
  if (!existsSync(path)) {
    console.error(dim(`${glyph.bullet()} does not exist yet — run \`fusionkit init\` to scaffold it`));
  }
  return 0;
}

/**
 * `fusionkit config export-yaml [-o file]` — emit the derived `fusionkit serve`
 * router YAML for the effective panel. Reuses the live stack's generator so the
 * exported config is byte-identical to what a real run writes. The YAML is the
 * only thing on stdout (pipe-friendly); notes go to stderr.
 */
function runExportYaml(opts: ConfigOpts): number {
  const { root } = repoRootFor(opts);
  const config = loadOrExit(root);
  const effective = resolveEffectiveConfig(config);
  const yaml = exportRouterYaml({
    specs: effective.panel.value,
    judgeModel: effective.judgeModel.value,
    ...(Object.keys(effective.prompts.value).length > 0 ? { prompts: effective.prompts.value } : {})
  });

  if (opts.out !== undefined) {
    const outPath = resolve(opts.out);
    writeFileSync(outPath, yaml);
    console.error(`${green(glyph.tick())} wrote ${cyan(outPath)}`);
    console.error(dim("run it with: fusionkit serve --config " + outPath));
    return 0;
  }
  process.stdout.write(yaml);
  return 0;
}

export function registerConfig(program: Command): void {
  const config = program
    .command("config")
    .description("inspect the one config source of truth (.fusionkit/fusion.json)");

  config
    .command("show")
    .description("show the effective merged config and where each value came from")
    .option("--repo <dir>", "repo whose .fusionkit/ to read (default: cwd's git root)")
    .action((opts: ConfigOpts) => {
      process.exit(runShow(opts));
    });

  config
    .command("path")
    .description("print the .fusionkit/fusion.json location")
    .option("--repo <dir>", "repo whose .fusionkit/ to read (default: cwd's git root)")
    .action((opts: ConfigOpts) => {
      process.exit(runPath(opts));
    });

  config
    .command("export-yaml")
    .description("emit the derived fusionkit serve router YAML (for raw `fusionkit serve`)")
    .option("-o, --out <file>", "write the YAML to a file instead of stdout")
    .option("--repo <dir>", "repo whose .fusionkit/ to read (default: cwd's git root)")
    .action((opts: ConfigOpts) => {
      process.exit(runExportYaml(opts));
    });
}
