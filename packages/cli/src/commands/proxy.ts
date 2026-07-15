import {
  enrollCurrentSubscription,
  startSubscriptionProxy,
  SubscriptionProxyClient,
  type SubscriptionAccountSetSnapshot,
  type SubscriptionMemberStatus,
  type SubscriptionSelectionStrategy
} from "@routekit/accounts";
import type { SubscriptionMode } from "@routekit/registry";
import { registerCleanup } from "@routekit/runtime";
import { cyan, dim, relativeTime, timeUntil } from "@routekit/cli-ui";
import { contextFor } from "@routekit/cli-core";
import type { Presenter } from "@routekit/cli-ui";
import type { Command } from "commander";

import {
  CLIPROXY_LOGIN_FLAGS,
  CLIPROXY_PINNED_VERSION,
  cliproxyConfigPath,
  cliproxyStatus,
  installCliproxy,
  runCliproxyLogin,
  spawnCliproxy
} from "../fusion/cliproxy.js";
import { cliproxyBaseUrl, defaultKeyEnv } from "../fusion/env.js";
import {
  discoverProxy,
  registerRunningProxy,
  stopProxy
} from "../fusion/subscription-proxy.js";

/** Portless is on unless the flag disables it or `PORTLESS=0` is set. */
function portlessEnabled(flag: boolean | undefined): boolean {
  return flag ?? process.env.PORTLESS !== "0";
}

type ProxyServeOptions = {
  host: string;
  port: string;
  authToken?: string;
  strategy: string;
  switchThreshold: string;
  probeInterval: string;
  portless?: boolean;
};

function parseMode(value: string): SubscriptionMode {
  if (value === "claude-code" || value === "codex") return value;
  throw new Error("provider must be claude-code or codex");
}

function parseStrategy(value: string): SubscriptionSelectionStrategy {
  if (value === "sticky" || value === "round_robin" || value === "capacity_weighted") {
    return value;
  }
  throw new Error("strategy must be sticky, round_robin, or capacity_weighted");
}

function parseNumber(value: string, label: string, options: { min: number; max: number }): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < options.min || parsed > options.max) {
    throw new Error(`${label} must be between ${options.min} and ${options.max}`);
  }
  return parsed;
}

/** One member's health kind + detail for a `status` row. */
function memberHealth(member: SubscriptionMemberStatus): {
  kind: "ok" | "warn" | "pending";
  detail: string;
} {
  const now = Date.now();
  if (member.coolingUntil !== undefined && member.coolingUntil * 1000 > now) {
    return { kind: "warn", detail: `cooling down, resets ${timeUntil(member.coolingUntil * 1000)}` };
  }
  if (member.expiresAt !== undefined && member.expiresAt * 1000 <= now) {
    return { kind: "pending", detail: "token expired, re-login" };
  }
  return { kind: "ok", detail: member.active ? "active" : "ready" };
}

/** Per-window rows for a member's rate-limit table (utilization + reset). */
function windowRows(member: SubscriptionMemberStatus): string[][] {
  return Object.entries(member.limits?.windows ?? {}).map(([key, window]) => [
    key,
    `${(window.utilization * 100).toFixed(0)}%`,
    window.resetsAt !== undefined ? `resets ${timeUntil(window.resetsAt * 1000)}` : dim("—")
  ]);
}

/** Render every account set through the shared presenter primitives. */
function presentSnapshots(
  presenter: Presenter,
  snapshots: readonly SubscriptionAccountSetSnapshot[]
): void {
  for (const set of snapshots) {
    presenter.blank();
    presenter.heading(set.mode);
    presenter.keyValue([
      { label: "strategy", value: set.strategy },
      { label: "switch at", value: `${(set.switchThreshold * 100).toFixed(0)}%` },
      { label: "accounts", value: String(set.members.length) }
    ]);
    if (set.members.length === 0) {
      presenter.note("no accounts available — sign in or run `fusionkit proxy add`");
      continue;
    }
    for (const member of set.members) {
      const health = memberHealth(member);
      const label = member.active ? `${member.label} ${dim("(active)")}` : member.label;
      presenter.status(health.kind, label, health.detail);
      const rows = windowRows(member);
      if (rows.length > 0) {
        presenter.table(rows, {
          head: ["window", "used", "reset"],
          indent: 4,
          align: ["left", "right", "left"]
        });
      }
    }
  }
}

