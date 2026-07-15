/**
 * `fusionkit ensemble list|add|edit|remove|rename` — manage the named
 * ensembles in `.fusionkit/fusion.json` entirely from the CLI. Every defined
 * ensemble is registered as its own selectable gateway model
 * (`fusion-<name>`; the `default` ensemble keeps `fusion-panel`).
 *
 * `add`/`edit` are interactive on a TTY (the same live panel builder `init`
 * uses); non-interactive runs use `--model`/`--judge`/`--synthesizer` flags,
 * so scripts and CI can manage ensembles too. All mutations validate through
 * `parseFusionConfig` before anything is written.
 */
import { existsSync, renameSync } from "node:fs";

import type { Command } from "commander";

import { fusionModelId } from "@fusionkit/registry";

import { bold, canPromptInteractively, confirm, cyan, dim, gray, select } from "@fusionkit/cli-ui";

import {
  DEFAULT_ENSEMBLE_NAME,
  FusionConfigError,
  fusionConfigPath,
  fusionPromptsDir,
  validateEnsembleName
} from "../fusion-config.js";
import type { EnsembleConfig } from "../fusion-config.js";
import {
  loadConfigOrFail,
  persistedShape,
  repoRootFor,
  shapeEnsembles,
  validateAndWrite
} from "../fusion/config-store.js";
import { defaultKeyEnv } from "../fusion/env.js";
import type { PanelModelSpec } from "../fusion/env.js";
import { detectHost } from "../fusion/local-catalog.js";
import { buildPanel, judgeOptions } from "../fusion/panel-builder.js";
import { contextFor } from "../shared/context.js";
import type { CommandContext } from "../shared/context.js";
import { fail } from "../shared/errors.js";
import { collect, parseIdValue, parsePanelModelSpec } from "../shared/options.js";
import { argOrPick } from "../shared/pickers.js";

type EnsembleCommandOpts = {
  repo?: string;
  json?: boolean;
  model?: string[];
  keyEnv?: string[];
  judge?: string;
  synthesizer?: string;
  addModel?: string[];
  removeModel?: string[];
  yes?: boolean;
};

function memberLabel(spec: PanelModelSpec): string {
  const provider = spec.provider ?? "mlx";
  const flavour = spec.auth !== undefined ? `${provider}:${spec.model} (${spec.auth})` : `${provider}:${spec.model}`;
  const key = spec.keyEnv ?? defaultKeyEnv(provider);
  const keyNote = spec.auth === undefined && key !== undefined ? ` ${gray(`[${key}]`)}` : "";
  return `${spec.id} = ${flavour}${keyNote}`;
}

/** Parse repeatable `--model`/`--key-env` flags into panel specs. */
function specsFromFlags(opts: EnsembleCommandOpts, flag = "--model"): PanelModelSpec[] {
  const keyEnvs: Record<string, string> = {};
  for (const spec of opts.keyEnv ?? []) {
    const { id, value } = parseIdValue("--key-env", spec);
    keyEnvs[id] = value;
  }
  const raw = flag === "--model" ? (opts.model ?? []) : (opts.addModel ?? []);
  return raw.map((spec) => parsePanelModelSpec(spec, keyEnvs));
}

/** The default ensemble name for a shape: `defaultEnsemble`, else `default`, else first. */
function defaultNameOf(shape: Record<string, unknown>): string | undefined {
  const names = Object.keys((shape.ensembles as Record<string, unknown> | undefined) ?? {});
  if (typeof shape.defaultEnsemble === "string") return shape.defaultEnsemble;
  if (names.length === 0) return undefined;
  return names.includes(DEFAULT_ENSEMBLE_NAME) ? DEFAULT_ENSEMBLE_NAME : names[0];
}

