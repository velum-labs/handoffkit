import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  appendEvent,
  contractHash,
  generateEd25519KeyPair,
  hashCanonical,
  keyIdFromPublicPem,
  signReceipt
} from "@warrant/protocol";
import type {
  ChainedEvent,
  ClaimResult,
  Receipt,
  RunEvent,
  RunnerIdentity,
  SessionIsolation
} from "@warrant/protocol";
import { PlaneClient } from "@warrant/sdk";
import { materializeWorkspace } from "@warrant/workspace";
import type { SessionBackend } from "./backend.js";
import { runSession } from "./session.js";

export type RunnerOptions = {
  planeUrl: string;
  pool: string;
  dataDir: string;
  enrollToken?: string;
  pollIntervalMs?: number;
  mockScriptPath?: string;
  /** How long to keep retrying enrollment while the plane is unreachable. */
  enrollRetryMs?: number;
  /**
   * Session isolation backends beyond the built-in "process" backend
   * (e.g. hermetic interpreter or microVM). Injected so the runner kernel
   * stays dependency-free.
   */
  backends?: SessionBackend[];
};

type StoredIdentity = {
  runnerId: string;
  runnerToken: string;
  pool: string;
};

const DEFAULT_MOCK_SCRIPT = fileURLToPath(
  new URL("./mock-agent.js", import.meta.url)
);

export class Runner {
  private readonly options: RunnerOptions;
  private readonly client: PlaneClient;
  private identity?: StoredIdentity;
  private publicKeyPem = "";
  private privateKeyPem = "";
  private stopped = false;

  constructor(options: RunnerOptions) {
    this.options = options;
    this.client = new PlaneClient(options.planeUrl);
  }

  async ensureEnrolled(): Promise<StoredIdentity> {
    if (this.identity) return this.identity;
    const dir = this.options.dataDir;
    mkdirSync(dir, { recursive: true });
    const identityPath = join(dir, "identity.json");
    const pubPath = join(dir, "runner.pub.pem");
    const keyPath = join(dir, "runner.key.pem");

    if (existsSync(identityPath) && existsSync(pubPath) && existsSync(keyPath)) {
      this.identity = JSON.parse(
        readFileSync(identityPath, "utf8")
      ) as StoredIdentity;
      this.publicKeyPem = readFileSync(pubPath, "utf8");
      this.privateKeyPem = readFileSync(keyPath, "utf8");
      return this.identity;
    }

    if (!this.options.enrollToken) {
      throw new Error("runner is not enrolled and no enroll token was provided");
    }
    const keys = generateEd25519KeyPair();
    const enrolled = await this.enrollWithRetry(keys.publicKeyPem);
    const identity: StoredIdentity = {
      runnerId: enrolled.runnerId,
      runnerToken: enrolled.runnerToken,
      pool: this.options.pool
    };
    writeFileSync(identityPath, JSON.stringify(identity, null, 2), {
      mode: 0o600
    });
    writeFileSync(pubPath, keys.publicKeyPem, { mode: 0o600 });
    writeFileSync(keyPath, keys.privateKeyPem, { mode: 0o600 });
    this.identity = identity;
    this.publicKeyPem = keys.publicKeyPem;
    this.privateKeyPem = keys.privateKeyPem;
    return identity;
  }

