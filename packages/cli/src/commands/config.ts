import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { contextFor, fail } from "@velum-labs/routekit-cli-core";
import type { CommandContext } from "@velum-labs/routekit-cli-core";
import type { Command } from "commander";

import { fusionConfigPath, parseFusionConfig } from "../fusion-config.js";
import {
  loadConfigOrFail,
  persistedShape,
  repoRootFor,
  validateAndWrite
} from "../fusion/config-store.js";
import { resolveEffectiveConfig } from "../fusion/effective-config.js";
import { registerPaletteAction } from "./palette.js";

type ConfigOpts = { repo?: string; json?: boolean };

export function settableConfigPaths(
  config: ReturnType<typeof loadConfigOrFail>
): Array<{ path: string; hint: string }> {
  const top = [
    "router.config",
    "router.url",
    "router.authEnv",
    "tool",
    "defaultEnsemble",
    "observe",
    "portless",
    "port",
    "onRateLimit",
    "budgetUsd",
    "panelTrust",
    "k",
    "reasoning",
    "subagents"
  ].map((path) => ({ path, hint: "FusionKit v4 setting" }));
  const ensemble = Object.keys(config?.ensembles ?? {}).flatMap((name) =>
    ["members", "judge", "synthesizer", "k"].map((key) => ({
      path: `ensembles.${name}.${key}`,
      hint: `ensemble ${name}`
    }))
  );
  return [...top, ...ensemble];
}

function parseValue(raw: string): unknown {
  if (raw === "on") return true;
  if (raw === "off") return false;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function pathParts(path: string): string[] {
  const parts = path.split(".").filter((part) => part.length > 0);
  if (parts.length === 0) fail("config path must not be empty");
  if (parts.some((part) => part === "__proto__" || part === "constructor")) {
    fail(`unsafe config path: ${path}`);
  }
  return parts;
}

function readPath(shape: Record<string, unknown>, path: string): unknown {
  let current: unknown = shape;
  for (const part of pathParts(path)) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function writePath(
  shape: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const parts = pathParts(path);
  let current = shape;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (typeof next === "object" && next !== null && !Array.isArray(next)) {
      current = next as Record<string, unknown>;
    } else {
      const created: Record<string, unknown> = {};
      current[part] = created;
      current = created;
    }
  }
  const final = parts.at(-1) as string;
  if (value === undefined) delete current[final];
  else current[final] = value;
}

function runShow(options: ConfigOpts, context: CommandContext): number {
  const { root } = repoRootFor(options);
  const config = loadConfigOrFail(root, context.presenter);
  if (config === undefined) {
    fail(`no ${fusionConfigPath(root)}; run \`fusionkit init\``);
  }
  const effective = resolveEffectiveConfig(config);
  const result = {
    source: fusionConfigPath(root),
    router: config.router,
    effective
  };
  if (context.json) context.emit(result);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

function runGet(
  path: string,
  options: ConfigOpts,
  context: CommandContext
): number {
  const { root } = repoRootFor(options);
  const value = readPath(
    persistedShape(loadConfigOrFail(root, context.presenter)),
    path
  );
  if (context.json) context.emit({ path, value: value ?? null });
  else if (value !== undefined) {
    process.stdout.write(
      `${typeof value === "string" ? value : JSON.stringify(value)}\n`
    );
  }
  return value === undefined ? 1 : 0;
}

function runSet(
  path: string,
  raw: string,
  options: ConfigOpts,
  context: CommandContext
): number {
  const { root, inRepo } = repoRootFor(options);
  if (!inRepo) fail("not inside a git repository");
  const shape = persistedShape(loadConfigOrFail(root, context.presenter));
  const value = parseValue(raw);
  writePath(shape, path, value);
  if (path === "router.config") writePath(shape, "router.url", undefined);
  if (path === "router.url") writePath(shape, "router.config", undefined);
  validateAndWrite(root, shape);
  if (context.json) context.emit({ path, value });
  else context.presenter.success(`updated ${path}`);
  return 0;
}

function runUnset(
  path: string,
  options: ConfigOpts,
  context: CommandContext
): number {
  const { root, inRepo } = repoRootFor(options);
  if (!inRepo) fail("not inside a git repository");
  const shape = persistedShape(loadConfigOrFail(root, context.presenter));
  writePath(shape, path, undefined);
  validateAndWrite(root, shape);
  if (context.json) context.emit({ path, unset: true });
  else context.presenter.success(`unset ${path}`);
  return 0;
}

function runEdit(options: ConfigOpts, context: CommandContext): number {
  const { root } = repoRootFor(options);
  const path = fusionConfigPath(root);
  if (!existsSync(path)) fail(`${path} does not exist; run \`fusionkit init\``);
  const editor = process.env.EDITOR ?? process.env.VISUAL;
  if (editor === undefined || editor.length === 0) {
    fail("set EDITOR or VISUAL before running config edit");
  }
  const directory = mkdtempSync(join(tmpdir(), "fusionkit-config-"));
  const temporary = join(directory, "fusion.json");
  try {
    writeFileSync(temporary, readFileSync(path, "utf8"), { mode: 0o600 });
    const result = spawnSync(editor, [temporary], { stdio: "inherit" });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) fail(`${editor} exited with status ${result.status}`);
    const raw = JSON.parse(readFileSync(temporary, "utf8")) as unknown;
    validateAndWrite(root, parseFusionConfig(raw, temporary) as unknown as Record<string, unknown>);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  context.presenter.success(`updated ${path}`);
  return 0;
}

export function registerConfig(program: Command): void {
  registerPaletteAction({
    label: "Show Fusion config",
    hint: "fusionkit config show",
    argv: ["config", "show"]
  });
  const command = program
    .command("config")
    .description("inspect and edit FusionKit v4 configuration");
  command
    .command("show")
    .option("--repo <dir>")
    .option("--json")
    .action((options: ConfigOpts, action: Command) => {
      process.exitCode = runShow(options, contextFor(action));
    });
  command
    .command("path")
    .option("--repo <dir>")
    .action((options: ConfigOpts) => {
      process.stdout.write(`${fusionConfigPath(repoRootFor(options).root)}\n`);
    });
  command
    .command("get <path>")
    .option("--repo <dir>")
    .option("--json")
    .action((path: string, options: ConfigOpts, action: Command) => {
      process.exitCode = runGet(path, options, contextFor(action));
    });
  command
    .command("set <path> <value>")
    .option("--repo <dir>")
    .option("--json")
    .action(
      (path: string, value: string, options: ConfigOpts, action: Command) => {
        process.exitCode = runSet(path, value, options, contextFor(action));
      }
    );
  command
    .command("unset <path>")
    .option("--repo <dir>")
    .option("--json")
    .action((path: string, options: ConfigOpts, action: Command) => {
      process.exitCode = runUnset(path, options, contextFor(action));
    });
  command
    .command("edit")
    .option("--repo <dir>")
    .action((options: ConfigOpts, action: Command) => {
      process.exitCode = runEdit(options, contextFor(action));
    });
}