async function serveProxy(options: ProxyServeOptions, command: Command): Promise<void> {
  const ctx = contextFor(command);
  const host = options.host;
  const port = parseNumber(options.port, "port", { min: 0, max: 65535 });
  const strategy = parseStrategy(options.strategy);
  const switchThreshold = parseNumber(options.switchThreshold, "switch threshold", {
    min: 0.01,
    max: 1
  });
  const probeSeconds = parseNumber(options.probeInterval, "probe interval", { min: 0, max: 86_400 });
  const policy = {
    source: { kind: "auto" as const },
    strategy,
    switchThreshold,
    ...(probeSeconds > 0 ? { probeIntervalMs: probeSeconds * 1000 } : {})
  };

  const proxy = await startSubscriptionProxy({
    accounts: { "claude-code": policy, codex: policy },
    host,
    port,
    ...(options.authToken !== undefined ? { token: options.authToken } : {})
  });
  const registration = await registerRunningProxy({
    loopbackUrl: proxy.url(),
    port: proxy.port(),
    token: proxy.token,
    portless: portlessEnabled(options.portless)
  });
  registerCleanup(async () => {
    await registration.release();
    await proxy.close();
  });

  if (ctx.json) {
    ctx.emit({
      url: registration.url,
      port: proxy.port(),
      token: proxy.token,
      providers: proxy.providers
    });
  } else {
    ctx.presenter.success(`subscription proxy listening at ${cyan(registration.url)}`);
    if (proxy.providers.includes("anthropic")) {
      ctx.presenter.box("Claude Code", [
        `export ANTHROPIC_BASE_URL=${registration.url}`,
        `export ANTHROPIC_AUTH_TOKEN=${proxy.token}`
      ]);
    }
    if (proxy.providers.includes("codex")) {
      ctx.presenter.box("Codex (~/.codex/config.toml)", [
        `export FUSIONKIT_PROXY_TOKEN=${proxy.token}`,
        "",
        "[model_providers.fusionkit-subscriptions]",
        'name = "openai"',
        `base_url = "${registration.url}/backend-api/codex"`,
        'wire_api = "responses"',
        'env_key = "FUSIONKIT_PROXY_TOKEN"',
        "requires_openai_auth = false"
      ]);
    }
    ctx.presenter.note("Press Ctrl+C to stop; use a process supervisor for a login-persistent service.");
  }

  // Keep the action pending so this is a real long-lived endpoint; the
  // process-wide signal handler runs the registered cleanup on SIGINT/SIGTERM.
  await new Promise<never>(() => undefined);
}

/**
 * `fusionkit proxy cliproxy` — the managed CLIProxyAPI sidecar: the local
 * OpenAI-compatible proxy that fronts OAuth subscription accounts (Gemini/
 * Antigravity, Grok, Kimi, and pooled Codex/Claude). Complements the built-in
 * provider-native `fusionkit proxy serve` (Claude Code + Codex): use cliproxy
 * for the providers FusionKit has no native OAuth adapter for.
 */
function registerCliproxy(proxy: Command): void {
  const keyEnv = defaultKeyEnv("cliproxy") ?? "CLIPROXY_API_KEY";
  const cliproxy = proxy
    .command("cliproxy")
    .description("manage the CLIProxyAPI sidecar (OAuth subscription models as a panel upstream)");

  cliproxy
    .command("install")
    .description(`download and verify the pinned CLIProxyAPI release (v${CLIPROXY_PINNED_VERSION})`)
    .option("--json", "emit machine-readable JSON")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const result = await installCliproxy({
        onProgress: (line) => {
          if (!ctx.json) ctx.presenter.note(dim(line));
        }
      });
      if (ctx.json) {
        ctx.emit(result);
        return;
      }
      ctx.presenter.success(
        result.downloaded
          ? `installed CLIProxyAPI v${result.version} at ${result.binary}`
          : `CLIProxyAPI v${result.version} already installed at ${result.binary}`
      );
      ctx.presenter.box("next steps", [
        `export ${keyEnv}=${result.ingressKey}`,
        "fusionkit proxy cliproxy login gemini   # or claude / codex / grok / kimi",
        "fusionkit proxy cliproxy serve"
      ]);
      ctx.presenter.note(
        "subscription OAuth reuse is for personal/local use only — see docs/cliproxy-upstream.md"
      );
    });

  cliproxy
    .command("login <provider>")
    .description(`OAuth a subscription account into the proxy (${Object.keys(CLIPROXY_LOGIN_FLAGS).join(", ")})`)
    .option("--no-browser", "print the OAuth URL instead of opening a browser")
    .action(async (provider: string, options: { browser?: boolean }, command: Command) => {
      const ctx = contextFor(command);
      const code = await runCliproxyLogin(provider, { noBrowser: options.browser === false });
      if (code === 0) ctx.presenter.success(`${provider} account added to the cliproxy pool`);
      process.exitCode = code;
    });

  cliproxy
    .command("serve")
    .description("run the managed CLIProxyAPI in the foreground")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const child = spawnCliproxy();
      ctx.presenter.note(
        `CLIProxyAPI serving at ${cyan(cliproxyBaseUrl())} (config: ${dim(cliproxyConfigPath())}); Ctrl+C to stop`
      );
      const code = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (exitCode) => resolve(exitCode ?? 0));
      });
      process.exitCode = code;
    });

  cliproxy
    .command("status")
    .description("show sidecar install state, reachability, and enrolled accounts")
    .option("--json", "emit machine-readable JSON")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const status = await cliproxyStatus();
      if (ctx.json) {
        ctx.emit(status);
        return;
      }
      ctx.presenter.header("cliproxy");
      ctx.presenter.keyValue([
        { label: "pinned", value: `v${status.version}` },
        { label: "installed", value: status.installed ? "yes" : "no (run `fusionkit proxy cliproxy install`)" },
        { label: "endpoint", value: cyan(status.baseUrl) },
        {
          label: "reachable",
          value: status.reachable
            ? status.keyRejected === true
              ? `yes — but the key was rejected (check ${keyEnv})`
              : `yes — ${status.models ?? 0} model(s)`
            : "no (run `fusionkit proxy cliproxy serve`)"
        },
        {
          label: "accounts",
          value:
            status.accounts.length > 0
              ? status.accounts.join(", ")
              : "none (run `fusionkit proxy cliproxy login <provider>`)"
        }
      ]);
    });
}

