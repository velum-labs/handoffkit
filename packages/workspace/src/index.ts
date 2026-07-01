/**
 * @fusionkit/workspace owns git workspace capture, materialization, output
 * collection, safe path resolution, and divergence-safe pull.
 *
 * The CLI uses it to capture state before a run, the runner uses it to
 * materialize state inside a session and collect output, and the handoff SDK
 * uses it to checkpoint the workspace before continuation.
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
