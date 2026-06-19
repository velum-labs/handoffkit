/**
 * @warrant/protocol — the open, versioned data contracts of the Warrant
 * platform plus the primitives needed to create and verify them offline:
 *
 * - warrant.contract.v1   signed run authorization
 * - warrant.receipt.v1    signed record of what actually happened
 * - warrant.event.v1      hash-chained event log
 * - warrant.manifest.v1   workspace capture manifest
 * - warrant.policy.v1     org policy snapshot
 * - warrant.checkpoint.v1 resumable state at a semantic boundary
 * - warrant.envelope.v1   portable continuation (handoff) description
 *
 * Everything here is stable protocol surface: packages should consume these
 * interfaces instead of recreating local string lists or proof logic.
 */

export {
  ACTOR_KINDS,
  AGENT_KINDS,
  CHECKPOINT_TIERS,
  DISCLOSURE_MODES,
  HEX_HASH_PATTERN,
  isAgentKind,
  isTerminalStatus,
  MODEL_FUSION_SCHEMA_NAMES,
  PROTOCOL_VERSIONS,
  RUN_EVENT_TYPES,
  RUN_STATUSES,
  SESSION_ISOLATIONS,
  TERMINAL_RUN_STATUSES
} from "./constants.js";
export {
  parseHostAllowlistEntry,
  parsePoolName,
  parseSecretName,
  parseWorkspaceManifestPath
} from "./validators.js";
export { defaultExecutionSpec, executionFromRunRequest } from "./execution.js";
export type {
  ExecutionEnv,
  ExecutionLogPolicy,
  ExecutionSpec
} from "./execution.js";
export {
  evaluateToolPolicy,
  modelFusionSideEffects,
  toolArgumentsHash,
  toolCallKey,
  toolSideEffectClassFromModelFusion
} from "./tool-executor.js";
export type {
  ToolDefinition,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolExecutorBudget,
  ToolExecutorContract,
  ToolExecutorLimits,
  ToolExecutorMode,
  ToolPolicyDecision,
  ToolSideEffectClass
} from "./tool-executor.js";
export { canonicalize } from "./jcs.js";
export type { JsonValue } from "./jcs.js";
export {
  artifactHash,
  hashCanonical,
  hashCanonicalSha256,
  requestHash,
  responseHash,
  schemaBundleHash,
  SHA256_PREFIX,
  sha256Hex,
  sha256PrefixedHex
} from "./hash.js";
export {
  MODEL_FUSION_SCHEMA_BUNDLE_HASH,
  assertArtifactRefV1,
  assertBenchmarkTaskRecordV1,
  assertEnsembleReceiptV1,
  assertHarnessCandidateRecordV1,
  assertHarnessRunRequestV1,
  assertHarnessRunResultV1,
  assertJudgeSynthesisRecordV1,
  assertModelCallRecordV1,
  assertModelFusionRecord,
  assertToolCallPlanV1,
  assertToolExecutionRecordV1
} from "./model-fusion.js";
export {
  executeHarnessTask,
  MODEL_FUSION_HARNESS_EXECUTOR_PATH,
  MODEL_FUSION_OPENAPI_SOURCE_HASH
} from "./generated/model-fusion-openapi.js";
export type {
  ExecuteHarnessTaskClientOptions,
  ModelFusionOpenApiArtifactRef,
  ModelFusionOpenApiErrorResponse,
  ModelFusionOpenApiHarnessExecutionRequest,
  ModelFusionOpenApiHarnessExecutionResult,
  ModelFusionOpenApiPersistedJsonRecord
} from "./generated/model-fusion-openapi.js";
export type {
  ArtifactRefV1,
  ArtifactRef,
  BenchmarkScorer,
  BenchmarkScorerKind,
  BenchmarkSourceRepo,
  BenchmarkTaskKind,
  BenchmarkTaskRecordV1,
  ContractMetadataV1,
  EnsembleReceiptV1,
  HarnessCandidateRecordV1,
  HarnessRunRequestV1,
  HarnessRunResultV1,
  JudgeSynthesisDecision,
  JudgeSynthesisRecordV1,
  ModelCallRecordV1,
  ModelFusionArtifactKind,
  ModelFusionCapabilityStatus,
  ModelFusionChatMessage,
  ModelFusionChatRole,
  ModelFusionError,
  ModelFusionErrorKind,
  ModelFusionHarnessKind,
  ModelFusionRecordV1,
  ModelFusionRedactionStatus,
  ModelFusionSchemaName,
  ModelFusionSideEffects,
  ModelFusionStatus,
  ModelFusionUsage,
  ToolCallPlanV1,
  ToolExecutionRecordV1
} from "./model-fusion.js";
export {
  generateEd25519KeyPair,
  keyIdFromPublicPem,
  signData,
  verifyData
} from "./keys.js";
export type { KeyPairPem } from "./keys.js";
export { contractHash, signContract } from "./contract.js";
export { appendEvent, verifyChain } from "./chain.js";
export type { ChainVerification } from "./chain.js";
export {
  signReceipt,
  verifyReceiptBundle,
  verifyRunnerReceipt
} from "./receipt.js";
export type { BundleVerification } from "./receipt.js";
export { buildReceiptStory, summarizeRunEvent } from "./receipt-story.js";
export type { EventSummary, ReceiptStory } from "./receipt-story.js";
export {
  ambientTraceId,
  assertFusionTraceEvent,
  emitTrace,
  FUSION_TRACE_COMPONENTS,
  FUSION_TRACE_EVENT_SCHEMA,
  FUSION_TRACE_EVENT_TYPES,
  FUSION_TRACE_EVENT_VERSION,
  getTraceEmitter,
  isFusionTraceEvent,
  judgeFinalPayload,
  judgeRequestPayload,
  judgeThinkingPayload,
  modelCallFinishedPayload,
  modelCallStartedPayload,
  newSpanId,
  newTraceId,
  TRACE_CANDIDATE_HEADER,
  TRACE_ID_HEADER,
  TRACE_PARENT_SPAN_HEADER,
  TRACE_SPAN_HEADER,
  TraceEmitter
} from "./trace.js";
export type {
  EmitInput,
  FusionTraceComponent,
  FusionTraceEvent,
  FusionTraceEventType
} from "./trace.js";
export { PolicyDeniedError } from "./types.js";
export type {
  ActorRef,
  AgentKind,
  AgentSpec,
  ArtifactKind,
  AttestationTier,
  BudgetSpec,
  ChainedEvent,
  Checkpoint,
  CheckpointTier,
  ConsentRule,
  ContinuationRef,
  DataClassRule,
  DisclosureMode,
  DisclosureRecord,
  FailureClass,
  HandoffEnvelope,
  HandoffSource,
  HandoffTargetRef,
  KeyRef,
  ManifestFile,
  ModelUsageRecord,
  NetworkAccessRecord,
  NetworkPolicy,
  Policy,
  Receipt,
  ReceiptBundle,
  RetentionPolicy,
  RunContract,
  RunEvent,
  RunnerIdentity,
  RunnerSelector,
  RunStatus,
  SecretClaim,
  SecretReleaseRecord,
  SecretScopeRule,
  SemanticState,
  SessionIsolation,
  Signature,
  TaskSpec,
  ToolCallRecord,
  ToolJournal,
  WorkspaceManifest
} from "./types.js";
export type {
  ClaimResult,
  DisclosureReport,
  PolicyDecision,
  RunnerSummary,
  RunRequest,
  RunRequestInput,
  RunSummary,
  RunView
} from "./api.js";
