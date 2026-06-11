import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import { localFirst } from "@warrant/handoff";
import { PolicyDeniedError } from "@warrant/protocol";
import { makeRepo, startStack } from "@warrant/testkit";
import type { Stack } from "@warrant/testkit";

import { remoteTools } from "../remote-tools.js";

const POOL = "eng-prod";

let stack: Stack;
let repoDir: string;

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined }
};

before(async () => {
  stack = await startStack({
    pool: POOL,
    startRunner: true,
    policy: (policy) => {
      policy.agents.allow = ["command"];
    }
  });
  repoDir = makeRepo({
    files: { "README.md": "# app-owned loop fixture\n", "data.txt": "alpha beta gamma\n" }
  });
});

after(async () => {
  await stack.stop();
  rmSync(repoDir, { recursive: true, force: true });
});

test("generateText executes tool calls in governed sessions and pulls results", async () => {
  const rt = remoteTools({
    workspace: repoDir,
    plane: { url: stack.planeUrl, adminToken: stack.adminToken },
    pool: POOL,
    actor: { kind: "human", id: "loop-owner" }
  });

  const command =
    "wc -w < data.txt > word-count.txt && echo governed-session-output && cat word-count.txt";
  // A scripted two-step model: first request a shell tool call, then close
  // out with text once the (governed) tool result is in the conversation.
  let modelCalls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      modelCalls++;
      if (modelCalls === 1) {
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "call-1",
              toolName: "shell",
              input: JSON.stringify({ command })
            }
          ],
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage,
          warnings: []
        };
      }
      return {
        content: [{ type: "text" as const, text: "the word count is recorded" }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage,
        warnings: []
      };
    }
  });

  const result = await generateText({
    model,
    tools: rt.tools,
    prompt: "count the words in data.txt inside the governed sandbox",
    stopWhen: stepCountIs(2)
  });

  // The loop stayed app-owned: the mock model drove two steps.
  assert.equal(result.text, "the word count is recorded");

  // The tool call executed remotely, with evidence.
  const calls = rt.calls();
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.toolName, "shell");
  assert.equal(call.command, command);
  assert.equal(call.status, "completed");
  assert.equal(call.exitCode, 0);
  assert.equal(call.receiptVerified, true, "receipt must verify offline");
  assert.equal(call.pullMode, "applied");
  assert.match(call.contractHash, /^[0-9a-f]{64}$/);

  // The tool result the model saw came from the governed session log.
  const toolResult = result.steps
    .flatMap((step) => step.toolResults)
    .find((r) => r.toolName === "shell");
  assert.ok(toolResult);
  const output = toolResult.output as { output: string; exitCode: number | undefined };
  assert.ok(output.output.includes("governed-session-output"));
  assert.equal(output.exitCode, 0);

  // The session's workspace output was pulled back into the local repo.
  assert.ok(existsSync(join(repoDir, "word-count.txt")));
  assert.equal(readFileSync(join(repoDir, "word-count.txt"), "utf8").trim(), "3");

  // The continuation trace explains the boundary crossing.
  const types = rt.context.trace().map((event) => event.type);
  assert.ok(types.includes("envelope.created"));
  assert.ok(types.includes("results.pulled"));
});

test("tool execution fails closed when continuation policy denies the pool", async () => {
  const rt = remoteTools({
    workspace: repoDir,
    plane: { url: stack.planeUrl, adminToken: stack.adminToken },
    pool: POOL,
    policy: localFirst({ denyPools: [POOL] })
  });
  const execute = rt.tools.shell.execute;
  assert.ok(execute);
  await assert.rejects(
    () =>
      Promise.resolve(
        execute({ command: "echo should-not-run" }, { toolCallId: "call-x", messages: [] })
      ),
    (error: unknown) => {
      assert.ok(error instanceof PolicyDeniedError);
      return true;
    }
  );
  assert.equal(rt.calls().length, 0, "denied calls must not produce records");
});

test("org policy denies the command harness when not allowlisted", async () => {
  const restricted = await startStack({
    pool: "locked-pool",
    policy: (policy) => {
      policy.agents.allow = ["mock"];
    }
  });
  try {
    const rt = remoteTools({
      workspace: repoDir,
      plane: { url: restricted.planeUrl, adminToken: restricted.adminToken },
      pool: "locked-pool"
    });
    const execute = rt.tools.shell.execute;
    assert.ok(execute);
    await assert.rejects(
      () =>
        Promise.resolve(
          execute({ command: "echo nope" }, { toolCallId: "call-y", messages: [] })
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /not allowed/);
        return true;
      }
    );
  } finally {
    await restricted.stop();
  }
});
