import { createPrivateKey, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  appendEvent,
  contractHash,
  executionFromRunRequest,
  hashCanonical,
  keyIdFromPublicPem,
  PROTOCOL_VERSIONS,
  verifyChain
} from "@fusionkit/protocol";
import type {
  ActorRef,
  ChainedEvent,
  ClaimResult,
  DisclosureReport,
  ExecutionSpec,
  Policy,
  PolicyDecision,
  Receipt,
  ReceiptBundle,
  RunContract,
  RunnerSummary,
  RunSummary,
  SecretClaim
} from "@fusionkit/protocol";

import { hashToken, principalCan, toPrincipal } from "./auth.js";
import type { Capability, Principal } from "./auth.js";
import { ClaimTokenService } from "./claim-token-service.js";
import { ContractService } from "./contract-service.js";
import { badRequest, conflict, notFound, unauthorized } from "./domain-errors.js";
import type { IdpVerifier } from "./idp.js";
import { createLogger, Metrics } from "./logging.js";
import type { Logger } from "./logging.js";
import { evaluatePolicy } from "./policy.js";
import { ReceiptService } from "./receipt-service.js";
import { RetentionSweeper } from "./retention.js";
import { assertRunTransition } from "./run-lifecycle.js";
import { SecretStore } from "./secrets.js";
import { SqliteStore } from "./sqlite-store.js";
import type {
  ApprovalRecord,
  PlaneStore,
  PrincipalRecord,
  PrincipalRole,
  RunRecord,
  RunRequest,
  RunnerRecord
} from "./store.js";

export type PlaneConfig = {
  dataDir: string;
  policy: Policy;
  planePrivateKeyPem: string;
  planePublicKeyPem: string;
  /** Bootstrap admin principal token. */
  adminToken: string;
  /** Bootstrap reusable enroller credential (also accepts single-use tokens). */
  enrollToken: string;
  secretStore: SecretStore;
  /** Inject a store (tests); defaults to SQLite at <dataDir>/<sqliteFilename>. */
  store?: PlaneStore;
  /** Verifier for IdP-issued approval assertions, when configured. */
  idp?: IdpVerifier;
  logger?: Logger;
  metrics?: Metrics;
  /** Start the background retention sweeper. Defaults to false. */
  startRetention?: boolean;
  /** Timeouts, sizes, and names; sensible defaults below. */
  tuning?: Partial<PlaneTuning>;
};

/** Tunable plane parameters. Defaults are in DEFAULT_PLANE_TUNING. */
export type PlaneTuning = {
  /** Validity of a runner claim token. */
  claimTokenTtlMs: number;
  /** Validity of an issued run contract. */
  contractTtlMs: number;
  /** How long a completion nonce is retained past claim-token expiry. */
  nonceTtlMs: number;
  /** Default validity of a minted single-use enroll token. */
  enrollTokenTtlMs: number;
  /** Random bytes of entropy in issued principal/runner/enroll tokens. */
  tokenBytes: number;
  /** SQLite database filename under dataDir. */
  sqliteFilename: string;
  /** Bootstrap principal names. */
  bootstrapAdminName: string;
  bootstrapEnrollerName: string;
};

export const DEFAULT_PLANE_TUNING: PlaneTuning = {
  claimTokenTtlMs: 10 * 60 * 1000,
  contractTtlMs: 60 * 60 * 1000,
  nonceTtlMs: 24 * 60 * 60 * 1000,
  enrollTokenTtlMs: 60 * 60 * 1000,
  tokenBytes: 32,
  sqliteFilename: "plane.db",
  bootstrapAdminName: "admin",
  bootstrapEnrollerName: "bootstrap-enroller"
};

export type { ClaimResult, DisclosureReport, PolicyDecision };

export type IssuedPrincipal = { principalId: string; name: string; role: PrincipalRole; token: string };

type VerifiedClaim = { runnerId: string; nonce: string; expMs: number };

