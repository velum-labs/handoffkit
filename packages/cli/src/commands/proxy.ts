import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  enrollCurrentSubscription,
  openSubscriptionRelays,
  RelayOnlyBackend,
  startGateway,
  type SubscriptionAccountSetSnapshot,
  type SubscriptionMemberStatus,
  type SubscriptionSelectionStrategy
} from "@fusionkit/model-gateway";
import type { SubscriptionMode } from "@fusionkit/registry";
import { registerCleanup } from "@fusionkit/runtime-utils";
import { cyan, dim, relativeTime, timeUntil } from "@fusionkit/cli-ui";
import type { Presenter } from "@fusionkit/cli-ui";
import type { Command } from "commander";

import { contextFor } from "../shared/context.js";

type ProxyConfig = {
  token: string;
};

type ProxyRuntime = {
  pid: number;
  url: string;
  port: number;
  startedAt: string;
};

type ProxyServeOptions = {
  host: string;
  port: string;
  authToken?: string;
  strategy: string;
  switchThreshold: string;
  probeInterval: string;
};

const PROXY_ROOT = join(homedir(), ".fusionkit", "subscriptions");
const PROXY_CONFIG_PATH = join(PROXY_ROOT, "proxy.json");
const PROXY_RUNTIME_PATH = join(PROXY_ROOT, "runtime.json");

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(PROXY_ROOT, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function proxyConfig(explicitToken?: string): ProxyConfig {
  const stored = readJson<ProxyConfig>(PROXY_CONFIG_PATH);
  const token = explicitToken ?? stored?.token ?? `fk-proxy-${randomBytes(24).toString("base64url")}`;
  const config = { token };
  writePrivateJson(PROXY_CONFIG_PATH, config);
  return config;
}

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

/** One member's status line: `● label`, plus cooldown/expiry tags. */
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

async function readLiveUsage(): Promise<{
  runtime?: ProxyRuntime;
  accountSets: SubscriptionAccountSetSnapshot[];
}> {
  const runtime = readJson<ProxyRuntime>(PROXY_RUNTIME_PATH);
  const config = readJson<ProxyConfig>(PROXY_CONFIG_PATH);
  if (runtime === undefined || config === undefined) return { accountSets: [] };
  try {
    const response = await fetch(`${runtime.url}/usage`, {
      headers: { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) return { runtime, accountSets: [] };
    const payload = (await response.json()) as {
      accountSets?: SubscriptionAccountSetSnapshot[];
    };
    return { runtime, accountSets: payload.accountSets ?? [] };
  } catch {
    return { runtime, accountSets: [] };
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
  const probeSeconds = parseNumber(options.probeInterval, "probe interval", {
    min: 0,
    max: 86_400
  });
  const config = proxyConfig(options.authToken);
  const policy = {
    source: { kind: "auto" as const },
    strategy,
    switchThreshold,
    ...(probeSeconds > 0 ? { probeIntervalMs: probeSeconds * 1000 } : {})
  };
  const { relays } = await openSubscriptionRelays({
    accounts: {
      "claude-code": policy,
      codex: policy
    }
  });

  if (relays.anthropic === undefined && relays.codex === undefined) {
    throw new Error(
      "no subscription accounts are available; sign in with `claude` or `codex login`, or enroll an additional account with `fusionkit proxy add`"
    );
  }

  const gateway = await startGateway({
    backend: new RelayOnlyBackend(),
    host,
    port,
    authToken: config.token,
    subscriptionRelays: relays
  });
  const runtime: ProxyRuntime = {
    pid: process.pid,
    url: gateway.url(),
    port: gateway.port(),
    startedAt: new Date().toISOString()
  };
  writePrivateJson(PROXY_RUNTIME_PATH, runtime);
  registerCleanup(async () => {
    rmSync(PROXY_RUNTIME_PATH, { force: true });
    await gateway.close();
  });

  if (ctx.json) {
    ctx.emit({ ...runtime, token: config.token, providers: Object.keys(relays) });
  } else {
    ctx.presenter.success(`subscription proxy listening at ${cyan(runtime.url)}`);
    if (relays.anthropic !== undefined) {
      ctx.presenter.box("Claude Code", [
        `export ANTHROPIC_BASE_URL=${runtime.url}`,
        `export ANTHROPIC_AUTH_TOKEN=${config.token}`
      ]);
    }
    if (relays.codex !== undefined) {
      ctx.presenter.box("Codex (~/.codex/config.toml)", [
        `export FUSIONKIT_PROXY_TOKEN=${config.token}`,
        "",
        "[model_providers.fusionkit-subscriptions]",
        'name = "openai"',
        `base_url = "${runtime.url}/backend-api/codex"`,
        'wire_api = "responses"',
        'env_key = "FUSIONKIT_PROXY_TOKEN"',
        "requires_openai_auth = false"
      ]);
    }
    ctx.presenter.note("Press Ctrl+C to stop; use a process supervisor for a login-persistent service.");
  }

  // Commander actions normally return after setup, and the top-level CLI then
  // runs cleanups and exits explicitly. Keep the serve action pending so this
  // is a real long-lived endpoint; the process-wide signal handler performs
  // the registered cleanup on SIGINT/SIGTERM.
  await new Promise<never>(() => undefined);
}

export function registerProxy(program: Command): void {
  const proxy = program.command("proxy").description(
    "long-lived Claude Code and Codex subscription pooling proxy"
  );

  proxy
    .command("serve")
    .description("serve the pooled provider-native proxy")
    .option("--host <host>", "bind host", "127.0.0.1")
    .option("--port <port>", "bind port", "8790")
    .option("--auth-token <token>", "stable ingress proxy token")
    .option(
      "--strategy <strategy>",
      "sticky | round_robin | capacity_weighted",
      "sticky"
    )
    .option("--switch-threshold <ratio>", "proactive utilization threshold", "0.9")
    .option("--probe-interval <seconds>", "usage endpoint poll interval (0 disables)", "0")
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
      const status = await readLiveUsage();
      if (ctx.json) {
        ctx.emit(status);
        return;
      }
      if (status.runtime === undefined) {
        ctx.presenter.note("subscription proxy is not running");
        return;
      }
      ctx.presenter.header("subscription proxy");
      ctx.presenter.keyValue([
        { label: "endpoint", value: cyan(status.runtime.url) },
        { label: "pid", value: String(status.runtime.pid) },
        { label: "uptime", value: relativeTime(Date.parse(status.runtime.startedAt)) }
      ]);
      if (status.accountSets.length === 0) {
        ctx.presenter.note("live usage unavailable (the proxy did not report account sets)");
        return;
      }
      presentSnapshots(ctx.presenter, status.accountSets);
    });

  proxy
    .command("stop")
    .description("stop the running subscription proxy")
    .action((_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const runtime = readJson<ProxyRuntime>(PROXY_RUNTIME_PATH);
      if (runtime === undefined) {
        if (ctx.json) ctx.emit({ stopped: false });
        else ctx.presenter.note("subscription proxy is not running");
        return;
      }
      try {
        process.kill(runtime.pid, "SIGTERM");
        rmSync(PROXY_RUNTIME_PATH, { force: true });
        if (ctx.json) ctx.emit({ stopped: true, pid: runtime.pid });
        else ctx.presenter.success(`stopped subscription proxy pid=${runtime.pid}`);
      } catch {
        rmSync(PROXY_RUNTIME_PATH, { force: true });
        if (ctx.json) ctx.emit({ stopped: false, stale: true });
        else ctx.presenter.note("removed stale subscription proxy state");
      }
    });
}
