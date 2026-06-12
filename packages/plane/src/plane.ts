import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import {
  appendEvent,
  contractHash,
  hashCanonical,
  keyIdFromPublicPem,
  signContract,
  signData,
  signReceipt,
  verifyChain,
  verifyData
} from "@warrant/protocol";
import type {
  ActorRef,
  ChainedEvent,
  ClaimResult,
  DisclosureReport,
  Policy,
  PolicyDecision,
  Receipt,
  ReceiptBundle,
  RunContract,
  RunnerSummary,
  RunSummary,
  SecretClaim
} from "@warrant/protocol";

import { hashToken, principalCan, toPrincipal } from "./auth.js";
import type { Capability, Principal } from "./auth.js";
import type { IdpVerifier } from "./idp.js";
import { createLogger, Metrics } from "./logging.js";
import type { Logger } from "./logging.js";
import { evaluatePolicy } from "./policy.js";
import { RetentionSweeper } from "./retention.js";
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
  /** Inject a store (tests); defaults to SQLite at <dataDir>/plane.db. */
  store?: PlaneStore;
  /** Verifier for IdP-issued approval assertions, when configured. */
  idp?: IdpVerifier;
  logger?: Logger;
  metrics?: Metrics;
  /** Start the background retention sweeper. Defaults to false. */
  startRetention?: boolean;
};

export type { ClaimResult, DisclosureReport, PolicyDecision };

export type IssuedPrincipal = { principalId: string; name: string; role: PrincipalRole; token: string };

type ClaimTokenPayload = {
  runId: string;
  runnerId: string;
  nonce: string;
  exp: string;
};

type VerifiedClaim = { runnerId: string; nonce: string; expMs: number };

// TODO(hardcoded): claim/contract/nonce TTLs are fixed constants; expose via PlaneConfig or policy.
const CLAIM_TOKEN_TTL_MS = 10 * 60 * 1000;
const CONTRACT_TTL_MS = 60 * 60 * 1000;
const NONCE_TTL_MS = 24 * 60 * 60 * 1000;

export class Plane {
  private readonly config: PlaneConfig;
  private readonly store: PlaneStore;
  private readonly policyHash: string;
  private readonly logger: Logger;
  private readonly idp?: IdpVerifier;
  readonly metrics: Metrics;
  private readonly sweeper: RetentionSweeper;

  constructor(config: PlaneConfig) {
    this.config = config;
    if (config.store) {
      this.store = config.store;
    } else {
      // TODO(hardcoded): SQLite filename "plane.db" is not configurable.
      const dbPath = join(config.dataDir, "plane.db");
      mkdirSync(dirname(dbPath), { recursive: true });
      this.store = new SqliteStore(dbPath);
    }
    this.policyHash = hashCanonical(config.policy);
    this.logger = config.logger ?? createLogger();
    this.metrics = config.metrics ?? new Metrics();
    if (config.idp) this.idp = config.idp;
    this.seedBootstrapPrincipals();
    this.sweeper = new RetentionSweeper(this.store, config.policy.retention);
    if (config.startRetention) this.sweeper.start();
  }

