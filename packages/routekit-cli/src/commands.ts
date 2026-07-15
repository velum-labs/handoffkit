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

import {
  attachGlobalFlags,
  contextFor,
  parsePort,
  probeBinaryVersion,
  registerCompletion
} from "@routekit/cli-core";
import {
  CLIPROXY_API_KEY_ENV,
  CLIPROXY_LOGIN_FLAGS,
  CLIPROXY_PINNED_VERSION,
  cliproxyApiKey,
  cliproxyBaseUrl,
  cliproxyConfigPath,
  cliproxyStatus,
  installCliproxy,
  runCliproxyLogin,
  spawnCliproxy
} from "@routekit/accounts";
import { probeEndpointHealth } from "@routekit/gateway";
import { commandOnPath, trimTrailingSlashes } from "@routekit/runtime";
import {
  installCodexIntegration,
  uninstallCodexIntegration
} from "@routekit/tool-codex";
import type { CodexInstallOwner } from "@routekit/tool-codex";
import { Command } from "commander";
import { stringify as stringifyYaml } from "yaml";

import {
  accountsStatus,
  addAccount,
  listAccounts,
  removeAccount,
  serveAccounts,
  stopAccounts
} from "./accounts.js";
import {
  DEFAULT_ROUTER_CONFIG,
  findProjectRouterConfig,
  globalRouterConfigPath,
  loadRouterConfig,
  migrateLegacyState,
  projectRouterConfigPath,
  routerConfigPaths,
  updateRouterConfig,
  writeRouterConfig
} from "./config.js";
import { registerDynamicCompletion } from "./completion.js";
import { launchTool, routekitToolRegistry } from "./launch.js";
import { startRouter, waitForShutdown } from "./serve.js";
import { stopAllServices, writeStateSnapshot } from "./state.js";
import {
  disableTelemetry,
  enableTelemetry,
  resolveTelemetry,
  TELEMETRY_FIELDS,
  telemetryPath
} from "./telemetry.js";

type ConfigGlobalOptions = { config?: string };

function configOverride(command: Command): string | undefined {
  return command.optsWithGlobals<ConfigGlobalOptions>().config;
}

function editableConfigPath(input: {
  command: Command;
  global?: boolean;
  cwd?: string;
}): string {
  const override = configOverride(input.command) ?? process.env.ROUTEKIT_CONFIG;
  if (override !== undefined && override.length > 0) return resolve(override);
  if (input.global === true) return globalRouterConfigPath();
  return findProjectRouterConfig(input.cwd) ?? projectRouterConfigPath(input.cwd);
}

function loaded(command: Command) {
  return loadRouterConfig({ configPath: configOverride(command) });
}

function numberOption(
  value: string,
  label: string,
  input: { min: number; max: number }
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < input.min || parsed > input.max) {
    throw new Error(`${label} must be between ${input.min} and ${input.max}`);
  }
  return parsed;
}

function registerServe(program: Command): void {
  program
    .command("serve")
    .description("serve the configured model router in the foreground")
    .option("--host <host>", "bind host", "127.0.0.1")
    .option("--port <port>", "bind port", "8080")
    .option("--auth-token <token>", "require a bearer or x-api-key token")
    .option("--no-portless", "disable the stable local route")
    .action(
      async (
        options: {
          host: string;
          port: string;
          authToken?: string;
          portless?: boolean;
        },
        command: Command
      ) => {
        const ctx = contextFor(command);
        const result = loaded(command);
        const running = await startRouter({
          config: result.config,
          host: options.host,
          port: parsePort(options.port, 8080),
          ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
          ...(options.portless !== undefined ? { portless: options.portless } : {})
        });
        if (ctx.json) {
          ctx.emit({
            url: running.url,
            port: running.gateway.port(),
            config: result.path,
            authenticated: options.authToken !== undefined
          });
        } else {
          ctx.presenter.success(`RouteKit gateway listening at ${running.url}`);
          ctx.presenter.note(`config: ${result.path}`);
          ctx.presenter.note("Press Ctrl+C to stop.");
        }
        await waitForShutdown();
      }
    );
}

