import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { contextFor } from "@velum-labs/routekit-cli-core";
import {
  parseRouterConfig,
  type RouterConfig
} from "@velum-labs/routekit-gateway";
import { catalogDefaultModel } from "@velum-labs/routekit-registry";
import { acquireLifecycleLock } from "@velum-labs/routekit-runtime";
import { Option, type Command } from "commander";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  DEFAULT_ROUTER_CONFIG,
  globalRouterConfigPath,
  migrateLegacyState,
  migrateLegacyRouterConfig,
  writeRouterConfig
} from "../config.js";
import {
  connectDaemon,
  daemonLifecycleLockPath,
  ensureDaemon,
  readDaemonRecord,
  routekitClient
} from "../client.js";
import { missingServiceCredentialVariables } from "../daemon.js";
import type { LaunchProviderId } from "../launch-support.js";

import { configOverride } from "./context.js";

export const CONFIG_INIT_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "openrouter"
] as const satisfies readonly LaunchProviderId[];

export type ConfigInitProviderId = (typeof CONFIG_INIT_PROVIDER_IDS)[number];

export function configInitRouterConfig(input: {
  provider?: ConfigInitProviderId;
  empty?: boolean;
} = {}): RouterConfig {
  if (input.empty === true) return parseRouterConfig({ providers: {} });
  const provider = input.provider ?? "openai";
  const defaultModel = catalogDefaultModel(provider);
  if (defaultModel === undefined) {
    throw new Error(`no default model is registered for ${provider}`);
  }
  return parseRouterConfig({
    providers: { [provider]: {} },
    defaultModel: `${provider}/${defaultModel}`
  });
}

export function configImportIdempotencyKey(input: {
  revision: number;
  document: string;
  source: string;
}): string {
  const fingerprint = createHash("sha256")
    .update(String(input.revision))
    .update("\0")
    .update(input.source)
    .update("\0")
    .update(input.document)
    .digest("hex")
    .slice(0, 24);
  return `config-import-${input.revision}-${fingerprint}`;
}

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
    .description("show the validated canonical singleton router config")
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

  const init = config
    .command("init")
    .description("create the canonical singleton router config")
    .addOption(new Option("--global").hideHelp())
    .addOption(
      new Option(
        "--provider <provider>",
        "API provider starter (openai, anthropic, or openrouter)"
      )
        .choices([...CONFIG_INIT_PROVIDER_IDS])
        .conflicts("empty")
    )
    .addOption(
      new Option(
        "--empty",
        "create an empty config before logging in a subscription account"
      ).conflicts("provider")
    )
    .option("--force", "replace an existing config");

  init.addHelpText(
    "after",
    [
      "",
      "Provider credentials:",
      "  openai      OPENAI_API_KEY",
      "  anthropic   ANTHROPIC_API_KEY",
      "  openrouter  OPENROUTER_API_KEY",
      "",
      "With --empty, run `routekit accounts login claude-code --name <label>` or use `codex`."
    ].join("\n")
  );

  init.action(
    async (
      options: {
        provider?: ConfigInitProviderId;
        empty?: boolean;
        force?: boolean;
      },
      command: Command
    ) => {
      const ctx = contextFor(command);
      const path = globalRouterConfigPath();
      const starterConfig =
        options.provider === undefined && options.empty !== true
          ? DEFAULT_ROUTER_CONFIG
          : configInitRouterConfig(options);
      const missingCredentials = missingServiceCredentialVariables(starterConfig);
      if (existsSync(path) && options.force !== true) {
        throw new Error(`${path} already exists (pass --force to replace it)`);
      }
      if (readDaemonRecord() === undefined) {
        const lock = await acquireLifecycleLock(daemonLifecycleLockPath(), {
          timeoutMs: 90_000
        });
        let bootstrapped = false;
        try {
          if (readDaemonRecord() === undefined) {
            if (existsSync(path) && options.force !== true) {
              throw new Error(`${path} already exists (pass --force to replace it)`);
            }
            writeRouterConfig(path, starterConfig);
            if (missingCredentials.length === 0) {
              await ensureDaemon({
                configPath: path,
                lifecycleLockHeld: true
              });
            }
            bootstrapped = true;
          }
        } finally {
          lock.release();
        }
        if (bootstrapped) {
          if (ctx.json) {
            ctx.emit({
              path,
              created: true,
              ...(missingCredentials.length > 0
                ? {
                    daemonStarted: false,
                    missingCredentials
                  }
                : {})
            });
          } else {
            ctx.presenter.success(`created ${path}`);
            if (missingCredentials.length > 0) {
              ctx.presenter.warn(
                `daemon not started: set ${missingCredentials.join(" or ")}`
              );
              ctx.presenter.note("then run `routekit start`");
            }
          }
          return;
        }
      }
      if (existsSync(path) && options.force !== true) {
        throw new Error(`${path} already exists (pass --force to replace it)`);
      }
      const client = (await connectDaemon())?.client ?? await routekitClient();
      const current = await client.call("config.get", {});
      if (resolve(current.path) !== resolve(path)) {
        throw new Error(
          `RouteKit is running with foreground config ${current.path}; ` +
            "stop it before replacing the canonical singleton config"
        );
      }
      await client.call(
        "config.update",
        {
          expectedRevision: current.revision,
          document: stringifyYaml(starterConfig)
        },
        { idempotencyKey: `config-init-${current.revision}` }
      );
      if (ctx.json) ctx.emit({ path, created: true });
      else ctx.presenter.success(`created ${path}`);
    }
  );

  config
    .command("edit")
    .description("edit and atomically validate the canonical singleton router config")
    .addOption(new Option("--global").hideHelp())
    .action(async (_options: unknown, command: Command) => {
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
    .description("validate a router file and replace the canonical singleton config")
    .requiredOption("--from <path>", "router YAML to import as the complete canonical config")
    .action(async (options: { from: string }, command: Command) => {
      const ctx = contextFor(command);
      const source = resolve(options.from);
      if (!existsSync(source)) throw new Error(`router config not found: ${source}`);
      const document = readFileSync(source, "utf8");
      parseYaml(document);
      const canonical = globalRouterConfigPath();
      let revision: number | undefined;
      const replaceThroughDaemon = async (): Promise<number> => {
        const client = (await connectDaemon())?.client ?? await routekitClient();
        const current = await client.call("config.get", {});
        if (resolve(current.path) !== resolve(canonical)) {
          throw new Error(
            `RouteKit is running with foreground config ${current.path}; ` +
              "stop it before importing into the canonical singleton config"
          );
        }
        const imported = await client.call(
          "config.import",
          {
            expectedRevision: current.revision,
            document,
            source
          },
          {
            idempotencyKey: configImportIdempotencyKey({
              revision: current.revision,
              document,
              source
            })
          }
        );
        return imported.revision;
      };
      if (readDaemonRecord() === undefined) {
        const lock = await acquireLifecycleLock(daemonLifecycleLockPath(), {
          timeoutMs: 90_000
        });
        try {
          if (readDaemonRecord() === undefined) {
            // Bootstrap/recovery exception. The lifecycle lock makes the
            // direct write and daemon start one authority transition.
            writeRouterConfig(canonical, parseYaml(document));
            const started = await ensureDaemon({
              configPath: canonical,
              lifecycleLockHeld: true
            });
            revision = (await started.client.call("config.get", {})).revision;
          }
        } finally {
          lock.release();
        }
      }
      if (revision === undefined) {
        revision = await replaceThroughDaemon();
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
      const override = configOverride(command) ?? process.env.ROUTEKIT_CONFIG;
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