  /** Ensure the bootstrap admin and enroller principals match the config. */
  private seedBootstrapPrincipals(): void {
    // TODO(hardcoded): bootstrap principal names ("admin", "bootstrap-enroller") are fixed.
    this.upsertPrincipal("admin", "admin", this.config.adminToken);
    this.upsertPrincipal("bootstrap-enroller", "enroller", this.config.enrollToken);
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
      throw new Error(`principal "${name}" already exists`);
    }
    // TODO(hardcoded): token size (32 bytes) and ID prefix "prn_" are not configurable.
    const token = randomBytes(32).toString("base64url");
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
      throw new Error(`principal "${name}" not found`);
    }
    const token = randomBytes(32).toString("base64url");
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
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    // TODO(hardcoded): default enroll-token TTL (1h) should live in config alongside other TTLs.
    const expiresAt = new Date(now + (options.ttlMs ?? 60 * 60 * 1000)).toISOString();
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
      throw new Error("invalid enroll token");
    }
    // TODO(brittle): publicKeyPem is stored without format/curve validation at enrollment.
    const runnerId = `rnr_${randomUUID()}`;
    const runnerToken = randomBytes(32).toString("base64url");
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
    if (!runner) throw new Error("invalid runner token");
    return runner;
  }

  private buildSecretClaims(secretNames: string[], pool: string): SecretClaim[] {
    return secretNames.map((name) => {
      const rule = this.config.policy.secrets.releasable.find(
        (r) => r.name === name
      );
      // TODO(hardcoded): fallback secret scope format `pool:${pool}` is inline; should match policy scope conventions.
      return { name, scope: rule ? rule.scope : `pool:${pool}` };
    });
  }

  private evaluateRequest(request: Omit<RunRequest, "runId">): PolicyDecision {
    // TODO(brittle): agentKind is cast to policy union without runtime check; invalid kinds slip through until policy eval.
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
      throw new Error(`run ${runId} is not awaiting approval`);
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
      throw new Error(
        `run ${runId} is ${record.status}; only unclaimed runs can be cancelled`
      );
    }
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
    const now = Date.now();
    const unsigned: RunContract = {
      // TODO(hardcoded): contract schema version string is inline; should reference a shared protocol constant.
      version: "warrant.contract.v1",
      runId: request.runId,
      issuedAt: new Date(now).toISOString(),
      issuer: {
        keyId: keyIdFromPublicPem(this.config.planePublicKeyPem),
        role: "plane"
      },
      requestedBy: request.requestedBy,
      ...(approvedBy.length > 0 ? { approvedBy } : {}),
      agent: {
        kind: request.agentKind as RunContract["agent"]["kind"],
        ...(request.agentVersion ? { version: request.agentVersion } : {})
      },
      task: { prompt: request.prompt },
      runner: { pool: request.pool },
      workspace: request.workspace,
      policyHash: this.policyHash,
      secrets: this.buildSecretClaims(request.secretNames, request.pool),
      network: request.network,
      budget: request.budget,
      disclosure: request.disclosure,
      ...(request.isolation ? { isolation: request.isolation } : {}),
      ...(request.continuation ? { continuation: request.continuation } : {}),
      expiresAt: new Date(now + CONTRACT_TTL_MS).toISOString(),
      signatures: []
    };
    return signContract(
      unsigned,
      this.config.planePrivateKeyPem,
      this.config.planePublicKeyPem,
      "plane"
    );
  }

  private appendPlaneEvents(
    record: RunRecord,
    events: ChainedEvent["event"][]
  ): void {
    if (!record.contract) throw new Error("cannot append events before contract");
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
      throw new Error("runner is not enrolled in the requested pool");
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

    // TODO(lib): suggest jose — ad-hoc base64url JSON + detached sig is not a standard JWS/JWT; harder to verify interoperably.
    const payload: ClaimTokenPayload = {
      runId: candidate.id,
      runnerId: runner.runnerId,
      nonce: randomBytes(16).toString("base64url"),
      exp: new Date(Date.now() + CLAIM_TOKEN_TTL_MS).toISOString()
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64url"
    );
    const sig = signData(this.config.planePrivateKeyPem, encoded);
    const claimToken = `${encoded}.${Buffer.from(sig, "base64").toString("base64url")}`;

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
   * Verify a claim token's plane signature and expiry only (not its run
   * binding). Used to authorize artifact blob uploads from a runner that
   * holds an active, plane-issued claim token.
   */
  verifyClaimTokenSignature(token: string): boolean {
    // TODO(brittle): signature-only check; no runId/runnerId/nonce binding — sufficient for blob upload gate but easy to misuse.
    const [encoded, sigB64url] = token.split(".");
    if (!encoded || !sigB64url) return false;
    const sig = Buffer.from(sigB64url, "base64url").toString("base64");
    if (!verifyData(this.config.planePublicKeyPem, encoded, sig)) return false;
    try {
      // TODO(brittle): ClaimTokenPayload parsed via `as` cast with no field validation (missing exp/runId silently passes partial checks).
      const payload = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8")
      ) as ClaimTokenPayload;
      return new Date(payload.exp).getTime() >= Date.now();
    } catch {
      return false;
    }
  }

  private verifyClaimToken(token: string, runId: string): VerifiedClaim {
    const [encoded, sigB64url] = token.split(".");
    if (!encoded || !sigB64url) throw new Error("malformed claim token");
    const sig = Buffer.from(sigB64url, "base64url").toString("base64");
    if (!verifyData(this.config.planePublicKeyPem, encoded, sig)) {
      throw new Error("claim token signature invalid");
    }
    // TODO(brittle): same ad-hoc token parse as verifyClaimTokenSignature; duplicate logic risks divergence.
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as ClaimTokenPayload;
    if (payload.runId !== runId) throw new Error("claim token run mismatch");
    const expMs = new Date(payload.exp).getTime();
    if (expMs < Date.now()) throw new Error("claim token expired");
    const record = this.mustGetRun(runId);
    if (record.claimedBy !== payload.runnerId) {
      throw new Error("claim token runner mismatch");
    }
    return { runnerId: payload.runnerId, nonce: payload.nonce, expMs };
  }

  appendRunnerEvents(
    runId: string,
    claimToken: string,
    events: ChainedEvent[]
  ): void {
    this.verifyClaimToken(claimToken, runId);
    const record = this.mustGetRun(runId);
    if (!record.contract) throw new Error("run has no contract");
    const existing = this.store.getEvents(runId);
    const combined = [...existing, ...events];
    const verification = verifyChain(combined, contractHash(record.contract));
    if (!verification.ok) {
      throw new Error(
        `event chain rejected at seq ${verification.brokenAtSeq}: ${verification.reason}`
      );
    }
    this.store.appendEvents(runId, events);
    if (record.status === "claimed") {
      record.status = "running";
      record.updatedAt = new Date().toISOString();
      this.store.saveRun(record);
    }
  }

  complete(runId: string, claimToken: string, receipt: Receipt): Receipt {
    const verified = this.verifyClaimToken(claimToken, runId);
    // Durable replay protection: the nonce ledger survives restarts and is
    // atomic, unlike the previous in-memory Set.
    if (!this.store.recordClaimNonce(verified.nonce, verified.expMs + NONCE_TTL_MS)) {
      throw new Error("claim token already used for completion");
    }
    const record = this.mustGetRun(runId);
    if (!record.contract) throw new Error("run has no contract");

    const runner = this.store.getRunnerById(verified.runnerId);
    if (!runner) throw new Error("unknown runner");

    const expectedHash = contractHash(record.contract);
    if (receipt.contractHash !== expectedHash) {
      throw new Error("receipt contract hash mismatch");
    }
    const runnerSig = receipt.signatures.find((s) => s.signer === "runner");
    if (!runnerSig) throw new Error("receipt is missing the runner signature");
    // TODO(brittle): runner signature presence is checked but cryptographic verification against runner.publicKeyPem is not done here.

    const countersigned = signReceipt(
      receipt,
      this.config.planePrivateKeyPem,
      this.config.planePublicKeyPem,
      "plane"
    );

    this.store.saveReceipt(runId, countersigned);
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
      // TODO(hardcoded): bundle version string is inline; should reference a shared protocol constant.
      version: "warrant.bundle.v1",
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

  /** Readiness: store reachable and signing key present. */
  ready(): boolean {
    try {
      this.store.countBlobs();
      // TODO(brittle): readiness only checks PEM string length, not that the key parses or matches the public key.
      return this.config.planePrivateKeyPem.length > 0;
    } catch {
      return false;
    }
  }

  verifyIdpToken(
    token: string
  ): Promise<{ idpSubject: string; idpIssuer: string }> {
    if (!this.idp) {
      return Promise.reject(new Error("no IdP is configured for approvals"));
    }
    return this.idp
      .verify(token)
      .then((v) => ({ idpSubject: v.subject, idpIssuer: v.issuer }));
  }

  private mustGetRun(runId: string): RunRecord {
    const record = this.store.getRun(runId);
    if (!record) throw new Error(`unknown run ${runId}`);
    return record;
  }
}
