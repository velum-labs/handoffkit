import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { runAcpAgent } from "../acp-agent.js";
import type { AcpRunner } from "../acp-agent.js";

type JsonRpcOut = {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
  params?: unknown;
};

async function driveAgent(
  runner: AcpRunner,
  requests: unknown[]
): Promise<JsonRpcOut[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  let raw = "";
  output.on("data", (chunk: Buffer) => {
    raw += chunk.toString("utf8");
  });
  const done = runAcpAgent({ runner, input, output });
  for (const request of requests) {
    input.write(`${JSON.stringify(request)}\n`);
  }
  input.end();
  await done;
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JsonRpcOut);
}

test("acp agent completes initialize, session/new, and session/prompt", async () => {
  const runner: AcpRunner = async (input) => ({
    finalOutput: `FUSION_OK:${input.prompt}`,
    runId: "run_acp_1",
    status: "succeeded",
    evidence: ["patch_artifact", "judge_synthesis"]
  });

  const messages = await driveAgent(runner, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } },
    { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: "sess_1", prompt: [{ type: "text", text: "patch the bug" }] }
    }
  ]);

  const initialize = messages.find((message) => message.id === 1);
  assert.ok(initialize?.result);
  assert.equal((initialize.result as { protocolVersion: number }).protocolVersion, 1);

  const sessionNew = messages.find((message) => message.id === 2);
  assert.equal((sessionNew?.result as { sessionId: string }).sessionId, "sess_1");

  const update = messages.find((message) => message.method === "session/update");
  assert.ok(update);
  const updateParams = update.params as {
    update: { content: { text: string } };
  };
  assert.match(updateParams.update.content.text, /FUSION_OK:patch the bug/);

  const promptResult = messages.find((message) => message.id === 3);
  const result = promptResult?.result as { stopReason: string; _meta: { runId: string } };
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result._meta.runId, "run_acp_1");
});

test("acp agent returns method-not-found for unknown methods", async () => {
  const runner: AcpRunner = async () => ({
    finalOutput: "unused",
    runId: "run",
    status: "succeeded",
    evidence: []
  });
  const messages = await driveAgent(runner, [
    { jsonrpc: "2.0", id: 9, method: "nonsense/method", params: {} }
  ]);
  const error = messages.find((message) => message.id === 9);
  assert.equal(error?.error?.code, -32601);
});
