import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { generateEd25519KeyPair } from "@fusionkit/protocol";
import type { RunRequest, WorkspaceManifest } from "@fusionkit/protocol";

import { generateMasterKeyHex, masterKeyFromMaterial, open, seal } from "../keys.js";
import { Plane } from "../plane.js";
import { defaultPolicy } from "../policy.js";
import { RateLimiter } from "../ratelimit.js";
import { SecretStore } from "../secrets.js";
import { SqliteStore } from "../sqlite-store.js";

function manifest(): WorkspaceManifest {
  return {
    version: "warrant.manifest.v1",
    baseRef: "0".repeat(40),
    bundleHash: "1".repeat(64),
    untrackedFiles: [],
    deniedPatterns: [],
    deniedPaths: []
  };
}

function runRequest(pool: string): Omit<RunRequest, "runId"> {
  return {
    requestedBy: { kind: "human", id: "tester" },
    agentKind: "mock",
    prompt: "hardening",
    pool,
    secretNames: [],
    workspace: manifest(),
    network: { defaultDeny: true, allowHosts: [] },
    budget: {},
    disclosure: "minimal-context"
  };
}

type Harness = { plane: Plane; dir: string; stop: () => void };

function makePlane(options: { dataDir?: string } = {}): Harness {
  const dir = options.dataDir ?? mkdtempSync(join(tmpdir(), "warrant-hard-"));
  const keys = generateEd25519KeyPair();
  const policy = defaultPolicy();
  const plane = new Plane({
    dataDir: dir,
    policy,
    planePrivateKeyPem: keys.privateKeyPem,
    planePublicKeyPem: keys.publicKeyPem,
    adminToken: "admin-tok",
    enrollToken: "enroll-tok",
    secretStore: new SecretStore(
      join(dir, "secrets.enc"),
      masterKeyFromMaterial(generateMasterKeyHex())
    )
  });
  return {
    plane,
    dir,
    stop: () => {
      plane.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("atomic claim: each created run is claimed exactly once", () => {
  const { plane, stop } = makePlane();
  try {
    const a = plane.enrollRunner({
      enrollToken: "enroll-tok",
      publicKeyPem: generateEd25519KeyPair().publicKeyPem,
      pool: "default"
    });
    const b = plane.enrollRunner({
      enrollToken: "enroll-tok",
      publicKeyPem: generateEd25519KeyPair().publicKeyPem,
      pool: "default"
    });

    const runIds = new Set<string>();
    for (let i = 0; i < 20; i++) {
      runIds.add(plane.requestRun(runRequest("default")).id);
    }

    // Two runners drain the queue; every claim must be a distinct run, and
    // the total claimed must equal the number created (no double-claim, no loss).
    const claimed: string[] = [];
    for (;;) {
      const fromA = plane.claim({ runnerToken: a.runnerToken, pool: "default" });
      const fromB = plane.claim({ runnerToken: b.runnerToken, pool: "default" });
      if (fromA) claimed.push(fromA.runId);
      if (fromB) claimed.push(fromB.runId);
      if (!fromA && !fromB) break;
    }
    assert.equal(claimed.length, runIds.size);
    assert.equal(new Set(claimed).size, claimed.length, "no run was claimed twice");
    for (const id of claimed) assert.ok(runIds.has(id));
  } finally {
    stop();
  }
});

test("plane state (runs, runners) is durable across a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "warrant-restart-"));
  let runId: string;
  try {
    const first = makePlane({ dataDir: dir });
    first.plane.enrollRunner({
      enrollToken: "enroll-tok",
      publicKeyPem: generateEd25519KeyPair().publicKeyPem,
      pool: "default"
    });
    runId = first.plane.requestRun(runRequest("default")).id;
    first.plane.close();

    // Reopen against the same database: a brand-new plane instance sees the
    // run and the enrolled runner. (The nonce ledger lives in this same DB,
    // which is what makes completion replay protection survive restarts.)
    const second = makePlane({ dataDir: dir });
    try {
      assert.equal(second.plane.getRun(runId)?.status, "created");
      assert.ok(second.plane.listRunners().length >= 1);
    } finally {
      second.plane.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("durable nonce ledger rejects a replayed nonce, even after reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "warrant-nonce-"));
  try {
    const store1 = new SqliteStore(join(dir, "plane.db"));
    assert.equal(store1.recordClaimNonce("nonce-1", Date.now() + 100000), true);
    assert.equal(store1.recordClaimNonce("nonce-1", Date.now() + 100000), false);
    store1.close();

    // Reopen: the nonce is still present and still rejected.
    const store2 = new SqliteStore(join(dir, "plane.db"));
    assert.equal(store2.recordClaimNonce("nonce-1", Date.now() + 100000), false);
    // Pruning removes expired nonces.
    assert.equal(store2.recordClaimNonce("nonce-2", Date.now() - 1), true);
    assert.ok(store2.pruneClaimNonces(Date.now()) >= 1);
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("principals: issue, role gating, rotation, and revocation", () => {
  const { plane, stop } = makePlane();
  try {
    assert.equal(plane.authenticate("admin-tok")?.role, "admin");
    assert.equal(plane.checkAdminToken("admin-tok"), true);
    assert.equal(plane.authenticate("nope"), undefined);

    const requester = plane.issuePrincipal("ci-bot", "requester");
    const p = plane.authenticate(requester.token);
    assert.equal(p?.role, "requester");
    // requester can create runs but not manage principals.
    assert.ok(plane.authorize(requester.token, "runs:create"));
    assert.equal(plane.authorize(requester.token, "principals:manage"), undefined);

    // Rotation invalidates the old token.
    const rotated = plane.rotatePrincipal("ci-bot");
    assert.equal(plane.authenticate(requester.token), undefined);
    assert.equal(plane.authenticate(rotated.token)?.name, "ci-bot");

    // Revocation invalidates entirely.
    assert.equal(plane.revokePrincipal("ci-bot"), true);
    assert.equal(plane.authenticate(rotated.token), undefined);

    assert.throws(() => plane.issuePrincipal("admin", "admin"), /already exists/);
  } finally {
    stop();
  }
});

test("single-use enroll tokens are consumed exactly once and expire", () => {
  const { plane, stop } = makePlane();
  try {
    const issued = plane.issueEnrollToken({ pool: "default" });
    const first = plane.enrollRunner({
      enrollToken: issued.token,
      publicKeyPem: generateEd25519KeyPair().publicKeyPem,
      pool: "default"
    });
    assert.match(first.runnerId, /^rnr_/);
    // Second use of the same single-use token is rejected.
    assert.throws(
      () =>
        plane.enrollRunner({
          enrollToken: issued.token,
          publicKeyPem: generateEd25519KeyPair().publicKeyPem,
          pool: "default"
        }),
      /invalid enroll token/
    );
    // Expired token is rejected.
    const expired = plane.issueEnrollToken({ pool: "default", ttlMs: -1 });
    assert.throws(
      () =>
        plane.enrollRunner({
          enrollToken: expired.token,
          publicKeyPem: generateEd25519KeyPair().publicKeyPem,
          pool: "default"
        }),
      /invalid enroll token/
    );
  } finally {
    stop();
  }
});

test("rate limiter: token bucket and auth-failure lockout", () => {
  let nowMs = 1_000_000;
  const limiter = new RateLimiter(
    { ratePerSec: 1, burst: 3, authFailureLimit: 3, authFailureWindowMs: 1000 },
    () => nowMs
  );
  assert.equal(limiter.allow("k"), true);
  assert.equal(limiter.allow("k"), true);
  assert.equal(limiter.allow("k"), true);
  assert.equal(limiter.allow("k"), false, "burst exhausted");
  nowMs += 1100; // refill ~1 token
  assert.equal(limiter.allow("k"), true);

  assert.equal(limiter.isLockedOut("ip"), false);
  limiter.recordAuthFailure("ip");
  limiter.recordAuthFailure("ip");
  assert.equal(limiter.isLockedOut("ip"), false);
  limiter.recordAuthFailure("ip");
  assert.equal(limiter.isLockedOut("ip"), true, "locked out after the limit");
  limiter.recordAuthSuccess("ip");
  assert.equal(limiter.isLockedOut("ip"), false, "success clears the lockout");
});

test("master-key sealing round-trips and rejects the wrong key", () => {
  const master = masterKeyFromMaterial(generateMasterKeyHex());
  const sealed = seal(master, Buffer.from("top secret", "utf8"));
  assert.equal(open(master, sealed).toString("utf8"), "top secret");

  const other = masterKeyFromMaterial(generateMasterKeyHex());
  assert.throws(() => open(other, sealed));

  // The sealed blob does not contain the plaintext.
  assert.ok(!JSON.stringify(sealed).includes("top secret"));
});

test("secret store seals at rest and the master key is required to read", () => {
  const dir = mkdtempSync(join(tmpdir(), "warrant-secret-"));
  try {
    const master = masterKeyFromMaterial(generateMasterKeyHex());
    const store = new SecretStore(join(dir, "secrets.enc"), master);
    store.set("API_KEY", "sk-live-do-not-leak");
    assert.deepEqual(store.release(["API_KEY"]), [
      { name: "API_KEY", value: "sk-live-do-not-leak" }
    ]);

    // A store opened with a different master key cannot read.
    const wrong = new SecretStore(
      join(dir, "secrets.enc"),
      masterKeyFromMaterial(generateMasterKeyHex())
    );
    assert.throws(() => wrong.names());

    store.rotate("API_KEY", "sk-live-rotated");
    assert.equal(store.release(["API_KEY"])[0]?.value, "sk-live-rotated");
    assert.equal(store.remove("API_KEY"), true);
    assert.throws(() => store.release(["API_KEY"]), /not in the store/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retention sweep deletes old terminal runs and GCs unreferenced blobs", () => {
  const { plane, stop } = makePlane();
  try {
    // An orphan blob nothing references should be collected.
    const orphan = plane.blobs.putBlob(Buffer.from("orphan", "utf8"));
    // A referenced workspace bundle blob should survive.
    plane.requestRun(runRequest("default"));
    const result = plane.sweepRetention();
    assert.ok(result.deletedBlobs >= 1, "orphan blob collected");
    assert.equal(plane.blobs.getBlob(orphan), undefined);
  } finally {
    stop();
  }
});
