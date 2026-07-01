/**
 * @fusionkit/adapter-ai-sdk is the AI SDK side of FusionKit for app-owned loops.
 *
 * The application keeps its own generateText or streamText loop and its own
 * model; FusionKit governs the execution boundary. remoteTools returns AI
 * SDK-compatible tools whose calls run as signed contracts in governed runner
 * sessions and return with offline-verifiable receipts. The model surfaces
 * withModel, routedModel, and mlxServer route the caller's own loop across
 * local and cloud models with every decision recorded.
 */
export { remoteTools } from "./remote-tools.js";
export type {
  RemoteToolCallRecord,
  RemoteTools,
  RemoteToolsConfig,
  RemoteToolsContextConfig
} from "./remote-tools.js";
export { swarmTools } from "./swarm-tools.js";
export type {
  DispatchInput,
  DispatchOutput,
  EscalateInput,
  EscalateOutput,
  PullInput,
  PullOutput,
  StatusInput,
  StatusOutput,
  SwarmPlane,
  SwarmRunRecord,
  SwarmTools,
  SwarmToolsConfig,
  SwarmToolsContextConfig,
  SwarmToolSet,
  WorkerTaskInput
} from "./swarm-tools.js";
export { handoffModel, withModel } from "./model.js";
export type { EscalationReason, HandoffModelConfig } from "./model.js";
export { loadRouterCard, routedModel, withRoutedModel } from "./routed-model.js";
export type { RouteDecision, RoutedModelConfig, RouterCard } from "./routed-model.js";
export { runWorktreeAgent, worktreeDiff } from "./worktree-agent.js";
export type {
  TrajectoryStep,
  TrajectoryStepType,
  WorktreeAgentInput,
  WorktreeAgentResult
} from "./worktree-agent.js";
export { defaultMlxDir, MlxCapabilityError, MlxEnv } from "./mlx-env.js";
export type { DownloadProgress, LocalModelInfo, ProvisionEvent } from "./mlx-env.js";
export { managedModelServer, mlxServer } from "./managed-server.js";
export type {
  ManagedModelServerOptions,
  ManagedServerEvent,
  MlxServerOptions
} from "./managed-server.js";
