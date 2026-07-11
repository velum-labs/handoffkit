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
  AnthropicBackendRelay,
  CodexBackendRelay,
  defaultSubscriptionPoolDirectory,
  enrollCurrentSubscription,
  RelayOnlyBackend,
  startGateway,
  SubscriptionPool,
  subscriptionProvider,
  type SubscriptionPoolSnapshot,
  type SubscriptionPoolStrategy,
  type SubscriptionRelay
} from "@fusionkit/model-gateway";
import type { SubscriptionMode } from "@fusionkit/registry";
import { registerCleanup } from "@fusionkit/runtime-utils";
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

function parseStrategy(value: string): SubscriptionPoolStrategy {
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

function codexCatalog(
  _template: Record<string, unknown>,
  stock: readonly Record<string, unknown>[]
): Record<string, unknown>[] {
  return [...stock];
}

function usageBar(utilization: number): string {
  const width = 20;
  const filled = Math.round(Math.max(0, Math.min(1, utilization)) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${(utilization * 100).toFixed(1)}%`;
}

function renderSnapshots(snapshots: SubscriptionPoolSnapshot[]): string {
  const lines: string[] = [];
  for (const pool of snapshots) {
    lines.push(`${pool.mode} (${pool.strategy}, switch at ${(pool.switchThreshold * 100).toFixed(0)}%)`);
    if (pool.members.length === 0) {
      lines.push("  no enrolled accounts");
      continue;
    }
    for (const member of pool.members) {
      const marker = member.active ? "*" : "-";
      const cooling =
        member.coolingUntil !== undefined && member.coolingUntil > Date.now() / 1000
          ? ` cooling until ${new Date(member.coolingUntil * 1000).toISOString()}`
          : "";
      lines.push(`  ${marker} ${member.label}${cooling}`);
      for (const [key, window] of Object.entries(member.limits?.windows ?? {})) {
        const reset =
          window.resetsAt === undefined
            ? ""
            : ` reset ${new Date(window.resetsAt * 1000).toISOString()}`;
        lines.push(`      ${key.padEnd(18)} ${usageBar(window.utilization)}${reset}`);
      }
    }
  }
  return lines.join("\n");
}

async function readLiveUsage(): Promise<{
  runtime?: ProxyRuntime;
  pools: SubscriptionPoolSnapshot[];
}> {
  const runtime = readJson<ProxyRuntime>(PROXY_RUNTIME_PATH);
  const config = readJson<ProxyConfig>(PROXY_CONFIG_PATH);
  if (runtime === undefined || config === undefined) return { pools: [] };
  try {
    const response = await fetch(`${runtime.url}/usage`, {
      headers: { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) return { runtime, pools: [] };
    const payload = (await response.json()) as { pools?: SubscriptionPoolSnapshot[] };
    return { runtime, pools: payload.pools ?? [] };
  } catch {
    return { runtime, pools: [] };
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
  const relays: Partial<Record<"anthropic" | "codex", SubscriptionRelay>> = {};

  const claudePool = await SubscriptionPool.open(subscriptionProvider("claude-code"), {
    mode: "claude-code",
    directory: defaultSubscriptionPoolDirectory("claude-code"),
    strategy,
    switchThreshold,
    ...(probeSeconds > 0 ? { probeIntervalMs: probeSeconds * 1000 } : {})
  });
  if (claudePool.size > 0) relays.anthropic = new AnthropicBackendRelay({ pool: claudePool });
  else await claudePool.close();

  const codexPool = await SubscriptionPool.open(subscriptionProvider("codex"), {
    mode: "codex",
    directory: defaultSubscriptionPoolDirectory("codex"),
    strategy,
    switchThreshold,
    ...(probeSeconds > 0 ? { probeIntervalMs: probeSeconds * 1000 } : {})
  });
  const codexRelay =
    codexPool.size > 0
      ? new CodexBackendRelay({ catalog: codexCatalog, pool: codexPool })
      : undefined;
  if (codexRelay !== undefined) relays.codex = codexRelay;
  else await codexPool.close();

  if (relays.anthropic === undefined && relays.codex === undefined) {
    throw new Error(
      "no subscription accounts are enrolled; run `fusionkit proxy add claude-code` or `fusionkit proxy add codex`"
    );
  }

  const gateway = await startGateway({
    backend: new RelayOnlyBackend(),
    host,
    port,
    authToken: config.token,
    ...(codexRelay !== undefined ? { codexRelay } : {}),
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
    ctx.presenter.success(`subscription proxy listening at ${runtime.url}`);
    ctx.presenter.line(`export ANTHROPIC_BASE_URL=${runtime.url}`);
    ctx.presenter.line(`export ANTHROPIC_AUTH_TOKEN=${config.token}`);
    ctx.presenter.blank();
    ctx.presenter.line(`export FUSIONKIT_PROXY_TOKEN=${config.token}`);
    ctx.presenter.line("[model_providers.fusionkit-subscriptions]");
    ctx.presenter.line('name = "openai"');
    ctx.presenter.line(`base_url = "${runtime.url}/backend-api/codex"`);
    ctx.presenter.line('wire_api = "responses"');
    ctx.presenter.line('env_key = "FUSIONKIT_PROXY_TOKEN"');
    ctx.presenter.line("requires_openai_auth = false");
    ctx.presenter.blank();
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
      ctx.presenter.line(
        `proxy ${status.runtime.url} pid=${status.runtime.pid} started=${status.runtime.startedAt}`
      );
      ctx.presenter.line(
        status.pools.length > 0 ? renderSnapshots(status.pools) : "usage unavailable"
      );
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