/** Throw unless `pem` parses as an ed25519 public key. */
function assertEd25519PublicKey(pem: string): void {
  let key;
  try {
    key = createPublicKey(pem);
  } catch (error) {
    throw new Error(
      `runner public key is not a valid PEM: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `runner public key must be ed25519, got ${key.asymmetricKeyType ?? "unknown"}`
    );
  }
}

export class Plane {
  private readonly config: PlaneConfig;
  private readonly store: PlaneStore;
  private readonly policyHash: string;
  private readonly receipts: ReceiptService;
  private readonly claimTokens: ClaimTokenService;
  private readonly contracts: ContractService;
  private readonly logger: Logger;
  private readonly idp?: IdpVerifier;
  readonly metrics: Metrics;
  private readonly sweeper: RetentionSweeper;
  private readonly tuning: PlaneTuning;

  constructor(config: PlaneConfig) {
    this.config = config;
    this.tuning = { ...DEFAULT_PLANE_TUNING, ...config.tuning };
    if (config.store) {
      this.store = config.store;
    } else {
      const dbPath = join(config.dataDir, this.tuning.sqliteFilename);
      mkdirSync(dirname(dbPath), { recursive: true });
      this.store = new SqliteStore(dbPath);
    }
    this.policyHash = hashCanonical(config.policy);
    this.receipts = new ReceiptService({
      planePrivateKeyPem: config.planePrivateKeyPem,
      planePublicKeyPem: config.planePublicKeyPem
    });
    this.claimTokens = new ClaimTokenService({
      planePrivateKeyPem: config.planePrivateKeyPem,
      planePublicKeyPem: config.planePublicKeyPem,
      claimTokenTtlMs: this.tuning.claimTokenTtlMs
    });
    this.contracts = new ContractService({
      planePrivateKeyPem: config.planePrivateKeyPem,
      planePublicKeyPem: config.planePublicKeyPem,
      policyHash: this.policyHash,
      contractTtlMs: this.tuning.contractTtlMs,
      buildSecretClaims: (secretNames, pool) =>
        this.buildSecretClaims(secretNames, pool)
    });
    this.logger = config.logger ?? createLogger();
    this.metrics = config.metrics ?? new Metrics();
    if (config.idp) this.idp = config.idp;
    this.seedBootstrapPrincipals();
    this.sweeper = new RetentionSweeper(
      this.store,
      config.policy.retention,
      undefined,
      this.logger
    );
    if (config.startRetention) this.sweeper.start();
  }

  /** Ensure the bootstrap admin and enroller principals match the config. */
  private seedBootstrapPrincipals(): void {
    this.upsertPrincipal(this.tuning.bootstrapAdminName, "admin", this.config.adminToken);
    this.upsertPrincipal(this.tuning.bootstrapEnrollerName, "enroller", this.config.enrollToken);
  }

  /** Mint a fresh bearer token with the configured entropy. */
  private newToken(): string {
    return randomBytes(this.tuning.tokenBytes).toString("base64url");
  }

  private upsertPrincipal(name: string, role: PrincipalRole, token: string): void {
    const existing = this.store.getPrincipalByName(name);
    const record: PrincipalRecord = {
      principalId: existing?.principalId ?? `prn_${randomUUID()}`,
      name,
      role,
      tokenHash: hashToken(token),
      createdAt: existing?.createdAt ?? new Date().toISOString()
    };
    this.store.savePrincipal(record);
  }

  close(): void {
    this.sweeper.stop();
    this.store.close();
  }

  get blobs(): PlaneStore {
    return this.store;
  }

  get policySnapshot(): { policy: Policy; policyHash: string } {
    return { policy: this.config.policy, policyHash: this.policyHash };
  }

  get log(): Logger {
    return this.logger;
  }

  /** Run one retention pass synchronously (also used by tests). */
  sweepRetention(): ReturnType<RetentionSweeper["sweepOnce"]> {
    return this.sweeper.sweepOnce();
  }

  // ---- Authentication and principals ----

  /** Resolve a bearer token to a principal, or undefined if invalid/revoked. */
  authenticate(token: string | undefined): Principal | undefined {
    if (!token) return undefined;
    const record = this.store.getPrincipalByTokenHash(hashToken(token));
    if (!record || record.revokedAt) return undefined;
    return toPrincipal(record);
  }

  authorize(token: string | undefined, capability: Capability): Principal | undefined {
    const principal = this.authenticate(token);
    if (!principal || !principalCan(principal.role, capability)) return undefined;
    return principal;
  }

  /** Backward-compatible admin check used by older callers. */
  checkAdminToken(token: string | undefined): boolean {
    const principal = this.authenticate(token);
    return principal?.role === "admin";
  }

  issuePrincipal(name: string, role: PrincipalRole): IssuedPrincipal {
    if (this.store.getPrincipalByName(name)) {
      throw conflict(`principal "${name}" already exists`);
    }
    const token = this.newToken();
    const record: PrincipalRecord = {
      principalId: `prn_${randomUUID()}`,
      name,
      role,
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString()
    };
    this.store.savePrincipal(record);
    this.metrics.inc("principals.issued");
    return { principalId: record.principalId, name, role, token };
  }

  rotatePrincipal(name: string): { token: string } {
    const existing = this.store.getPrincipalByName(name);
    if (!existing || existing.revokedAt) {
      throw notFound(`principal "${name}" not found`);
    }
    const token = this.newToken();
    this.store.savePrincipal({ ...existing, tokenHash: hashToken(token) });
    this.metrics.inc("principals.rotated");
    return { token };
  }

  revokePrincipal(name: string): boolean {
    const existing = this.store.getPrincipalByName(name);
    if (!existing) return false;
    const ok = this.store.revokePrincipal(existing.principalId, new Date().toISOString());
    if (ok) this.metrics.inc("principals.revoked");
    return ok;
  }

  listPrincipals(): { name: string; role: PrincipalRole; createdAt: string; revoked: boolean }[] {
    return this.store.listPrincipals().map((p) => ({
      name: p.name,
      role: p.role,
      createdAt: p.createdAt,
      revoked: p.revokedAt !== undefined
    }));
  }

  /** Mint a single-use, expiring runner enrollment token. */
  issueEnrollToken(options: { pool?: string; ttlMs?: number } = {}): { token: string; expiresAt: string } {
    const token = this.newToken();
    const now = Date.now();
    const expiresAt = new Date(
      now + (options.ttlMs ?? this.tuning.enrollTokenTtlMs)
    ).toISOString();
    this.store.saveEnrollToken({
      tokenHash: hashToken(token),
      ...(options.pool ? { pool: options.pool } : {}),
      createdAt: new Date(now).toISOString(),
      expiresAt
    });
    return { token, expiresAt };
  }

  // ---- Runners ----

  enrollRunner(input: {
    enrollToken: string;
    publicKeyPem: string;
    pool: string;
  }): { runnerId: string; runnerToken: string } {
    const principal = this.authenticate(input.enrollToken);
    const byPrincipal =
      principal !== undefined &&
      (principal.role === "enroller" || principal.role === "admin");
    let bySingleUse = false;
    if (!byPrincipal) {
      const consumed = this.store.consumeEnrollToken(
        hashToken(input.enrollToken),
        new Date().toISOString()
      );
      bySingleUse =
        consumed !== undefined && (!consumed.pool || consumed.pool === input.pool);
    }
    if (!byPrincipal && !bySingleUse) {
      this.metrics.inc("enroll.rejected");
      throw badRequest("invalid enroll token");
    }
    // Validate the runner's public key parses as an ed25519 SPKI key before
    // storing it; a malformed key would otherwise only fail later at receipt
    // verification time.
    assertEd25519PublicKey(input.publicKeyPem);
    const runnerId = `rnr_${randomUUID()}`;
    const runnerToken = this.newToken();
    const record: RunnerRecord = {
      runnerId,
      pool: input.pool,
      publicKeyPem: input.publicKeyPem,
      tokenHash: hashToken(runnerToken),
      enrolledAt: new Date().toISOString()
    };
    this.store.saveRunner(record);
    this.metrics.inc("enroll.accepted");
    return { runnerId, runnerToken };
  }

  listRunners(): RunnerSummary[] {
    return this.store.listRunners().map((runner) => ({
      runnerId: runner.runnerId,
      pool: runner.pool,
      keyId: keyIdFromPublicPem(runner.publicKeyPem),
      enrolledAt: runner.enrolledAt
    }));
  }

  listRuns(): RunSummary[] {
    return this.store.listRuns().map((record) => ({
      runId: record.id,
      status: record.status,
      agentKind: record.request.agentKind,
      pool: record.request.pool,
      prompt: record.request.prompt,
      requestedBy: record.request.requestedBy,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      consentRequirements: record.consentRequirements,
      hasReceipt: this.store.getReceipt(record.id) !== undefined,
      ...(record.request.continuation
        ? { continuation: record.request.continuation }
        : {})
    }));
  }

  private authRunner(runnerToken: string): RunnerRecord {
    const runner = this.store.getRunnerByTokenHash(hashToken(runnerToken));
    if (!runner) throw unauthorized("invalid runner token");
    return runner;
  }

  private buildSecretClaims(secretNames: string[], pool: string): SecretClaim[] {
    return secretNames.map((name) => {
      const rule = this.config.policy.secrets.releasable.find(
        (r) => r.name === name
      );
      // When policy has no explicit rule, the claim is scoped to the run's
      // pool using the same `pool:<name>` convention policy rules use.
      return { name, scope: rule ? rule.scope : `pool:${pool}` };
    });
  }

  private evaluateRequest(request: Omit<RunRequest, "runId">): PolicyDecision {
    // The type assertion narrows for evaluatePolicy's signature only; the
    // runtime allow-list check happens inside evaluatePolicy, which denies
    // any agentKind not present in policy.agents.allow.
    return evaluatePolicy(this.config.policy, {
      agentKind: request.agentKind as Policy["agents"]["allow"][number],
      pool: request.pool,
      secretNames: request.secretNames,
      allowHosts: request.network.allowHosts,
      maxSpendUsd: request.budget.maxSpendUsd,
      maxDurationMin: request.budget.maxDurationMin
    });
  }

  dryRun(request: Omit<RunRequest, "runId">): DisclosureReport {
    const decision = this.evaluateRequest(request);
    return {
      dryRun: true,
      agent: { kind: request.agentKind, version: request.agentVersion },
      pool: request.pool,
      workspace: {
        baseRef: request.workspace.baseRef,
        bundleHash: request.workspace.bundleHash,
        dirtyDiffHash: request.workspace.dirtyDiffHash,
        untrackedPaths: request.workspace.untrackedFiles.map((f) => f.path),
        deniedPaths: request.workspace.deniedPaths
      },
      secrets: this.buildSecretClaims(request.secretNames, request.pool),
      network: request.network,
      budget: request.budget,
      disclosure: request.disclosure,
      execution: executionFromRunRequest(request),
      ...(request.isolation ? { isolation: request.isolation } : {}),
      ...(request.continuation ? { continuation: request.continuation } : {}),
      policyDecision: decision
    };
  }

  requestRun(request: Omit<RunRequest, "runId">): RunRecord {
    const decision = this.evaluateRequest(request);

    const runId = `run_${randomUUID()}`;
    const fullRequest: RunRequest = { ...request, runId };
    const now = new Date().toISOString();
    const record: RunRecord = {
      id: runId,
      status: decision.decision === "ask" ? "awaiting_approval" : "created",
      createdAt: now,
      updatedAt: now,
      request: fullRequest,
      consentRequirements: decision.consentRequirements,
      approvals: []
    };

    if (decision.decision === "allow") {
      record.contract = this.issueContract(fullRequest, []);
      this.store.saveRun(record);
      this.appendPlaneEvents(record, [
        { type: "run.created" as const },
        ...this.continuationEvents(fullRequest),
        {
          type: "policy.evaluated" as const,
          decision: decision.decision,
          reason: decision.reason
        }
      ]);
    } else {
      this.store.saveRun(record);
    }
    this.metrics.inc("runs.requested");
    return record;
  }

  private continuationEvents(
    request: RunRequest
  ): Extract<ChainedEvent["event"], { type: "checkpoint.created" }>[] {
    if (!request.continuation) return [];
    return [
      {
        type: "checkpoint.created" as const,
        checkpointId: request.continuation.checkpointId,
        tier: request.continuation.tier
      }
    ];
  }

  approve(
    runId: string,
    actor: ActorRef,
    verified?: { idpSubject: string; idpIssuer: string }
  ): RunRecord {
    const record = this.mustGetRun(runId);
    if (record.status !== "awaiting_approval") {
      throw conflict(`run ${runId} is not awaiting approval`);
    }
    const approval: ApprovalRecord = {
      actor,
      ts: new Date().toISOString(),
      ...(verified
        ? { idpSubject: verified.idpSubject, idpIssuer: verified.idpIssuer }
        : {})
    };
    record.approvals.push(approval);
    record.contract = this.issueContract(record.request, [actor]);
    assertRunTransition(record.status, "created");
    record.status = "created";
    record.updatedAt = new Date().toISOString();
    this.store.saveRun(record);
    this.appendPlaneEvents(record, [
      { type: "run.created" as const },
      ...this.continuationEvents(record.request),
      {
        type: "policy.evaluated" as const,
        decision: "ask" as const,
        reason: `consent required: ${record.consentRequirements.join("; ")}`
      },
      ...record.consentRequirements.map((requirement) => ({
        type: "consent.requested" as const,
        requirement
      })),
      { type: "consent.granted" as const, actor }
    ]);
    this.metrics.inc("runs.approved");
    return record;
  }

  cancel(runId: string, actor: ActorRef): RunRecord {
    const record = this.mustGetRun(runId);
    if (record.status !== "created" && record.status !== "awaiting_approval") {
      throw badRequest(
        `run ${runId} is ${record.status}; only unclaimed runs can be cancelled`
      );
    }
    assertRunTransition(record.status, "cancelled");
    record.status = "cancelled";
    record.updatedAt = new Date().toISOString();
    this.store.saveRun(record);
    if (record.contract) {
      this.appendPlaneEvents(record, [{ type: "run.cancelled", actor }]);
    }
    this.metrics.inc("runs.cancelled");
    return record;
  }

  private issueContract(request: RunRequest, approvedBy: ActorRef[]): RunContract {
    return this.contracts.issue(request, approvedBy);
  }

  private appendPlaneEvents(
    record: RunRecord,
    events: ChainedEvent["event"][]
  ): void {
    if (!record.contract) throw badRequest("cannot append events before contract");
    const genesis = contractHash(record.contract);
    const chain = this.store.getEvents(record.id);
    const appended: ChainedEvent[] = [];
    for (const event of events) {
      appended.push(appendEvent(chain, event, genesis));
    }
    this.store.appendEvents(record.id, appended);
  }

  claim(input: { runnerToken: string; pool: string }): ClaimResult | undefined {
    const runner = this.authRunner(input.runnerToken);
    if (runner.pool !== input.pool) {
      throw unauthorized("runner is not enrolled in the requested pool");
    }
    const candidate = this.store.claimNextRun(
      input.pool,
      runner.runnerId,
      new Date().toISOString()
    );
    if (!candidate || !candidate.contract) return undefined;

    this.appendPlaneEvents(candidate, [
      {
        type: "run.claimed",
        runnerId: runner.runnerId,
        runnerKeyId: keyIdFromPublicPem(runner.publicKeyPem)
      },
      ...candidate.contract.secrets.map((claim) => ({
        type: "secret.released" as const,
        name: claim.name,
        scope: claim.scope
      }))
    ]);
    this.metrics.inc("runs.claimed");

    // The claim token is intentionally a plane-internal credential (base64url
    // JSON + ed25519 detached signature), never verified by third parties, so
    // a full JWS envelope would add surface without adding interoperability.
    const claimToken = this.claimTokens.issue({
      runId: candidate.id,
      runnerId: runner.runnerId
    });

    const secrets =
      candidate.contract.secrets.length > 0
        ? this.config.secretStore.release(
            candidate.contract.secrets.map((c) => c.name)
          )
        : [];
    if (secrets.length > 0) this.metrics.inc("secrets.released", secrets.length);

    return {
      runId: candidate.id,
      contract: candidate.contract,
      claimToken,
      events: this.store.getEvents(candidate.id),
      secrets
    };
  }

  /**
   * Single decoder for claim tokens: verifies the plane signature, validates
   * every payload field is present and well-formed, and checks expiry.
   * Throws on any defect; both public verifiers below build on this.
   */
  private parseClaimToken(token: string): ReturnType<ClaimTokenService["parse"]> {
    return this.claimTokens.parse(token);
  }

  /**
   * Verify a claim token's plane signature, payload shape, and expiry, plus
   * that the named run is actually claimed by the named runner. Used to
   * authorize artifact blob uploads from a runner holding an active claim;
   * unlike verifyClaimToken it does not require the caller to know the run
   * id ahead of time, but it still enforces the token's own run binding.
   */
  verifyClaimTokenSignature(token: string): boolean {
    try {
      const payload = this.parseClaimToken(token);
      const record = this.store.getRun(payload.runId);
      return record !== undefined && record.claimedBy === payload.runnerId;
    } catch {
      return false;
    }
  }

  private verifyClaimToken(token: string, runId: string): VerifiedClaim {
    const payload = this.parseClaimToken(token);
    if (payload.runId !== runId) throw unauthorized("claim token run mismatch");
    const record = this.mustGetRun(runId);
    if (record.claimedBy !== payload.runnerId) {
      throw unauthorized("claim token runner mismatch");
    }
    return { runnerId: payload.runnerId, nonce: payload.nonce, expMs: payload.expMs };
  }

  appendRunnerEvents(
    runId: string,
    claimToken: string,
    events: ChainedEvent[]
  ): void {
    this.verifyClaimToken(claimToken, runId);
    const record = this.mustGetRun(runId);
    if (!record.contract) throw badRequest("run has no contract");
    const existing = this.store.getEvents(runId);
    const combined = [...existing, ...events];
    const verification = verifyChain(combined, contractHash(record.contract));
    if (!verification.ok) {
      throw badRequest(
        `event chain rejected at seq ${verification.brokenAtSeq}: ${verification.reason}`
      );
    }
    this.store.appendEvents(runId, events);
    if (record.status === "claimed") {
      assertRunTransition(record.status, "running");
      record.status = "running";
      record.updatedAt = new Date().toISOString();
      this.store.saveRun(record);
    }
  }

  complete(runId: string, claimToken: string, receipt: Receipt): Receipt {
    const verified = this.verifyClaimToken(claimToken, runId);
    // Durable replay protection: the nonce ledger survives restarts and is
    // atomic, unlike the previous in-memory Set.
    if (!this.store.recordClaimNonce(verified.nonce, verified.expMs + this.tuning.nonceTtlMs)) {
      throw conflict("claim token already used for completion");
    }
    const record = this.mustGetRun(runId);
    if (!record.contract) throw badRequest("run has no contract");

    const runner = this.store.getRunnerById(verified.runnerId);
    if (!runner) throw notFound("unknown runner");

    this.receipts.verifyRunnerReceipt({
      contract: record.contract,
      receipt,
      events: this.store.getEvents(runId),
      runnerPublicKeyPem: runner.publicKeyPem
    });

    const countersigned = this.receipts.countersign(receipt);

    this.store.saveReceipt(runId, countersigned);
    assertRunTransition(record.status, receipt.status);
    record.status = receipt.status;
    record.updatedAt = new Date().toISOString();
    this.store.saveRun(record);
    this.metrics.inc(`runs.completed.${receipt.status}`);
    return countersigned;
  }

  getRun(runId: string): RunRecord | undefined {
    return this.store.getRun(runId);
  }

  getEvents(runId: string): ChainedEvent[] {
    return this.store.getEvents(runId);
  }

  getBundle(runId: string): ReceiptBundle | undefined {
    const record = this.store.getRun(runId);
    const receipt = this.store.getReceipt(runId);
    if (!record || !record.contract || !receipt || !record.claimedBy) {
      return undefined;
    }
    const runner = this.store.getRunnerById(record.claimedBy);
    if (!runner) return undefined;
    return {
      version: PROTOCOL_VERSIONS.bundle,
      contract: record.contract,
      receipt,
      events: this.store.getEvents(runId),
      keys: {
        planePublicKeyPem: this.config.planePublicKeyPem,
        runnerPublicKeyPem: runner.publicKeyPem
      }
    };
  }

  exportJsonl(sinceIso?: string): string {
    const since = sinceIso ? new Date(sinceIso).getTime() : 0;
    const lines = this.store
      .exportEvents(since)
      .map(({ runId, event }) => JSON.stringify({ runId, ...event }));
    return lines.join("\n") + (lines.length > 0 ? "\n" : "");
  }

  /**
   * Readiness: store reachable and the signing keypair actually usable —
   * the private key must parse and its public half must match the
   * configured public key, so a plane with mismatched key material reports
   * not-ready instead of issuing unverifiable contracts.
   */
  ready(): boolean {
    try {
      this.store.countBlobs();
      const privateKey = createPrivateKey(this.config.planePrivateKeyPem);
      const derivedPublicPem = createPublicKey(privateKey)
        .export({ type: "spki", format: "pem" })
        .toString();
      return (
        keyIdFromPublicPem(derivedPublicPem) ===
        keyIdFromPublicPem(this.config.planePublicKeyPem)
      );
    } catch {
      return false;
    }
  }

  verifyIdpToken(
    token: string
  ): Promise<{ idpSubject: string; idpIssuer: string }> {
    if (!this.idp) {
      return Promise.reject(badRequest("no IdP is configured for approvals"));
    }
    return this.idp
      .verify(token)
      .then((v) => ({ idpSubject: v.subject, idpIssuer: v.issuer }));
  }

  private mustGetRun(runId: string): RunRecord {
    const record = this.store.getRun(runId);
    if (!record) throw notFound(`unknown run ${runId}`);
    return record;
  }
}