function runList(opts: EnsembleCommandOpts, ctx: CommandContext): number {
  const { root } = repoRootFor(opts);
  const config = loadConfigOrFail(root, ctx.presenter);
  const shape = persistedShape(config);
  const ensembles = (shape.ensembles ?? {}) as Record<string, EnsembleConfig>;
  const names = Object.keys(ensembles);
  const defaultName = defaultNameOf(shape);

  if (ctx.json) {
    ctx.emit({
      configPath: config !== undefined ? fusionConfigPath(root) : null,
      defaultEnsemble: defaultName ?? null,
      ensembles: names.map((name) => ({
        name,
        modelId: fusionModelId(name),
        default: name === defaultName,
        panel: ensembles[name]?.panel ?? [],
        judgeModel: ensembles[name]?.judgeModel ?? null,
        synthesizerModel: ensembles[name]?.synthesizerModel ?? null
      }))
    });
    return 0;
  }

  const { presenter } = ctx;
  presenter.blank();
  presenter.header("ensembles");
  presenter.blank();
  if (names.length === 0) {
    presenter.line(dim("no ensembles configured — the built-in default panel applies."));
    presenter.line(dim(`add one with ${bold("fusionkit ensemble add <name>")} (or run ${bold("fusionkit init")}).`));
    return 0;
  }
  for (const name of names) {
    const ensemble = ensembles[name] ?? {};
    const marker = name === defaultName ? ` ${gray("(session default)")}` : "";
    presenter.line(`  ${bold(name)} ${dim("→")} ${cyan(fusionModelId(name))}${marker}`);
    presenter.line(
      `    judge: ${ensemble.judgeModel ?? dim("(first panel model)")}${ensemble.synthesizerModel !== undefined ? `  synthesizer: ${ensemble.synthesizerModel}` : ""}`
    );
    for (const spec of ensemble.panel ?? []) presenter.line(`    ${gray("•")} ${memberLabel(spec)}`);
    if ((ensemble.panel ?? []).length === 0) presenter.line(`    ${dim("(built-in default panel)")}`);
  }
  presenter.blank();
  presenter.line(
    dim(`each ensemble is its own selectable model; switch the session default with ${bold("fusionkit config set defaultEnsemble <name>")}`)
  );
  return 0;
}

async function runAdd(name: string, opts: EnsembleCommandOpts, ctx: CommandContext): Promise<number> {
  const { root, inRepo } = repoRootFor(opts);
  if (!inRepo) fail("not inside a git repository (and no --repo given) — nowhere to write .fusionkit/fusion.json");
  try {
    validateEnsembleName(name, "ensemble add");
  } catch (error) {
    fail(error instanceof FusionConfigError ? error.message : String(error));
  }
  const config = loadConfigOrFail(root, ctx.presenter);
  const shape = persistedShape(config);
  const ensembles = shapeEnsembles(shape);
  if (ensembles[name] !== undefined) {
    fail(`ensemble "${name}" already exists — edit it with \`fusionkit ensemble edit ${name}\``);
  }

  let panel = specsFromFlags(opts);
  let judgeModel = opts.judge;
  if (panel.length === 0) {
    if (!canPromptInteractively()) {
      fail(
        `ensemble add needs a panel: pass --model ID=PROVIDER:MODEL (repeatable), ` +
          `or run interactively to build one`
      );
    }
    ctx.presenter.blank();
    ctx.presenter.header(`new ensemble: ${name}`);
    ctx.presenter.blank();
    panel = await buildPanel(detectHost());
    if (panel.length === 0) fail("an ensemble needs at least one panel member");
    if (judgeModel === undefined) {
      const choices = judgeOptions(panel);
      judgeModel =
        choices.length <= 1
          ? panel[0]?.model
          : await select<string>({
              message: "Judge model (synthesizes the panel)",
              options: choices,
              defaultIndex: 0
            });
    }
  }

  ensembles[name] = {
    panel,
    ...(judgeModel !== undefined && judgeModel.length > 0 ? { judgeModel } : {}),
    ...(opts.synthesizer !== undefined ? { synthesizerModel: opts.synthesizer } : {})
  };
  validateAndWrite(root, shape);

  if (ctx.json) {
    ctx.emit({ added: name, modelId: fusionModelId(name), panel, judgeModel: judgeModel ?? null });
    return 0;
  }
  ctx.presenter.success(
    `added ensemble ${bold(name)} ${dim("→")} ${cyan(fusionModelId(name))} ${dim(`(${panel.length} member(s))`)}`
  );
  ctx.presenter.line(dim(`make it the session default with ${bold(`fusionkit config set defaultEnsemble ${name}`)}`));
  return 0;
}

