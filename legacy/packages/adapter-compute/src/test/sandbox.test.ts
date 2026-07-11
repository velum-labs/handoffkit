import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { after, before, test } from "node:test";

import { handoff, localFirst } from "@fusionkit/handoff";
import { makeRepo, startStack } from "@fusionkit/testkit";
import type { Stack } from "@fusionkit/testkit";
import { resolveInsideWorkspace } from "@fusionkit/workspace";

import { governedCompute, withCompute } from "../sandbox.js";
import type { GovernedSandbox } from "../sandbox.js";

const POOL = "eng-prod";
const FAKE_COMMAND_HASH = "0".repeat(64);

let stack: Stack;
let repoDir: string;
let sandbox: GovernedSandbox;

before(async () => {
  stack = await startStack({
    pool: POOL,
    startRunner: true,
    backends: [
      {
        isolation: "vercel-sandbox",
        execute: async (input) => {
          const { execution } = input;
          const cwd = resolveInsideWorkspace(input.repoDir, execution.cwd);
          const env = { ...process.env, ...execution.env };
          const chunks: Buffer[] = [];
          let capturedBytes = 0;
          let killChild: () => void = () => undefined;
          const push = (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            chunks.push(buffer);
            capturedBytes += buffer.byteLength;
            if (
              execution.logMaxBytes !== undefined &&
              capturedBytes > execution.logMaxBytes
            ) {
              killChild();
            }
          };
          const exitCode = await new Promise<number>((resolve) => {
            const child =
              execution.kind === "argv"
                ? spawn(execution.cmd, execution.args, { cwd, env })
                : spawn(execution.shell, ["-c", execution.script], { cwd, env });
            killChild = () => {
              child.kill("SIGKILL");
            };
            const timer = setTimeout(() => {
              child.kill("SIGKILL");
            }, execution.timeoutMs);
            child.stdout.on("data", push);
            child.stderr.on("data", push);
            child.on("error", (error) => {
              chunks.push(Buffer.from(`spawn error: ${error.message}\n`, "utf8"));
              clearTimeout(timer);
              resolve(127);
            });
            child.on("close", (code) => {
              clearTimeout(timer);
              resolve(code ?? 1);
            });
          });

          input.emit({
            type: "command.executed",
            argvHash: FAKE_COMMAND_HASH,
            exitCode
          });
          return { exitCode, log: Buffer.concat(chunks) };
        }
      }
    ],
    policy: (policy) => {
      policy.agents.allow = ["command"];
    }
  });
  repoDir = makeRepo({ files: { "README.md": "# sandbox fixture\n" } });
  const compute = governedCompute({
    workspace: repoDir,
    plane: { url: stack.planeUrl, adminToken: stack.adminToken },
    pool: POOL,
    actor: { kind: "human", id: "sandbox-user" }
  });
  sandbox = await compute.sandbox.create();
});

after(async () => {
  await stack.stop();
  rmSync(repoDir, { recursive: true, force: true });
});

test("staged files are visible to commands; outputs persist across commands", async () => {
  await sandbox.filesystem.writeFile("task.md", "build the report\nwith two lines\n");

  const first = await sandbox.runCommand(
    "cat task.md | wc -l | tr -d ' ' > lines.txt && cat lines.txt"
  );
  assert.equal(first.status, "completed");
  assert.equal(first.exitCode, 0);
  assert.equal(first.output.trim(), "2");

  // Sequential composition: the second command sees the first one's output.
  const second = await sandbox.runCommand("cat lines.txt && echo done >> log.txt");
  assert.equal(second.status, "completed");
  assert.equal(second.output.trim(), "2");

  assert.equal(await sandbox.filesystem.readFile("lines.txt"), "2\n");
  assert.equal(await sandbox.filesystem.exists("log.txt"), true);

  const runs = sandbox.runs();
  assert.equal(runs.length, 2);
  for (const run of runs) {
    assert.equal(run.receiptVerified, true, "every command carries a verified receipt");
    assert.match(run.contractHash, /^[0-9a-f]{64}$/);
    assert.equal(run.isolation, "process");
    assert.equal(run.sandboxId, sandbox.sandboxId);
  }
  assert.notEqual(runs[0]?.runId, runs[1]?.runId);
});

test("failing commands report their exit code and keep their receipt", async () => {
  const failed = await sandbox.runCommand("ls /nonexistent-path-zz");
  assert.equal(failed.status, "failed");
  assert.notEqual(failed.exitCode, 0);
  assert.ok(failed.output.length > 0, "stderr is captured in the session log");
  const last = sandbox.runs().at(-1);
  assert.ok(last);
  assert.equal(last.receiptVerified, true);
});

test("paths cannot escape the sandbox workspace", async () => {
  await assert.rejects(() => sandbox.filesystem.writeFile("../escape.txt", "nope"));
  await assert.rejects(() => sandbox.filesystem.readFile("/etc/hostname"));
});

test("withCompute attaches the compute surface to an existing context with one shared trace", async () => {
  const sharedRepo = makeRepo({ files: { "README.md": "# golden compute\n" } });
  try {
    const h = withCompute(
      handoff({
        workspace: sharedRepo,
        plane: { url: stack.planeUrl, adminToken: stack.adminToken },
        policy: localFirst({ allowPools: [POOL] })
      }),
      { pool: POOL }
    );
    const box = await h.compute.sandbox.create();
    const result = await box.runCommand("echo golden > golden.txt && cat golden.txt");
    assert.equal(result.status, "completed");
    assert.equal(result.output.trim(), "golden");
    assert.equal(await box.filesystem.readFile("golden.txt"), "golden\n");

    // The sandbox command and the context share one trace and one summary.
    const types = h.trace().map((e) => e.type);
    assert.ok(types.includes("envelope.created"));
    assert.ok(types.includes("results.pulled"));
    const summary = await h.summary();
    assert.equal(summary.runs.length, 1);
    assert.equal(summary.runs[0]?.status, "completed");
  } finally {
    rmSync(sharedRepo, { recursive: true, force: true });
  }
});

test("session config requests vercel-sandbox without changing the sandbox API", async () => {
  const microvmRepo = makeRepo({ files: { "README.md": "# microvm compute\n" } });
  try {
    const compute = governedCompute({
      workspace: microvmRepo,
      plane: { url: stack.planeUrl, adminToken: stack.adminToken },
      pool: POOL,
      actor: { kind: "human", id: "sandbox-user" },
      session: "vercel-sandbox"
    });
    const box = await compute.sandbox.create();

    await box.filesystem.writeFile("input.txt", "microvm\n");
    const result = await box.runCommand("cat input.txt > microvm.txt && cat microvm.txt");

    assert.equal(result.status, "completed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.output.trim(), "microvm");
    assert.equal(await box.filesystem.readFile("microvm.txt"), "microvm\n");
    assert.equal(box.handoffContext.lastEnvelope()?.isolation, "vercel-sandbox");

    const runs = box.runs();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.receiptVerified, true);
    assert.equal(runs[0]?.isolation, "vercel-sandbox");
  } finally {
    rmSync(microvmRepo, { recursive: true, force: true });
  }
});

test("destroyed sandboxes refuse further operations", async () => {
  await sandbox.destroy();
  await assert.rejects(
    () => sandbox.runCommand("echo too-late"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /destroyed/);
      return true;
    }
  );
  await assert.rejects(() => sandbox.filesystem.readFile("task.md"));
});
