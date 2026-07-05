/**
 * `fusionkit config` — inspect and edit the one config source of truth.
 *
 *   config show               the effective merged config + where each value came from
 *   config path               the `.fusionkit/fusion.json` location
 *   config get <path>         read one stored value (dot path, e.g. budgetUsd)
 *   config set <path> <value> set one value, validated before writing
 *   config unset <path>       remove one value (falls back to the default)
 *   config edit               interactive editor over every setting
 *   config export-yaml        the derived `fusionkit serve` router YAML (raw endpoint)
 *
 * Every mutation goes through the same load → validate → write pipeline as the
 * runtime (`parseFusionConfig`), so the file on disk can never drift into an
 * invalid state. Hand-editing `.fusionkit/fusion.json` still works — the CLI
 * is just the better way.
 */
import { resolve } from "node:path";
import { existsSync, writeFileSync } from "node:fs";

import type { Command } from "commander";

import { bold, cyan, dim, glyph, gray, green, yellow } from "@fusionkit/cli-ui";

import { autocompleteText, select, text } from "@fusionkit/cli-ui";

import { FusionConfigError, fusionConfigPath, parseFusionConfig } from "../fusion-config.js";
import type { FusionConfig } from "../fusion-config.js";
import { defaultKeyEnv, toolSelectOptions } from "../fusion-quickstart.js";
import type { PanelModelSpec } from "../fusion-quickstart.js";
import { cachedCatalog, CATALOG_PROVIDERS } from "../fusion/catalog.js";
import { loadConfigOrFail, persistedShape, repoRootFor, validateAndWrite } from "../fusion/config-store.js";
import { resolveEffectiveConfig } from "../fusion/effective-config.js";
import type { ConfigSource } from "../fusion/effective-config.js";
import { exportRouterYaml } from "../fusion/stack.js";
import { contextFor } from "../shared/context.js";
import type { CommandContext } from "../shared/context.js";
import { fail } from "../shared/errors.js";
import { ON_RATE_LIMIT_OPTIONS, PANEL_TRUST_OPTIONS } from "../shared/options.js";
import { argOrPick, canPickInteractively } from "../shared/pickers.js";

import { runConfigEdit } from "./config-edit.js";
import { registerPaletteAction } from "./palette.js";

type ConfigOpts = { repo?: string; out?: string; json?: boolean };

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

