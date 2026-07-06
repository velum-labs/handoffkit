/**
 * @fusionkit/protocol is the open, versioned data contract layer.
 *
 * It exports signed run contracts, receipts, hash-chained event logs, workspace
 * manifests, policy snapshots, checkpoints, handoff envelopes, model-fusion
 * schemas, generated OpenAPI clients, hashing, signing, verification, trace
 * events, validators, and normalization helpers.
 *
 * Everything here is stable protocol surface. Packages should consume these
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
  assertWireTrajectory,
  isWireTrajectory,
  normalizeWireTrajectories
} from "./fusion-wire.js";
export type { WireTrajectory } from "./fusion-wire.js";
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
  ATTR,
  EXPORTABLE_ATTRIBUTES,
  FUSION_CONVENTIONS_VERSION,
  FUSION_MARKER_NAMES,
  FUSION_SCOPES,
  FUSION_SPAN_NAMES,
  FUSION_UNIT_SPAN_NAMES
} from "./generated/trace-conventions.js";
export type {
  FusionAttributeKey,
  FusionMarkerName,
  FusionSpanName
} from "./generated/trace-conventions.js";
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
