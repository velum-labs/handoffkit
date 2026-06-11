import { randomBytes, randomUUID } from "node:crypto";

import {
  appendEvent,
  contractHash,
  hashCanonical,
  keyIdFromPublicPem,
  sha256Hex,
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
import { evaluatePolicy } from "./policy.js";
import { FsStore } from "./store.js";
import type { RunRecord, RunRequest, RunnerRecord } from "./store.js";
import { SecretStore } from "./secrets.js";

export type PlaneConfig = {
  dataDir: string;
  policy: Policy;
  planePrivateKeyPem: string;
  planePublicKeyPem: string;
  adminToken: string;
  enrollToken: string;
  secretStore: SecretStore;
};

export type { ClaimResult, DisclosureReport, PolicyDecision };

type ClaimTokenPayload = {
  runId: string;
  runnerId: string;
  nonce: string;
  exp: string;
};

const CLAIM_TOKEN_TTL_MS = 10 * 60 * 1000;
const CONTRACT_TTL_MS = 60 * 60 * 1000;

export class Plane {
  private readonly config: PlaneConfig;
  private readonly store: FsStore;
  private readonly policyHash: string;
  private readonly usedClaimNonces = new Set<string>();

  constructor(config: PlaneConfig) {
    this.config = config;
    this.store = new FsStore(config.dataDir);
    this.policyHash = hashCanonical(config.policy);
  }

  get blobs(): FsStore {
    return this.store;
  }

  get policySnapshot(): { policy: Policy; policyHash: string } {
    return { policy: this.config.policy, policyHash: this.policyHash };
  }

  checkAdminToken(token: string | undefined): boolean {
    return token !== undefined && token === this.config.adminToken;
  }

  enrollRunner(input: {
    enrollToken: string;
    publicKeyPem: string;
    pool: string;
  }): { runnerId: string; runnerToken: string } {
    if (input.enrollToken !== this.config.enrollToken) {
      throw new Error("invalid enroll token");
    }
    const runnerId = `rnr_${randomUUID()}`;
    const runnerToken = randomBytes(32).toString("base64url");
    const record: RunnerRecord = {
      runnerId,
      pool: input.pool,
      publicKeyPem: input.publicKeyPem,
      tokenHash: sha256Hex(runnerToken),
      enrolledAt: new Date().toISOString()
    };
    this.store.saveRunners([...this.store.getRunners(), record]);
    return { runnerId, runnerToken };
  }

  listRunners(): RunnerSummary[] {
    return this.store.getRunners().map((runner) => ({
      runnerId: runner.runnerId,
      pool: runner.pool,
      keyId: keyIdFromPublicPem(runner.publicKeyPem),
      enrolledAt: runner.enrolledAt
    }));
  }

  listRuns(): RunSummary[] {
    return this.store
      .listRunIds()
      .map((id) => this.store.getRun(id))
      .filter((record): record is RunRecord => record !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((record) => ({
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
    const hash = sha256Hex(runnerToken);
    const runner = this.store.getRunners().find((r) => r.tokenHash === hash);
    if (!runner) throw new Error("invalid runner token");
    return runner;
  }

  private buildSecretClaims(secretNames: string[], pool: string): SecretClaim[] {
    return secretNames.map((name) => {
      const rule = this.config.policy.secrets.releasable.find(
        (r) => r.name === name
      );
      return { name, scope: rule ? rule.scope : `pool:${pool}` };
    });
  }

  private evaluateRequest(request: Omit<RunRequest, "runId">): PolicyDecision {
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
      this.appendPlaneEvents(record, [
        { type: "run.created" as const },
        ...this.continuationEvents(fullRequest),
        {
          type: "policy.evaluated" as const,
          decision: decision.decision,
          reason: decision.reason
        }
      ]);
    }
    this.store.saveRun(record);
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

  approve(runId: string, actor: ActorRef): RunRecord {
    const record = this.mustGetRun(runId);
    if (record.status !== "awaiting_approval") {
      throw new Error(`run ${runId} is not awaiting approval`);
    }
    record.approvals.push({ actor, ts: new Date().toISOString() });
    record.contract = this.issueContract(record.request, [actor]);
    record.status = "created";
    record.updatedAt = new Date().toISOString();
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
    this.store.saveRun(record);
    return record;
  }

  /**
   * Cancel a run that has not been claimed yet. Claimed or running work
   * belongs to the runner session boundary; v1 does not signal runners,
   * and pretending otherwise would make the receipt dishonest.
   */
  cancel(runId: string, actor: ActorRef): RunRecord {
    const record = this.mustGetRun(runId);
    if (record.status !== "created" && record.status !== "awaiting_approval") {
      throw new Error(
        `run ${runId} is ${record.status}; only unclaimed runs can be cancelled`
      );
    }
    if (record.contract) {
      this.appendPlaneEvents(record, [{ type: "run.cancelled", actor }]);
    }
    record.status = "cancelled";
    record.updatedAt = new Date().toISOString();
    this.store.saveRun(record);
    return record;
  }

  private issueContract(request: RunRequest, approvedBy: ActorRef[]): RunContract {
    const now = Date.now();
    const unsigned: RunContract = {
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
    const candidate = this.store
      .listRunIds()
      .map((id) => this.store.getRun(id))
      .filter((r): r is RunRecord => r !== undefined)
      .filter((r) => r.status === "created" && r.request.pool === input.pool)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!candidate || !candidate.contract) return undefined;

    candidate.status = "claimed";
    candidate.claimedBy = runner.runnerId;
    candidate.updatedAt = new Date().toISOString();
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
    this.store.saveRun(candidate);

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

    return {
      runId: candidate.id,
      contract: candidate.contract,
      claimToken,
      events: this.store.getEvents(candidate.id),
      secrets
    };
  }

  verifyClaimToken(token: string, runId: string): string {
    const [encoded, sigB64url] = token.split(".");
    if (!encoded || !sigB64url) throw new Error("malformed claim token");
    const sig = Buffer.from(sigB64url, "base64url").toString("base64");
    if (!verifyData(this.config.planePublicKeyPem, encoded, sig)) {
      throw new Error("claim token signature invalid");
    }
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as ClaimTokenPayload;
    if (payload.runId !== runId) throw new Error("claim token run mismatch");
    if (new Date(payload.exp).getTime() < Date.now()) {
      throw new Error("claim token expired");
    }
    const record = this.mustGetRun(runId);
    if (record.claimedBy !== payload.runnerId) {
      throw new Error("claim token runner mismatch");
    }
    return payload.runnerId;
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
    const runnerId = this.verifyClaimToken(claimToken, runId);
    if (this.usedClaimNonces.has(claimToken)) {
      throw new Error("claim token already used for completion");
    }
    const record = this.mustGetRun(runId);
    if (!record.contract) throw new Error("run has no contract");

    const runner = this.store
      .getRunners()
      .find((r) => r.runnerId === runnerId);
    if (!runner) throw new Error("unknown runner");

    const expectedHash = contractHash(record.contract);
    if (receipt.contractHash !== expectedHash) {
      throw new Error("receipt contract hash mismatch");
    }
    const runnerSig = receipt.signatures.find((s) => s.signer === "runner");
    if (!runnerSig) throw new Error("receipt is missing the runner signature");

    const countersigned = signReceipt(
      receipt,
      this.config.planePrivateKeyPem,
      this.config.planePublicKeyPem,
      "plane"
    );

    this.store.saveReceipt(runId, countersigned);
    this.usedClaimNonces.add(claimToken);
    record.status = receipt.status;
    record.updatedAt = new Date().toISOString();
    this.store.saveRun(record);
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
    const runner = this.store
      .getRunners()
      .find((r) => r.runnerId === record.claimedBy);
    if (!runner) return undefined;
    return {
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
    const lines: string[] = [];
    for (const runId of this.store.listRunIds().sort()) {
      for (const event of this.store.getEvents(runId)) {
        if (new Date(event.ts).getTime() >= since) {
          lines.push(JSON.stringify({ runId, ...event }));
        }
      }
    }
    return lines.join("\n") + (lines.length > 0 ? "\n" : "");
  }

  private mustGetRun(runId: string): RunRecord {
    const record = this.store.getRun(runId);
    if (!record) throw new Error(`unknown run ${runId}`);
    return record;
  }
}
