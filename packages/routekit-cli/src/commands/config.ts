import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { contextFor } from "@routekit/cli-core";
import type { Command } from "commander";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  DEFAULT_ROUTER_CONFIG,
  globalRouterConfigPath,
  migrateLegacyState,
  migrateLegacyRouterConfig,
  writeRouterConfig
} from "../config.js";
import { ensureDaemon, readDaemonRecord, routekitClient } from "../client.js";

import { configOverride } from "./context.js";

export function registerConfig(program: Command): void {
  const config = program.command("config").description("manage router configuration");

  config
    .command("path")
    .description("print the canonical singleton router config path")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      if (configOverride(command) !== undefined) {
        throw new Error(
          "--config is not supported by daemon-backed commands; use `routekit config import --from <path>`"
        );
      }
      const path = (await (await routekitClient()).call("config.get", {})).path;
      if (ctx.json) ctx.emit({ path, exists: existsSync(path) });
      else process.stdout.write(`${path}\n`);
    });

  config
    .command("show")
    .description("show the validated effective router config")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const result = await (await routekitClient()).call("config.get", {});
      if (ctx.json) {
        ctx.emit({
          path: result.path,
          revision: result.revision,
          sources: result.sources,
          config: parseYaml(result.document)
        });
      } else process.stdout.write(result.document);
    });

  config
    .command("init")
    .description("create a safe router config template")
    .option("--global", "write the global config")
    .option("--force", "replace an existing config")
    .action(async (options: { global?: boolean; force?: boolean }, command: Command) => {
      const ctx = contextFor(command);
      const path = globalRouterConfigPath();
      if (existsSync(path) && options.force !== true) {
        throw new Error(`${path} already exists (pass --force to replace it)`);
      }
      if (readDaemonRecord() !== undefined && existsSync(path)) {
        const client = await routekitClient();
        const current = await client.call("config.get", {});
        await client.call(
          "config.update",
          {
            expectedRevision: current.revision,
            document: stringifyYaml(DEFAULT_ROUTER_CONFIG)
          },
          { idempotencyKey: `config-init-${current.revision}` }
        );
      } else {
        // Bootstrap/recovery exception: there cannot be a daemon until its
        // canonical config exists.
        writeRouterConfig(path, DEFAULT_ROUTER_CONFIG);
        await ensureDaemon({ configPath: path });
      }
      if (ctx.json) ctx.emit({ path, created: true });
      else ctx.presenter.success(`created ${path}`);
    });

  config
    .command("edit")
    .description("edit and atomically validate the router config")
    .option("--global", "edit the global config")
    .action(async (_options: { global?: boolean }, command: Command) => {
      const ctx = contextFor(command);
      if (ctx.json) {
        throw new Error("`config edit` is interactive and does not support --json");
      }
      const client = await routekitClient();
      const snapshot = await client.call("config.get", {});
      const path = snapshot.path;
      const directory = mkdtempSync(join(tmpdir(), "routekit-config-"));
      const temporary = join(directory, "router.yaml");
      try {
        writeFileSync(temporary, snapshot.document, { mode: 0o600 });
        const editor = process.env.EDITOR ?? process.env.VISUAL;
        if (editor === undefined || editor.length === 0) {
          throw new Error("set EDITOR or VISUAL before running config edit");
        }
        const result = spawnSync(editor, [temporary], { stdio: "inherit" });
        if (result.error !== undefined) throw result.error;
        if (result.status !== 0) throw new Error(`${editor} exited with status ${result.status}`);
        const editedDocument = readFileSync(temporary, "utf8");
        // Parse client-side for immediate syntax feedback; the daemon performs
        // authoritative schema validation and transactional router reload.
        parseYaml(editedDocument);
        await client.call(
          "config.update",
          { expectedRevision: snapshot.revision, document: editedDocument },
          { idempotencyKey: `config-edit-${snapshot.revision}` }
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
      ctx.presenter.success(`updated ${path}`);
    });

  config
    .command("import")
    .description("import a router file into the canonical singleton config")
    .requiredOption("--from <path>", "router YAML to import")
    .action(async (options: { from: string }, command: Command) => {
      const ctx = contextFor(command);
      const source = resolve(options.from);
      if (!existsSync(source)) throw new Error(`router config not found: ${source}`);
      const document = readFileSync(source, "utf8");
      parseYaml(document);
      const canonical = globalRouterConfigPath();
      let revision: number;
      if (!existsSync(canonical) && readDaemonRecord() === undefined) {
        // Bootstrap/recovery exception; validation still goes through the
        // public config writer before the daemon is started.
        writeRouterConfig(canonical, parseYaml(document));
        const started = await ensureDaemon({ configPath: canonical });
        revision = (await started.client.call("config.get", {})).revision;
      } else {
        const client = await routekitClient();
        const current = await client.call("config.get", {});
        const imported = await client.call(
          "config.import",
          {
            expectedRevision: current.revision,
            document,
            source
          },
          { idempotencyKey: `config-import-${current.revision}` }
        );
        revision = imported.revision;
      }
      if (ctx.json) ctx.emit({ imported: true, source, path: canonical, revision });
      else ctx.presenter.success(`imported ${source} into ${canonical}`);
    });

  config
    .command("migrate")
    .description("convert legacy endpoint/account config and import subscription state")
    .option("--dry-run", "diagnose and print the conversion without writing")
    .action(async (options: { dryRun?: boolean }, command: Command) => {
      const ctx = contextFor(command);
      const override = configOverride(command);
      const path = override ?? globalRouterConfigPath();
      if (!existsSync(path)) {
        throw new Error(`router config not found: ${path}`);
      }
      const migration = migrateLegacyRouterConfig(path, {
        write: options.dryRun !== true
      });
      const hasErrors = migration.diagnostics.some(
        (diagnostic) => diagnostic.level === "error"
      );
      const actions =
        hasErrors || options.dryRun === true ? [] : migrateLegacyState();
      if (
        override === undefined &&
        !hasErrors &&
        options.dryRun !== true &&
        migration.changed
      ) {
        const client = await routekitClient();
        await client.call(
          "daemon.reload",
          {},
          { idempotencyKey: `legacy-migrate-${Date.now()}` }
        );
      }
      if (ctx.json) {
        ctx.emit({ migration, actions, dryRun: options.dryRun === true });
        if (hasErrors) process.exitCode = 1;
        return;
      }
      for (const diagnostic of migration.diagnostics) {
        ctx.presenter.status(
          diagnostic.level === "error" ? "fail" : "pending",
          diagnostic.code,
          diagnostic.message
        );
      }
      if (migration.changed) {
        if (options.dryRun === true) {
          ctx.presenter.note(`legacy config at ${path} is convertible`);
        } else {
          ctx.presenter.success(`converted legacy config at ${path}`);
          if (migration.backupPath !== undefined) {
            ctx.presenter.note(`backup: ${migration.backupPath}`);
          }
        }
      } else if (!migration.legacy && !hasErrors) {
        ctx.presenter.note("router config already uses providers");
      }
      for (const action of actions) {
        ctx.presenter.status(
          action.action === "copied" ? "ok" : "pending",
          action.action,
          `${action.source} -> ${action.destination}`
        );
      }
      if (actions.length === 0 && !hasErrors && options.dryRun !== true) {
        ctx.presenter.note("no legacy subscription state found");
      }
      if (hasErrors) process.exitCode = 1;
    });
}
