import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { contextFor } from "@routekit/cli-core";
import type { Command } from "commander";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  DEFAULT_ROUTER_CONFIG,
  migrateLegacyState,
  routerConfigPaths,
  updateEffectiveRouterConfig,
  updateRouterConfig,
  writeRouterConfig
} from "../config.js";

import { configOverride, editableConfigPath, loaded } from "./context.js";

function replaceRecord(
  target: Record<string, unknown>,
  replacement: unknown
): void {
  if (typeof replacement !== "object" || replacement === null || Array.isArray(replacement)) {
    throw new Error("router config must be a YAML object");
  }
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, replacement);
}

export function registerConfig(program: Command): void {
  const config = program.command("config").description("manage router configuration");

  config
    .command("path")
    .description("print the effective router config path")
    .action((_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const paths = routerConfigPaths({ configPath: configOverride(command) });
      const path = paths.override ?? paths.project ?? paths.global;
      if (ctx.json) ctx.emit({ path, exists: existsSync(path) });
      else process.stdout.write(`${path}\n`);
    });

  config
    .command("show")
    .description("show the validated effective router config")
    .action((_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const result = loaded(command);
      if (ctx.json) ctx.emit({ ...result, config: result.config });
      else process.stdout.write(stringifyYaml(result.config));
    });

  config
    .command("init")
    .description("create a safe router config template")
    .option("--global", "write the global config")
    .option("--force", "replace an existing config")
    .action((options: { global?: boolean; force?: boolean }, command: Command) => {
      const ctx = contextFor(command);
      const path = editableConfigPath({ command, global: options.global });
      if (existsSync(path) && options.force !== true) {
        throw new Error(`${path} already exists (pass --force to replace it)`);
      }
      writeRouterConfig(path, DEFAULT_ROUTER_CONFIG);
      if (ctx.json) ctx.emit({ path, created: true });
      else ctx.presenter.success(`created ${path}`);
    });

  config
    .command("edit")
    .description("edit and atomically validate the router config")
    .option("--global", "edit the global config")
    .action((options: { global?: boolean }, command: Command) => {
      const ctx = contextFor(command);
      if (ctx.json) {
        throw new Error("`config edit` is interactive and does not support --json");
      }
      const path =
        options.global === true
          ? editableConfigPath({ command, global: true })
          : loaded(command).path;
      if (!existsSync(path)) {
        throw new Error(`${path} does not exist; run \`routekit config init\``);
      }
      const directory = mkdtempSync(join(tmpdir(), "routekit-config-"));
      const temporary = join(directory, "router.yaml");
      try {
        writeFileSync(temporary, readFileSync(path, "utf8"), { mode: 0o600 });
        const editor = process.env.EDITOR ?? process.env.VISUAL;
        if (editor === undefined || editor.length === 0) {
          throw new Error("set EDITOR or VISUAL before running config edit");
        }
        const result = spawnSync(editor, [temporary], { stdio: "inherit" });
        if (result.error !== undefined) throw result.error;
        if (result.status !== 0) throw new Error(`${editor} exited with status ${result.status}`);
        const edited = parseYaml(readFileSync(temporary, "utf8")) as unknown;
        if (options.global === true) {
          updateRouterConfig(path, (draft) => replaceRecord(draft, edited));
        } else {
          updateEffectiveRouterConfig(
            { configPath: configOverride(command) },
            (draft) => replaceRecord(draft, edited)
          );
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
      ctx.presenter.success(`updated ${path}`);
    });

  config
    .command("migrate")
    .description("explicitly import legacy subscription state")
    .action((_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const actions = migrateLegacyState();
      if (ctx.json) {
        ctx.emit({ actions });
        return;
      }
      if (actions.length === 0) {
        ctx.presenter.note("no legacy subscription state found");
        return;
      }
      for (const action of actions) {
        ctx.presenter.status(
          action.action === "copied" ? "ok" : "pending",
          action.action,
          `${action.source} -> ${action.destination}`
        );
      }
    });
}
