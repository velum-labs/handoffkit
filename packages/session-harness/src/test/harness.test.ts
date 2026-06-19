import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type { RunContract } from "@fusionkit/protocol";
import { verifyReceiptBundle } from "@fusionkit/protocol";
import { CapabilityMismatchError, prepareExecution } from "@fusionkit/runner";
import type { SessionBackend, SessionExecution } from "@fusionkit/runner";
import { makeRepo, startStack } from "@fusionkit/testkit";
import type { Stack } from "@fusionkit/testkit";
import { captureWorkspace } from "@fusionkit/workspace";

import {
  aiSdkHarnessBackend,
  claudeCodeAuthFromEnv,
  isClaudeCodeAgentRun,
  TranscriptRecorder
} from "../index.js";
import { emptyHarnessLog, fakeHarness, fakeLocalSandboxProvider } from "./fakes.js";
import type { FakeHarnessLog } from "./fakes.js";

// ---------------------------------------------------------------------------
// auth: explicit credentials only, fail closed on everything else
// ---------------------------------------------------------------------------

test("auth: anthropic credentials map to explicit settings with host fallback suppressed", () => {
  const auth = claudeCodeAuthFromEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
  assert.deepEqual(auth, {
    anthropic: { apiKey: "sk-ant-test", authToken: "", baseUrl: "" }
  });
});

test("auth: an auth token alone still occupies the api-key slot with an empty string", () => {
  const auth = claudeCodeAuthFromEnv({
    ANTHROPIC_AUTH_TOKEN: "tok",
    ANTHROPIC_BASE_URL: "https://proxy.example.com"
  });
  assert.deepEqual(auth, {
    anthropic: { apiKey: "", authToken: "tok", baseUrl: "https://proxy.example.com" }
  });
});

test("auth: a gateway key wins and the default base url is pinned explicitly", () => {
  const auth = claudeCodeAuthFromEnv({
    AI_GATEWAY_API_KEY: "gw-key",
    ANTHROPIC_API_KEY: "sk-ant-test"
  });
  assert.deepEqual(auth, {
    gateway: { apiKey: "gw-key", baseUrl: "https://ai-gateway.vercel.sh" }
  });
});

test("auth: no credential in the session env fails closed", () => {
  assert.throws(
    () => claudeCodeAuthFromEnv({}),
    (error: unknown) =>
      error instanceof CapabilityMismatchError && /refusing to fall back/.test(error.message)
  );
});

test("auth: env vars the harness path cannot deliver fail closed", () => {
  assert.throws(
    () => claudeCodeAuthFromEnv({ ANTHROPIC_API_KEY: "k", CUSTOM_FLAG: "1" }),
    (error: unknown) =>
      error instanceof CapabilityMismatchError && /CUSTOM_FLAG/.test(error.message)
  );
});

// ---------------------------------------------------------------------------
// transcript: structured stream parts become JSONL evidence
// ---------------------------------------------------------------------------