/** `fusionkit config show` — the effective config with per-field provenance. */
function runShow(opts: ConfigOpts, ctx: CommandContext): number {
  const { root, inRepo } = repoRootFor(opts);
  const config = loadConfigOrFail(root, ctx.presenter);
  const effective = resolveEffectiveConfig(config);

  if (ctx.json) {
    ctx.emit({
      source: config !== undefined ? fusionConfigPath(root) : null,
      repo: root,
      effective
    });
    return 0;
  }

  const { presenter } = ctx;
  presenter.blank();
  presenter.header("config");
  presenter.blank();
  const path = fusionConfigPath(root);
  const where = config !== undefined ? cyan(path) : dim("(no .fusionkit/fusion.json — built-in defaults)");
  presenter.keyValue([
    { label: "source", value: where },
    { label: "repo", value: inRepo ? root : dim(`${root} (not a git repo)`) },
    {
      label: "precedence",
      value: `CLI flags ${glyph.arrow()} .fusionkit/fusion.json ${glyph.arrow()} built-in defaults`
    }
  ]);
  presenter.blank();

  const overrides = Object.keys(effective.prompts.value);
  presenter.keyValue([
    { label: "tool", value: effective.tool.value, tag: sourceTag(effective.tool.source) },
    { label: "local", value: effective.local.value ? "on" : "off", tag: sourceTag(effective.local.source) },
    {
      label: "ensemble",
      value: effective.defaultEnsemble.value,
      tag: sourceTag(effective.defaultEnsemble.source)
    },
    {
      label: "judge",
      value: effective.judgeModel.value || "(first panel model)",
      tag: sourceTag(effective.judgeModel.source)
    },
    { label: "observe", value: effective.observe.value ? "on" : "off", tag: sourceTag(effective.observe.source) },
    {
      label: "on-rate-limit",
      value: effective.onRateLimit.value,
      tag: sourceTag(effective.onRateLimit.source)
    },
    { label: "portless", value: effective.portless.value ? "on" : "off", tag: sourceTag(effective.portless.source) },
    {
      label: "reasoning",
      value: effective.reasoning.value ? "on" : "off",
      tag: sourceTag(effective.reasoning.source)
    },
    {
      label: "reasoning-model",
      value: effective.reasoningModel.value ?? "templated prose",
      tag: sourceTag(effective.reasoningModel.source)
    },
    {
      label: "prompts",
      value: overrides.length > 0 ? overrides.join(", ") : "built-in",
      tag: sourceTag(effective.prompts.source)
    },
    {
      label: "panel",
      value: `${effective.panel.value.length} model(s)`,
      tag: sourceTag(effective.panel.source)
    }
  ]);
  for (const spec of effective.panel.value) presenter.line(`    ${glyph.bullet()} ${panelLabel(spec)}`);

  // Every registered ensemble: each is its own selectable gateway model
  // (`fusion-<name>`; the default keeps `fusion-panel`).
  if (effective.ensembles.value.length > 1) {
    presenter.blank();
    presenter.keyValue([
      {
        label: "ensembles",
        value: `${effective.ensembles.value.length} registered`,
        tag: sourceTag(effective.ensembles.source)
      }
    ]);
    for (const ensemble of effective.ensembles.value) {
      const marker = ensemble.name === effective.defaultEnsemble.value ? ` ${gray("(session default)")}` : "";
      presenter.line(`    ${glyph.bullet()} ${bold(ensemble.name)} ${glyph.arrow()} ${cyan(ensemble.modelId)}${marker}`);
      presenter.line(
        `      judge: ${ensemble.judgeModel || "(first panel model)"}${ensemble.synthesizerModel !== undefined ? `  synthesizer: ${ensemble.synthesizerModel}` : ""}`
      );
      for (const spec of ensemble.panel) presenter.line(`      ${glyph.bullet()} ${panelLabel(spec)}`);
    }
  }

  presenter.blank();
  presenter.line(
    `${dim("edit any value with")} ${bold("fusionkit config set <path> <value>")} ${dim("or interactively via")} ${bold("fusionkit config edit")}`
  );
  return 0;
}

/** `fusionkit config path` — print the config file location (machine-friendly). */
function runPath(opts: ConfigOpts, ctx: CommandContext): number {
  const { root } = repoRootFor(opts);
  const path = fusionConfigPath(root);
  if (ctx.json) {
    ctx.emit({ path, exists: existsSync(path) });
    return 0;
  }
  // The path itself goes to stdout (scriptable); the existence note to stderr.
  process.stdout.write(`${path}\n`);
  if (!existsSync(path)) {
    ctx.presenter.note(dim(`does not exist yet — run \`fusionkit init\` to scaffold it`));
  }
  return 0;
}

/**
 * `fusionkit config export-yaml [-o file]` — emit the derived `fusionkit serve`
 * router YAML for the effective panel. Reuses the live stack's generator so the
 * exported config is byte-identical to what a real run writes. The YAML is the
 * only thing on stdout (pipe-friendly); notes go to stderr.
 */