  /**
   * Enroll against the plane, retrying while it is unreachable. Runners
   * routinely start before the plane in container deployments; a transport
   * failure here is a startup-ordering problem, not a fatal one. An invalid
   * enroll token is rejected by the plane with a response and never retried.
   */
  private async enrollWithRetry(
    publicKeyPem: string
  ): Promise<{ runnerId: string; runnerToken: string }> {
    // TODO(hardcoded): enrollRetryMs 60s
    const deadline = Date.now() + (this.options.enrollRetryMs ?? 60_000);
    const enrollToken = this.options.enrollToken;
    if (!enrollToken) throw new Error("no enroll token was provided");
    for (;;) {
      try {
        return await this.client.enroll({
          enrollToken,
          publicKeyPem,
          pool: this.options.pool
        });
      } catch (error) {
        const transport = error instanceof TypeError;
        if (!transport || Date.now() >= deadline) throw error;
        console.error(
          `plane not reachable at ${this.options.planeUrl}; retrying enrollment...`
        );
        // TODO(hardcoded): retry sleep 2s
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  /** Poll once; execute at most one claimed run. Returns the run id if work was done. */
  async runOnce(): Promise<string | undefined> {
    const identity = await this.ensureEnrolled();
    const claim = await this.client.claim({
      runnerToken: identity.runnerToken,
      pool: identity.pool
    });
    if ("empty" in claim) return undefined;
    await this.execute(claim);
    return claim.runId;
  }

  async start(): Promise<void> {
    this.stopped = false;
    // TODO(hardcoded): poll 1s
    const interval = this.options.pollIntervalMs ?? 1000;
    while (!this.stopped) {
      try {
        const ran = await this.runOnce();
        if (!ran) {
          await new Promise((resolve) => setTimeout(resolve, interval));
        }
      } catch (error) {
        console.error(
          `runner error: ${error instanceof Error ? error.message : String(error)}`
        );
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async execute(claim: ClaimResult): Promise<void> {
    const { contract, claimToken, runId } = claim;
    const genesis = contractHash(contract);
    const chain: ChainedEvent[] = [...claim.events];
    let flushedThrough = chain.length;

    const emitLocal = (event: RunEvent): ChainedEvent =>
      appendEvent(chain, event, genesis);

    const flush = async (): Promise<void> => {
      const pending = chain.slice(flushedThrough);
      if (pending.length === 0) return;
      await this.client.postEvents(runId, claimToken, pending);
      flushedThrough = chain.length;
    };

    const sessionDir = mkdtempSync(join(tmpdir(), "warrant-session-"));
    try {
      const repoDir = await materializeWorkspace(
        sessionDir,
        contract.workspace,
        (hash) => this.client.getBlob(hash)
      );
      const manifestHash = hashCanonical(contract.workspace);
      emitLocal({ type: "workspace.materialized", manifestHash });
      await flush();

      const session = await runSession({
        contract,
        repoDir,
        secrets: claim.secrets,
        mockScriptPath: this.options.mockScriptPath ?? DEFAULT_MOCK_SCRIPT,
        emit: (event) => void emitLocal(event),
        backends: this.options.backends ?? []
      });

      const artifactHashes: string[] = [];
      let diffHash = "";
      if (session.output.diff.length > 0) {
        diffHash = await this.client.putBlob(session.output.diff, claimToken);
        emitLocal({ type: "artifact.created", kind: "diff", hash: diffHash });
        emitLocal({
          type: "boundary.crossed",
          direction: "out",
          contentHash: diffHash,
          dataClass: "code-diff"
        });
        artifactHashes.push(diffHash);
      }
      if (session.log.length > 0) {
        const logHash = await this.client.putBlob(session.log, claimToken);
        emitLocal({ type: "artifact.created", kind: "log", hash: logHash });
        emitLocal({
          type: "boundary.crossed",
          direction: "out",
          contentHash: logHash,
          dataClass: "session-log"
        });
        artifactHashes.push(logHash);
      }

      if (session.exitCode === 0) {
        emitLocal({ type: "run.completed" });
      } else {
        emitLocal({
          type: "run.failed",
          failure: "session_failed",
          message: `agent exited with code ${session.exitCode}`
        });
      }
      await flush();

      const receipt = this.buildReceipt({
        runId,
        contract,
        chain,
        genesis,
        manifestHash,
        diffHash,
        artifactHashes,
        isolation: session.isolation,
        status: session.exitCode === 0 ? "completed" : "failed"
      });
      await this.client.complete(runId, claimToken, receipt);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }

  private buildReceipt(input: {
    runId: string;
    contract: ClaimResult["contract"];
    chain: ChainedEvent[];
    genesis: string;
    manifestHash: string;
    diffHash: string;
    artifactHashes: string[];
    isolation: SessionIsolation;
    status: "completed" | "failed";
  }): Receipt {
    const identity = this.identity;
    if (!identity) throw new Error("runner identity missing");
    const { chain } = input;
    const head = chain[chain.length - 1];
    if (!head) throw new Error("event chain is empty");

    const secretsReleased = chain
      .filter((e) => e.event.type === "secret.released")
      .map((e) =>
        e.event.type === "secret.released"
          ? { name: e.event.name, scope: e.event.scope, ts: e.ts }
          : { name: "", scope: "", ts: "" }
      );

    const networkSeen = new Map<string, "allowed" | "blocked">();
    for (const entry of chain) {
      if (entry.event.type === "network.connected") {
        networkSeen.set(
          `${entry.event.host}:${entry.event.decision}`,
          entry.event.decision
        );
      }
    }
    // TODO(brittle): network receipt dedup via host:decision split on :
    const networkAccessed = [...networkSeen.entries()].map(([key, decision]) => ({
      host: key.slice(0, key.lastIndexOf(":")),
      decision
    }));

    const boundaryDisclosures = chain
      .filter((e) => e.event.type === "boundary.crossed")
      .map((e) =>
        e.event.type === "boundary.crossed"
          ? {
              direction: e.event.direction,
              contentHash: e.event.contentHash,
              dataClass: e.event.dataClass
            }
          : { direction: "out" as const, contentHash: "", dataClass: "" }
      );

    const runnerIdentity: RunnerIdentity = {
      runnerId: identity.runnerId,
      keyId: keyIdFromPublicPem(this.publicKeyPem),
      pool: identity.pool,
      // TODO(hardcoded): attestationTier "mock"
      attestationTier: "mock",
      isolation: input.isolation
    };

    const first = chain[0];
    const unsigned: Receipt = {
      version: "warrant.receipt.v1",
      runId: input.runId,
      contractHash: input.genesis,
      runner: runnerIdentity,
      startedAt: first ? first.ts : head.ts,
      endedAt: head.ts,
      status: input.status,
      eventsHead: head.hash,
      eventCount: chain.length,
      workspaceIn: {
        baseRef: input.contract.workspace.baseRef,
        manifestHash: input.manifestHash
      },
      workspaceOut: {
        diffHash: input.diffHash,
        artifactHashes: input.artifactHashes
      },
      secretsReleased,
      networkAccessed,
      modelsUsed: [],
      boundaryDisclosures,
      signatures: []
    };
    return signReceipt(unsigned, this.privateKeyPem, this.publicKeyPem, "runner");
  }
}