async function runEdit(name: string, opts: EnsembleCommandOpts, ctx: CommandContext): Promise<number> {
  const { root, inRepo } = repoRootFor(opts);
  if (!inRepo) fail("not inside a git repository (and no --repo given) — nowhere to write .fusionkit/fusion.json");
  const config = loadConfigOrFail(root, ctx.presenter);
  const shape = persistedShape(config);
  const ensembles = shapeEnsembles(shape);
  const ensemble = ensembles[name];
  if (ensemble === undefined) {
    fail(`unknown ensemble "${name}" (have: ${Object.keys(ensembles).join(", ") || "none"})`);
  }

  // Non-interactive edits via flags.
  const flagAdds = specsFromFlags(opts, "--add-model");
  const removes = opts.removeModel ?? [];
  const hasFlagEdits =
    flagAdds.length > 0 || removes.length > 0 || opts.judge !== undefined || opts.synthesizer !== undefined;
  if (hasFlagEdits) {
    const panel = [...(ensemble.panel ?? [])];
    for (const id of removes) {
      const index = panel.findIndex((spec) => spec.id === id);
      if (index === -1) fail(`ensemble "${name}" has no panel member "${id}"`);
      panel.splice(index, 1);
    }
    for (const spec of flagAdds) {
      if (panel.some((existing) => existing.id === spec.id)) {
        fail(`ensemble "${name}" already has a panel member "${spec.id}"`);
      }
      panel.push(spec);
    }
    ensembles[name] = {
      ...ensemble,
      panel,
      ...(opts.judge !== undefined ? { judgeModel: opts.judge } : {}),
      ...(opts.synthesizer !== undefined ? { synthesizerModel: opts.synthesizer } : {})
    };
    validateAndWrite(root, shape);
    if (ctx.json) {
      ctx.emit({ edited: name, panel, judgeModel: ensembles[name]?.judgeModel ?? null });
      return 0;
    }
    ctx.presenter.success(`updated ensemble ${bold(name)} ${dim(`(${panel.length} member(s))`)}`);
    return 0;
  }

  if (!canPromptInteractively()) {
    fail(
      "ensemble edit is interactive — in scripts/CI use --add-model/--remove-model/--judge/--synthesizer flags"
    );
  }

  const { presenter } = ctx;
  presenter.blank();
  presenter.header(`edit ensemble: ${name}`);
  presenter.blank();

  let dirty = false;
  for (;;) {
    const panel = ensemble.panel ?? [];
    const action = await select<string>({
      message: `${name} — ${panel.length} member(s), judge ${ensemble.judgeModel ?? "(first panel model)"}`,
      options: [
        { value: "add", label: "add a panel member" },
        ...(panel.length > 0 ? [{ value: "remove", label: "remove a panel member" }] : []),
        ...(panel.length > 0 ? [{ value: "judge", label: "change the judge model" }] : []),
        { value: "synthesizer", label: "change the synthesizer model", hint: ensemble.synthesizerModel ?? dim("judge (default)") },
        { value: "done", label: dirty ? "save and exit" : "exit" }
      ],
      defaultIndex: 0
    });
    if (action === "done") break;
    if (action === "add") {
      const added = await buildPanel(detectHost(), { existing: panel, maxMembers: 1 });
      if (added.length > 0) {
        ensemble.panel = [...panel, ...added];
        dirty = true;
      }
    } else if (action === "remove") {
      const id = await select<string>({
        message: "Remove which member?",
        options: panel.map((spec) => ({ value: spec.id, label: memberLabel(spec) })),
        defaultIndex: 0
      });
      ensemble.panel = panel.filter((spec) => spec.id !== id);
      if (ensemble.judgeModel !== undefined && !ensemble.panel.some((spec) => spec.model === ensemble.judgeModel)) {
        delete ensemble.judgeModel;
        presenter.note("the judge pointed at the removed member — reset to the first panel model");
      }
      dirty = true;
    } else if (action === "judge") {
      const choices = judgeOptions(panel);
      ensemble.judgeModel = await select<string>({
        message: "Judge model (synthesizes the panel)",
        options: choices,
        defaultIndex: Math.max(0, choices.findIndex((choice) => choice.value === ensemble.judgeModel))
      });
      dirty = true;
    } else if (action === "synthesizer") {
      const choices = [
        { value: "", label: "same as the judge (default)" },
        ...judgeOptions(panel).map((choice) => ({ value: choice.value, label: choice.label }))
      ];
      const chosen = await select<string>({ message: "Synthesizer model", options: choices, defaultIndex: 0 });
      if (chosen.length === 0) delete ensemble.synthesizerModel;
      else ensemble.synthesizerModel = chosen;
      dirty = true;
    }
  }

  if (!dirty) {
    presenter.note("no changes");
    return 0;
  }
  validateAndWrite(root, shape);
  presenter.success(`wrote ${cyan(fusionConfigPath(root))}`);
  return 0;
}

