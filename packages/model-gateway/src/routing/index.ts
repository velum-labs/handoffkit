/** Claude Code Router integration for the model gateway. */
export {
  RoutingBackend,
  formatRoutingDecision,
  previewRoutingForAnthropic,
  previewRoutingForChat,
  countRequestTokens,
  resolveModelForProviderId
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
  classifyProviderError,
  disposeRoutingMlxBackends,
  parseRoutingProviderSpec,
  requireProvider,
  resolveProviderBaseUrl,
  resolveRoutingProviders,
  RoutingProviderError,
  ROUTING_PROVIDER_KINDS,
  sanitizeDeepSeekRequest,
  sanitizeGroqRequest,
  sanitizeProviderRequest
} from "./providers.js";
export type {
  ProviderErrorAction,
  ResolvedRoutingProvider,
  RoutingProviderKind,
  RoutingProviderSpec
} from "./providers.js";

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
