import type {
  ActorRef,
  ChainedEvent,
  ContinuationRef,
  Receipt,
  RunContract,
  RunRequest,
  RunStatus
} from "@warrant/protocol";

export type { RunRequest };

export type RunRecord = {
  id: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  request: RunRequest;
  consentRequirements: string[];
  approvals: ApprovalRecord[];
  contract?: RunContract;
  claimedBy?: string;
  failureMessage?: string;
};

export type ApprovalRecord = {
  actor: ActorRef;
  ts: string;
  /** Present when the approval was backed by a verified IdP assertion. */
  idpSubject?: string;
  idpIssuer?: string;
};

export type RunnerRecord = {
  runnerId: string;
  pool: string;
  publicKeyPem: string;
  tokenHash: string;
  enrolledAt: string;
};

/** A principal authorized to call the plane, identified by a hashed key. */
export type PrincipalRole = "admin" | "requester" | "approver" | "enroller";

export type PrincipalRecord = {
  principalId: string;
  name: string;
  role: PrincipalRole;
  /** sha256 of the bearer token; the token itself is never stored. */
  tokenHash: string;
  createdAt: string;
  /** Set when revoked; revoked principals never authenticate. */
  revokedAt?: string;
};

/** A single-use, expiring runner enrollment token (hashed at rest). */
export type EnrollTokenRecord = {
  tokenHash: string;
  pool?: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
};

export type RunSummaryRow = {
  record: RunRecord;
  hasReceipt: boolean;
};

/**
 * Durable, transactional storage for the control plane. The default
 * implementation ([sqlite-store.ts](sqlite-store.ts)) is backed by
 * node:sqlite with WAL and immediate-transaction claims; the interface is
 * deliberately narrow so a Postgres adapter can be added for multi-node
 * deployments without touching the plane logic.
 */
// TODO(brittle): claimNextRun and rate limiting assume single-writer semantics; multi-node needs a shared store + distributed limiter.
export interface PlaneStore {
  /** Release any underlying handles. */
  close(): void;

  // Runs
  saveRun(record: RunRecord): void;
  getRun(runId: string): RunRecord | undefined;
  listRuns(): RunRecord[];
  /**
   * Atomically claim the oldest `created` run in a pool: transition it to
   * `claimed` for the runner and return the updated record, or undefined if
   * none is available. Must be a single transaction (compare-and-set).
   */
  claimNextRun(
    pool: string,
    runnerId: string,
    now: string
  ): RunRecord | undefined;

  // Events
  appendEvents(runId: string, events: ChainedEvent[]): void;
  getEvents(runId: string): ChainedEvent[];
  /** All events across all runs at or after `sinceMs`, oldest first. */
  exportEvents(sinceMs: number): { runId: string; event: ChainedEvent }[];

  // Receipts
  saveReceipt(runId: string, receipt: Receipt): void;
  getReceipt(runId: string): Receipt | undefined;

  // Blobs (content-addressed)
  putBlob(content: Buffer): string;
  getBlob(hash: string): Buffer | undefined;

  // Runners
  saveRunner(record: RunnerRecord): void;
  getRunnerByTokenHash(tokenHash: string): RunnerRecord | undefined;
  getRunnerById(runnerId: string): RunnerRecord | undefined;
  listRunners(): RunnerRecord[];

  // Principals
  savePrincipal(record: PrincipalRecord): void;
  getPrincipalByTokenHash(tokenHash: string): PrincipalRecord | undefined;
  getPrincipalByName(name: string): PrincipalRecord | undefined;
  listPrincipals(): PrincipalRecord[];
  revokePrincipal(principalId: string, now: string): boolean;

  // Enrollment tokens (single-use)
  saveEnrollToken(record: EnrollTokenRecord): void;
  /** Atomically consume an enroll token; returns it if valid and unused. */
  consumeEnrollToken(tokenHash: string, now: string): EnrollTokenRecord | undefined;

  // Claim-completion nonces (replay protection)
  /** Record a nonce; returns false if it was already present (a replay). */
  recordClaimNonce(nonce: string, expiresAtMs: number): boolean;
  /** Delete claim nonces whose expiry is at or before `nowMs`. */
  pruneClaimNonces(nowMs: number): number;

  // Retention / GC
  /** Delete terminal runs (and their events/receipts) updated before the cutoff. */
  deleteRunsUpdatedBefore(cutoffMs: number, terminalStatuses: RunStatus[]): string[];
  /** Delete every blob whose hash is not in `keep`; returns the count removed. */
  deleteBlobsExcept(keep: Set<string>): number;
  countBlobs(): number;
}

export type ContinuationRefOrUndefined = ContinuationRef | undefined;
