/**
 * Warrant protocol types. These are the schemas marked for open
 * publication in the spec (warrant.contract.v1, warrant.receipt.v1,
 * warrant.event.v1, warrant.manifest.v1, warrant.policy.v1).
 */

import type { JsonValue } from "./jcs.js";
import type { ExecutionSpec } from "./execution.js";

export type RunStatus =
  | "created"
  | "claimed"
  | "provisioning"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type FailureClass =
  | "policy_denied"
  | "consent_timeout"
  | "capability_mismatch"
  | "attestation_failed"
  | "secret_release_denied"
  | "capture_failed"
  | "transfer_failed"
  | "session_failed"
  | "side_effect_conflict"
  | "budget_exceeded";

export type DisclosureMode =
  | "none"
  | "metadata-only"
  | "redacted"
  | "minimal-context"
  | "full";

export type CheckpointTier = "semantic" | "workspace";

export type AttestationTier = "mock" | "standard" | "zdr" | "cpu-tee" | "cpu-gpu-tee";

/**
 * How the runner isolates the agent session, recorded honestly in receipts:
 *
 * - "process": a child process with a scrubbed environment and an egress
 *   proxy. Enforcement is process-level — a malicious binary can ignore
 *   proxy variables — but every attempt is recorded.
 * - "hermetic": a simulated bash interpreter (just-bash) with a virtual
 *   filesystem rooted in the workspace and interpreter-enforced network
 *   allowlists. There are no real processes or sockets to escape with;
 *   only the "command" harness can run here.
 * - "vercel-sandbox": a Firecracker microVM (Vercel Sandbox) with
 *   VM-level isolation and domain-based egress policy.
 */
export type SessionIsolation = "process" | "hermetic" | "vercel-sandbox";

/**
 * "command" is the harness for app-owned loops and the compute adapter:
 * a single shell command executed inside a governed session. "mock" is the
 * built-in test harness. "pi" is a host-runtime harness with no vendor CLI:
 * it runs only through the AI SDK harness session backend, never as a
 * spawned process. The rest are vendor CLIs wrapped as-is.
 */
export type AgentKind = "claude-code" | "codex" | "pi" | "mock" | "command";

export type AgentSpec = {
  kind: AgentKind;
  version?: string;
};

export type TaskSpec = {
  prompt: string;
};

export type RunnerSelector = {
  pool: string;
};

export type ActorRef = {
  kind: "human" | "service";
  id: string;
};

export type KeyRef = {
  keyId: string;
  role: "org" | "plane" | "runner";
};

export type Signature = {
  keyId: string;
  alg: "ed25519";
  signer: "org" | "plane" | "runner";
  sig: string;
};

export type ManifestFile = {
  path: string;
  hash: string;
  bytes: number;
};

export type WorkspaceManifest = {
  version: "warrant.manifest.v1";
  baseRef: string;
  /** Hash of the git bundle blob containing history up to baseRef. */
  bundleHash: string;
  /** Hash of the binary diff blob for staged+unstaged changes, if any. */
  dirtyDiffHash?: string;
  /** Allowlisted untracked files, content-addressed. */
  untrackedFiles: ManifestFile[];
  /** Patterns that were denied capture; recorded so absence is provable. */
  deniedPatterns: string[];
  /** Paths that matched a deny pattern and were excluded. */
  deniedPaths: string[];
};

export type SecretClaim = {
  name: string;
  scope: string;
};

export type NetworkPolicy = {
  defaultDeny: boolean;
  allowHosts: string[];
};

export type BudgetSpec = {
  maxSpendUsd?: number;
  maxDurationMin?: number;
};

export type RunContract = {
  version: "warrant.contract.v1";
  runId: string;
  issuedAt: string;
  issuer: KeyRef;
  requestedBy: ActorRef;
  approvedBy?: ActorRef[];
  agent: AgentSpec;
  task: TaskSpec;
  runner: RunnerSelector;
  workspace: WorkspaceManifest;
  policyHash: string;
  secrets: SecretClaim[];
  network: NetworkPolicy;
  budget: BudgetSpec;
  disclosure: DisclosureMode;
  /** Durable machine intent. If absent, legacy contracts derive execution from agent/task. */
  execution?: ExecutionSpec;
  /** Requested session isolation. Defaults to "process". */
  isolation?: SessionIsolation;
  /** Present when this run continues prior work from a handoff envelope. */
  continuation?: ContinuationRef;
  expiresAt: string;
  signatures: Signature[];
};

export type DataClassRule = {
  dataClass: string;
  allowPools: string[];
};

export type SecretScopeRule = {
  name: string;
  scope: string;
  pools: string[];
};

export type ConsentRule = {
  when: "secret-release" | "any-run" | "agent-kind";
  match?: string;
  approvers: string[];
};

export type RetentionPolicy = {
  receiptsDays: number;
  artifactsDays: number;
};

export type Policy = {
  version: "warrant.policy.v1";
  runners: { allowPools: string[] };
  agents: { allow: AgentKind[] };
  dataClasses: DataClassRule[];
  network: NetworkPolicy;
  secrets: { releasable: SecretScopeRule[] };
  budget: { maxSpendUsd: number; maxDurationMin: number };
  consent: ConsentRule[];
  retention: RetentionPolicy;
};

export type ArtifactKind = "diff" | "log" | "file" | "bundle" | "trace";

