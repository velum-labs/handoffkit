/**
 * `fusionkit fusion status` — print smart routing status from config and dashboard.
 */

import { relative, resolve } from "node:path";

import { ROUTING_SCENARIOS } from "@fusionkit/model-gateway";
import type { RoutingScenario } from "@fusionkit/model-gateway";

import {
  fusionConfigPath,
  FusionConfigError,
  loadFusionConfig
} from "../fusion-config.js";
import type { FusionConfig } from "../fusion-config.js";
import { gitToplevel } from "../fusion/env.js";
import { resolveRoutingScopeIngestUrl } from "../fusion/routing-decision-publisher.js";
import { detectSubscriptions } from "../fusion/subscriptions.js";
import type { SubscriptionStatus } from "../fusion/subscriptions.js";
import { fail } from "../shared/errors.js";

export type FusionStatusOptions = {
  repo?: string;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
};

type RoutingDecisionEvent = {
  scenario: RoutingScenario;
  ts?: number;
};

type Last24hStats = {
  count: number;
  topScenario: string;
  topCount: number;
};

/** JSON payload emitted by `fusion status --json`. */
export type FusionStatusJson = {
  activeConfig: string;
  subscriptions: {
    claudeCode: string;
    codex: string;
  };
  routing: FusionConfig["routing"];
  last24h: Last24hStats | { dashboardDown: true };
  costTracking: "deferred-to-v0.6";
};

const SMART_ROUTING_LABEL = "Smart routing (recommended)";

/**
 * Format subscription status for the status report line.
 */
export function formatSubscriptionEntry(label: string, status: SubscriptionStatus, nowSec: number): string {
  if (!status.available) return `${label} ❌`;
  if (status.expired) return `${label} ⚠️ (expired)`;
  if (status.expiresAt !== undefined) {
    const days = Math.max(0, Math.ceil((status.expiresAt - nowSec) / 86_400));
    return `${label} ✅ (${days}d)`;
  }
  return `${label} ✅`;
}

/**
 * Parse routing decision events from an SSE response body.
 */
export function parseRoutingDecisionSse(body: string): RoutingDecisionEvent[] {
  const events: RoutingDecisionEvent[] = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length).trim();
    if (payload.length === 0) continue;
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { scenario?: unknown }).scenario === "string"
      ) {
        const record = parsed as { scenario: RoutingScenario; ts?: number };
        events.push({
          scenario: record.scenario,
          ...(typeof record.ts === "number" ? { ts: record.ts } : {})
        });
      }
    } catch {
      // ignore malformed SSE payloads
    }
  }
  return events;
}

/**
 * Summarise routing decisions from the last 24 hours.
 */
export function summarizeLast24h(
  events: readonly RoutingDecisionEvent[],
  nowMs: number
): Last24hStats {
  const cutoffSec = nowMs / 1000 - 86_400;
  const recent = events.filter((event) => event.ts === undefined || event.ts >= cutoffSec);
  const counts = new Map<string, number>();
  for (const event of recent) {
    counts.set(event.scenario, (counts.get(event.scenario) ?? 0) + 1);
  }
  let topScenario = "—";
  let topCount = 0;
  for (const [scenario, count] of counts) {
    if (count > topCount) {
      topScenario = scenario;
      topCount = count;
    }
  }
  return { count: recent.length, topScenario, topCount };
}

/**
 * Best-effort fetch of last-24h routing stats from the scope dashboard SSE feed.
 */
export async function fetchLast24hRoutingStats(
  ingestUrl: string,
  options: { fetchImpl?: typeof fetch; now?: () => number } = {}
): Promise<Last24hStats | undefined> {
  const fetchFn = options.fetchImpl ?? fetch;
  const nowMs = options.now?.() ?? Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const response = await fetchFn(ingestUrl, {
      method: "GET",
      headers: { accept: "text/event-stream" },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) return undefined;
    const body = await response.text();
    return summarizeLast24h(parseRoutingDecisionSse(body), nowMs);
  } catch {
    return undefined;
  }
}

function formatConfigPath(repoRoot: string, cwd: string): string {
  const absolute = fusionConfigPath(repoRoot);
  const rel = relative(cwd, absolute);
  return rel.length > 0 && !rel.startsWith("..") ? `./${rel}` : absolute;
}

