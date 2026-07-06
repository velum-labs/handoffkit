import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";

import { runPanelRound } from "../panel-round.js";

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

test("runPanelRound dispatches k=1 to proposal completions (no harness, no worktree)", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    void readJson(req).then((body) => {
      bodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "proposal" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    // The honest k=1 signature: no repo, no outputRoot, no prompt — nothing
    // executes, so the API does not demand executor fields.
    const wires = await runPanelRound({
      id: "round_test",
      models: [{ id: "alpha", model: "provider/alpha" }],
      fusionBackendUrl: `http://127.0.0.1:${port}`,
      k: 1,
      messages: [{ role: "user", content: "do the task" }],
      tools: [{ type: "function", function: { name: "write_file" } }]
    });

    assert.equal(wires.length, 1);
    assert.equal(wires[0]?.final_output, "proposal");
    assert.equal(wires[0]?.harness_kind, undefined, "proposal candidates carry no harness_kind");
    assert.deepEqual(bodies[0]?.messages, [{ role: "user", content: "do the task" }]);
    assert.equal(bodies[0]?.model, "alpha");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("runPanelRound routes k>1 to the harness path (rejected for non-boundable harnesses)", async () => {
  await assert.rejects(
    runPanelRound({
      id: "round_test",
      repo: process.cwd(),
      outputRoot: "/tmp/round-test-out",
      prompt: "task",
      models: [{ id: "alpha", model: "provider/alpha" }],
      harness: "codex",
      fusionBackendUrl: "http://127.0.0.1:1",
      k: 2
    }),
    /finite k \(k=2\) is not supported by the "codex" harness/
  );
});

test("each mode names its missing requirements with guidance", async () => {
  // k=1 without the caller history.
  await assert.rejects(
    runPanelRound({
      models: [{ id: "alpha", model: "provider/alpha" }],
      fusionBackendUrl: "http://127.0.0.1:1",
      k: 1
    }),
    /proposal mode \(k=1\) needs the caller's `messages`/
  );
  // Rollout without executor fields.
  await assert.rejects(
    runPanelRound({
      models: [{ id: "alpha", model: "provider/alpha" }],
      fusionBackendUrl: "http://127.0.0.1:1"
    }),
    /rollout mode \(k=∞\) needs `repo`, `outputRoot`, and `prompt`/
  );
});
