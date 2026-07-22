import assert from "node:assert/strict";
import { test } from "node:test";

import type { Backend } from "../backend.js";
import { startGateway } from "../server.js";

/**
 * Graceful drain: a draining gateway must report unhealthy and reject new
 * model calls while letting in-flight requests (long-lived LLM streams)
 * finish within the grace, and must sever what remains once it expires.
 */

/** A backend whose chat stream stays open until the test releases it. */
function heldStreamBackend(): Backend & { release(): void } {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  return {
    defaultModel: "mock-model",
    chat: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            controller = streamController;
            streamController.enqueue(
              Buffer.from('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
            );
          }
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      ),
    models: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    embeddings: async () => new Response(JSON.stringify({}), { status: 200 }),
    release: () => {
      controller?.enqueue(Buffer.from("data: [DONE]\n\n"));
      controller?.close();
    }
  };
}

test("drain finishes in-flight streams, rejects new work, and flips /health to 503", async () => {
  const backend = heldStreamBackend();
  const gateway = await startGateway({ backend });
  try {
    const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock-model",
        stream: true,
        messages: [{ role: "user", content: "hi" }]
      })
    });
    const reader = response.body?.getReader();
    assert.ok(reader !== undefined);
    await reader.read();

    // Begin the drain while the stream is in flight.
    const drained = gateway.drain(5_000);

    // Health flips to 503 so probes stop routing new work here.
    const health = await fetch(`${gateway.url()}/health`);
    assert.equal(health.status, 503);
    assert.deepEqual(await health.json(), { status: "draining" });

    // New model calls are rejected while draining.
    const rejected = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-model", messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(rejected.status, 503);
    const body = (await rejected.json()) as { error?: { type?: string } };
    assert.equal(body.error?.type, "unavailable");

    // The in-flight stream completes normally once the upstream finishes.
    backend.release();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += Buffer.from(value ?? []).toString("utf8");
    }
    assert.match(text, /\[DONE\]/);

    await drained;
  } finally {
    await gateway.close();
  }
});

test("drain grace expiry severs a stream that never finishes", async () => {
  const backend = heldStreamBackend();
  const gateway = await startGateway({ backend });
  try {
    const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock-model",
        stream: true,
        messages: [{ role: "user", content: "hi" }]
      })
    });
    const reader = response.body?.getReader();
    assert.ok(reader !== undefined);
    await reader.read();

    const started = Date.now();
    await gateway.drain(300);
    assert.ok(Date.now() - started >= 250, "drain waits out the grace before severing");

    // The severed client observes an abnormal end, not a silent hang.
    await assert.rejects(async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    });
  } finally {
    await gateway.close();
  }
});

test("close without a prior drain remains immediate", async () => {
  const backend = heldStreamBackend();
  const gateway = await startGateway({ backend });
  const health = await fetch(`${gateway.url()}/health`);
  assert.equal(health.status, 200);
  const started = Date.now();
  await gateway.close();
  assert.ok(Date.now() - started < 1_000, "close() must not wait for a drain grace");
  await assert.rejects(fetch(`${gateway.url()}/health`));
});
