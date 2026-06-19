import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { generateEd25519KeyPair } from "@fusionkit/protocol";
import type { RunRequestInput, RunSummary, WorkspaceManifest } from "@fusionkit/protocol";

import { generateMasterKeyHex, masterKeyFromMaterial } from "../keys.js";
import { Plane } from "../plane.js";
import { defaultPolicy } from "../policy.js";
import { SecretStore } from "../secrets.js";
import { startPlaneServer } from "../server.js";

const ADMIN = "api-test-admin";
let dataDir: string;
let baseUrl: string;
let server: { close(cb: () => void): void };

function manifestFixture(): WorkspaceManifest {
  return {
    version: "warrant.manifest.v1",
    baseRef: "0".repeat(40),
    bundleHash: "1".repeat(64),
    untrackedFiles: [],
    deniedPatterns: [],
    deniedPaths: []
  };
}

function requestFixture(overrides: Partial<RunRequestInput> = {}): RunRequestInput {
  return {
    requestedBy: { kind: "human", id: "api-tester" },
    agentKind: "mock",
    prompt: "api test task",
    pool: "default",
    secretNames: [],
    workspace: manifestFixture(),
    network: { defaultDeny: true, allowHosts: [] },
    budget: {},
    disclosure: "minimal-context",
    ...overrides
  };
}

async function http(
  method: string,
  path: string,
  options: { body?: unknown; token?: string } = {}
): Promise<{ status: number; body: unknown; contentType: string }> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "manual"
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  return { status: response.status, body, contentType };
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "warrant-api-test-"));
  const keys = generateEd25519KeyPair();
  const policy = defaultPolicy();
  policy.consent = [{ when: "agent-kind", match: "codex", approvers: ["sec"] }];
  policy.agents.allow = ["mock", "codex"];
  const plane = new Plane({
    dataDir: join(dataDir, "data"),
    policy,
    planePrivateKeyPem: keys.privateKeyPem,
    planePublicKeyPem: keys.publicKeyPem,
    adminToken: ADMIN,
    enrollToken: "api-test-enroll",
    secretStore: new SecretStore(
      join(dataDir, "secrets.enc"),
      masterKeyFromMaterial(generateMasterKeyHex())
    )
  });
  const started = await startPlaneServer(plane, { port: 0 });
  server = started.server;
  baseUrl = `http://127.0.0.1:${started.port}`;
});

after(() => {
  server.close(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
});

test("health endpoint requires no auth", async () => {
  const { status, body } = await http("GET", "/v1/health");
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, service: "warrant-plane" });
});

test("root redirects to the control panel, which serves all assets", async () => {
  const root = await fetch(`${baseUrl}/`, { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/ui/");
  await root.arrayBuffer();

  const page = await http("GET", "/ui/");
  assert.equal(page.status, 200);
  assert.match(page.contentType, /text\/html/);
  assert.match(String(page.body), /Warrant — Control Panel/);

  const css = await http("GET", "/ui/app.css");
  assert.equal(css.status, 200);
  assert.match(css.contentType, /text\/css/);

  const js = await http("GET", "/ui/app.js");
  assert.equal(js.status, 200);
  assert.match(js.contentType, /text\/javascript/);
  assert.match(String(js.body), /control panel/);
});

test("admin endpoints fail closed without the admin token", async () => {
  for (const path of ["/v1/runs", "/v1/runners", "/v1/policy", "/v1/export"]) {
    const { status } = await http("GET", path);
    assert.equal(status, 401, `${path} must require auth`);
  }
  const { status } = await http("GET", "/v1/runs", { token: "wrong" });
  assert.equal(status, 401);
});

test("policy endpoint returns the snapshot and its hash", async () => {
  const { status, body } = await http("GET", "/v1/policy", { token: ADMIN });
  assert.equal(status, 200);
  const snapshot = body as { policy: { version: string }; policyHash: string };
  assert.equal(snapshot.policy.version, "warrant.policy.v1");
  assert.match(snapshot.policyHash, /^[0-9a-f]{64}$/);
});

test("runs can be listed, and unclaimed runs can be cancelled", async () => {
  const created = await http("POST", "/v1/runs", {
    token: ADMIN,
    body: { request: requestFixture() }
  });
  assert.equal(created.status, 200);
  const { runId } = created.body as { runId: string };

  const list = await http("GET", "/v1/runs", { token: ADMIN });
  assert.equal(list.status, 200);
  const { runs } = list.body as { runs: RunSummary[] };
  const row = runs.find((r) => r.runId === runId);
  assert.ok(row, "created run must appear in the list");
  assert.equal(row.status, "created");
  assert.equal(row.agentKind, "mock");
  assert.equal(row.hasReceipt, false);

  const cancelled = await http("POST", `/v1/runs/${runId}/cancel`, {
    token: ADMIN,
    body: { actor: { kind: "human", id: "api-tester" } }
  });
  assert.equal(cancelled.status, 200);
  assert.deepEqual(cancelled.body, { runId, status: "cancelled" });

  const again = await http("POST", `/v1/runs/${runId}/cancel`, {
    token: ADMIN,
    body: { actor: { kind: "human", id: "api-tester" } }
  });
  assert.equal(again.status, 400, "terminal runs cannot be cancelled twice");
});

test("awaiting-approval runs can be cancelled before any contract exists", async () => {
  const created = await http("POST", "/v1/runs", {
    token: ADMIN,
    body: { request: requestFixture({ agentKind: "codex", pool: "default" }) }
  });
  assert.equal(created.status, 200);
  const { runId, status } = created.body as { runId: string; status: string };
  assert.equal(status, "awaiting_approval");

  const cancelled = await http("POST", `/v1/runs/${runId}/cancel`, {
    token: ADMIN,
    body: { actor: { kind: "human", id: "sec" } }
  });
  assert.equal(cancelled.status, 200);
  assert.deepEqual(cancelled.body, { runId, status: "cancelled" });
});

test("runner listing reports enrolled runners without token material", async () => {
  const enrolled = await http("POST", "/v1/runners/enroll", {
    body: {
      enrollToken: "api-test-enroll",
      publicKeyPem: generateEd25519KeyPair().publicKeyPem,
      pool: "default"
    }
  });
  assert.equal(enrolled.status, 200);

  const { status, body } = await http("GET", "/v1/runners", { token: ADMIN });
  assert.equal(status, 200);
  const { runners } = body as { runners: Record<string, string>[] };
  assert.ok(runners.length >= 1);
  const runner = runners[0];
  assert.ok(runner);
  assert.match(runner.runnerId ?? "", /^rnr_/);
  assert.match(runner.keyId ?? "", /^ed25519:/);
  assert.equal(runner.tokenHash, undefined, "token hashes must not be exposed");
  assert.equal(runner.publicKeyPem, undefined, "raw PEM is not part of the summary");
});
