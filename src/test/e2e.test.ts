import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { Plane } from "../plane/plane.js";
import { startPlaneServer } from "../plane/server.js";
import { defaultPolicy } from "../plane/policy.js";
import { SecretStore } from "../plane/secrets.js";
import { generateEd25519KeyPair } from "../protocol/keys.js";
import { verifyReceiptBundle } from "../protocol/receipt.js";
import type { ReceiptBundle } from "../protocol/types.js";
import { Runner } from "../runner/runner.js";
import { captureWorkspace, pullRun } from "../runner/workspace.js";
import { PlaneClient, PlaneClientError } from "../sdk/client.js";
import type { RunRequestInput } from "../sdk/client.js";

const MOCK_SCRIPT = fileURLToPath(
  new URL("../runner/mock-agent.js", import.meta.url)
);
const SECRET_VALUE = "super-sensitive-value-1234";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "warrant-e2e-repo-"));
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "test@warrant.local"]);
  git(dir, ["config", "user.name", "warrant-test"]);
  writeFileSync(join(dir, "README.md"), "# e2e fixture\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", "init"]);
  return dir;
}

let planeDir: string;
let runnerDir: string;
let repoDir: string;
let server: { close(cb: () => void): void };
let client: PlaneClient;
let runner: Runner;

before(async () => {
  planeDir = mkdtempSync(join(tmpdir(), "warrant-e2e-plane-"));
  runnerDir = mkdtempSync(join(tmpdir(), "warrant-e2e-runner-"));
  repoDir = makeRepo();

  const policy = defaultPolicy();
  policy.runners.allowPools = ["eng-prod"];
  policy.agents.allow = ["mock"];
  policy.secrets.releasable = [
    { name: "MOCK_SECRET", scope: "e2e-test", pools: ["eng-prod"] }
  ];
  policy.consent = [{ when: "secret-release", approvers: ["security"] }];

  const keys = generateEd25519KeyPair();
  const secretStore = new SecretStore(
    join(planeDir, "secrets.enc"),
    SecretStore.generateKeyHex()
  );
  secretStore.set("MOCK_SECRET", SECRET_VALUE);

  const plane = new Plane({
    dataDir: join(planeDir, "data"),
    policy,
    planePrivateKeyPem: keys.privateKeyPem,
    planePublicKeyPem: keys.publicKeyPem,
    adminToken: "admin-token-test",
    enrollToken: "enroll-token-test",
    secretStore
  });
  const started = await startPlaneServer(plane, 0);
  server = started.server;

  const planeUrl = `http://127.0.0.1:${started.port}`;
  client = new PlaneClient(planeUrl, "admin-token-test");
  runner = new Runner({
    planeUrl,
    pool: "eng-prod",
    dataDir: runnerDir,
    enrollToken: "enroll-token-test",
    mockScriptPath: MOCK_SCRIPT
  });
  await runner.ensureEnrolled();
});

