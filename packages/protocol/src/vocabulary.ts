import type {
  ActorRef,
  AgentKind,
  ArtifactKind,
  AttestationTier,
  CheckpointTier,
  DisclosureMode,
  FailureClass,
  RunEvent,
  RunStatus,
  SessionIsolation,
  Signature
} from "./types.js";

export const RUN_STATUSES = [
  "created",
  "claimed",
  "provisioning",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled"
] as const satisfies readonly RunStatus[];

export const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled"
] as const satisfies readonly RunStatus[];

export const CANCELLABLE_RUN_STATUSES = [
  "created",
  "awaiting_approval"
] as const satisfies readonly RunStatus[];

export const RECEIPT_STATUSES = [
  "completed",
  "failed",
  "cancelled"
] as const satisfies readonly RunStatus[];

export const AGENT_KINDS = [
  "claude-code",
  "codex",
  "mock",
  "command"
] as const satisfies readonly AgentKind[];

export const SESSION_ISOLATIONS = [
  "process",
  "hermetic",
  "vercel-sandbox"
] as const satisfies readonly SessionIsolation[];

export const DISCLOSURE_MODES = [
  "none",
  "metadata-only",
  "redacted",
  "minimal-context",
  "full"
] as const satisfies readonly DisclosureMode[];

export const CHECKPOINT_TIERS = [
  "semantic",
  "workspace"
] as const satisfies readonly CheckpointTier[];

export const ACTOR_KINDS = [
  "human",
  "service"
] as const satisfies readonly ActorRef["kind"][];

export const ARTIFACT_KINDS = [
  "diff",
  "log",
  "file",
  "bundle",
  "trace"
] as const satisfies readonly ArtifactKind[];

export const FAILURE_CLASSES = [
  "policy_denied",
  "consent_timeout",
  "capability_mismatch",
  "attestation_failed",
  "secret_release_denied",
  "capture_failed",
  "transfer_failed",
  "session_failed",
  "side_effect_conflict",
  "budget_exceeded"
] as const satisfies readonly FailureClass[];

export const ATTESTATION_TIERS = [
  "mock",
  "standard",
  "zdr",
  "cpu-tee",
  "cpu-gpu-tee"
] as const satisfies readonly AttestationTier[];

export const SIGNERS = [
  "org",
  "plane",
  "runner"
] as const satisfies readonly Signature["signer"][];

/**
 * Every event type a run can record. The `Record` satisfies-check makes the
 * map provably complete: adding a `RunEvent` variant fails compilation here
 * until the vocabulary (and therefore every renderer parity test) learns
 * it. Renderers that cannot import this module (the dependency-free control
 * panel) are held to the same set by a parity test instead.
 */
const RUN_EVENT_TYPE_MAP = {
  "run.created": true,
  "run.claimed": true,
  "workspace.materialized": true,
  "policy.evaluated": true,
  "consent.requested": true,
  "consent.granted": true,
  "secret.released": true,
  "command.executed": true,
  "file.changed": true,
  "network.connected": true,
  "model.called": true,
  "boundary.crossed": true,
  "artifact.created": true,
  "checkpoint.created": true,
  "run.completed": true,
  "run.failed": true,
  "run.cancelled": true
} as const satisfies Record<RunEvent["type"], true>;

export const RUN_EVENT_TYPES = Object.keys(
  RUN_EVENT_TYPE_MAP
) as readonly RunEvent["type"][];

export const HEX_HASH_PATTERN = /^[0-9a-f]{64}$/;

function includes<T extends string>(
  values: readonly T[],
  value: string
): value is T {
  return (values as readonly string[]).includes(value);
}

export function isRunStatus(value: string): value is RunStatus {
  return includes(RUN_STATUSES, value);
}

export function isTerminalStatus(status: RunStatus): boolean {
  return includes(TERMINAL_RUN_STATUSES, status);
}

export function isAwaitingApprovalStatus(status: RunStatus): boolean {
  return status === "awaiting_approval";
}

export function isCancellableStatus(status: RunStatus): boolean {
  return includes(CANCELLABLE_RUN_STATUSES, status);
}

export function isReceiptStatus(
  status: RunStatus
): status is Extract<RunStatus, "completed" | "failed" | "cancelled"> {
  return includes(RECEIPT_STATUSES, status);
}

export function isReceiptAvailableStatus(status: RunStatus): boolean {
  return isReceiptStatus(status);
}

export function isAgentKind(value: string): value is AgentKind {
  return includes(AGENT_KINDS, value);
}

export function isSessionIsolation(value: string): value is SessionIsolation {
  return includes(SESSION_ISOLATIONS, value);
}

export function isDisclosureMode(value: string): value is DisclosureMode {
  return includes(DISCLOSURE_MODES, value);
}

export function isCheckpointTier(value: string): value is CheckpointTier {
  return includes(CHECKPOINT_TIERS, value);
}
