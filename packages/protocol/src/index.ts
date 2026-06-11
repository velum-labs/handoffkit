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
 * Zero runtime dependencies: everything here runs on Node built-ins only.
 */

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
export { signReceipt, verifyReceiptBundle } from "./receipt.js";
export type { BundleVerification } from "./receipt.js";
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
  Signature,
  TaskSpec,
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
