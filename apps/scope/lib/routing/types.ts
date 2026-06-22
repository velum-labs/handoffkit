/**
 * Routing types mirrored from `@fusionkit/model-gateway` and `@fusionkit/cli`
 * fusion config. Kept local so the isolated scope app does not depend on the
 * monorepo workspace packages.
 */

/** The five routing scenarios Claude Code Router recognises. */
export const ROUTING_SCENARIOS = [
  "default",
  "background",
  "longContext",
  "reasoning",
  "webSearch"
] as const;

export type RoutingScenario = (typeof ROUTING_SCENARIOS)[number];

export const DEFAULT_LONG_CONTEXT_THRESHOLD = 60_000;

export type RouteTargetSpec = string;

/** Per-scenario route table plus optional fallbacks. */
export type ScenarioRoutes = {
  default: RouteTargetSpec;
  background?: RouteTargetSpec;
  longContext?: RouteTargetSpec;
  longContextThreshold?: number;
  reasoning?: RouteTargetSpec;
  webSearch?: RouteTargetSpec;
  fallbacks?: Partial<Record<RoutingScenario, readonly RouteTargetSpec[]>>;
};

export const ROUTING_PROVIDER_KINDS = [
  "anthropic",
  "openai",
  "google",
  "google-gemini",
  "openai-compatible",
  "openrouter",
  "deepseek",
  "groq"
] as const;

export type RoutingProviderKind = (typeof ROUTING_PROVIDER_KINDS)[number];

export type RoutingProviderSpec = {
  id: string;
  provider: RoutingProviderKind;
  baseUrl?: string;
  keyEnv?: string;
};

export type FusionRoutingConfig = {
  routes: ScenarioRoutes;
  providers: RoutingProviderSpec[];
};

export type ParsedRouteTarget = {
  providerId?: string;
  model: string;
};

/** Outcome of routing a single request. */
export type RoutingDecision = {
  scenario: RoutingScenario;
  target: ParsedRouteTarget;
  tokenCount: number;
  reason: string;
  fallbackIndex: number;
};

/** A routing decision with ingest metadata for the live stream. */
export type RoutingDecisionEvent = RoutingDecision & {
  id: string;
  ts: number;
};

/** Provider row returned by the providers API. */
export type ProviderStatus = {
  id: string;
  kind: RoutingProviderKind;
  baseUrl: string;
  keyEnv: string | undefined;
  hasKey: boolean;
  reachable: boolean | null;
  pingMs: number | null;
  pingError: string | undefined;
};
