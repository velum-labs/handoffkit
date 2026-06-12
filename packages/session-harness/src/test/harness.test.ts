import assert from "node:assert/strict";
import { execFile, spawn as spawnChild } from "node:child_process";
import { createReadStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
  HarnessV1Session,
  HarnessV1StreamPart
} from "@ai-sdk/harness";
import type { RunContract } from "@warrant/protocol";
import { verifyReceiptBundle } from "@warrant/protocol";
import { prepareExecution } from "@warrant/runner";
import type { SessionBackend, SessionExecution } from "@warrant/runner";
import { CapabilityError } from "@warrant/session-vercel-sandbox";
import { makeRepo, startStack } from "@warrant/testkit";
import type { Stack } from "@warrant/testkit";
import { captureWorkspace } from "@warrant/workspace";

import {
  aiSdkHarnessBackend,
  claudeCodeAuthFromEnv,
  isClaudeCodeAgentRun,
  TranscriptRecorder
} from "../index.js";
import type { HarnessAdapter } from "../index.js";

const execFileAsync = promisify(execFile);

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
      error instanceof CapabilityError && /refusing to fall back/.test(error.message)
  );
});

test("auth: env vars the harness path cannot deliver fail closed", () => {
  assert.throws(
    () => claudeCodeAuthFromEnv({ ANTHROPIC_API_KEY: "k", CUSTOM_FLAG: "1" }),
    (error: unknown) =>
      error instanceof CapabilityError && /CUSTOM_FLAG/.test(error.message)
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
// The fake below replaces only what needs credentials: the harness adapter
// (in place of the claude-code bridge) and the sandbox provider (a local
// directory in place of a Firecracker microVM). Everything between the
// signed contract and the receipt is real: plane, runner, workspace
// materialization, the HarnessAgent orchestration, staging, mirror-back,
// event chain, and offline verification.
// ---------------------------------------------------------------------------

const usage = {
  inputTokens: { total: 7, noCache: 7, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: 3, reasoning: undefined }
};

type FakeHarnessLog = {
  prompts: string[];
  envSeen: Record<string, string>[];
  workDirs: string[];
  destroyed: number;
};

function fakeHarness(log: FakeHarnessLog): HarnessAdapter {
  const resumeState = {
    harnessId: "fake-claude-code",
    specificationVersion: "harness-v1",
    data: {}
  } as const;
  return {
    specificationVersion: "harness-v1",
    harnessId: "fake-claude-code",
    builtinTools: {},
    doStart: async (start) => {
      const sandbox = start.sandboxSession.restricted();
      log.workDirs.push(start.sessionWorkDir);
      const session: HarnessV1Session = {
        sessionId: start.sessionId,
        isResume: false,
        doPromptTurn: async ({ prompt, emit }) => {
          const promptText = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
          log.prompts.push(promptText);
          // The "agent work": read a staged workspace file, write a result
          // file next to it through the sandbox surface.
          const staged = await sandbox.readTextFile({
            path: `${start.sessionWorkDir}/data.txt`
          });
          await sandbox.writeTextFile({
            path: `${start.sessionWorkDir}/result.txt`,
            content: `lines=${(staged ?? "").trim().split("\n").length}\n`
          });
          const parts: HarnessV1StreamPart[] = [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "governed harness turn" },
            { type: "text-end", id: "t1" },
            { type: "file-change", event: "create", path: "result.txt" },
            { type: "finish-step", finishReason: { unified: "stop", raw: "end_turn" }, usage },
            { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, totalUsage: usage }
          ];
          for (const part of parts) emit(part);
          return {
            submitToolResult: async () => undefined,
            done: Promise.resolve()
          };
        },
        doCompact: async () => {
          throw new Error("compaction unsupported by the fake harness");
        },
        doContinueTurn: async ({ emit }) => {
          emit({ type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, totalUsage: usage });
          return { submitToolResult: async () => undefined, done: Promise.resolve() };
        },
        doSuspendTurn: async () => ({ ...resumeState, type: "continue-turn" }),
        doDetach: async () => ({ ...resumeState, type: "resume-session" }),
        doStop: async () => ({ ...resumeState, type: "resume-session" }),
        doDestroy: async () => {
          log.destroyed += 1;
        }
      };
      return session;
    }
  };
}

/**
 * A sandbox provider over a local directory: `run`/`spawn` execute through
 * /bin/sh and the file surface is node:fs. Implements the same
 * `HarnessV1SandboxProvider` contract as `createVercelSandbox`.
 */
function fakeLocalSandboxProvider(root: string): HarnessV1SandboxProvider {
  async function runCommand(
    command: string,
    workingDirectory?: string
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", command], {
        cwd: workingDirectory ?? root
      });
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return {
        exitCode: typeof failure.code === "number" ? failure.code : 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? ""
      };
    }
  }

  const session: HarnessV1NetworkSandboxSession = {
    id: "fake-local-sandbox",
    description: `fake local sandbox at ${root}`,
    defaultWorkingDirectory: root,
    ports: [4000],
    getPortUrl: async ({ port, protocol }) => `${protocol ?? "http"}://127.0.0.1:${port}/`,
    stop: async () => undefined,
    restricted: () => session,
    readFile: async ({ path }) => {
      try {
        return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
      } catch {
        return null;
      }
    },
    readBinaryFile: async ({ path }) => {
      try {
        return new Uint8Array(await readFile(path));
      } catch {
        return null;
      }
    },
    readTextFile: async ({ path }) => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return null;
      }
    },
    writeFile: async ({ path, content }) => {
      const chunks: Uint8Array[] = [];
      const reader = content.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.concat(chunks));
    },
    writeBinaryFile: async ({ path, content }) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
    writeTextFile: async ({ path, content }) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    },
    run: async ({ command, workingDirectory }) => runCommand(command, workingDirectory),
    spawn: async ({ command, workingDirectory }) => {
      const child = spawnChild("/bin/sh", ["-c", command], {
        cwd: workingDirectory ?? root
      });
      return {
        ...(child.pid !== undefined ? { pid: child.pid } : {}),
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        wait: () =>
          new Promise<{ exitCode: number }>((resolve) => {
            child.on("close", (code) => resolve({ exitCode: code ?? 0 }));
          }),
        kill: async () => {
          child.kill();
        }
      };
    }
  };

  return {
    specificationVersion: "harness-sandbox-v1",
    providerId: "fake-local",
    createSession: async () => session
  };
}

const POOL = "eng-prod";

let stack: Stack;
let repoDir: string;
let sandboxRoot: string;
const harnessLog: FakeHarnessLog = { prompts: [], envSeen: [], workDirs: [], destroyed: 0 };

before(async () => {
  sandboxRoot = mkdtempSync(join(tmpdir(), "warrant-fake-sandbox-"));
  stack = await startStack({
    pool: POOL,
    startRunner: true,
    backends: [
      aiSdkHarnessBackend({
        createHarness: ({ env }) => {
          harnessLog.envSeen.push(env);
          return fakeHarness(harnessLog);
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
