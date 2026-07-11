/**
 * @fusionkit/adapter-ai-sdk is the AI SDK side of FusionKit local-model flows.
 *
 * This product package contains managed MLX local-model helpers and worktree
 * agent utilities. Governed remote tools, swarm tools, and handoff-aware model
 * routing live in the legacy `@fusionkit/handoff` package.
 */
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
