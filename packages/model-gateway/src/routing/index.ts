/** Claude Code Router integration for the model gateway. */
export {
  RoutingBackend,
  formatRoutingDecision,
  previewRoutingForAnthropic,
  previewRoutingForChat,
  countRequestTokens
} from "./routing/routing-backend.js";
export type { RoutingBackendOptions } from "./routing/routing-backend.js";

export {
  countAnthropicTokens,
  countRequestTokens as countRoutableTokens,
  detectRoutingScenario,
  extractRequestText,
  fallbackChain,
  hasWebSearchTools,
  isBackgroundRequest,
  isReasoningRequest,
  parseRouteTarget,
  parseScenarioRoutes,
  resolveRoutingDecision,
  resolveRoutingFallback,
  RoutingConfigError
} from "./routing/routing.js";

export {
  parseRoutingProviderSpec,
  requireProvider,
  resolveRoutingProviders,
  RoutingProviderError
} from "./routing/providers.js";
export type { ResolvedRoutingProvider, RoutingProviderKind, RoutingProviderSpec } from "./routing/providers.js";

export {
  DEFAULT_LONG_CONTEXT_THRESHOLD,
  ROUTING_PROVIDER_KINDS,
  ROUTING_SCENARIOS
} from "./routing/types.js";
export type {
  ParsedRouteTarget,
  RouteTargetSpec,
  RoutableAnthropicRequest,
  RoutableChatRequest,
  RoutingDecision,
  RoutingScenario,
  ScenarioRoutes
} from "./routing/types.js";
