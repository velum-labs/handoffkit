import assert from "node:assert/strict";
import { test } from "node:test";

import { appendEvent, verifyChain } from "../chain.js";
import { contractHash, signContract } from "../contract.js";
import { canonicalize } from "../jcs.js";
import { hashCanonical } from "../hash.js";
import {
  generateEd25519KeyPair,
  keyIdFromPublicPem,
  signData,
  verifyData
} from "../keys.js";
import { signReceipt, verifyRunnerReceipt } from "../receipt.js";
import { buildReceiptStory } from "../receipt-story.js";
import {
  AGENT_KINDS,
  isAgentKind,
  isTerminalStatus,
  parseSecretName,
  parseWorkspaceManifestPath,
  RUN_STATUSES,
  SESSION_ISOLATIONS
} from "../index.js";
import type { ChainedEvent, Receipt, RunContract } from "../types.js";

test("canonicalize sorts keys and is whitespace-free", () => {
  const value = { b: 2, a: { d: [1, 2, { z: true, y: null }], c: "x" } };
  assert.equal(
    canonicalize(value),
    '{"a":{"c":"x","d":[1,2,{"y":null,"z":true}]},"b":2}'
  );
});

test("canonicalize uses ES number serialization", () => {
  assert.equal(canonicalize({ n: 1e21 }), '{"n":1e+21}');
  assert.equal(canonicalize({ n: 0.000001 }), '{"n":0.000001}');
  assert.equal(canonicalize({ n: 10 }), '{"n":10}');
  assert.throws(() => canonicalize({ n: Infinity }));
});

test("canonicalize is order-insensitive for equal objects", () => {
  const a = { x: 1, y: [true, "s"] };
  const b = { y: [true, "s"], x: 1 };
  assert.equal(hashCanonical(a), hashCanonical(b));
});

test("ed25519 sign/verify roundtrip and tamper detection", () => {
  const keys = generateEd25519KeyPair();
  const payload = "warrant test payload";
  const sig = signData(keys.privateKeyPem, payload);
  assert.equal(verifyData(keys.publicKeyPem, payload, sig), true);
  assert.equal(verifyData(keys.publicKeyPem, payload + "x", sig), false);
  const other = generateEd25519KeyPair();
  assert.equal(verifyData(other.publicKeyPem, payload, sig), false);
  assert.match(keyIdFromPublicPem(keys.publicKeyPem), /^ed25519:[0-9a-f]{16}$/);
});

test("event chain appends and verifies; tampering breaks it", () => {
  const genesis = hashCanonical({ contract: "fake" });
  const chain: ChainedEvent[] = [];
  appendEvent(chain, { type: "run.created" }, genesis);
  appendEvent(
    chain,
    { type: "policy.evaluated", decision: "allow", reason: "test" },
    genesis
  );
  appendEvent(chain, { type: "run.completed" }, genesis);

  assert.deepEqual(verifyChain(chain, genesis), { ok: true });

  const tampered = structuredClone(chain);
  const second = tampered[1];
  assert.ok(second);
  second.event = {
    type: "policy.evaluated",
    decision: "allow",
    reason: "rewritten history"
  };
  const result = verifyChain(tampered, genesis);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.brokenAtSeq, 1);

  const dropped = chain.slice(1);
  const droppedResult = verifyChain(dropped, genesis);
  assert.equal(droppedResult.ok, false);
});

test("protocol vocabulary is canonical and guarded", () => {
  assert.deepEqual(AGENT_KINDS, ["claude-code", "codex", "pi", "mock", "command"]);
  assert.deepEqual(SESSION_ISOLATIONS, [
    "process",
    "hermetic",
    "vercel-sandbox"
  ]);
  assert.ok(RUN_STATUSES.includes("awaiting_approval"));
  assert.equal(isAgentKind("command"), true);
  assert.equal(isAgentKind("shell"), false);
  assert.equal(isTerminalStatus("completed"), true);
  assert.equal(isTerminalStatus("running"), false);
});

test("protocol validators reject unsafe workspace paths and secret names", () => {
  assert.equal(parseWorkspaceManifestPath("src/index.ts"), "src/index.ts");
  assert.throws(() => parseWorkspaceManifestPath("../escape"));
  assert.throws(() => parseWorkspaceManifestPath("/absolute"));
  assert.throws(() => parseWorkspaceManifestPath("a/../escape"));
  assert.equal(parseSecretName("API_TOKEN"), "API_TOKEN");
  assert.throws(() => parseSecretName("bad-name"));
});