function registerLaunchers(program: Command): void {
  for (const integration of routekitToolRegistry.list()) {
    const command = program
      .command(integration.id)
      .description(`launch ${integration.displayName} through RouteKit`)
      .argument("[model]", "configured endpoint id")
      .argument("[toolArgs...]", `arguments passed to ${integration.displayName}`)
      .option("--gateway-url <url>", "connect to an existing RouteKit gateway")
      .option("--host <host>", "embedded gateway bind host", "127.0.0.1")
      .option("--port <port>", "embedded gateway bind port", "0")
      .option("--auth-token <token>", "gateway authentication token")
      .option("--cwd <dir>", "tool working directory");
    if (integration.id === "cursor") {
      command.option("--ide", "launch the desktop integration");
    }
    command.action(
        async (
          model: string | undefined,
          toolArgs: string[],
          options: {
            gatewayUrl?: string;
            host: string;
            port: string;
            authToken?: string;
            cwd?: string;
            ide?: boolean;
          },
          actionCommand: Command
        ) => {
          const config = loaded(actionCommand).config;
          process.exitCode = await launchTool({
            tool: integration.id,
            config,
            ...(options.gatewayUrl !== undefined
              ? { gatewayUrl: trimTrailingSlashes(options.gatewayUrl) }
              : {}),
            ...(model !== undefined ? { model } : {}),
            args: toolArgs,
            ...(options.cwd !== undefined ? { cwd: resolve(options.cwd) } : {}),
            ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
            host: options.host,
            port: parsePort(options.port, 0),
            ...(integration.id === "cursor" && options.ide !== undefined
              ? { ide: options.ide }
              : {})
          });
        }
      );
  }
}

