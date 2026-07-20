import {
  CLIPROXY_API_KEY_ENV,
  CLIPROXY_LOGIN_FLAGS,
  CLIPROXY_PINNED_VERSION,
  cliproxyBaseUrl,
  cliproxyConfigPath,
  cliproxyStatus,
  defaultSubscriptionCredentialPath,
  installCliproxy,
  runCliproxyLogin,
  spawnCliproxy
} from "@routekit/accounts";
import { contextFor } from "@routekit/cli-core";
import type { Command } from "commander";
import { readFileSync } from "node:fs";

import {
  captureLoginCredential,
  parseAccountMode
} from "../accounts.js";
import { ensureDaemon, routekitClient } from "../client.js";


async function activateAccount(subscriptionKind: "claude-code" | "codex"): Promise<string> {
  const client = await routekitClient();
  const updated = await client.call(
    "providers.set",
    { provider: subscriptionKind, enabled: true },
    { idempotencyKey: `account-activate-${subscriptionKind}-${Date.now()}` }
  );
  return updated.path;
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
      await (await routekitClient()).call("daemon.status", {});
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
        await (await routekitClient()).call("daemon.status", {});
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
      await (await routekitClient()).call("daemon.status", {});
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
      await (await routekitClient()).call("daemon.status", {});
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
        const result = await captureLoginCredential(subscriptionKind, options.name);
        const client = await routekitClient();
        await client.call(
          "accounts.enroll",
          {
            kind: result.subscriptionKind,
            label: result.label,
            credential: result.credential
          },
          { idempotencyKey: `account-login-${result.subscriptionKind}-${result.label}` }
        );
        const configPath = await activateAccount(result.subscriptionKind);
        ctx.presenter.success(
          `logged in, enrolled, and enabled ${result.subscriptionKind}/${result.label}`
        );
        ctx.presenter.note(`config: ${configPath}`);
      }
    );

  accounts
    .command("add <subscription-kind>")
    .description("enroll the current official CLI login")
    .option("--name <name>", "account label")
    .action(async (subscriptionKind: string, options: { name?: string }, command: Command) => {
      const ctx = contextFor(command);
      const kind = parseAccountMode(subscriptionKind);
      const label = options.name ?? `${kind}-default`;
      const sourcePath = defaultSubscriptionCredentialPath(kind);
      const credential = JSON.parse(readFileSync(sourcePath, "utf8")) as unknown;
      const client = await routekitClient();
      const enrolled = await client.call(
        "accounts.enroll",
        { kind, label, credential },
        { idempotencyKey: `account-add-${kind}-${label}` }
      );
      const configPath = await activateAccount(kind);
      const output = {
        subscriptionKind: kind,
        label,
        revision: enrolled.revision,
        activated: true,
        configPath
      };
      if (ctx.json) {
        ctx.emit(output);
      } else {
        ctx.presenter.success(
          `enrolled and enabled ${kind}/${label}`
        );
        ctx.presenter.note(`config: ${configPath}`);
      }
    });

  accounts
    .command("remove <subscription-kind> <name>")
    .description("remove an enrolled account from RouteKit-managed state")
    .action(async (provider: string, name: string, _options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const kind = parseAccountMode(provider);
      const result = await (await routekitClient()).call(
        "accounts.remove",
        { kind, label: name },
        { idempotencyKey: `account-remove-${kind}-${name}` }
      );
      if (ctx.json) {
        ctx.emit({ ...result, subscriptionKind: kind, label: name });
      } else if (result.removed) {
        ctx.presenter.success(`removed ${kind}/${name}`);
        const remaining = await (await routekitClient()).call("accounts.list", {});
        if (
          (remaining.accounts as Array<{ subscriptionKind?: string }>).every(
            (entry) => entry.subscriptionKind !== kind
          )
        ) {
          ctx.presenter.note(
            `The official ${kind} login may be imported again; ` +
              `run \`routekit providers remove ${kind}\` to stop subscription routing.`
          );
        }
      } else {
        ctx.presenter.note(`${kind}/${name} is not enrolled`);
      }
    });

  accounts
    .command("list")
    .description("list enrolled accounts without reading credential values")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const response = await (await routekitClient()).call("accounts.list", {});
      const entries = response.accounts as Array<{
        subscriptionKind: string;
        label: string;
      }>;
      if (ctx.json) ctx.emit({ accounts: entries });
      else {
        ctx.presenter.table(
          entries.map((entry) => [entry.subscriptionKind, entry.label])
        );
      }
    });

  accounts
    .command("status")
    .description("show account proxy and pooled account status")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const status = (await (await routekitClient()).call("accounts.status", {})) as {
        accounts: Array<{
          subscriptionKind: string;
          label: string;
          credentialValid?: boolean;
          configured?: boolean;
          relayOpen?: boolean;
        }>;
        revision: number;
      };
      if (ctx.json) {
        ctx.emit(status);
        return;
      }
      ctx.presenter.status("ok", "daemon account pool", `revision ${status.revision}`);
      for (const entry of status.accounts) {
        const ok = entry.credentialValid !== false && entry.configured !== false;
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
    .description("compatibility alias: ensure the singleton daemon account pool is running")
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
        const running = await ensureDaemon();
        const status = await running.client.call("daemon.status", {});
        if (ctx.json) {
          ctx.emit({
            compatibilityAlias: true,
            daemon: status,
            providers: ["claude-code", "codex"]
          });
        }
        else {
          ctx.presenter.success(`singleton daemon account pool is running at ${status.dataUrl}`);
          ctx.presenter.note("`accounts serve` is deprecated; accounts now live inside the daemon.");
        }
      }
    );

  accounts
    .command("stop")
    .description("compatibility alias; there is no separate account proxy")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      await routekitClient();
      if (ctx.json) ctx.emit({ stopped: false, integrated: true });
      else ctx.presenter.note("accounts are integrated into the singleton daemon; nothing separate to stop");
    });

  registerCliproxy(accounts);
}
