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
  DEFAULT_PULL_COMMITTER,
  DELETED_FILE_HASH,
  materializeWorkspace,
  matchesPattern,
  PULL_BRANCH_PREFIX,
  pullRun
} from "./workspace.js";
export { GIT_MAX_BUFFER_BYTES, gitBinary, gitText } from "./git.js";
export type { GitOptions } from "./git.js";
export type {
  BlobFetcher,
  CaptureOptions,
  CapturedWorkspace,
  PullOptions,
  PullResult,
  WorkspaceOutput
} from "./workspace.js";
