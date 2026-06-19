/**
 * @fusionkit/runner — outbound-only runner: claims signed contracts,
 * materializes workspaces, runs vendor agent harnesses inside governed
 * sessions, and signs receipts.
 *
 * The public surface is deliberately small: the Runner itself, the
 * SessionBackend seam that isolation tiers implement, and the execution
 * helpers those backends share. Everything else is runner-internal.
 */
export { Runner } from "./runner.js";
export { CapabilityMismatchError } from "./session.js";
export type {
  SessionBackend,
  SessionBackendResult,
  SessionExecution
} from "./backend.js";
export {
  executionHash,
  executionSpecFor,
  prepareExecution,
  requireShellExecution,
  resolveSessionEnv
} from "./execution.js";
export type { BackendExecutionKind } from "./execution.js";