function transcriptLines(recorder: TranscriptRecorder): Record<string, unknown>[] {
  const body = recorder.toBuffer().toString("utf8").trim();
  if (body.length === 0) return [];
  return body.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("transcript: text deltas aggregate, tool calls and finish are recorded", () => {
  const recorder = new TranscriptRecorder();
  recorder.ingest({ type: "stream-start", modelId: "claude-sonnet-4-6" });
  recorder.ingest({ type: "text-start", id: "t1" });
  recorder.ingest({ type: "text-delta", id: "t1", delta: "hello " });
  recorder.ingest({ type: "text-delta", id: "t1", delta: "world" });
  recorder.ingest({ type: "text-end", id: "t1" });
  recorder.ingest({
    type: "tool-call",
    toolCallId: "c1",
    toolName: "bash",
    input: { command: "npm test" }
  });
  recorder.ingest({
    type: "tool-result",
    toolCallId: "c1",
    toolName: "bash",
    output: { exitCode: 0 }
  });
  recorder.ingest({ type: "file-change", event: "modify", path: "src/app.ts" });
  recorder.ingest({ type: "finish", finishReason: "stop" });

  const lines = transcriptLines(recorder);
  assert.deepEqual(
    lines.map((line) => line.part),
    ["stream-start", "text", "tool-call", "tool-result", "file-change", "finish"]
  );
  assert.equal(lines[1]?.text, "hello world");
  assert.deepEqual(lines[2]?.input, { command: "npm test" });
  assert.equal(lines[4]?.path, "src/app.ts");
  assert.equal(recorder.exitCode(), 0);
});

test("transcript: the AI SDK field spellings (text, output) are accepted too", () => {
  const recorder = new TranscriptRecorder();
  recorder.ingest({ type: "text-start", id: "a" });
  recorder.ingest({ type: "text-delta", id: "a", text: "via-ai-sdk" });
  recorder.ingest({ type: "text-end", id: "a" });
  recorder.ingest({
    type: "tool-result",
    toolCallId: "c",
    toolName: "bash",
    result: { ok: true }
  });
  const lines = transcriptLines(recorder);
  assert.equal(lines[0]?.text, "via-ai-sdk");
  assert.deepEqual(lines[1]?.output, { ok: true });
});

test("transcript: error parts and turn failures produce a non-zero exit code", () => {
  const errored = new TranscriptRecorder();
  errored.ingest({ type: "error", error: new Error("bridge died") });
  assert.equal(errored.exitCode(), 1);
  assert.equal(transcriptLines(errored)[0]?.error, "bridge died");

  const failed = new TranscriptRecorder();
  failed.ingest({ type: "finish", finishReason: "error" });
  assert.equal(failed.exitCode(), 1);

  const thrown = new TranscriptRecorder();
  thrown.fail(new Error("turn exploded"));
  assert.equal(thrown.exitCode(), 1);
  assert.equal(transcriptLines(thrown)[0]?.part, "turn-failed");
});

test("transcript: unknown part types are recorded by name without payload", () => {
  const recorder = new TranscriptRecorder();
  recorder.ingest({ type: "some-novel-part", giant: "x".repeat(4096) });
  assert.deepEqual(transcriptLines(recorder), [{ part: "some-novel-part" }]);
});

test("transcript: the log honors the contract's max-bytes cap", () => {
  const recorder = new TranscriptRecorder();
  recorder.ingest({ type: "text-start", id: "t" });
  recorder.ingest({ type: "text-delta", id: "t", delta: "y".repeat(1000) });
  recorder.ingest({ type: "text-end", id: "t" });
  assert.ok(recorder.toBuffer(64).byteLength <= 64);
});

// ---------------------------------------------------------------------------
// delegation: non-claude-code executions go to the fallback backend untouched
// ---------------------------------------------------------------------------

function contractFor(agentKind: "claude-code" | "command", prompt: string): RunContract {
  return {
    version: "warrant.contract.v1",
    runId: "run_test",
    issuedAt: new Date().toISOString(),
    issuer: { keyId: "k", role: "plane" },
    requestedBy: { kind: "human", id: "tester" },
    agent: { kind: agentKind },
    task: { prompt },
    runner: { pool: "eng-prod" },
    workspace: {
      version: "warrant.manifest.v1",
      baseRef: "0".repeat(40),
      bundleHash: "0".repeat(64),
      untrackedFiles: [],
      deniedPatterns: [],
      deniedPaths: []
    },
    policyHash: "0".repeat(64),
    secrets: [],
    network: { defaultDeny: true, allowHosts: [] },
    budget: {},
    disclosure: "minimal-context",
    isolation: "vercel-sandbox",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    signatures: []
  };
}

test("delegation: command contracts are executed by the fallback backend", async () => {
  const seen: string[] = [];
  const fallback: SessionBackend = {
    isolation: "vercel-sandbox",
    supports: () => true,
    execute: async (input: SessionExecution) => {
      seen.push(input.contract.agent.kind);
      return { exitCode: 0, log: Buffer.from("fallback ran") };
    }
  };
  const backend = aiSdkHarnessBackend({ fallback });

  const commandContract = contractFor("command", "echo hi");
  assert.equal(isClaudeCodeAgentRun(commandContract), false);
  assert.equal(backend.supports("shell", commandContract), true);

  const result = await backend.execute({
    contract: commandContract,
    repoDir: ".",
    secrets: [],
    execution: prepareExecution({ contract: commandContract, mockScriptPath: "unused" }),
    emit: () => undefined
  });
  assert.equal(result.log.toString("utf8"), "fallback ran");
  assert.deepEqual(seen, ["command"]);

  const agentContract = contractFor("claude-code", "fix it");
  assert.equal(isClaudeCodeAgentRun(agentContract), true);
  assert.equal(backend.supports("argv", agentContract), true);
});

// ---------------------------------------------------------------------------
// end to end: a governed run through the real HarnessAgent
//
// The fakes (shared in ./fakes.ts) replace only what needs credentials: the
// harness adapter (in place of the claude-code bridge) and the sandbox
// provider (a local directory in place of a Firecracker microVM). Everything
// between the signed contract and the receipt is real: plane, runner,
// workspace materialization, the HarnessAgent orchestration, staging,
// mirror-back, event chain, and offline verification.
// ---------------------------------------------------------------------------

const POOL = "eng-prod";

let stack: Stack;
let repoDir: string;
let sandboxRoot: string;
const harnessLog: FakeHarnessLog = emptyHarnessLog();

before(async () => {
  sandboxRoot = mkdtempSync(join(tmpdir(), "warrant-fake-sandbox-"));
  stack = await startStack({
    pool: POOL,
    startRunner: true,
    backends: [
      aiSdkHarnessBackend({
        createHarness: ({ env }) => {
          harnessLog.envSeen.push(env);
          return fakeHarness(harnessLog, "fake-claude-code");
        },
        createSandboxProvider: () => fakeLocalSandboxProvider(sandboxRoot)
      })
    ],
    policy: (policy) => {
      policy.agents.allow = ["claude-code"];
    }
  });
  repoDir = makeRepo({
    files: { "README.md": "# harness fixture\n", "data.txt": "one\ntwo\nthree\n" }
  });
});

after(async () => {
  await stack.stop();
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(sandboxRoot, { recursive: true, force: true });
});

test("e2e: a claude-code contract runs through the real HarnessAgent and yields a verifiable receipt", async () => {
  const captured = captureWorkspace(repoDir);
  await stack.client.putBlob(captured.bundle);
  if (captured.dirtyDiff) await stack.client.putBlob(captured.dirtyDiff);
  const created = await stack.client.requestRun({
    requestedBy: { kind: "human", id: "harness-tester" },
    agentKind: "claude-code",
    prompt: "count the lines in data.txt",
    pool: POOL,
    secretNames: [],
    workspace: captured.manifest,
    network: { defaultDeny: true, allowHosts: [] },
    budget: {},
    disclosure: "minimal-context",
    isolation: "vercel-sandbox",
    execution: {
      kind: "agent",
      agent: { kind: "claude-code" },
      prompt: "count the lines in data.txt",
      env: { vars: { ANTHROPIC_API_KEY: "test-key-not-real" } }
    }
  });
  assert.equal(await stack.runOnce(), created.runId);
  const bundle = await stack.client.getBundle(created.runId);

  // The receipt records the tier honestly and verifies offline.
  assert.equal(bundle.receipt.status, "completed");
  assert.equal(bundle.receipt.runner.isolation, "vercel-sandbox");
  assert.deepEqual(verifyReceiptBundle(bundle).problems, []);

  // The harness saw the prompt and the broker-resolved env; never the host env.
  assert.deepEqual(harnessLog.prompts, ["count the lines in data.txt"]);
  assert.deepEqual(harnessLog.envSeen, [{ ANTHROPIC_API_KEY: "test-key-not-real" }]);
  assert.equal(harnessLog.destroyed, 1);

  // The workspace was staged into the session workdir and the result file
  // mirrored back into the runner's checkout (visible in the git diff).
  assert.ok(bundle.receipt.workspaceOut.diffHash, "expected a workspace diff");
  const diff = await stack.client.getBlob(bundle.receipt.workspaceOut.diffHash);
  assert.ok(diff.toString("utf8").includes("result.txt"));

  // The session log artifact is the structured JSONL transcript.
  const logEvent = bundle.events.find(
    (e) => e.event.type === "artifact.created" && e.event.kind === "log"
  );
  assert.ok(logEvent && logEvent.event.type === "artifact.created");
  const log = (await stack.client.getBlob(logEvent.event.hash)).toString("utf8");
  const lines = log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(
    lines.some((line) => line.part === "text" && line.text === "governed harness turn"),
    `expected the aggregated text part in: ${log}`
  );
  assert.ok(
    lines.some((line) => line.part === "finish" && line.finishReason === "stop"),
    `expected the finish part in: ${log}`
  );

  // The boundary event chain saw exactly one executed command for the turn.
  const commandEvents = bundle.events.filter((e) => e.event.type === "command.executed");
  assert.equal(commandEvents.length, 1);
  const fileEvents = bundle.events.filter((e) => e.event.type === "file.changed");
  assert.ok(
    fileEvents.some((e) => e.event.type === "file.changed" && e.event.path === "result.txt"),
    "expected the mirrored result.txt in the boundary file events"
  );
});
