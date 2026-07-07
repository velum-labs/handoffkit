/**
 * `fusionkit prompts` — manage the committable system-prompt overrides without
 * touching the filesystem by hand:
 *
 *   prompts list [--ensemble <name>]        which overrides exist and where
 *   prompts edit <id> [--ensemble <name>]   open the override in $EDITOR,
 *                                           seeded from the engine's default
 *   prompts reset <id> [--ensemble <name>]  remove the override (built-in
 *                                           default applies again)
 *
 * The flat `.fusionkit/prompts/<id>.md` files are the default ensemble's
 * prompts (and the per-id fallback for every named ensemble);
 * `.fusionkit/prompts/<ensemble>/<id>.md` overrides them per ensemble.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Command } from "commander";

import { bold, canPromptInteractively, cyan, dim, gray } from "@fusionkit/cli-ui";

import {
  DEFAULT_ENSEMBLE_NAME,
  fusionPromptPath,
  fusionPromptsDir,
  PROMPT_IDS
} from "../fusion-config.js";
import type { PromptId } from "../fusion-config.js";
import { loadConfigOrFail, repoRootFor } from "../fusion/config-store.js";
import { fetchDefaultPrompts } from "../fusion/prompts.js";
import { contextFor } from "../shared/context.js";
import type { CommandContext } from "../shared/context.js";
import { fail } from "../shared/errors.js";
import { argOrPick } from "../shared/pickers.js";

type PromptOpts = { repo?: string; ensemble?: string; json?: boolean; fusionkitDir?: string };

function parsePromptId(raw: string): PromptId {
  if ((PROMPT_IDS as readonly string[]).includes(raw)) return raw as PromptId;
  return fail(`unknown prompt id "${raw}" — expected one of ${PROMPT_IDS.join(", ")}`);
}

/** The ensemble scope for a prompt operation (undefined = default/flat files). */
function ensembleScope(opts: PromptOpts): string | undefined {
  if (opts.ensemble === undefined || opts.ensemble === DEFAULT_ENSEMBLE_NAME) return undefined;
  return opts.ensemble;
}

function overrideState(root: string, id: PromptId, ensemble: string | undefined): {
  path: string;
  exists: boolean;
  active: boolean;
} {
  const path = fusionPromptPath(root, id, ensemble);
  const exists = existsSync(path);
  const active = exists && readFileSync(path, "utf8").trim().length > 0;
  return { path, exists, active };
}

function runList(opts: PromptOpts, ctx: CommandContext): number {
  const { root } = repoRootFor(opts);
  const config = loadConfigOrFail(root, ctx.presenter);
  const ensembleNames = Object.keys(config?.ensembles ?? {}).filter(
    (name) => name !== DEFAULT_ENSEMBLE_NAME
  );
  const scopes: Array<string | undefined> =
    opts.ensemble !== undefined ? [ensembleScope(opts)] : [undefined, ...ensembleNames];

  const entries = scopes.flatMap((scope) =>
    PROMPT_IDS.map((id) => {
      const state = overrideState(root, id, scope);
      return { ensemble: scope ?? DEFAULT_ENSEMBLE_NAME, id, ...state };
    })
  );

  if (ctx.json) {
    ctx.emit({ promptsDir: fusionPromptsDir(root), prompts: entries });
    return 0;
  }

  const { presenter } = ctx;
  presenter.blank();
  presenter.header("prompts");
  presenter.blank();
  presenter.table(
    entries.map((entry) => [
      entry.ensemble,
      bold(entry.id),
      entry.active ? cyan("overridden") : entry.exists ? gray("empty (built-in)") : gray("built-in"),
      dim(entry.path)
    ]),
    { head: ["ensemble", "prompt", "state", "file"], indent: 2 }
  );
  presenter.blank();
  presenter.line(
    dim(`edit with ${bold("fusionkit prompts edit <id>")}; an empty/absent file falls back to the built-in default`)
  );
  return 0;
}

/** Resolve the editor to launch: $VISUAL, then $EDITOR. */
function resolveEditor(): string | undefined {
  const visual = process.env.VISUAL;
  if (visual !== undefined && visual.trim().length > 0) return visual;
  const editor = process.env.EDITOR;
  if (editor !== undefined && editor.trim().length > 0) return editor;
  return undefined;
}

/**
 * Seed the override file when it does not exist yet: the engine's real default
 * prompt when reachable (so the user edits from truth), a commented stub
 * otherwise.
 */
function seedContent(id: PromptId, fusionkitDir: string | undefined, ctx: CommandContext): string {
  const task = ctx.presenter.task(`fetching the engine's default ${id} prompt`);
  const defaults = fetchDefaultPrompts(fusionkitDir);
  const seeded = defaults?.[id];
  if (seeded !== undefined) {
    task.succeed(`seeded from the engine's default ${id} prompt`);
    return seeded.endsWith("\n") ? seeded : `${seeded}\n`;
  }
  task.warn(`engine unreachable — starting from an empty override (empty = built-in default)`);
  return "";
}

