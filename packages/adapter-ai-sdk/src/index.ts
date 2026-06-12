/**
 * @warrant/adapter-ai-sdk — the AI SDK side of Warrant for app-owned loops.
 *
 * The application keeps its own `generateText`/`streamText` loop and its own
 * model; Warrant governs the execution boundary. `remoteTools(...)` returns
 * AI SDK-compatible tools whose calls run as signed contracts in governed
 * runner sessions and return with offline-verifiable receipts. The model
 * surfaces (`withModel`, `routedModel`, `mlxServer`) route the caller's own
 * loop across local and cloud models with every decision recorded.
 */
export { remoteTools } from "./remote-tools.js";
export type {
  RemoteToolCallRecord,
  RemoteTools,
  RemoteToolsConfig,
  RemoteToolsContextConfig
} from "./remote-tools.js";
export { handoffModel, withModel } from "./model.js";
export type { EscalationReason, HandoffModelConfig } from "./model.js";
export { loadRouterCard, routedModel, withRoutedModel } from "./routed-model.js";
export type { RouteDecision, RoutedModelConfig, RouterCard } from "./routed-model.js";
export { defaultMlxDir, MlxCapabilityError, MlxEnv } from "./mlx-env.js";
export { managedModelServer, mlxServer } from "./managed-server.js";
export type {
  ManagedModelServerOptions,
  ManagedServerEvent,
  MlxServerOptions
} from "./managed-server.js";
