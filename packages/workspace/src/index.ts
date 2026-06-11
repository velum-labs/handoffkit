/**
 * @warrant/workspace — git workspace capture, materialization, output
 * collection, and divergence-safe pull. Shared by the CLI (capture before
 * a run), the runner (materialize inside a session, collect the output),
 * and the handoff SDK (checkpoint the workspace before continuation).
 */

export {
  captureWorkspace,
  collectOutput,
  DEFAULT_DENY_PATTERNS,
  materializeWorkspace,
  matchesPattern,
  pullRun
} from "./workspace.js";
export type {
  BlobFetcher,
  CaptureOptions,
  CapturedWorkspace,
  PullOptions,
  PullResult,
  WorkspaceOutput
} from "./workspace.js";
