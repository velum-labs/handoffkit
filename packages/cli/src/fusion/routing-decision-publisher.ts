/**
 * Best-effort publisher for live routing decisions to the scope dashboard.
 */

import type { RoutingDecision } from "@fusionkit/model-gateway";

import { SCOPE_DASHBOARD_PORT } from "./observability.js";

/** Env var: set to `0`, `false`, or `off` to disable dashboard publishing. */
export const ROUTING_SCOPE_PUBLISH_ENV = "FUSION_ROUTING_SCOPE_PUBLISH";

/** Env var: override the scope dashboard base URL (default `http://127.0.0.1:4317`). */
export const ROUTING_SCOPE_URL_ENV = "FUSION_ROUTING_SCOPE_URL";

const DISABLED_VALUES = new Set(["0", "false", "off", "no", "disabled"]);

export type RoutingDecisionPublisherOptions = {
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override the decisions ingest URL (skips {@link ROUTING_SCOPE_URL_ENV}). */
  ingestUrl?: string;
  /** Optional debug logger for publish failures. */
  debug?: (message: string) => void;
};

/**
 * Whether routing decision publishing to scope is enabled for the given env.
 */
export function isRoutingScopePublishEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env[ROUTING_SCOPE_PUBLISH_ENV];
  if (flag === undefined || flag.trim().length === 0) return true;
  return !DISABLED_VALUES.has(flag.trim().toLowerCase());
}

/**
 * Resolve the scope dashboard base URL from env (optional port override).
 */
export function resolveRoutingScopeBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  port?: number
): string {
  const override = env[ROUTING_SCOPE_URL_ENV]?.trim();
  if (override !== undefined && override.length > 0) {
    return override.replace(/\/$/, "");
  }
  const resolvedPort = port ?? SCOPE_DASHBOARD_PORT;
  return `http://127.0.0.1:${resolvedPort}`;
}

/**
 * Resolve the scope dashboard decisions ingest URL from env.
 */
export function resolveRoutingScopeIngestUrl(
  env: NodeJS.ProcessEnv = process.env,
  port?: number
): string {
  return `${resolveRoutingScopeBaseUrl(env, port)}/api/routing/decisions`;
}

/**
 * Resolve the scope routing dashboard page URL from env.
 */
export function resolveRoutingDashboardUrl(
  env: NodeJS.ProcessEnv = process.env,
  port?: number
): string {
  return `${resolveRoutingScopeBaseUrl(env, port)}/routing`;
}

/**
 * Publish a routing decision to the scope dashboard without blocking the caller.
 * Failures are swallowed (optional debug log only).
 */
export function publishRoutingDecisionToScope(
  decision: RoutingDecision,
  options: RoutingDecisionPublisherOptions = {}
): void {
  const env = options.env ?? process.env;
  if (!isRoutingScopePublishEnabled(env)) return;

  const url = options.ingestUrl ?? resolveRoutingScopeIngestUrl(env);
  void fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(decision)
  }).catch((error: unknown) => {
    options.debug?.(
      `routing scope publish failed: ${error instanceof Error ? error.message : String(error)}`
    );
  });
}

/**
 * Create an `onDecision` callback that best-effort POSTs to the scope dashboard.
 */
export function createRoutingDecisionPublisher(
  options: RoutingDecisionPublisherOptions = {}
): (decision: RoutingDecision) => void {
  return (decision) => publishRoutingDecisionToScope(decision, options);
}
