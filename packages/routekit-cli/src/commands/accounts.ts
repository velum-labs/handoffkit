import {
  CLIPROXY_API_KEY_ENV,
  CLIPROXY_LOGIN_FLAGS,
  CLIPROXY_PINNED_VERSION,
  cliproxyBaseUrl,
  cliproxyConfigPath,
  cliproxyStatus,
  installCliproxy,
  runCliproxyLogin,
  spawnCliproxy
} from "@routekit/accounts";
import { contextFor, parsePort } from "@routekit/cli-core";
import type { Command } from "commander";

import {
  accountsStatus,
  addAccount,
  listAccounts,
  loginAccount,
  removeAccount,
  serveAccounts,
  stopAccounts
} from "../accounts.js";
import type { AccountListEntry } from "../accounts.js";
import { updateEffectiveRouterConfig } from "../config.js";
import { waitForShutdown } from "../serve.js";

import { configOverride, loaded, numberOption } from "./context.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function activateAccount(command: Command, result: AccountListEntry): string {
  return updateEffectiveRouterConfig(
    { configPath: configOverride(command) },
    (draft) => {
      const providers = record(draft.providers);
      const policy = record(providers[result.subscriptionKind]);
      draft.providers = {
        ...providers,
        [result.subscriptionKind]: { ...policy }
      };
    }
  ).path;
}

function registerCliproxy(accounts: Command): void {
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
      async (provider: string, options: { browser?: boolean }, command: Command) => {
        const ctx = contextFor(command);
        if (ctx.json) {
          throw new Error(
            "`accounts cliproxy login` is interactive and does not support --json"
          );
        }
        const code = await runCliproxyLogin(provider, {
          noBrowser: options.browser === false
        });
        if (code === 0) {
          ctx.presenter.success(`${provider} account added`);
          ctx.presenter.note("Next: routekit accounts cliproxy serve");
          ctx.presenter.note(
            "Then enable its live model catalog with `routekit providers add cliproxy`."
          );
        }
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
      ctx.presenter.status(
        status.installed ? "ok" : "pending",
        "installed",
        status.installed ? `v${status.version}` : "no"
      );
      ctx.presenter.status(
        status.reachable && status.keyRejected !== true ? "ok" : "pending",
        "proxy API",
        status.reachable
          ? status.keyRejected === true
            ? "reachable; credential rejected"
            : `${status.models ?? 0} model(s)`
          : "not reachable"
      );
      ctx.presenter.note(`URL: ${status.baseUrl}`);
      ctx.presenter.note(
        `accounts: ${status.accounts.length > 0 ? status.accounts.join(", ") : "none"}`
      );
    });
}

export function registerAccounts(program: Command): void {
  const accounts = program.command("accounts").description("manage pooled provider subscriptions");

  accounts
    .command("login <subscription-kind>")
    .description("log in an isolated official CLI profile and enroll it")
    .requiredOption("--name <name>", "account label")
    .action(
      async (
        subscriptionKind: string,
        options: { name: string },
        command: Command
      ) => {
        const ctx = contextFor(command);
        if (ctx.json || ctx.noInput) {
          throw new Error(
            "`accounts login` is interactive and does not support --json or --no-input"
          );
        }
        loaded(command);
        const result = await loginAccount(subscriptionKind, options.name);
        let configPath: string;
        try {
          configPath = activateAccount(command, result);
        } catch (error) {
          removeAccount(result.subscriptionKind, result.label);
          throw error;
        }
        ctx.presenter.success(
          `logged in, enrolled, and enabled ${result.subscriptionKind}/${result.label}`
        );
        ctx.presenter.note(`account: ${result.path}`);
        ctx.presenter.note(`config: ${configPath}`);
      }
    );

  accounts
    .command("add <subscription-kind>")
    .description("enroll the current official CLI login")
    .option("--name <name>", "account label")
    .action(async (subscriptionKind: string, options: { name?: string }, command: Command) => {
      const ctx = contextFor(command);
      loaded(command);
      const result = await addAccount(subscriptionKind, options.name);
      const configPath = activateAccount(command, result);
      const output = {
        ...result,
        activated: true,
        configPath
      };
      if (ctx.json) {
        ctx.emit(output);
      } else {
        ctx.presenter.success(
          `enrolled and enabled ${result.subscriptionKind} account at ${result.path}`
        );
        ctx.presenter.note(`config: ${configPath}`);
      }
    });

  accounts
    .command("remove <subscription-kind> <name>")
    .description("remove an enrolled account from RouteKit-managed state")
    .action((provider: string, name: string, _options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const result = removeAccount(provider, name);
      if (ctx.json) {
        ctx.emit({ ...result, subscriptionKind: result.mode });
      } else if (result.removed) {
        ctx.presenter.success(`removed ${result.mode}/${result.label}`);
        if (
          listAccounts().every(
            (entry) => entry.subscriptionKind !== result.mode
          )
        ) {
          ctx.presenter.note(
            `The official ${result.mode} login may be imported again on startup; ` +
              `run \`routekit providers remove ${result.mode}\` to stop subscription routing.`
          );
        }
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
      else {
        ctx.presenter.table(
          entries.map((entry) => [entry.subscriptionKind, entry.label, entry.path])
        );
      }
    });

  accounts
    .command("status")
    .description("show account proxy and pooled account status")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const status = await accountsStatus(loaded(command).config);
      if (ctx.json) {
        ctx.emit(status);
        return;
      }
      ctx.presenter.status(
        status.running ? "ok" : "pending",
        "accounts proxy",
        status.running ? status.url : "not running"
      );
      for (const entry of status.accounts) {
        const ok = entry.credentialValid && entry.configured;
        ctx.presenter.status(
          ok ? "ok" : "pending",
          `${entry.subscriptionKind}/${entry.label}`,
          !entry.credentialValid
            ? "stored; credential invalid"
            : !entry.configured
              ? "stored; routing disabled"
              : "stored; configured; relay ready"
        );
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

  registerCliproxy(accounts);
}