async function runRemove(name: string, opts: EnsembleCommandOpts, ctx: CommandContext): Promise<number> {
  const { root, inRepo } = repoRootFor(opts);
  if (!inRepo) fail("not inside a git repository (and no --repo given) — nowhere to write .fusionkit/fusion.json");
  const config = loadConfigOrFail(root, ctx.presenter);
  const shape = persistedShape(config);
  const ensembles = shapeEnsembles(shape);
  if (ensembles[name] === undefined) {
    fail(`unknown ensemble "${name}" (have: ${Object.keys(ensembles).join(", ") || "none"})`);
  }
  if (Object.keys(ensembles).length === 1) {
    fail(`"${name}" is the only ensemble — a config with an ensembles map needs at least one`);
  }
  if (!ctx.yes && canPromptInteractively()) {
    const sure = await confirm({
      message: `Remove ensemble "${name}" (${fusionModelId(name)})?`,
      defaultValue: false
    });
    if (!sure) {
      ctx.presenter.note("kept it");
      return 0;
    }
  }
  delete ensembles[name];
  if (shape.defaultEnsemble === name) delete shape.defaultEnsemble;
  validateAndWrite(root, shape);
  if (ctx.json) {
    ctx.emit({ removed: name });
    return 0;
  }
  ctx.presenter.success(`removed ensemble ${bold(name)}`);
  return 0;
}

function runRename(from: string, to: string, opts: EnsembleCommandOpts, ctx: CommandContext): number {
  const { root, inRepo } = repoRootFor(opts);
  if (!inRepo) fail("not inside a git repository (and no --repo given) — nowhere to write .fusionkit/fusion.json");
  try {
    validateEnsembleName(to, "ensemble rename");
  } catch (error) {
    fail(error instanceof FusionConfigError ? error.message : String(error));
  }
  const config = loadConfigOrFail(root, ctx.presenter);
  const shape = persistedShape(config);
  const ensembles = shapeEnsembles(shape);
  const ensemble = ensembles[from];
  if (ensemble === undefined) {
    fail(`unknown ensemble "${from}" (have: ${Object.keys(ensembles).join(", ") || "none"})`);
  }
  if (ensembles[to] !== undefined) fail(`ensemble "${to}" already exists`);
  // The default ensemble may omit its panel (built-in trio); a named one can't.
  if (from === DEFAULT_ENSEMBLE_NAME && (ensemble.panel ?? []).length === 0) {
    fail(`the "${DEFAULT_ENSEMBLE_NAME}" ensemble uses the built-in panel; give it an explicit panel before renaming`);
  }
  delete ensembles[from];
  ensembles[to] = ensemble;
  if (shape.defaultEnsemble === from) shape.defaultEnsemble = to;
  validateAndWrite(root, shape);
  // Per-ensemble prompt overrides live in a directory named after the ensemble.
  const fromDir = fusionPromptsDir(root, from);
  const toDir = fusionPromptsDir(root, to);
  if (from !== DEFAULT_ENSEMBLE_NAME && existsSync(fromDir) && !existsSync(toDir)) {
    renameSync(fromDir, toDir);
  }
  if (ctx.json) {
    ctx.emit({ renamed: { from, to }, modelId: fusionModelId(to) });
    return 0;
  }
  ctx.presenter.success(`renamed ensemble ${bold(from)} ${dim("→")} ${bold(to)} ${dim(`(${fusionModelId(to)})`)}`);
  return 0;
}

