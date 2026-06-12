/**
 * Versioned schema identifiers and shared enumerations, referenced instead
 * of inlining string literals across packages. The literal-typed `as const`
 * values still satisfy the corresponding `version: "..."` fields.
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
  RECEIPT_STATUSES,
  RUN_STATUSES,
  SESSION_ISOLATIONS,
  SIGNERS,
  TERMINAL_RUN_STATUSES
} from "./vocabulary.js";

export const PROTOCOL_VERSIONS = {
  contract: "warrant.contract.v1",
  receipt: "warrant.receipt.v1",
  event: "warrant.event.v1",
  manifest: "warrant.manifest.v1",
  policy: "warrant.policy.v1",
  checkpoint: "warrant.checkpoint.v1",
  envelope: "warrant.envelope.v1",
  bundle: "warrant.bundle.v1",
  toolJournal: "warrant.tooljournal.v1",
  sealed: "warrant.sealed.v1"
} as const;

/**
 * Length (in hex characters) of the public-key fingerprint embedded in a
 * key id. 16 hex = 64 bits of a SHA-256 digest: ample collision resistance
 * for identifying enrolled keys while keeping ids short and readable.
 */
export const KEY_ID_HEX_LENGTH = 16;
