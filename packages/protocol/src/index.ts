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
  AGENT_KINDS,
  ARTIFACT_KINDS,
  ATTESTATION_TIERS,
  ACTOR_KINDS,
  CANCELLABLE_RUN_STATUSES,
  CHECKPOINT_TIERS,
  DISCLOSURE_MODES,
  FAILURE_CLASSES,
  HEX_HASH_PATTERN,
  isAgentKind,
  isAwaitingApprovalStatus,
  isCancellableStatus,
  isCheckpointTier,
  isDisclosureMode,
  isReceiptAvailableStatus,
  isReceiptStatus,
  isRunStatus,
  isSessionIsolation,
  isTerminalStatus,
  KEY_ID_HEX_LENGTH,
  PROTOCOL_VERSIONS,
  RECEIPT_STATUSES,
  RUN_EVENT_TYPES,
  RUN_STATUSES,
  SESSION_ISOLATIONS,
  SIGNERS,
  TERMINAL_RUN_STATUSES
} from "./constants.js";
export {
  parseAgentKind,
  parseDisclosureMode,
  parseHashHex,
  parseHostAllowlistEntry,
  parseManifestFile,
  parsePoolName,
  parseRunId,
  parseSecretName,
  parseSessionIsolation,
  parseWorkspaceManifest,
  parseWorkspaceManifestPath,
  POOL_NAME_PATTERN,
  RUN_ID_PATTERN,
  SECRET_NAME_PATTERN,
  WORKSPACE_RELATIVE_PATH_PATTERN
} from "./validators.js";
export { defaultExecutionSpec, executionFromRunRequest } from "./execution.js";
export type {
  ExecutionEnv,
  ExecutionLogPolicy,
  ExecutionSpec
} from "./execution.js";
export { canonicalize } from "./jcs.js";
export type { JsonValue } from "./jcs.js";
export { hashCanonical, sha256Hex } from "./hash.js";
export {
  generateEd25519KeyPair,
  keyIdFromPublicPem,
  signData,
  verifyData
} from "./keys.js";
export type { KeyPairPem } from "./keys.js";
export {
  contractHash,
  signContract,
  verifyContractSignature
} from "./contract.js";
export type { KeyResolver } from "./contract.js";
export { appendEvent, verifyChain } from "./chain.js";
export type { ChainVerification } from "./chain.js";
export {
  signReceipt,
  verifyReceiptBundle,
  verifyReceiptSignature,
  verifyRunnerReceipt
} from "./receipt.js";
export type {
  BundleVerification,
  RunnerReceiptVerificationInput
} from "./receipt.js";
export {
  buildReceiptStory,
  summarizeChainedEvent,
  summarizeDisclosureReport,
  summarizeRunEvent
} from "./receipt-story.js";
export type { EventSummary, ReceiptStory } from "./receipt-story.js";
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
