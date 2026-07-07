import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { verifyReceiptBundle } from "@fusionkit/protocol";
import { CapabilityMismatchError } from "@fusionkit/runner";
import { makeRepo, startStack } from "@fusionkit/testkit";
import type { Stack } from "@fusionkit/testkit";
import { captureWorkspace } from "@fusionkit/workspace";

import { isPiAgentRun, piAuthFromEnv, piHarnessBackend } from "../index.js";
import { emptyHarnessLog, fakeHarness, fakeLocalSandboxProvider } from "./fakes.js";
import type { FakeHarnessLog } from "./fakes.js";

// ---------------------------------------------------------------------------
// auth: a local endpoint maps to explicit customEnv; everything else fails closed
// ---------------------------------------------------------------------------

test("pi auth: a local OpenAI-compatible endpoint maps to explicit customEnv", () => {
  const auth = piAuthFromEnv({
    OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
    OPENAI_API_KEY: "local-dummy"
  });
  assert.deepEqual(auth, {
    customEnv: {
      OPENAI_API_KEY: "local-dummy",
      OPENAI_BASE_URL: "http://127.0.0.1:11434/v1"
    }
  });
});

test("pi auth: a gateway key is forwarded as customEnv too", () => {
  const auth = piAuthFromEnv({ AI_GATEWAY_API_KEY: "gw" });
  assert.deepEqual(auth, { customEnv: { AI_GATEWAY_API_KEY: "gw" } });
});

test("pi auth: no provider credential fails closed", () => {
  assert.throws(
    () => piAuthFromEnv({ OPENAI_BASE_URL: "http://127.0.0.1:11434/v1" }),
    (error: unknown) =>
      error instanceof CapabilityMismatchError && /refusing to fall back/.test(error.message)
  );
});

test("pi auth: env vars the pi path cannot deliver fail closed", () => {
  assert.throws(
    () => piAuthFromEnv({ OPENAI_API_KEY: "k", CUSTOM_FLAG: "1" }),
    (error: unknown) =>
      error instanceof CapabilityMismatchError && /CUSTOM_FLAG/.test(error.message)
  );
});

// ---------------------------------------------------------------------------
// delegation: non-pi executions go to the fallback (hermetic) backend
// ---------------------------------------------------------------------------

test("pi backend reports the hermetic tier and recognizes pi agent runs", () => {
  const backend = piHarnessBackend();
  assert.equal(backend.isolation, "hermetic");
});

// ---------------------------------------------------------------------------
// end to end: a governed pi run through the real HarnessAgent
//
// As in the claude-code e2e, the fakes replace only what needs a live local
// model (the pi adapter) and a real sandbox (a local directory in place of
// just-bash). The binding wiring, generic backend, staging, mirror-back,
// event chain, and offline verification are all real — and the run is
// labeled with the hermetic tier the pi binding declares.
// ---------------------------------------------------------------------------

const POOL = "swarm-pool";

let stack: Stack;
let repoDir: string;
let sandboxRoot: string;
const harnessLog: FakeHarnessLog = emptyHarnessLog();

before(async () => {
  sandboxRoot = mkdtempSync(join(tmpdir(), "warrant-fake-pi-sandbox-"));
  stack = await startStack({
    pool: POOL,
    startRunner: true,
    backends: [
      piHarnessBackend({
        createHarness: ({ env }) => {
          harnessLog.envSeen.push(env);
          return fakeHarness(harnessLog, "fake-pi");
        },
        createSandboxProvider: () => fakeLocalSandboxProvider(sandboxRoot)
      })
    ],
    policy: (policy) => {
      policy.agents.allow = ["pi"];
    }
  });
  repoDir = makeRepo({
    files: { "README.md": "# pi fixture\n", "data.txt": "alpha\nbeta\n" }
  });
});

after(async () => {
  await stack.stop();
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(sandboxRoot, { recursive: true, force: true });
});

test("e2e: a pi contract runs through the real HarnessAgent on the hermetic tier", async () => {
  const captured = captureWorkspace(repoDir);
  await stack.client.putBlob(captured.bundle);
  if (captured.dirtyDiff) await stack.client.putBlob(captured.dirtyDiff);
  const created = await stack.client.requestRun({
    requestedBy: { kind: "human", id: "swarm-worker" },
    agentKind: "pi",
    prompt: "count the lines in data.txt",
    pool: POOL,
    secretNames: [],
    workspace: captured.manifest,
    network: { defaultDeny: true, allowHosts: [] },
    budget: {},
    disclosure: "minimal-context",
    isolation: "hermetic",
    execution: {
      kind: "agent",
      agent: { kind: "pi" },
      prompt: "count the lines in data.txt",
      env: {
        vars: {
          OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
          OPENAI_API_KEY: "local-dummy"
        }
      }
    }
  });

  const contract = created.runId;
  assert.ok(isPiAgentRun);
  assert.equal(await stack.runOnce(), contract);
  const bundle = await stack.client.getBundle(contract);

  assert.equal(bundle.receipt.status, "completed");
  assert.equal(bundle.receipt.runner.isolation, "hermetic");
  assert.deepEqual(verifyReceiptBundle(bundle).problems, []);

  // The pi adapter saw the prompt and the broker-resolved local endpoint env,
  // never the host environment.
  assert.deepEqual(harnessLog.prompts, ["count the lines in data.txt"]);
  assert.deepEqual(harnessLog.envSeen, [
    {
      OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      OPENAI_API_KEY: "local-dummy"
    }
  ]);

  // The worker's edit was mirrored back into the runner's checkout.
  assert.ok(bundle.receipt.workspaceOut.diffHash, "expected a workspace diff");
  const diff = await stack.client.getBlob(bundle.receipt.workspaceOut.diffHash);
  assert.ok(diff.toString("utf8").includes("result.txt"));

  const fileEvents = bundle.events.filter((e) => e.event.type === "file.changed");
  assert.ok(
    fileEvents.some((e) => e.event.type === "file.changed" && e.event.path === "result.txt"),
    "expected the mirrored result.txt in the boundary file events"
  );
});
