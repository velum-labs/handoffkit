import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { generateText, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import { managedModelServer } from "../managed-server.js";
import type { ManagedServerEvent } from "../managed-server.js";
import { MlxCapabilityError } from "../mlx-env.js";
import type { SpawnSpec } from "../mlx-env.js";

/**
 * Lifecycle tests against a fake OpenAI-compatible server (a node child
 * process fully under the test's control) so they run on any host: lazy
 * start, shared start across concurrent calls, idle scale-to-zero,
 * transparent restart, and stream leases.
 */

// Serves /v1/models (health) and /v1/chat/completions (plain + SSE).
// FAKE_STREAM_GAP_MS inserts a mid-stream pause to exercise stream leases.
const FAKE_SERVER_SOURCE = `
const http = require("node:http");
const port = Number(process.argv[2]);
const gapMs = Number(process.env.FAKE_STREAM_GAP_MS || "0");
const server = http.createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "fake", object: "model" }] }));
    return;
  }
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta, finish) =>
          "data: " + JSON.stringify({
            id: "cmpl-1", object: "chat.completion.chunk", created: 1,
            model: parsed.model,
            choices: [{ index: 0, delta, finish_reason: finish }]
          }) + "\\n\\n";
        res.write(chunk({ role: "assistant", content: "hello " }, null));
        setTimeout(() => {
          res.write(chunk({ content: "world" }, null));
          res.write(chunk({}, "stop"));
          res.write("data: [DONE]\\n\\n");
          res.end();
        }, gapMs);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "cmpl-1", object: "chat.completion", created: 1,
        model: parsed.model,
        choices: [{ index: 0, message: { role: "assistant", content: "hello from fake" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
      }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, "127.0.0.1");
`;

const scratch = mkdtempSync(join(tmpdir(), "fusionkit-managed-"));
const serverScript = join(scratch, "fake-server.cjs");
writeFileSync(serverScript, FAKE_SERVER_SOURCE);
after(() => rmSync(scratch, { recursive: true, force: true }));

function fakePrepare(env: Record<string, string> = {}) {
  return (port: number): Promise<SpawnSpec> =>
    Promise.resolve({
      cmd: process.execPath,
      args: [serverScript, String(port)],
      env
    });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("lazy start, shared start across concurrent calls, and roundtrip", async () => {
  const events: ManagedServerEvent[] = [];
  const model = managedModelServer({
    prepare: fakePrepare(),
    modelId: "fake-model",
    idleShutdownMs: 0,
    onEvent: (event) => events.push(event)
  });
  assert.equal(model.status(), "stopped", "nothing runs before the first call");

  try {
    const results = await Promise.all([
      generateText({ model, prompt: "one" }),
      generateText({ model, prompt: "two" }),
      generateText({ model, prompt: "three" })
    ]);
    for (const result of results) assert.equal(result.text, "hello from fake");
    assert.equal(model.status(), "running");
    assert.equal(
      events.filter((event) => event.type === "ready").length,
      1,
      "three concurrent first calls share one server start"
    );
  } finally {
    await model.stop();
  }
  assert.equal(model.status(), "stopped");
  const stopped = events.find((event) => event.type === "stopped");
  assert.ok(stopped && stopped.type === "stopped" && stopped.reason === "explicit");
});

test("scales to zero when idle and transparently restarts", async () => {
  const events: ManagedServerEvent[] = [];
  const model = managedModelServer({
    prepare: fakePrepare(),
    modelId: "fake-model",
    idleShutdownMs: 150,
    onEvent: (event) => events.push(event)
  });

  try {
    const first = await generateText({ model, prompt: "warm up" });
    assert.equal(first.text, "hello from fake");
    assert.equal(model.status(), "running");

    await waitFor(() => model.status() === "stopped");
    const stopped = events.find((event) => event.type === "stopped");
    assert.ok(
      stopped && stopped.type === "stopped" && stopped.reason === "idle",
      "the idle sweep stopped the server"
    );

    // Next call cold-starts a fresh process without the caller noticing.
    const second = await generateText({ model, prompt: "wake up" });
    assert.equal(second.text, "hello from fake");
    assert.equal(events.filter((event) => event.type === "ready").length, 2);
  } finally {
    await model.stop();
  }
});

test("a stream holds its lease: no idle shutdown mid-stream", async () => {
  const events: ManagedServerEvent[] = [];
  const model = managedModelServer({
    // The mid-stream gap (400ms) far exceeds the idle window (120ms): only
    // the held lease keeps the server alive across it.
    prepare: fakePrepare({ FAKE_STREAM_GAP_MS: "400" }),
    modelId: "fake-model",
    idleShutdownMs: 120,
    onEvent: (event) => events.push(event)
  });

  try {
    const result = streamText({ model, prompt: "stream it" });
    const text = await result.text;
    assert.equal(text, "hello world");
    assert.equal(
      events.filter((event) => event.type === "stopped").length,
      0,
      "no shutdown while the stream was in flight"
    );

    await waitFor(() => model.status() === "stopped");
    const stopped = events.find((event) => event.type === "stopped");
    assert.ok(stopped && stopped.type === "stopped" && stopped.reason === "idle");
  } finally {
    await model.stop();
  }
});

test("a killed server emits a crashed event with signal and output tail", async () => {
  const events: ManagedServerEvent[] = [];
  const model = managedModelServer({
    prepare: fakePrepare(),
    modelId: "fake-model",
    idleShutdownMs: 0,
    onEvent: (event) => events.push(event)
  });

  try {
    await generateText({ model, prompt: "warm up" });
    const ready = events.find((event) => event.type === "ready");
    assert.ok(ready && ready.type === "ready");

    // Simulate the OS killing the server under memory pressure.
    process.kill(ready.pid, "SIGKILL");
    await waitFor(() => events.some((event) => event.type === "crashed"));

    const crashed = events.find((event) => event.type === "crashed");
    assert.ok(crashed && crashed.type === "crashed");
    assert.equal(crashed.signal, "SIGKILL", "the termination signal is reported");
    assert.equal(crashed.exitCode, null, "a signal death carries no exit code");
    assert.equal(typeof crashed.outputTail, "string", "diagnostics tail is attached");
    assert.equal(model.status(), "stopped", "state resets so the next call respawns");
  } finally {
    await model.stop();
  }
});

test("startup failure surfaces with server output in the message", async () => {
  const model = managedModelServer({
    prepare: () =>
      Promise.resolve({
        cmd: process.execPath,
        args: ["-e", "console.error('model weights not found'); process.exit(3)"],
        env: {}
      }),
    modelId: "fake-model",
    startupTimeoutMs: 5_000
  });
  await assert.rejects(
    () => generateText({ model, prompt: "boom" }),
    /exited during startup .*model weights not found/s
  );
  assert.equal(model.status(), "stopped");
});