function receiptFixture(): {
  contract: RunContract;
  receipt: Receipt;
  events: ChainedEvent[];
  runnerPublicKeyPem: string;
} {
  const plane = generateEd25519KeyPair();
  const runner = generateEd25519KeyPair();
  const workspace = {
    version: "warrant.manifest.v1" as const,
    baseRef: "abc123",
    bundleHash: "1".repeat(64),
    untrackedFiles: [],
    deniedPatterns: [],
    deniedPaths: []
  };
  const contract = signContract(
    {
      version: "warrant.contract.v1",
      runId: "run_test",
      issuedAt: "2026-06-11T00:00:00.000Z",
      issuer: { keyId: keyIdFromPublicPem(plane.publicKeyPem), role: "plane" },
      requestedBy: { kind: "human", id: "alice" },
      agent: { kind: "command" },
      task: { prompt: "echo hi" },
      runner: { pool: "default" },
      workspace,
      policyHash: "2".repeat(64),
      secrets: [{ name: "API_TOKEN", scope: "pool:default" }],
      network: { defaultDeny: true, allowHosts: [] },
      budget: {},
      disclosure: "minimal-context",
      execution: { kind: "shell", script: "echo hi" },
      expiresAt: "2026-06-11T01:00:00.000Z",
      signatures: []
    },
    plane.privateKeyPem,
    plane.publicKeyPem,
    "plane"
  );
  const genesis = contractHash(contract);
  const events: ChainedEvent[] = [];
  appendEvent(events, { type: "run.created" }, genesis);
  appendEvent(events, { type: "secret.released", name: "API_TOKEN", scope: "pool:default" }, genesis);
  appendEvent(events, { type: "command.executed", argvHash: "3".repeat(64), exitCode: 0 }, genesis);
  appendEvent(events, { type: "run.completed" }, genesis);
  const last = events.at(-1);
  assert.ok(last);
  const receipt = signReceipt(
    {
      version: "warrant.receipt.v1",
      runId: "run_test",
      contractHash: genesis,
      runner: {
        runnerId: "rnr_test",
        keyId: keyIdFromPublicPem(runner.publicKeyPem),
        pool: "default",
        attestationTier: "standard",
        isolation: "process"
      },
      startedAt: "2026-06-11T00:00:00.000Z",
      endedAt: "2026-06-11T00:00:01.000Z",
      status: "completed",
      eventsHead: last.hash,
      eventCount: events.length,
      workspaceIn: {
        baseRef: workspace.baseRef,
        manifestHash: hashCanonical(workspace)
      },
      workspaceOut: { diffHash: "", artifactHashes: [] },
      secretsReleased: [
        {
          name: "API_TOKEN",
          scope: "pool:default",
          ts: "2026-06-11T00:00:00.500Z"
        }
      ],
      networkAccessed: [],
      modelsUsed: [],
      boundaryDisclosures: [],
      signatures: []
    },
    runner.privateKeyPem,
    runner.publicKeyPem,
    "runner"
  );
  return { contract, receipt, events, runnerPublicKeyPem: runner.publicKeyPem };
}

test("verifyRunnerReceipt checks pre-countersign receipt evidence", () => {
  const fixture = receiptFixture();
  assert.deepEqual(
    verifyRunnerReceipt({
      contract: fixture.contract,
      receipt: fixture.receipt,
      events: fixture.events,
      runnerPublicKeyPem: fixture.runnerPublicKeyPem
    }),
    { ok: true, problems: [] }
  );

  const tampered = structuredClone(fixture.receipt);
  tampered.eventCount += 1;
  const result = verifyRunnerReceipt({
    contract: fixture.contract,
    receipt: tampered,
    events: fixture.events,
    runnerPublicKeyPem: fixture.runnerPublicKeyPem
  });
  assert.equal(result.ok, false);
  assert.ok(result.problems.includes("receipt.eventCount does not match the event chain"));
});

test("receipt story is the canonical CLI/UI summary model", () => {
  const fixture = receiptFixture();
  const story = buildReceiptStory({
    version: "warrant.bundle.v1",
    contract: fixture.contract,
    receipt: fixture.receipt,
    events: fixture.events,
    keys: {
      planePublicKeyPem: generateEd25519KeyPair().publicKeyPem,
      runnerPublicKeyPem: fixture.runnerPublicKeyPem
    }
  });
  assert.equal(story.runId, "run_test");
  assert.equal(story.status, "completed");
  assert.equal(story.agent, "command");
  assert.deepEqual(story.secrets, ["API_TOKEN (pool:default)"]);
});
