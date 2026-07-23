/**
 * @velum-labs/routekit-harness-core is the single coding-agent harness contract:
 * driver -> instance -> session interfaces, the canonical harness event
 * union (with raw provider envelopes), one tagged error taxonomy with
 * derived retryability, deferred-based approvals with explicit policies,
 * status probes with an identity-checked disk cache, and an explicit driver
 * registry. Drivers (tool-codex, tool-claude, tool-cursor, tool-opencode)
 * implement this contract; orchestrators and launchers consume it.
 */
export { HARNESS_KINDS, isHarnessKind } from "./kinds.js";
export type { HarnessKind } from "./kinds.js";

export {
  HARNESS_ERROR_CODES,
  HarnessError,
  asHarnessError,
  isRetryable
} from "./errors.js";
export type { HarnessErrorCategory, HarnessErrorCode } from "./errors.js";

export type {
  HarnessContentStream,
  HarnessEvent,
  HarnessEventRaw,
  HarnessEventType,
  HarnessItemType,
  HarnessRequestType,
  HarnessTokenUsage,
  HarnessTurnEndReason
} from "./events.js";

export {
  DEFAULT_AUTOMATION_APPROVAL_POLICY,
  PendingRequests,
  createDeferred,
  decideApproval
} from "./approvals.js";
export type { ApprovalDecision, ApprovalPolicy, Deferred, PendingRequest } from "./approvals.js";

export {
  DEFAULT_STATUS_CACHE_DIR,
  readCachedStatus,
  statusSkipReason,
  writeCachedStatus
} from "./status.js";
export type { HarnessAuthStatus, HarnessModelDescriptor, HarnessStatus } from "./status.js";

export type {
  AnyHarnessDriver,
  DriverContext,
  HarnessDriver,
  HarnessInstance,
  ResumeCursor,
  SessionHandle,
  SessionTurnInput,
  StartSessionOptions
} from "./contract.js";

export { DriverRegistry } from "./registry.js";

export {
  createCachedHarnessDriver,
  probeCliVersion,
  resolveDriverEnv
} from "./driver-factory.js";
export type {
  CachedHarnessDriverInput,
  CliVersionProbeInput
} from "./driver-factory.js";

export { AsyncChannel } from "./channel.js";

export { EventLog } from "./logging.js";
export type { EventLogOptions } from "./logging.js";

export {
  asArray,
  asObject,
  asString,
  createStreamJsonStepEmitter,
  parseStreamJsonLine,
  parseStreamJsonTrajectory,
  streamJsonResultContentText,
  stringifyStreamJsonValue,
  STREAM_JSON_MAX_TEXT,
  STREAM_JSON_MAX_TOOL_INPUT,
  truncateStreamJsonText
} from "./stream-json.js";
export type {
  ParsedStreamJson,
  ParseStreamJsonOptions,
  StreamJsonEmitterOptions,
  StreamJsonStepText
} from "./stream-json.js";

export {
  DEFAULT_TMP_MANIFEST,
  createTrackedTmpDir,
  releaseTrackedTmpDir,
  sweepTrackedTmpDirs
} from "./tmp-sweep.js";

export {
  buildChildEnv,
  freePort,
  runCliCapture,
  spawnLogged,
  terminate,
  waitForHttp,
  waitForOutput,
  withDeadline,
  withTimeout
} from "./process.js";
export type {
  BuildChildEnvInput,
  CliCaptureOptions,
  CliCaptureResult,
  LoggedChild,
  LoggedSpawnOptions
} from "./process.js";