function runExportYaml(opts: ConfigOpts, ctx: CommandContext): number {
  const { root } = repoRootFor(opts);
  const config = loadConfigOrFail(root, ctx.presenter);
  const effective = resolveEffectiveConfig(config);
  const yaml = exportRouterYaml({
    specs: effective.panel.value,
    judgeModel: effective.judgeModel.value,
    ...(Object.keys(effective.prompts.value).length > 0 ? { prompts: effective.prompts.value } : {})
  });

  if (opts.out !== undefined) {
    const outPath = resolve(opts.out);
    writeFileSync(outPath, yaml);
    ctx.presenter.success(`wrote ${cyan(outPath)}`);
    ctx.presenter.line(dim("run it with: fusionkit serve --config " + outPath));
    return 0;
  }
  process.stdout.write(yaml);
  return 0;
}

// ---------------------------------------------------------------------------
// Mutation: config get / set / unset
// ---------------------------------------------------------------------------

/** The persisted top-level keys `config set` may address (prompts are files). */
const SETTABLE_TOP_LEVEL = [
  "tool",
  "defaultEnsemble",
  "local",
  "observe",
  "portless",
  "port",
  "onRateLimit",
  "budgetUsd",
  "panelTrust",
  "reasoning",
  "reasoningModel"
] as const;

/** Per-ensemble keys addressable as `ensembles.<name>.<key>`. */
const SETTABLE_ENSEMBLE_KEYS = ["panel", "judgeModel", "synthesizerModel"] as const;

export type ConfigPath =
  | { kind: "top"; key: (typeof SETTABLE_TOP_LEVEL)[number] }
  | { kind: "ensemble"; name: string; key: (typeof SETTABLE_ENSEMBLE_KEYS)[number] };

/** Parse a dot path into a supported config address, failing with guidance. */
export function parseConfigPath(path: string): ConfigPath {
  const parts = path.split(".");
  if (parts.length === 1 && (SETTABLE_TOP_LEVEL as readonly string[]).includes(parts[0] ?? "")) {
    return { kind: "top", key: parts[0] as (typeof SETTABLE_TOP_LEVEL)[number] };
  }
  if (parts.length === 3 && parts[0] === "ensembles") {
    const key = parts[2] ?? "";
    if ((SETTABLE_ENSEMBLE_KEYS as readonly string[]).includes(key)) {
      return {
        kind: "ensemble",
        name: parts[1] ?? "",
        key: key as (typeof SETTABLE_ENSEMBLE_KEYS)[number]
      };
    }
    return fail(
      `unknown ensemble setting "${key}" — expected one of ${SETTABLE_ENSEMBLE_KEYS.join(", ")}`
    );
  }
  return fail(
    `unknown config path "${path}" — expected one of ${SETTABLE_TOP_LEVEL.join(", ")}, ` +
      `or ensembles.<name>.<${SETTABLE_ENSEMBLE_KEYS.join("|")}>`
  );
}

/**
 * Parse a raw CLI value: JSON when it parses (numbers, booleans, null, arrays,
 * objects), with `on`/`off` as boolean sugar; everything else stays a string.
 * The typed validation happens in `parseFusionConfig` afterwards.
 */