function registerConfig(program: Command): void {
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
      const path = editableConfigPath({ command, global: options.global });
      if (!existsSync(path)) throw new Error(`${path} does not exist; run \`routekit config init\``);
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
        const validated = loadRouterConfig({ configPath: temporary }).config;
        writeRouterConfig(path, validated);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
      if (ctx.json) ctx.emit({ path, updated: true });
      else ctx.presenter.success(`updated ${path}`);
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

function registerEndpoints(program: Command): void {
  const endpoints = program.command("endpoints").description("manage configured endpoints");

  endpoints
    .command("list")
    .description("list opaque endpoint ids")
    .action((_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const entries = loaded(command).config.endpoints;
      if (ctx.json) {
        ctx.emit({ endpoints: entries });
        return;
      }
      ctx.presenter.table(
        entries.map((entry) => [
          entry.endpointId,
          entry.provider ?? "custom",
          entry.dialect,
          entry.baseUrl,
          entry.apiKeyEnv ?? "none"
        ]),
        { head: ["id", "provider", "dialect", "base URL", "credential env"] }
      );
    });

  endpoints
    .command("add <id>")
    .description("add an endpoint using an environment credential reference")
    .requiredOption("--model <model>", "upstream model id")
    .requiredOption("--base-url <url>", "upstream API base URL")
    .option("--provider <provider>", "provider label")
    .option("--dialect <dialect>", "openai | anthropic | google | codex", "openai")
    .option("--api-key-env <name>", "environment variable holding the credential")
    .option("--instance-id <id>", "pool instance id")
    .option("--default", "make this endpoint the default")
    .action(
      (
        id: string,
        options: {
          model: string;
          baseUrl: string;
          provider?: string;
          dialect: string;
          apiKeyEnv?: string;
          instanceId?: string;
          default?: boolean;
        },
        command: Command
      ) => {
        const path = editableConfigPath({ command });
        const current = loadRouterConfig({ configPath: path }).config;
        if (
          options.instanceId === undefined &&
          current.endpoints.some((entry) => entry.endpointId === id)
        ) {
          throw new Error(`endpoint already exists: ${id} (use --instance-id for a pool member)`);
        }
        const next = {
          ...current,
          endpoints: [
            ...current.endpoints,
            {
              endpointId: id,
              model: options.model,
              baseUrl: options.baseUrl,
              dialect: options.dialect,
              ...(options.provider !== undefined ? { provider: options.provider } : {}),
              ...(options.apiKeyEnv !== undefined ? { apiKeyEnv: options.apiKeyEnv } : {}),
              ...(options.instanceId !== undefined ? { instanceId: options.instanceId } : {})
            }
          ],
          ...(options.default === true ? { defaultEndpointId: id } : {})
        };
        writeRouterConfig(path, next);
        const ctx = contextFor(command);
        if (ctx.json) ctx.emit({ path, endpointId: id, added: true });
        else ctx.presenter.success(`added ${id} to ${path}`);
      }
    );

  endpoints
    .command("remove <id>")
    .description("remove an endpoint and all of its pool members")
    .action((id: string, _options: unknown, command: Command) => {
      const path = editableConfigPath({ command });
      const next = updateRouterConfig(path, (draft) => {
        const entries = Array.isArray(draft.endpoints) ? draft.endpoints : [];
        const filtered = entries.filter(
          (entry) =>
            typeof entry !== "object" ||
            entry === null ||
            (entry as { endpointId?: unknown }).endpointId !== id
        );
        if (filtered.length === entries.length) throw new Error(`endpoint not found: ${id}`);
        draft.endpoints = filtered;
        if (draft.defaultEndpointId === id) {
          const first = filtered[0] as { endpointId?: unknown } | undefined;
          if (typeof first?.endpointId === "string") draft.defaultEndpointId = first.endpointId;
          else delete draft.defaultEndpointId;
        }
      });
      const ctx = contextFor(command);
      if (ctx.json) ctx.emit({ path, endpointId: id, removed: true, config: next });
      else ctx.presenter.success(`removed ${id} from ${path}`);
    });

  endpoints
    .command("health [id]")
    .description("probe endpoint model discovery without printing credentials")
    .action(async (id: string | undefined, _options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const config = loaded(command).config;
      const entries = config.endpoints.filter(
        (entry) => id === undefined || entry.endpointId === id
      );
      if (entries.length === 0) throw new Error(`endpoint not found: ${id}`);
      const results = await Promise.all(
        entries.map(async (entry) => {
          const credential =
            entry.apiKeyEnv !== undefined
              ? process.env[entry.apiKeyEnv] ??
                (entry.apiKeyEnv === CLIPROXY_API_KEY_ENV ? cliproxyApiKey() : undefined)
              : undefined;
          return {
            endpointId: entry.endpointId,
            ...(entry.instanceId !== undefined ? { instanceId: entry.instanceId } : {}),
            ...(await probeEndpointHealth(entry, { credential }))
          };
        })
      );
      writeStateSnapshot("health", "endpoints", {
        checkedAt: new Date().toISOString(),
        endpoints: results
      });
      if (ctx.json) ctx.emit({ endpoints: results });
      else {
        for (const result of results) {
          switch (result.kind) {
            case "response":
              ctx.presenter.status(
                result.ok ? "ok" : "fail",
                result.endpointId,
                `HTTP ${result.status}${result.authRejected ? " (credential rejected)" : ""}`
              );
              break;
            case "unsupported":
              ctx.presenter.status("pending", result.endpointId, result.reason);
              break;
            case "error":
              ctx.presenter.status("fail", result.endpointId, result.error);
              break;
            default: {
              const exhaustive: never = result;
              throw new Error(`unknown health result: ${String(exhaustive)}`);
            }
          }
        }
      }
      if (
        results.some(
          (result) =>
            result.kind === "error" || (result.kind === "response" && !result.ok)
        )
      ) {
        process.exitCode = 1;
      }
    });
}

function registerModels(program: Command): void {
  program
    .command("models")
    .description("inspect models")
    .command("list", { isDefault: true })
    .description("list configured opaque model ids")
    .action((_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const config = loaded(command).config;
      const models = [...new Set(config.endpoints.map((entry) => entry.endpointId))];
      writeStateSnapshot("catalog", "models", {
        updatedAt: new Date().toISOString(),
        defaultModel: config.defaultEndpointId ?? models[0],
        models
      });
      if (ctx.json) ctx.emit({ defaultModel: config.defaultEndpointId ?? models[0], models });
      else for (const model of models) process.stdout.write(`${model}\n`);
    });
}

function registerAccounts(program: Command): void {
  const accounts = program.command("accounts").description("manage pooled provider subscriptions");

  accounts
    .command("add <provider>")
    .description("enroll the current official CLI login")
    .option("--name <name>", "account label")
    .action(async (provider: string, options: { name?: string }, command: Command) => {
      const ctx = contextFor(command);
      const result = await addAccount(provider, options.name);
      if (ctx.json) ctx.emit(result);
      else ctx.presenter.success(`enrolled ${result.provider} account at ${result.path}`);
    });

  accounts
    .command("remove <provider> <name>")
    .description("remove an enrolled account from RouteKit-managed state")
    .action((provider: string, name: string, _options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const result = removeAccount(provider, name);
      if (ctx.json) {
        ctx.emit(result);
      } else if (result.removed) {
        ctx.presenter.success(`removed ${result.mode}/${result.label}`);
      } else {
        ctx.presenter.note(`${result.mode}/${result.label} is not enrolled`);
      }
    });

  accounts
    .command("list")
    .description("list enrolled accounts without reading credential values")
    .action((_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const entries = listAccounts();
      if (ctx.json) ctx.emit({ accounts: entries });
      else ctx.presenter.table(entries.map((entry) => [entry.provider, entry.label, entry.path]));
    });

  accounts
    .command("status")
    .description("show account proxy and pooled account status")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const status = await accountsStatus();
      if (ctx.json) {
        ctx.emit(status);
        return;
      }
      ctx.presenter.status(status.running ? "ok" : "pending", "accounts proxy", status.running ? status.url : "not running");
      for (const entry of status.accounts) {
        ctx.presenter.status("ok", `${entry.provider}/${entry.label}`, "enrolled");
      }
    });

  accounts
    .command("serve")
    .description("serve pooled Claude and Codex subscriptions in the foreground")
    .option("--host <host>", "bind host", "127.0.0.1")
    .option("--port <port>", "bind port", "8790")
    .option("--strategy <strategy>", "sticky | round_robin | capacity_weighted", "sticky")
    .option("--switch-threshold <ratio>", "proactive utilization threshold", "0.9")
    .option("--probe-interval <seconds>", "usage poll interval", "0")
    .option("--no-portless", "disable the stable local route")
    .action(
      async (
        options: {
          host: string;
          port: string;
          strategy: "sticky" | "round_robin" | "capacity_weighted";
          switchThreshold: string;
          probeInterval: string;
          portless?: boolean;
        },
        command: Command
      ) => {
        const ctx = contextFor(command);
        const probeSeconds = numberOption(options.probeInterval, "probe interval", {
          min: 0,
          max: 86_400
        });
        const running = await serveAccounts({
          host: options.host,
          port: parsePort(options.port, 8790),
          strategy: options.strategy,
          switchThreshold: numberOption(options.switchThreshold, "switch threshold", {
            min: 0.01,
            max: 1
          }),
          ...(probeSeconds > 0 ? { probeIntervalMs: probeSeconds * 1000 } : {}),
          ...(process.env.ROUTEKIT_ACCOUNTS_TOKEN !== undefined
            ? { token: process.env.ROUTEKIT_ACCOUNTS_TOKEN }
            : {}),
          ...(options.portless !== undefined ? { portless: options.portless } : {})
        });
        if (ctx.json) ctx.emit({ url: running.url, providers: running.providers });
        else {
          ctx.presenter.success(`accounts proxy listening at ${running.url}`);
          ctx.presenter.note("The ingress token is stored privately and is never printed.");
          ctx.presenter.note("Press Ctrl+C to stop.");
        }
        await waitForShutdown();
      }
    );

  accounts
    .command("stop")
    .description("stop the RouteKit-owned account proxy")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const result = await stopAccounts();
      if (ctx.json) ctx.emit(result);
      else if (result.stopped) ctx.presenter.success("stopped the accounts proxy");
      else ctx.presenter.note("accounts proxy is not running");
    });

  const cliproxy = accounts
    .command("cliproxy")
    .description("manage the RouteKit-owned CLIProxyAPI OAuth account pool");

  cliproxy
    .command("install")
    .description(`download and verify CLIProxyAPI v${CLIPROXY_PINNED_VERSION}`)
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const result = await installCliproxy({
        onProgress: (line) => {
          if (!ctx.json) ctx.presenter.note(line);
        }
      });
      if (ctx.json) {
        ctx.emit(result);
        return;
      }
      ctx.presenter.success(
        `${result.downloaded ? "installed" : "found"} CLIProxyAPI v${result.version} at ${result.binary}`
      );
      ctx.presenter.note(`config: ${result.configPath}`);
      ctx.presenter.note(
        `The ingress credential stays in that private config; ${CLIPROXY_API_KEY_ENV} may override it.`
      );
    });

  cliproxy
    .command("login <provider>")
    .description(`OAuth an account (${Object.keys(CLIPROXY_LOGIN_FLAGS).join(", ")})`)
    .option("--no-browser", "print the OAuth URL instead of opening a browser")
    .action(
      async (
        provider: string,
        options: { browser?: boolean },
        command: Command
      ) => {
        const ctx = contextFor(command);
        const code = await runCliproxyLogin(provider, {
          noBrowser: options.browser === false
        });
        if (code === 0) ctx.presenter.success(`${provider} account added`);
        process.exitCode = code;
      }
    );

  cliproxy
    .command("serve")
    .description("run the managed CLIProxyAPI in the foreground")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const child = spawnCliproxy();
      if (ctx.json) {
        ctx.emit({
          url: cliproxyBaseUrl(),
          configPath: cliproxyConfigPath(),
          pid: child.pid ?? null
        });
      } else {
        ctx.presenter.success(`CLIProxyAPI listening at ${cliproxyBaseUrl()}`);
        ctx.presenter.note(`config: ${cliproxyConfigPath()}`);
        ctx.presenter.note("Press Ctrl+C to stop.");
      }
      process.exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 0));
      });
    });

  cliproxy
    .command("status")
    .description("show install, reachability, model count, and enrolled account files")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const status = await cliproxyStatus();
      if (ctx.json) {
        ctx.emit(status);
        return;
      }
      ctx.presenter.status(status.installed ? "ok" : "pending", "installed", status.installed ? `v${status.version}` : "no");
      ctx.presenter.status(
        status.reachable && status.keyRejected !== true ? "ok" : "pending",
        "endpoint",
        status.reachable
          ? status.keyRejected === true
            ? "reachable; credential rejected"
            : `${status.models ?? 0} model(s)`
          : "not reachable"
      );
      ctx.presenter.note(`URL: ${status.baseUrl}`);
      ctx.presenter.note(`accounts: ${status.accounts.length > 0 ? status.accounts.join(", ") : "none"}`);
    });
}

