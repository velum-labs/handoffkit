/**
 * @warrant/runner — outbound-only runner: claims signed contracts,
 * materializes workspaces, runs vendor agent harnesses inside governed
 * sessions, and signs receipts.
 */
export { Runner } from "./runner.js";
export type { RunnerOptions } from "./runner.js";
export { CapabilityMismatchError, runSession } from "./session.js";
export type { SessionResult } from "./session.js";
export { ProcessSessionBackend } from "./process-backend.js";
export type {
  SessionBackend,
  SessionBackendResult,
  SessionExecution
} from "./backend.js";
export { buildAgentCommand } from "./agents.js";
export type { AgentCommand, AgentContext } from "./agents.js";
export {
  DEFAULT_TIMEOUT_MS,
  defaultExecutionForContract,
  executionHash,
  executionSpecFor,
  prepareExecution,
  requireShellExecution,
  resolveSessionEnv
} from "./execution.js";
export type {
  BackendExecutionKind,
  PreparedExecution,
  PrepareExecutionInput
} from "./execution.js";
export { startEgressProxy } from "./egress.js";
export type { EgressEvent, EgressProxy } from "./egress.js";