export function parseConfigValue(raw: string): unknown {
  if (raw === "on") return true;
  if (raw === "off") return false;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** Short hints for the path picker (what each settable key controls). */
const TOP_LEVEL_HINTS: Record<(typeof SETTABLE_TOP_LEVEL)[number], string> = {
  tool: "default coding agent (codex, claude, cursor)",
  defaultEnsemble: "session-default ensemble name",
  local: "run the panel on local MLX models (on/off)",
  observe: "boot the scope dashboard (on/off)",
  portless: "stable .localhost URLs (on/off)",
  port: "fixed gateway port (default: ephemeral)",
  onRateLimit: "rate-limit handoff: fusion | passthrough | fail",
  budgetUsd: "per-session USD spend cap",
  panelTrust: "candidate autonomy: full | guarded",
  reasoning: "narrate panel/judge in the tool (on/off)",
  reasoningModel: "model that writes the narration prose"
};

/** Every settable dot path for the loaded config (top-level + per-ensemble). */
export function settableConfigPaths(config: FusionConfig | undefined): Array<{ path: string; hint: string }> {
  const paths: Array<{ path: string; hint: string }> = SETTABLE_TOP_LEVEL.map((key) => ({
    path: key,
    hint: TOP_LEVEL_HINTS[key]
  }));
  for (const name of Object.keys(config?.ensembles ?? {})) {
    for (const key of SETTABLE_ENSEMBLE_KEYS) {
      paths.push({ path: `ensembles.${name}.${key}`, hint: `ensemble "${name}" ${key}` });
    }
  }
  return paths;
}

/** Resolve the `[path]` argument, offering a fuzzy picker on a TTY. */
async function pathArgOrPick(
  given: string | undefined,
  config: FusionConfig | undefined,
  verb: string
): Promise<string> {
  return argOrPick<string>({
    given,
    message: `Which setting to ${verb}?`,
    placeholder: "type to filter",
    missing:
      `missing config path — expected one of ${SETTABLE_TOP_LEVEL.join(", ")}, ` +
      `or ensembles.<name>.<${SETTABLE_ENSEMBLE_KEYS.join("|")}>`,
    options: () => settableConfigPaths(config).map((entry) => ({ value: entry.path, label: entry.path, hint: entry.hint }))
  });
}

/** All cached model ids across providers (ghost suggestions for model paths). */
function cachedModelIdSuggestions(): string[] {
  const ids: string[] = [];
  for (const provider of CATALOG_PROVIDERS) {
    for (const model of cachedCatalog(provider)) ids.push(model.id);
  }
  return ids;
}

/**
 * Prompt for the `[value]` argument with the right input for the path: on/off
 * for booleans, a picker for enums, ghost-completed text for model names, and
 * plain text otherwise. Only reached on an interactive TTY.
 */
/** on/off toggle options for the boolean config keys. */
const ON_OFF_OPTIONS = [
  { value: "on", label: "on" },
  { value: "off", label: "off" }
] as const;

async function promptConfigValue(address: ConfigPath): Promise<string> {
  if (address.kind === "top") {
    switch (address.key) {
      case "local":
      case "observe":
      case "portless":
      case "reasoning":
        return select<string>({
          message: `${address.key}`,
          options: ON_OFF_OPTIONS,
          defaultIndex: 0
        });
      case "tool":
        return select<string>({
          message: "default tool",
          options: toolSelectOptions().filter((option) => option.value !== "serve"),
          defaultIndex: 0
        });
      case "onRateLimit":
        return select<string>({
          message: "on rate limit",
          options: ON_RATE_LIMIT_OPTIONS,
          defaultIndex: 0
        });
      case "panelTrust":
        return select<string>({
          message: "panel trust",
          options: PANEL_TRUST_OPTIONS,
          defaultIndex: 0
        });
      case "reasoningModel": {
        const value = await autocompleteText({
          message: "reasoning model",
          suggestions: cachedModelIdSuggestions(),
          placeholder: "e.g. openai/gpt-5.5-mini"
        });
        return String(value);
      }
      case "port":
        return text({ message: "gateway port", placeholder: "e.g. 8787" });
      case "budgetUsd":
        return text({ message: "budget (USD)", placeholder: "e.g. 5" });
      case "defaultEnsemble":
        return text({ message: "default ensemble name" });
      default: {
        const exhaustive: never = address;
        throw new Error(`unknown top-level config key: ${String(exhaustive)}`);
      }
    }
  }
  switch (address.key) {
    case "judgeModel":
    case "synthesizerModel": {
      const value = await autocompleteText({
        message: `${address.name} ${address.key}`,
        suggestions: cachedModelIdSuggestions(),
        placeholder: "model name (tab completes from the catalog cache)"
      });
      return String(value);
    }
    case "panel":
      return text({
        message: `${address.name} panel (JSON array of {id, model, provider})`,
        placeholder: '[{"id":"gpt","provider":"openai","model":"gpt-5.5"}]'
      });
    default: {
      const exhaustive: never = address;
      throw new Error(`unknown ensemble config key: ${String(exhaustive)}`);
    }
  }
}

function readPath(shape: Record<string, unknown>, address: ConfigPath): unknown {
  if (address.kind === "top") return shape[address.key];
  const ensembles = shape.ensembles as Record<string, Record<string, unknown>> | undefined;
  return ensembles?.[address.name]?.[address.key];
}

function writePath(shape: Record<string, unknown>, address: ConfigPath, value: unknown): void {
  if (address.kind === "top") {
    if (value === undefined) delete shape[address.key];
    else shape[address.key] = value;
    return;
  }
  const ensembles = (shape.ensembles ?? {}) as Record<string, Record<string, unknown>>;
  const ensemble = ensembles[address.name] ?? {};
  if (value === undefined) delete ensemble[address.key];
  else ensemble[address.key] = value;
  ensembles[address.name] = ensemble;
  shape.ensembles = ensembles;
}

function runGet(path: string, opts: ConfigOpts, ctx: CommandContext): number {
  const { root } = repoRootFor(opts);
  const address = parseConfigPath(path);
  const config = loadConfigOrFail(root, ctx.presenter);
  const value = readPath(persistedShape(config), address);
  if (ctx.json) {
    ctx.emit({ path, value: value === undefined ? null : value, set: value !== undefined });
    return value !== undefined ? 0 : 1;
  }
  if (value === undefined) {
    ctx.presenter.note(`${path} is not set (the built-in default applies) — see \`fusionkit config show\``);
    return 1;
  }
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
  return 0;
}

function runSet(path: string, rawValue: string, opts: ConfigOpts, ctx: CommandContext): number {
  const { root, inRepo } = repoRootFor(opts);
  if (!inRepo) {
    fail("not inside a git repository (and no --repo given) — nowhere to write .fusionkit/fusion.json");
  }
  const address = parseConfigPath(path);
  const config = loadConfigOrFail(root, ctx.presenter);
  const shape = persistedShape(config);
  writePath(shape, address, parseConfigValue(rawValue));
  validateAndWrite(root, shape);
  if (ctx.json) {
    ctx.emit({ path, value: parseConfigValue(rawValue), written: fusionConfigPath(root) });
    return 0;
  }
  ctx.presenter.success(
    `set ${bold(path)} ${glyph.arrow()} ${cyan(rawValue)} ${dim(`in ${fusionConfigPath(root)}`)}`
  );
  return 0;
}

function runUnset(path: string, opts: ConfigOpts, ctx: CommandContext): number {
  const { root, inRepo } = repoRootFor(opts);
  if (!inRepo) {
    fail("not inside a git repository (and no --repo given) — nowhere to write .fusionkit/fusion.json");
  }
  const address = parseConfigPath(path);
  const config = loadConfigOrFail(root, ctx.presenter);
  const shape = persistedShape(config);
  if (readPath(shape, address) === undefined) {
    if (ctx.json) {
      ctx.emit({ path, unset: false, reason: "not set" });
      return 0;
    }
    ctx.presenter.note(`${path} was not set — nothing to do`);
    return 0;
  }
  writePath(shape, address, undefined);
  validateAndWrite(root, shape);
  if (ctx.json) {
    ctx.emit({ path, unset: true, written: fusionConfigPath(root) });
    return 0;
  }
  ctx.presenter.success(`unset ${bold(path)} ${dim(`(the built-in default applies again)`)}`);
  return 0;
}

export function registerConfig(program: Command): void {
  registerPaletteAction({ label: "Edit the repo config", hint: "fusionkit config edit", argv: ["config", "edit"] });
  const config = program
    .command("config")
    .description("inspect and edit the one config source of truth (.fusionkit/fusion.json)");

  config
    .command("show")
    .description("show the effective merged config and where each value came from")
    .option("--repo <dir>", "repo whose .fusionkit/ to read (default: cwd's git root)")
    .option("--json", "emit machine-readable JSON (includes provenance)")
    .action((opts: ConfigOpts, command: Command) => {
      process.exit(runShow(opts, contextFor(command)));
    });

  config
    .command("path")
    .description("print the .fusionkit/fusion.json location")
    .option("--repo <dir>", "repo whose .fusionkit/ to read (default: cwd's git root)")
    .option("--json", "emit machine-readable JSON")
    .action((opts: ConfigOpts, command: Command) => {
      process.exit(runPath(opts, contextFor(command)));
    });

  config
    .command("get")
    .argument("[path]", "dot path, e.g. budgetUsd or ensembles.default.judgeModel; omit on a TTY to pick")
    .description("print one stored config value (exit 1 when unset)")
    .option("--repo <dir>", "repo whose .fusionkit/ to read (default: cwd's git root)")
    .option("--json", "emit machine-readable JSON")
    .action(async (path: string | undefined, opts: ConfigOpts, command: Command) => {
      const ctx = contextFor(command);
      const { root } = repoRootFor(opts);
      const resolved = await pathArgOrPick(path, loadConfigOrFail(root, ctx.presenter), "read");
      process.exit(runGet(resolved, opts, ctx));
    });

  config
    .command("set")
    .argument("[path]", "dot path, e.g. budgetUsd or ensembles.default.judgeModel; omit on a TTY to pick")
    .argument("[value]", "the new value (JSON, on/off, or a bare string); omit on a TTY to be prompted")
    .description("set one config value, validated before writing")
    .option("--repo <dir>", "repo whose .fusionkit/ to write (default: cwd's git root)")
    .option("--json", "emit machine-readable JSON")
    .action(async (path: string | undefined, value: string | undefined, opts: ConfigOpts, command: Command) => {
      const ctx = contextFor(command);
      const { root } = repoRootFor(opts);
      const resolvedPath = await pathArgOrPick(path, loadConfigOrFail(root, ctx.presenter), "set");
      let resolvedValue = value;
      if (resolvedValue === undefined) {
        if (!canPickInteractively()) {
          fail(`missing value for ${resolvedPath} — pass it as the second argument`);
        }
        resolvedValue = await promptConfigValue(parseConfigPath(resolvedPath));
      }
      process.exit(runSet(resolvedPath, resolvedValue, opts, ctx));
    });

  config
    .command("unset")
    .argument("[path]", "dot path, e.g. budgetUsd or ensembles.default.judgeModel; omit on a TTY to pick")
    .description("remove one config value (the built-in default applies again)")
    .option("--repo <dir>", "repo whose .fusionkit/ to write (default: cwd's git root)")
    .option("--json", "emit machine-readable JSON")
    .action(async (path: string | undefined, opts: ConfigOpts, command: Command) => {
      const ctx = contextFor(command);
      const { root } = repoRootFor(opts);
      const resolved = await pathArgOrPick(path, loadConfigOrFail(root, ctx.presenter), "unset");
      process.exit(runUnset(resolved, opts, ctx));
    });

  config
    .command("edit")
    .description("interactively edit every setting (tool, budget, trust, reasoning, ...)")
    .option("--repo <dir>", "repo whose .fusionkit/ to edit (default: cwd's git root)")
    .action(async (opts: ConfigOpts, command: Command) => {
      process.exit(await runConfigEdit(opts, contextFor(command)));
    });

  config
    .command("export-yaml")
    .description("emit the derived fusionkit serve router YAML (for raw `fusionkit serve`)")
    .option("-o, --out <file>", "write the YAML to a file instead of stdout")
    .option("--repo <dir>", "repo whose .fusionkit/ to read (default: cwd's git root)")
    .action((opts: ConfigOpts, command: Command) => {
      process.exit(runExportYaml(opts, contextFor(command)));
    });
}