after(() => {
  server.close(() => undefined);
  rmSync(planeDir, { recursive: true, force: true });
  rmSync(runnerDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

function buildRequest(prompt: string): RunRequestInput {
  const captured = captureWorkspace(repoDir);
  return {
    requestedBy: { kind: "human", id: "e2e-tester" },
    agentKind: "mock",
    prompt,
    pool: "eng-prod",
    secretNames: ["MOCK_SECRET"],
    workspace: captured.manifest,
    network: { defaultDeny: true, allowHosts: [] },
    budget: {},
    disclosure: "minimal-context"
  };
}

async function uploadWorkspaceBlobs(): Promise<void> {
  const captured = captureWorkspace(repoDir);
  await client.putBlob(captured.bundle);
  if (captured.dirtyDiff) await client.putBlob(captured.dirtyDiff);
  for (const file of captured.untracked) await client.putBlob(file.content);
}

let completedBundle: ReceiptBundle;

test("dry run disclosure report moves nothing", async () => {
  const report = await client.dryRun(buildRequest("dry run probe"));
  assert.equal(report.dryRun, true);
  assert.equal(report.policyDecision.decision, "ask");
  assert.deepEqual(
    report.secrets.map((s) => s.name),
    ["MOCK_SECRET"]
  );
  assert.equal(report.network.defaultDeny, true);
});

test("policy denies a disallowed agent kind, fail closed", async () => {
  const request = { ...buildRequest("nope"), agentKind: "codex" };
  await assert.rejects(
    () => client.requestRun(request),
    (error: unknown) => {
      assert.ok(error instanceof PlaneClientError);
      assert.equal(error.status, 403);
      return true;
    }
  );
});

test("governed run: consent, execution, secret injection, egress blocking, receipt", async () => {
  await uploadWorkspaceBlobs();
  const created = await client.requestRun(
    buildRequest("e2e task: touch files and probe network")
  );
  assert.equal(created.status, "awaiting_approval");

  // Runner cannot claim before approval.
  assert.equal(await runner.runOnce(), undefined);

  await client.approve(created.runId, { kind: "human", id: "security-lead" });

  const processed = await runner.runOnce();
  assert.equal(processed, created.runId);

  const view = await client.getRun(created.runId);
  assert.equal(view.status, "completed");

  completedBundle = await client.getBundle(created.runId);
  const { receipt, events } = completedBundle;

  // Receipt answers the five questions.
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.runner.attestationTier, "mock");
  assert.deepEqual(
    receipt.secretsReleased.map((s) => s.name),
    ["MOCK_SECRET"]
  );
  assert.ok(
    receipt.networkAccessed.some(
      (n) => n.host === "denied.example.com" && n.decision === "blocked"
    ),
    "egress probe must be recorded as blocked"
  );
  assert.ok(receipt.workspaceOut.diffHash, "run must produce a diff");
  assert.ok(
    events.some(
      (e) => e.event.type === "file.changed" && e.event.path === "MOCK_AGENT.md"
    )
  );
  assert.ok(events.some((e) => e.event.type === "consent.granted"));
  assert.ok(events.some((e) => e.event.type === "boundary.crossed"));

  // Secret value never appears anywhere in the bundle.
  assert.ok(!JSON.stringify(completedBundle).includes(SECRET_VALUE));

  // The agent saw the secret (injection worked) without the value leaking.
  const diff = await client.getBlob(receipt.workspaceOut.diffHash);
  const diffText = diff.toString("utf8");
  assert.ok(diffText.includes("secret:present"));
  assert.ok(!diffText.includes(SECRET_VALUE));
});

test("receipt bundle verifies offline; tampering is detected", () => {
  const verification = verifyReceiptBundle(completedBundle);
  assert.deepEqual(verification.problems, []);
  assert.equal(verification.ok, true);

  const tampered = structuredClone(completedBundle);
  const secretEvent = tampered.events.find(
    (e) => e.event.type === "secret.released"
  );
  assert.ok(secretEvent, "fixture must include a secret.released event");
  tampered.events = tampered.events.filter((e) => e !== secretEvent);
  tampered.events.forEach((e, i) => {
    e.seq = i;
  });
  const tamperedResult = verifyReceiptBundle(tampered);
  assert.equal(tamperedResult.ok, false);

  const forgedReceipt = structuredClone(completedBundle);
  forgedReceipt.receipt.secretsReleased = [];
  const forgedResult = verifyReceiptBundle(forgedReceipt);
  assert.equal(forgedResult.ok, false);
});

test("pull applies the run output divergence-safely", async () => {
  const diff = await client.getBlob(completedBundle.receipt.workspaceOut.diffHash);

  // Clean repo at base ref: fast path applies in place.
  const clean = pullRun(
    repoDir,
    completedBundle.receipt.runId,
    completedBundle.contract.workspace.baseRef,
    diff
  );
  assert.deepEqual(clean, { mode: "applied" });
  const content = readFileSync(join(repoDir, "MOCK_AGENT.md"), "utf8");
  assert.ok(content.includes("e2e task"));
  assert.ok(content.includes("secret:present"));

  // Diverged repo: results land on a branch, checkout untouched.
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "--quiet", "-m", "absorb pulled output"]);
  writeFileSync(join(repoDir, "local-edit.txt"), "concurrent local work\n");
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "--quiet", "-m", "diverge"]);

  const diverged = pullRun(
    repoDir,
    completedBundle.receipt.runId,
    completedBundle.contract.workspace.baseRef,
    diff
  );
  assert.equal(diverged.mode, "branch");
});

test("audit export emits JSONL for every event", async () => {
  const jsonl = await client.exportJsonl();
  const lines = jsonl.trim().split("\n");
  assert.ok(lines.length >= completedBundle.events.length);
  for (const line of lines) {
    const parsed = JSON.parse(line) as { runId: string; hash: string };
    assert.ok(parsed.runId.startsWith("run_"));
    assert.match(parsed.hash, /^[0-9a-f]{64}$/);
  }
  assert.ok(!jsonl.includes(SECRET_VALUE));
});
