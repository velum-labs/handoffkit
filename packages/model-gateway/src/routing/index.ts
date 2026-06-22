/** Claude Code Router integration for the model gateway. */
export {
  RoutingBackend,
  formatRoutingDecision,
  previewRoutingForAnthropic,
  previewRoutingForChat,
  countRequestTokens
} from "./routing-backend.js";
export type { RoutingBackendOptions } from "./routing-backend.js";

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
} from "./routing.js";

export {
  parseRoutingProviderSpec,
  requireProvider,
  resolveRoutingProviders,
  RoutingProviderError,
  ROUTING_PROVIDER_KINDS
} from "./providers.js";
export type { ResolvedRoutingProvider, RoutingProviderKind, RoutingProviderSpec } from "./providers.js";

export {
  DEFAULT_LONG_CONTEXT_THRESHOLD,
  ROUTING_SCENARIOS
} from "./types.js";
export type {
  ParsedRouteTarget,
  RouteTargetSpec,
  RoutableAnthropicRequest,
  RoutableChatRequest,
  RoutingDecision,
  RoutingScenario,
  ScenarioRoutes
} from "./types.js";
