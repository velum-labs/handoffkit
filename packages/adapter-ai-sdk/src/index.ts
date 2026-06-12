/**
 * @warrant/adapter-ai-sdk — the AI SDK side of Warrant for app-owned loops.
 *
 * The application keeps its own `generateText`/`streamText` loop and its own
 * model; Warrant governs the execution boundary. `remoteTools(...)` returns
 * AI SDK-compatible tools whose calls run as signed contracts in governed
 * runner sessions and return with offline-verifiable receipts.
 */
export { remoteTools } from "./remote-tools.js";
export type {
  RemoteToolCallRecord,
  RemoteTools,
  RemoteToolsConfig,
  RemoteToolSet,
  ShellToolInput,
  ShellToolOutput
} from "./remote-tools.js";
export { HandoffModel, handoffModel, withModel } from "./model.js";
export type { EscalationReason, HandoffModelConfig } from "./model.js";
export { loadRouterCard, RoutedModel, routedModel, withRoutedModel } from "./routed-model.js";
export type { RouteDecision, RoutedModelConfig, RouterCard } from "./routed-model.js";
export {
  defaultMlxDir,
  MLX_LM_PIN,
  MlxCapabilityError,
  MlxEnv,
  PYTHON_PIN
} from "./mlx-env.js";
export type { MlxEnvManifest, MlxEnvOptions, SpawnSpec } from "./mlx-env.js";
export {
  DEFAULT_IDLE_SHUTDOWN_MS,
  DEFAULT_SHUTDOWN_GRACE_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  ManagedModelServer,
  managedModelServer,
  mlxServer
} from "./managed-server.js";
export type {
  ManagedModelServerOptions,
  ManagedServerEvent,
  ManagedServerStatus,
  MlxServerOptions
} from "./managed-server.js";