async function runEdit(rawId: string, opts: PromptOpts, ctx: CommandContext): Promise<number> {
  const { root, inRepo } = repoRootFor(opts);
  if (!inRepo) fail("not inside a git repository (and no --repo given) — nowhere to write .fusionkit/prompts/");
  const id = parsePromptId(rawId);
  const scope = ensembleScope(opts);
  if (scope !== undefined) {
    const config = loadConfigOrFail(root, ctx.presenter);
    if (config?.ensembles?.[scope] === undefined) {
      fail(`unknown ensemble "${scope}" (have: ${Object.keys(config?.ensembles ?? {}).join(", ") || "none"})`);
    }
  }
  const path = fusionPromptPath(root, id, scope);

  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, seedContent(id, opts.fusionkitDir, ctx));
    ctx.presenter.success(`created ${cyan(path)}`);
  }

  const editor = resolveEditor();
  if (editor === undefined || !canPromptInteractively()) {
    ctx.presenter.note(`edit ${cyan(path)} in your editor (set $EDITOR to open it from here)`);
    if (ctx.json) ctx.emit({ id, ensemble: scope ?? DEFAULT_ENSEMBLE_NAME, path, opened: false });
    return 0;
  }

  const result = spawnSync(editor, [path], { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    fail(`${editor} exited with status ${result.status ?? "unknown"}`);
  }
  const state = overrideState(root, id, scope);
  ctx.presenter.success(
    state.active
      ? `${bold(id)} override saved ${dim(`(${path})`)}`
      : `${bold(id)} file is empty — the built-in default applies ${dim(`(${path})`)}`
  );
  return 0;
}

function runReset(rawId: string, opts: PromptOpts, ctx: CommandContext): number {
  const { root, inRepo } = repoRootFor(opts);
  if (!inRepo) fail("not inside a git repository (and no --repo given) — nothing to reset");
  const id = parsePromptId(rawId);
  const scope = ensembleScope(opts);
  const path = fusionPromptPath(root, id, scope);
  if (!existsSync(path)) {
    if (ctx.json) {
      ctx.emit({ id, ensemble: scope ?? DEFAULT_ENSEMBLE_NAME, reset: false, reason: "no override" });
      return 0;
    }
    ctx.presenter.note(`${id} has no override${scope !== undefined ? ` for ensemble ${scope}` : ""} — nothing to do`);
    return 0;
  }
  unlinkSync(path);
  if (ctx.json) {
    ctx.emit({ id, ensemble: scope ?? DEFAULT_ENSEMBLE_NAME, reset: true });
    return 0;
  }
  ctx.presenter.success(`reset ${bold(id)} — the built-in default applies again ${dim(`(removed ${path})`)}`);
  return 0;
}

export function registerPrompts(program: Command): void {
  const prompts = program
    .command("prompts")
    .description("manage the committable judge/synthesizer prompt overrides");

  prompts
    .command("list")
    .description("show which prompt overrides exist (default and per-ensemble)")
    .option("--repo <dir>", "repo whose .fusionkit/ to read (default: cwd's git root)")
    .option("--ensemble <name>", "only this ensemble's overrides")
    .option("--json", "emit machine-readable JSON")
    .action((opts: PromptOpts, command: Command) => {
      process.exit(runList(opts, contextFor(command)));
    });

  const promptIdOrPick = async (given: string | undefined, verb: string): Promise<string> =>
    argOrPick<string>({
      given,
      message: `Which prompt to ${verb}?`,
      missing: `missing prompt id — expected one of ${PROMPT_IDS.join(", ")}`,
      options: () => PROMPT_IDS.map((id) => ({ value: id, label: id }))
    });

  prompts
    .command("edit")
    .argument("[id]", `prompt to edit: ${PROMPT_IDS.join(" | ")}; omit on a TTY to pick`)
    .description("open a prompt override in $EDITOR, seeded from the engine's default")
    .option("--repo <dir>", "repo whose .fusionkit/ to write (default: cwd's git root)")
    .option("--ensemble <name>", "edit this ensemble's override instead of the default")
    .option("--fusionkit-dir <dir>", "local FusionKit checkout (dev override for default prompts)")
    .option("--json", "emit machine-readable JSON")
    .action(async (id: string | undefined, opts: PromptOpts, command: Command) => {
      const ctx = contextFor(command);
      process.exit(await runEdit(await promptIdOrPick(id, "edit"), opts, ctx));
    });

  prompts
    .command("reset")
    .argument("[id]", `prompt to reset: ${PROMPT_IDS.join(" | ")}; omit on a TTY to pick`)
    .description("remove a prompt override (the built-in default applies again)")
    .option("--repo <dir>", "repo whose .fusionkit/ to write (default: cwd's git root)")
    .option("--ensemble <name>", "reset this ensemble's override instead of the default")
    .option("--json", "emit machine-readable JSON")
    .action(async (id: string | undefined, opts: PromptOpts, command: Command) => {
      const ctx = contextFor(command);
      process.exit(runReset(await promptIdOrPick(id, "reset"), opts, ctx));
    });
}
