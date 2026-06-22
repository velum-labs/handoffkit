/**
 * Claude Code Router scenario types and configuration shapes.
 *
 * Ported from the MIT-licensed claude-code-router routing model: five scenarios
 * (`default`, `background`, `longContext`, `reasoning`, `webSearch`) each map
 * to a provider/model target with optional fallback chains.
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

/** Default token threshold for {@link RoutingScenario.longContext}. */
export const DEFAULT_LONG_CONTEXT_THRESHOLD = 60_000;

/**
 * A route target spec: `providerId,modelId` or bare `modelId` (uses the
 * provider id equal to the model id's prefix when unqualified).
 */
export type RouteTargetSpec = string;

/** Per-scenario route table plus optional fallbacks. */
export type ScenarioRoutes = {
  /** Required default route when no other scenario matches. */
  default: RouteTargetSpec;
  background?: RouteTargetSpec;
  longContext?: RouteTargetSpec;
  /** Token count above which {@link RoutingScenario.longContext} applies. */
  longContextThreshold?: number;
  reasoning?: RouteTargetSpec;
  webSearch?: RouteTargetSpec;
  /** Ordered fallback targets tried when the primary provider fails. */
  fallbacks?: Partial<Record<RoutingScenario, readonly RouteTargetSpec[]>>;
};

/** A parsed route target ready for provider lookup. */
export type ParsedRouteTarget = {
  /** Provider id from config (may be undefined for bare model specs). */
  providerId?: string;
  /** Upstream model id sent to the provider. */
  model: string;
};

/** Outcome of routing a single request. */
export type RoutingDecision = {
  scenario: RoutingScenario;
  target: ParsedRouteTarget;
  tokenCount: number;
  reason: string;
  /** Zero-based index into the fallback chain (0 = primary). */
  fallbackIndex: number;
};

/** Minimal chat request shape used for scenario detection. */
export type RoutableChatRequest = {
  model?: string;
  messages?: Array<{
    role?: string;
    content?: unknown;
    tool_calls?: unknown;
  }>;
  tools?: Array<{ type?: string; function?: { name?: string }; name?: string }>;
  /** Extended thinking / reasoning budget (Anthropic or OpenAI o-series). */
  thinking?: { type?: string; budget_tokens?: number };
  /** OpenAI reasoning effort hint. */
  reasoning_effort?: string;
};

/** Minimal Anthropic Messages shape used for scenario detection. */
export type RoutableAnthropicRequest = {
  model?: string;
  system?: string | Array<{ type?: string; text?: string }>;
  messages?: Array<{ role?: string; content?: unknown }>;
  tools?: Array<{ name?: string }>;
  thinking?: { type?: string; budget_tokens?: number };
};