export type RunEvent =
  | { type: "run.created" }
  | { type: "run.claimed"; runnerId: string; runnerKeyId: string }
  | { type: "workspace.materialized"; manifestHash: string }
  | { type: "policy.evaluated"; decision: "allow" | "ask"; reason: string }
  | { type: "consent.requested"; requirement: string }
  | { type: "consent.granted"; actor: ActorRef }
  | { type: "secret.released"; name: string; scope: string }
  | { type: "command.executed"; argvHash: string; exitCode: number }
  | { type: "file.changed"; path: string; contentHash: string }
  | { type: "network.connected"; host: string; decision: "allowed" | "blocked" }
  | { type: "model.called"; provider: string; model: string }
  | {
      type: "boundary.crossed";
      direction: "out" | "in";
      contentHash: string;
      dataClass: string;
    }
  | { type: "artifact.created"; kind: ArtifactKind; hash: string }
  | { type: "checkpoint.created"; checkpointId: string; tier: CheckpointTier }
  | { type: "run.completed" }
  | { type: "run.failed"; failure: FailureClass; message: string }
  | { type: "run.cancelled"; actor: ActorRef };

export type ChainedEvent = {
  version: "warrant.event.v1";
  seq: number;
  ts: string;
  /** Hash of the previous chained event; the genesis event uses the contract hash. */
  prev: string;
  event: RunEvent;
  /** sha256 over canonical JSON of {seq, ts, prev, event}. */
  hash: string;
};

export type RunnerIdentity = {
  runnerId: string;
  keyId: string;
  pool: string;
  attestationTier: AttestationTier;
  /** How the session was actually isolated. Absent in older receipts means "process". */
  isolation?: SessionIsolation;
};

export type SecretReleaseRecord = {
  name: string;
  scope: string;
  ts: string;
};

export type NetworkAccessRecord = {
  host: string;
  decision: "allowed" | "blocked";
};

export type ModelUsageRecord = {
  provider: string;
  model: string;
};

export type DisclosureRecord = {
  direction: "out" | "in";
  contentHash: string;
  dataClass: string;
};

export type Receipt = {
  version: "warrant.receipt.v1";
  runId: string;
  contractHash: string;
  runner: RunnerIdentity;
  startedAt: string;
  endedAt: string;
  status: Extract<RunStatus, "completed" | "failed" | "cancelled">;
  eventsHead: string;
  eventCount: number;
  workspaceIn: { baseRef: string; manifestHash: string };
  workspaceOut: { diffHash: string; artifactHashes: string[] };
  secretsReleased: SecretReleaseRecord[];
  networkAccessed: NetworkAccessRecord[];
  modelsUsed: ModelUsageRecord[];
  boundaryDisclosures: DisclosureRecord[];
  costUsd?: number;
  signatures: Signature[];
};

/**
 * Handoff protocol objects (warrant.checkpoint.v1, warrant.envelope.v1).
 *
 * A checkpoint captures resumable state at a semantic boundary. An envelope
 * is the portable description of a continuation: which checkpoint, which
 * agent, which target, and under which conditions work should continue.
 * Envelopes are content-addressed; the signed run contract pins the
 * envelope hash, so the continuation provenance is covered by the plane
 * signature without requiring requester-held keys.
 */

export type SemanticState = {
  /** Blob hash of the captured transcript, if one was attached. */
  transcriptHash?: string;
  /** Blob hash of the tool-call journal (warrant.tooljournal.v1), if any. */
  toolJournalHash?: string;
  /** Short human-readable summary of where the work stands. */
  note?: string;
};

/** One recorded tool invocation from an app-owned loop. */
export type ToolCallRecord = {
  seq: number;
  ts: string;
  toolName: string;
  input: JsonValue;
  output?: JsonValue;
  error?: string;
  durationMs: number;
};

/**
 * Tool-call history captured at semantic boundaries (warrant.tooljournal.v1).
 * Content-addressed and referenced from a checkpoint's semantic state, so a
 * continuation carries what the loop's tools saw and did.
 */
export type ToolJournal = {
  version: "warrant.tooljournal.v1";
  entries: ToolCallRecord[];
};

export type Checkpoint = {
  version: "warrant.checkpoint.v1";
  checkpointId: string;
  createdAt: string;
  tier: CheckpointTier;
  message?: string;
  semantic?: SemanticState;
  workspace?: WorkspaceManifest;
  /** Lineage: the checkpoint this one descends from, if any. */
  parent?: string;
};

export type HandoffSource = {
  kind: "local";
  actor: ActorRef;
  host?: string;
};

export type HandoffTargetRef = {
  kind: "runner-pool";
  pool: string;
};

export type HandoffEnvelope = {
  version: "warrant.envelope.v1";
  envelopeId: string;
  createdAt: string;
  source: HandoffSource;
  target: HandoffTargetRef;
  checkpoint: Checkpoint;
  agent: AgentSpec;
  task: TaskSpec;
  reason?: string;
  secrets: SecretClaim[];
  network: NetworkPolicy;
  budget: BudgetSpec;
  disclosure: DisclosureMode;
  /** Durable machine intent for this continuation. */
  execution?: ExecutionSpec;
  /** Requested session isolation for the continuation. */
  isolation?: SessionIsolation;
};

/** Reference embedded in a run contract when the run continues prior work. */
export type ContinuationRef = {
  envelopeHash: string;
  checkpointId: string;
  tier: CheckpointTier;
};

/** Self-contained bundle sufficient for fully offline verification. */
export type ReceiptBundle = {
  version: "warrant.bundle.v1";
  contract: RunContract;
  receipt: Receipt;
  events: ChainedEvent[];
  keys: {
    planePublicKeyPem: string;
    runnerPublicKeyPem: string;
    orgPublicKeyPem?: string;
  };
};

export class PolicyDeniedError extends Error {
  readonly code: FailureClass = "policy_denied";
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`policy denied: ${reasons.join("; ")}`);
    this.name = "PolicyDeniedError";
    this.reasons = reasons;
  }
}