function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("check config, credentials, and coding-agent binaries")
    .action((_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const checks: Array<{ label: string; ok: boolean; detail?: string }> = [];
      try {
        const result = loaded(command);
        checks.push({ label: "router config", ok: true, detail: result.path });
        for (const name of new Set(
          result.config.endpoints
            .map((entry) => entry.apiKeyEnv)
            .filter((entry): entry is string => entry !== undefined)
        )) {
          checks.push({
            label: name,
            ok: process.env[name] !== undefined && process.env[name]!.length > 0,
            detail: process.env[name] !== undefined ? "set" : "not set"
          });
        }
      } catch (error) {
        checks.push({
          label: "router config",
          ok: false,
          detail: error instanceof Error ? error.message : String(error)
        });
      }
      for (const tool of routekitToolRegistry.list()) {
        if (tool.binary === undefined) continue;
        const ok = commandOnPath(tool.binary);
        checks.push({
          label: tool.binary,
          ok,
          ...(ok ? { detail: probeBinaryVersion(tool.binary) ?? "installed" } : {})
        });
      }
      if (ctx.json) ctx.emit({ ready: checks.every((check) => check.ok), checks });
      else {
        for (const check of checks) {
          ctx.presenter.status(check.ok ? "ok" : "fail", check.label, check.detail);
        }
      }
      if (checks.some((check) => !check.ok)) process.exitCode = 1;
    });
}

