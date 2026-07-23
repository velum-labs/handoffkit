import type { ProviderId } from "@velum-labs/routekit-gateway";

/**
 * RouteKit's first-launch public contract.
 *
 * The neutral registry intentionally contains additional providers, account
 * connectors, and tool integrations for internal compatibility. Presence in
 * that registry does not make an entry supported or user-facing.
 */
export const LAUNCH_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "openrouter",
  "codex",
  "claude-code"
] as const satisfies readonly ProviderId[];

export type LaunchProviderId = (typeof LAUNCH_PROVIDER_IDS)[number];

export const LAUNCH_ROUTE_IDS = [
  "route-openai-api",
  "route-anthropic-api",
  "route-openrouter-api",
  "route-codex-subscription",
  "route-claude-code-subscription",
  "route-cursor-ide",
  "route-cursor-agent"
] as const;

export type LaunchRouteId = (typeof LAUNCH_ROUTE_IDS)[number];

export const LAUNCH_ACCOUNT_KINDS = ["claude-code", "codex"] as const;
export const LAUNCH_ACCOUNT_KIND_CHOICES = ["claude-code", "claude", "codex"] as const;

export type LaunchAccountKind = (typeof LAUNCH_ACCOUNT_KINDS)[number];

export const LAUNCH_TOOL_IDS = ["codex", "claude", "cursor"] as const;

export type LaunchToolId = (typeof LAUNCH_TOOL_IDS)[number];

export function isLaunchProviderId(value: string): value is LaunchProviderId {
  return (LAUNCH_PROVIDER_IDS as readonly string[]).includes(value);
}

export function isLaunchAccountKind(value: string): value is LaunchAccountKind {
  return (LAUNCH_ACCOUNT_KINDS as readonly string[]).includes(value);
}

export function isLaunchToolId(value: string): value is LaunchToolId {
  return (LAUNCH_TOOL_IDS as readonly string[]).includes(value);
}
