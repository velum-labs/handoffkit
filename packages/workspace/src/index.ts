/**
 * @warrant/workspace — git workspace capture, materialization, output
 * collection, and divergence-safe pull. Shared by the CLI (capture before
 * a run), the runner (materialize inside a session, collect the output),
 * and the handoff SDK (checkpoint the workspace before continuation).
 */

export {
  captureWorkspace,
  collectOutput,
  materializeWorkspace,
  pullRun
} from "./workspace.js";
export { gitText } from "./git.js";
export { parseWorkspaceRelativePath, resolveInsideWorkspace } from "./paths.js";
export type {
  CapturedWorkspace,
  PullResult,
  WorkspaceOutput
} from "./workspace.js";