const CODEX_OWNER: CodexInstallOwner = {
  id: "routekit",
  displayName: "RouteKit",
  providerId: "routekit",
  installCommand: "routekit install codex",
  uninstallCommand: "routekit uninstall codex",
  startCommand: "routekit serve"
};

function assertCodex(tool: string): void {
  if (tool !== "codex") throw new Error("supported install target: codex");
}

function codexProfileId(modelId: string, index: number): string {
  return modelId.length > 0 &&
    !modelId.includes("/") &&
    !modelId.includes("\\") &&
    !modelId.startsWith(".")
    ? modelId
    : `routekit-endpoint-${index + 1}`;
}

function registerInstall(program: Command): void {
  program
    .command("install <tool>")
    .description("install a RouteKit-owned provider and profiles")
    .requiredOption("--gateway-url <url>", "running gateway URL")
    .option("--codex-home <dir>", "Codex home directory")
    .action(
      (
        tool: string,
        options: { gatewayUrl: string; codexHome?: string },
        command: Command
      ) => {
        assertCodex(tool);
        const ctx = contextFor(command);
        const config = loaded(command).config;
        const ids = [...new Set(config.endpoints.map((entry) => entry.endpointId))];
        const result = installCodexIntegration({
          gatewayUrl: trimTrailingSlashes(options.gatewayUrl),
          profiles: ids.map((modelId, index) => ({
            modelId,
            profileId: codexProfileId(modelId, index)
          })),
          owner: CODEX_OWNER,
          ...(options.codexHome !== undefined ? { codexHome: options.codexHome } : {})
        });
        if (ctx.json) ctx.emit(result);
        else ctx.presenter.success(`${result.action} RouteKit in ${result.configPath}`);
      }
    );

  program
    .command("uninstall <tool>")
    .description("remove RouteKit-owned tool configuration")
    .option("--codex-home <dir>", "Codex home directory")
    .action((tool: string, options: { codexHome?: string }, command: Command) => {
      assertCodex(tool);
      const ctx = contextFor(command);
      const result = uninstallCodexIntegration({
        ownerId: CODEX_OWNER.id,
        ...(options.codexHome !== undefined ? { codexHome: options.codexHome } : {})
      });
      if (ctx.json) ctx.emit(result);
      else if (result.removed) ctx.presenter.success(`removed RouteKit from ${result.configPath}`);
      else ctx.presenter.note(`no RouteKit block found in ${result.configPath}`);
    });
}