/** Resolve an omitted ensemble name with a fuzzy picker over the config. */
async function ensembleNameOrPick(
  given: string | undefined,
  opts: EnsembleCommandOpts,
  ctx: CommandContext,
  verb: string
): Promise<string> {
  const { root } = repoRootFor(opts);
  const config = loadConfigOrFail(root, ctx.presenter);
  const shape = persistedShape(config);
  const ensembles = shapeEnsembles(shape);
  const defaultName = defaultNameOf(shape);
  return argOrPick<string>({
    given,
    message: `Which ensemble to ${verb}?`,
    missing: `missing ensemble name (see \`fusionkit ensemble list\`)`,
    empty: "no ensembles configured — add one with `fusionkit ensemble add <name>`",
    options: () =>
      Object.entries(ensembles).map(([name, ensembleConfig]) => ({
        value: name,
        label: name,
        hint: `${(ensembleConfig.panel ?? []).length || "built-in"} member(s)${name === defaultName ? " · session default" : ""}`
      }))
  });
}

/** Attach the ensemble-management subcommands to the `ensemble` group. */
export function registerEnsembleConfig(ensemble: Command): void {
  ensemble
    .command("list")
    .description("list the named ensembles in .fusionkit/fusion.json")
    .option("--repo <dir>", "repo whose .fusionkit/ to read (default: cwd's git root)")
    .option("--json", "emit machine-readable JSON")
    .action((opts: EnsembleCommandOpts, command: Command) => {
      process.exitCode = runList(opts, contextFor(command));
    });

  ensemble
    .command("add")
    .argument("<name>", "ensemble name (lowercase letters, digits, dashes)")
    .description("add a named ensemble (interactive panel builder, or --model flags)")
    .option("--repo <dir>", "repo whose .fusionkit/ to write (default: cwd's git root)")
    .option("--model <spec>", "panel member ID=MODEL or ID=PROVIDER:MODEL (repeatable)", collect)
    .option("--key-env <spec>", "env var holding a member's API key ID=ENV (repeatable)", collect)
    .option("--judge <model>", "judge model (defaults to the first panel member)")
    .option("--synthesizer <model>", "synthesizer model (defaults to the judge)")
    .option("--json", "emit machine-readable JSON")
    .action(async (name: string, opts: EnsembleCommandOpts, command: Command) => {
      process.exitCode = await runAdd(name, opts, contextFor(command));
    });

  ensemble
    .command("edit")
    .argument("[name]", "ensemble to edit; omit on a TTY to pick")
    .description("edit an ensemble's members, judge, and synthesizer")
    .option("--repo <dir>", "repo whose .fusionkit/ to write (default: cwd's git root)")
    .option("--add-model <spec>", "add a panel member ID=MODEL or ID=PROVIDER:MODEL (repeatable)", collect)
    .option("--remove-model <id>", "remove a panel member by id (repeatable)", collect)
    .option("--key-env <spec>", "env var holding a member's API key ID=ENV (repeatable)", collect)
    .option("--judge <model>", "set the judge model")
    .option("--synthesizer <model>", "set the synthesizer model")
    .option("--json", "emit machine-readable JSON")
    .action(async (name: string | undefined, opts: EnsembleCommandOpts, command: Command) => {
      const ctx = contextFor(command);
      process.exitCode = await runEdit(await ensembleNameOrPick(name, opts, ctx, "edit"), opts, ctx);
    });

  ensemble
    .command("remove")
    .alias("rm")
    .argument("[name]", "ensemble to remove; omit on a TTY to pick")
    .description("remove a named ensemble")
    .option("--repo <dir>", "repo whose .fusionkit/ to write (default: cwd's git root)")
    .option("--yes", "skip the confirmation")
    .option("--json", "emit machine-readable JSON")
    .action(async (name: string | undefined, opts: EnsembleCommandOpts, command: Command) => {
      const ctx = contextFor(command);
      process.exitCode = await runRemove(await ensembleNameOrPick(name, opts, ctx, "remove"), opts, ctx);
    });

  ensemble
    .command("rename")
    .argument("<from>", "current ensemble name")
    .argument("<to>", "new ensemble name")
    .description("rename an ensemble (its prompt overrides move with it)")
    .option("--repo <dir>", "repo whose .fusionkit/ to write (default: cwd's git root)")
    .option("--json", "emit machine-readable JSON")
    .action((from: string, to: string, opts: EnsembleCommandOpts, command: Command) => {
      process.exitCode = runRename(from, to, opts, contextFor(command));
    });

}
