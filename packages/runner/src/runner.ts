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

/** Default time budget for enrollment retries while the plane is unreachable. */
const DEFAULT_ENROLL_RETRY_MS = 60_000;
/** Wait between enrollment retry attempts. */
const ENROLL_RETRY_INTERVAL_MS = 2_000;
/** Default idle poll interval between claim attempts. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** Attestation tier reported by this software runner: honestly "mock". */
const RUNNER_ATTESTATION_TIER = "mock" as const;

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
  /**
   * How many claimed runs this runner executes at the same time.
   * Defaults to 1, which preserves the strictly sequential claim loop.
   * Each execution already owns all of its state (event chain, temp
   * session dir), so concurrency is purely a claim-loop property — this
   * is the single knob for one runner host; scale-out across hosts is
   * more enrolled runners in the pool.
   */
  concurrency?: number;
};

type StoredIdentity = {
  runnerId: string;
  runnerToken: string;
  pool: string;
};

const DEFAULT_MOCK_SCRIPT = fileURLToPath(
  new URL("./mock-agent.js", import.meta.url)
);
const REDACTED_SECRET_PREFIX = "[REDACTED:";

function redactSecrets(
  buffer: Buffer,
  secrets: readonly { name: string; value: string }[]
): Buffer {
  let text = buffer.toString("utf8");
  for (const secret of secrets) {
    if (secret.value.length === 0) continue;
    text = text.split(secret.value).join(`${REDACTED_SECRET_PREFIX}${secret.name}]`);
  }
  return Buffer.from(text, "utf8");
}

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
    const deadline =
      Date.now() + (this.options.enrollRetryMs ?? DEFAULT_ENROLL_RETRY_MS);
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
        await new Promise((resolve) =>
          setTimeout(resolve, ENROLL_RETRY_INTERVAL_MS)
        );
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
    const interval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const concurrency = Math.max(1, Math.floor(this.options.concurrency ?? 1));
    const inFlight = new Set<Promise<void>>();
    const sleep = (): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, interval));

    while (!this.stopped) {
      if (inFlight.size >= concurrency) {
        // At capacity: wait for any execution to settle before claiming
        // again. The executions never reject (errors are caught below).
        await Promise.race(inFlight);
        continue;
      }
      try {
        const identity = await this.ensureEnrolled();
        const claim = await this.client.claim({
          runnerToken: identity.runnerToken,
          pool: identity.pool
        });
        if ("empty" in claim) {
          await sleep();
          continue;
        }
        const task: Promise<void> = this.execute(claim)
          .catch((error) => {
            console.error(
              `runner error: ${error instanceof Error ? error.message : String(error)}`
            );
          })
          .finally(() => {
            inFlight.delete(task);
          });
        inFlight.add(task);
      } catch (error) {
        console.error(
          `runner error: ${error instanceof Error ? error.message : String(error)}`
        );
        await sleep();
      }
    }
    // stop() interrupts claiming, not execution: drain what was claimed so
    // every accepted run still ends in a posted receipt.
    await Promise.all(inFlight);
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
      const diff = redactSecrets(session.output.diff, claim.secrets);
      const log = redactSecrets(session.log, claim.secrets);
      if (diff.length > 0) {
        diffHash = await this.client.putBlob(diff, claimToken);
        emitLocal({ type: "artifact.created", kind: "diff", hash: diffHash });
        emitLocal({
          type: "boundary.crossed",
          direction: "out",
          contentHash: diffHash,
          dataClass: "code-diff"
        });
        artifactHashes.push(diffHash);
      }
      if (log.length > 0) {
        const logHash = await this.client.putBlob(log, claimToken);
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

    // Dedupe distinct (host, decision) pairs without string-packing the key,
    // so hosts containing ":" (IPv6 literals) are handled correctly.
    const networkSeen = new Map<string, Set<"allowed" | "blocked">>();
    for (const entry of chain) {
      if (entry.event.type === "network.connected") {
        const decisions = networkSeen.get(entry.event.host) ?? new Set();
        decisions.add(entry.event.decision);
        networkSeen.set(entry.event.host, decisions);
      }
    }
    const networkAccessed = [...networkSeen.entries()].flatMap(([host, decisions]) =>
      [...decisions].map((decision) => ({ host, decision }))
    );

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
      // Honest labeling: a software runner offers no hardware attestation,
      // so the tier is "mock" until a TEE-backed runner reports otherwise.
      attestationTier: RUNNER_ATTESTATION_TIER,
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