function registerTelemetryCommand(program: Command): void {
  const telemetry = program
    .command("telemetry")
    .description("inspect and control anonymous telemetry");
  telemetry
    .command("status", { isDefault: true })
    .action((_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const decision = resolveTelemetry();
      const result = {
        enabled: decision.enabled,
        source: decision.source,
        installId: decision.installId ?? null,
        path: telemetryPath(),
        fields: TELEMETRY_FIELDS
      };
      if (ctx.json) ctx.emit(result);
      else {
        ctx.presenter.status(decision.enabled ? "ok" : "pending", "telemetry", decision.enabled ? "on" : "off");
        ctx.presenter.note(`decided by: ${decision.source}`);
      }
    });
  telemetry.command("on").action((_options: unknown, command: Command) => {
    const ctx = contextFor(command);
    const result = enableTelemetry();
    if (ctx.json) ctx.emit({ enabled: true, installId: result.installId });
    else ctx.presenter.success("telemetry enabled");
  });
  telemetry.command("off").action((_options: unknown, command: Command) => {
    const ctx = contextFor(command);
    disableTelemetry();
    if (ctx.json) ctx.emit({ enabled: false });
    else ctx.presenter.success("telemetry disabled");
  });
}

export function registerCommands(program: Command): void {
  attachGlobalFlags(program);
  program.option("--config <path>", "router config path (overrides project and global config)");
  registerServe(program);
  registerLaunchers(program);
  registerAccounts(program);
  registerEndpoints(program);
  registerModels(program);
  registerConfig(program);
  registerDoctor(program);
  registerInstall(program);
  program
    .command("stop")
    .description("stop only RouteKit-owned services")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const results = await stopAllServices();
      if (ctx.json) ctx.emit({ services: results });
      else {
        const stopped = results.filter((result) => result.stopped).length;
        if (stopped > 0) ctx.presenter.success(`stopped ${stopped} RouteKit service(s)`);
        else ctx.presenter.note("no RouteKit services are running");
      }
    });
  registerTelemetryCommand(program);
  registerCompletion(program, "routekit");
  registerDynamicCompletion(program);
}