function formatRouteTarget(target: string | undefined): string {
  if (target === undefined) return "—";
  const comma = target.indexOf(",");
  return comma >= 0 ? target.slice(0, comma) : target;
}

/**
 * Render the smart routing status report as plain text lines.
 */
export function renderFusionStatusReport(input: {
  configPath: string;
  subscriptionsLine: string;
  routes: FusionConfig["routing"];
  stats?: Last24hStats;
  dashboardDown?: boolean;
}): string {
  const lines: string[] = [
    "📊 Smart Routing Status",
    `├─ Active config: ${input.configPath}`,
    `├─ Subscriptions: ${input.subscriptionsLine}`
  ];

  lines.push("├─ Routing rules:");
  const routes = input.routes?.routes;
  if (routes === undefined) {
    lines.push("│   └─ (no routing section in config)");
  } else {
    const scenarioLines = ROUTING_SCENARIOS.filter(
      (scenario) => scenario === "default" || routes[scenario] !== undefined
    );
    scenarioLines.forEach((scenario, index) => {
      const isLast = index === scenarioLines.length - 1;
      const branch = isLast ? "└─" : "├─";
      const target = scenario === "default" ? routes.default : routes[scenario];
      lines.push(`│   ${branch} ${scenario.padEnd(13)} → ${formatRouteTarget(target)}`);
    });
  }

  if (input.dashboardDown === true) {
    lines.push("├─ Last 24h: dashboard not running");
  } else if (input.stats !== undefined) {
    lines.push(`├─ Last 24h: ${input.stats.count} requests routed`);
    lines.push(
      `├─ Top scenario: ${input.stats.topScenario} (${input.stats.topCount} requests)`
    );
  }

  lines.push("└─ Cost tracking: coming in v0.6");
  return lines.join("\n");
}

/**
 * Build the structured status payload shared by formatted and JSON output.
 */
export function buildFusionStatusPayload(input: {
  configPath: string;
  subscriptions: ReturnType<typeof detectSubscriptions>;
  nowSec: number;
  routes: FusionConfig["routing"];
  stats?: Last24hStats;
  dashboardDown?: boolean;
}): FusionStatusJson {
  return {
    activeConfig: input.configPath,
    subscriptions: {
      claudeCode: formatSubscriptionEntry("Claude Code", input.subscriptions["claude-code"], input.nowSec),
      codex: formatSubscriptionEntry("Codex", input.subscriptions.codex, input.nowSec)
    },
    routing: input.routes,
    last24h:
      input.dashboardDown === true
        ? { dashboardDown: true }
        : (input.stats ?? { count: 0, topScenario: "—", topCount: 0 }),
    costTracking: "deferred-to-v0.6"
  };
}

/**
 * Run `fusionkit fusion status`.
 */
export async function runFusionStatus(options: FusionStatusOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? ((line: string) => console.log(line));
  const nowMs = options.now?.() ?? Date.now();
  const nowSec = nowMs / 1000;

  const repoRoot = options.repo !== undefined ? resolve(options.repo) : gitToplevel(cwd);
  if (repoRoot === undefined) {
    fail("not inside a git repository — run from a repo root or pass --repo");
  }

  let config: FusionConfig | undefined;
  try {
    config = loadFusionConfig(repoRoot);
  } catch (error) {
    if (error instanceof FusionConfigError) fail(error.message);
    throw error;
  }

  const subs = detectSubscriptions();
  const configPath = formatConfigPath(repoRoot, cwd);

  const ingestUrl = resolveRoutingScopeIngestUrl(env);
  const stats = await fetchLast24hRoutingStats(ingestUrl, {
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    now: () => nowMs
  });

  const payload = buildFusionStatusPayload({
    configPath,
    subscriptions: subs,
    nowSec,
    routes: config?.routing,
    ...(stats !== undefined ? { stats } : { dashboardDown: true })
  });

  if (options.json === true) {
    log(JSON.stringify(payload, null, 2));
    return 0;
  }

  const report = renderFusionStatusReport({
    configPath,
    subscriptionsLine: [payload.subscriptions.claudeCode, payload.subscriptions.codex].join(", "),
    routes: config?.routing,
    ...(stats !== undefined ? { stats } : { dashboardDown: true })
  });
  log(report);
  return 0;
}

export { SMART_ROUTING_LABEL };
