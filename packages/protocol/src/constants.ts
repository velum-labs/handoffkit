/**
 * Versioned schema identifiers and shared enumerations, referenced instead
 * of inlining string literals across packages. The literal-typed `as const`
 * values still satisfy the corresponding `version: "..."` fields.
 */
export {
  ACTOR_KINDS,
  AGENT_KINDS,
  CHECKPOINT_TIERS,
  DISCLOSURE_MODES,
  HEX_HASH_PATTERN,
  isAgentKind,
  isTerminalStatus,
  RUN_EVENT_TYPES,
  RUN_STATUSES,
  SESSION_ISOLATIONS,
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

export const MODEL_FUSION_SCHEMA_NAMES = [
  "model-call-record.v1",
  "harness-run-request.v1",
  "harness-run-result.v1",
  "harness-candidate-record.v1",
  "judge-synthesis-record.v1",
  "benchmark-task-record.v1",
  "artifact-ref.v1",
  "tool-call-plan.v1",
  "tool-execution-record.v1",
  "ensemble-receipt.v1"
] as const;

/**
 * Length (in hex characters) of the public-key fingerprint embedded in a
 * key id. 16 hex = 64 bits of a SHA-256 digest: ample collision resistance
 * for identifying enrolled keys while keeping ids short and readable.
 */
export const KEY_ID_HEX_LENGTH = 16;