export function registerProxy(program: Command): void {
  const proxy = program.command("proxy").description(
    "subscription proxies: the built-in Claude Code / Codex pool, and the CLIProxyAPI sidecar"
  );

  proxy
    .command("serve")
    .description("serve the pooled provider-native proxy")
    .option("--host <host>", "bind host", "127.0.0.1")
    .option("--port <port>", "bind port", "8790")
    .option("--auth-token <token>", "stable ingress proxy token")
    .option("--strategy <strategy>", "sticky | round_robin | capacity_weighted", "sticky")
    .option("--switch-threshold <ratio>", "proactive utilization threshold", "0.9")
    .option("--probe-interval <seconds>", "usage endpoint poll interval (0 disables)", "0")
    .option("--no-portless", "bind loopback only (skip the stable portless route)")
    .action(serveProxy);

  proxy
    .command("add <provider>")
    .description("copy the current official CLI login into the FusionKit-owned pool")
    .option("--name <name>", "account label")
    .action(async (provider: string, options: { name?: string }, command: Command) => {
      const ctx = contextFor(command);
      const mode = parseMode(provider);
      const path = await enrollCurrentSubscription(mode, {
        ...(options.name !== undefined ? { label: options.name } : {})
      });
      if (ctx.json) ctx.emit({ mode, path });
      else ctx.presenter.success(`enrolled ${mode} account at ${path}`);
    });

  proxy
    .command("status")
    .description("show proxy health and per-account subscription windows")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const state = discoverProxy();
      if (state === undefined) {
        if (ctx.json) ctx.emit({ running: false });
        else ctx.presenter.note("subscription proxy is not running");
        return;
      }
      const client = SubscriptionProxyClient.open({ baseUrl: state.url, token: state.token });
      let usage;
      try {
        usage = await client.usage();
      } catch {
        usage = undefined;
      }
      if (ctx.json) {
        ctx.emit({ running: true, url: state.url, pid: state.pid, usage });
        return;
      }
      ctx.presenter.header("subscription proxy");
      ctx.presenter.keyValue([
        { label: "endpoint", value: cyan(state.url) },
        { label: "pid", value: String(state.pid) },
        { label: "uptime", value: relativeTime(Date.parse(state.startedAt)) }
      ]);
      if (usage === undefined) {
        ctx.presenter.note("live usage unavailable (the proxy did not answer)");
        return;
      }
      presentSnapshots(ctx.presenter, usage.accountSets);
    });

  registerCliproxy(proxy);

  proxy
    .command("stop")
    .description("stop the running subscription proxy")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const result = await stopProxy();
      if (ctx.json) {
        ctx.emit(result);
        return;
      }
      if (result.stopped) ctx.presenter.success(`stopped subscription proxy${result.pid !== undefined ? ` pid=${result.pid}` : ""}`);
      else if (result.stale) ctx.presenter.note("removed stale subscription proxy state");
      else ctx.presenter.note("subscription proxy is not running");
    });
}
