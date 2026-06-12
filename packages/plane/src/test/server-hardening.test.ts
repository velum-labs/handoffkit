import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { generateEd25519KeyPair } from "@warrant/protocol";
import type { RunRequestInput, WorkspaceManifest } from "@warrant/protocol";

import { generateMasterKeyHex, masterKeyFromMaterial } from "../keys.js";
import { Plane } from "../plane.js";
import { defaultPolicy } from "../policy.js";
import { SecretStore } from "../secrets.js";
import { startPlaneServer } from "../server.js";

const ADMIN = "srv-admin";
let dir: string;
let plane: Plane;
let server: Server;
let baseUrl: string;
let requesterToken: string;

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

function runBody(): RunRequestInput {
  return {
    requestedBy: { kind: "human", id: "tester" },
    agentKind: "mock",
    prompt: "server hardening",
    pool: "default",
    secretNames: [],
    workspace: manifest(),
    network: { defaultDeny: true, allowHosts: [] },
    budget: {},
    disclosure: "minimal-context"
  };
}

type Resp = { status: number; body: unknown };

async function http(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; rawBody?: string } = {}
): Promise<Resp> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined || options.rawBody !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body:
      options.rawBody ??
      (options.body === undefined ? undefined : JSON.stringify(options.body))
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? JSON.parse(text) : undefined
  };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "warrant-srv-"));
  const keys = generateEd25519KeyPair();
  plane = new Plane({
    dataDir: dir,
    policy: defaultPolicy(),
    planePrivateKeyPem: keys.privateKeyPem,
    planePublicKeyPem: keys.publicKeyPem,
    adminToken: ADMIN,
    enrollToken: "srv-enroll",
    secretStore: new SecretStore(
      join(dir, "secrets.enc"),
      masterKeyFromMaterial(generateMasterKeyHex())
    )
  });
  requesterToken = plane.issuePrincipal("ci", "requester").token;
  const started = await startPlaneServer(plane, { port: 0 });
  server = started.server;
  baseUrl = `http://127.0.0.1:${started.port}`;
});

after(() => {
  server.close(() => undefined);
  plane.close();
  rmSync(dir, { recursive: true, force: true });
});

test("readiness and health probes", async () => {
  assert.equal((await http("GET", "/v1/health")).status, 200);
  const ready = await http("GET", "/v1/ready");
  assert.equal(ready.status, 200);
  assert.deepEqual(ready.body, { ready: true });
});

test("auth distinguishes 401 (no/invalid token) from 403 (wrong role)", async () => {
  assert.equal((await http("GET", "/v1/runs")).status, 401);
  assert.equal((await http("GET", "/v1/runs", { token: "bogus" })).status, 401);
  // requester may read/create runs but not list runners or manage principals.
  assert.equal((await http("GET", "/v1/runs", { token: requesterToken })).status, 200);
  assert.equal(
    (await http("GET", "/v1/runners", { token: requesterToken })).status,
    403
  );
  assert.equal(
    (await http("GET", "/v1/principals", { token: requesterToken })).status,
    403
  );
  assert.equal((await http("GET", "/v1/principals", { token: ADMIN })).status, 200);
});

test("malformed JSON and schema violations return structured 400s", async () => {
  const malformed = await http("POST", "/v1/runs", {
    token: ADMIN,
    rawBody: "{not json"
  });
  assert.equal(malformed.status, 400);

  const missingRequest = await http("POST", "/v1/runs", {
    token: ADMIN,
    body: {}
  });
  assert.equal(missingRequest.status, 400);
  assert.ok(Array.isArray((missingRequest.body as { issues?: unknown[] }).issues));

  const badEnum = await http("POST", "/v1/runs", {
    token: ADMIN,
    body: { request: { ...runBody(), disclosure: "nonsense" } }
  });
  assert.equal(badEnum.status, 400);

  const badHash = await http("POST", "/v1/runs", {
    token: ADMIN,
    body: {
      request: {
        ...runBody(),
        workspace: { ...manifest(), bundleHash: "not-a-hash" }
      }
    }
  });
  assert.equal(badHash.status, 400);
});

test("valid run request is accepted and listed", async () => {
  const created = await http("POST", "/v1/runs", {
    token: ADMIN,
    body: { request: runBody() }
  });
  assert.equal(created.status, 200);
  const list = await http("GET", "/v1/runs", { token: ADMIN });
  assert.equal(list.status, 200);
});

test("admin can mint and use a single-use enroll token over HTTP", async () => {
  const issued = await http("POST", "/v1/enroll-tokens", { token: ADMIN });
  assert.equal(issued.status, 200);
  const token = (issued.body as { token: string }).token;
  const enroll = await http("POST", "/v1/runners/enroll", {
    body: {
      enrollToken: token,
      publicKeyPem: generateEd25519KeyPair().publicKeyPem,
      pool: "default"
    }
  });
  assert.equal(enroll.status, 200);
  // Reuse is rejected.
  const reuse = await http("POST", "/v1/runners/enroll", {
    body: {
      enrollToken: token,
      publicKeyPem: generateEd25519KeyPair().publicKeyPem,
      pool: "default"
    }
  });
  assert.equal(reuse.status, 400);
});

test("rate limiting trips after the burst is exhausted", async () => {
  // A dedicated server with a tiny bucket so the limit trips deterministically
  // without starving the other tests sharing the main server.
  const tinyDir = mkdtempSync(join(tmpdir(), "warrant-rl-"));
  const keys = generateEd25519KeyPair();
  const tinyPlane = new Plane({
    dataDir: tinyDir,
    policy: defaultPolicy(),
    planePrivateKeyPem: keys.privateKeyPem,
    planePublicKeyPem: keys.publicKeyPem,
    adminToken: "rl-admin",
    enrollToken: "rl-enroll",
    secretStore: new SecretStore(
      join(tinyDir, "secrets.enc"),
      masterKeyFromMaterial(generateMasterKeyHex())
    )
  });
  const started = await startPlaneServer(tinyPlane, {
    port: 0,
    rateLimit: { ratePerSec: 1, burst: 3, authFailureLimit: 100, authFailureWindowMs: 1000 }
  });
  const tinyUrl = `http://127.0.0.1:${started.port}`;
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${tinyUrl}/v1/runs`, {
        headers: { authorization: "Bearer rl-admin" }
      });
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    assert.ok(statuses.includes(200), "the first requests within the burst succeed");
    assert.ok(statuses.includes(429), "later requests are rate limited");
  } finally {
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
    tinyPlane.close();
    rmSync(tinyDir, { recursive: true, force: true });
  }
});
