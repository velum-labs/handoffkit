/**
 * Tool integration entry point. It exposes the launcher and harness integration contract, registry helpers, process helpers, constants, environment compatibility helpers, and skipped-candidate utilities.
 */
export {
  captureWorktreeDiff,
  commandOnPath,
  distillLog,
  formatDurationMs,
  freePort,
  runCliCapture,
  sleep,
  spawnLogged,
  spawnTool,
  terminate,
  waitForHttp,
  waitForOutput,
  withDeadline,
  withTimeout
} from "./proc.js";
export type {
  CliCaptureOptions,
  CliCaptureResult,
  LoggedChild,
  LoggedSpawnOptions
} from "./proc.js";
export {
  CANDIDATE_ISOLATION_DEFAULTS,
  escapeMarkdownCell,
  markdownTable,
  RUNTIME_TIMEOUT_MS
} from "@fusionkit/runtime-utils";
export type {
  ToolDashboardLiveSmoke,
  ToolDashboardMetadata,
  ToolDashboardSmoke,
  ToolHarnessMetadata,
  ToolIntegration,
  ToolLaunchContext,
  ToolLaunchMode
} from "./types.js";
export { createToolRegistry } from "./registry.js";
export type { ToolRegistry } from "./registry.js";
export {
  CURSOR_BRIDGE_MODEL_NAME,
  DEFAULT_ENSEMBLE_NAME,
  FUSION_PANEL_MODEL,
  fusionModelId,
  LOCAL_MODEL_LABEL
} from "./constants.js";
export {
  envFlagEnabled,
  HARNESS_DRIVERS_FLAG,
  harnessDriversEnabled,
  legacyEnvName,
  readEnv
} from "./env-compat.js";
export {
  buildChildEnv,
  DEFAULT_BRIDGE_SCRUB_PREFIXES,
  definedEnv,
  normalizeApiBaseUrl,
  scrubBridgeEnv
} from "./env.js";
export type { BuildChildEnvInput } from "./env.js";
export { buildSkippedCandidate } from "./candidate.js";
