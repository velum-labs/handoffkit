import assert from "node:assert/strict";
import { test } from "node:test";

import type { Backend } from "../backend.js";
import { startGateway } from "../server.js";

/**
 * Crash resilience: an upstream stream that dies mid-response (the shape of a
 * local model server being OOM-killed during a turn) must fail only that one
 * request. Historically the error path wrote JSON onto a response whose
 * headers were already sent, which threw inside the catch handler and killed
 * the whole process hosting the gateway (for `fusionkit codex`, the CLI
 * itself) — leaving the tool with a bare "stream disconnected" error.
 */

/** A backend whose chat stream emits one SSE chunk, then errors mid-stream. */
function midStreamFailureBackend(): Backend {
  return {
    defaultModel: "mock-model",
    chat: async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            Buffer.from('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "utf8")
          );
          controller.error(new Error("upstream server crashed (simulated OOM kill)"));
        }
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    },
    models: async () =>
      new Response(JSON.stringify({ object: "list", data: [{ id: "mock-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }),
    embeddings: async () => new Response(JSON.stringify({}), { status: 200 })
  };
}

test("a mid-stream upstream failure does not kill the gateway process", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  const gateway = await startGateway({ backend: midStreamFailureBackend() });
  try {
    // The streaming request fails abnormally (destroyed socket), not silently.
    await assert.rejects(async () => {
      const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "mock-model", stream: true, messages: [] })
      });
      await response.text();
    });

    // Give any would-be unhandled rejection a macrotask to surface.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, [], "no unhandled rejection escaped the error path");

    // The gateway (and its hosting process) is still alive and serving.
    const health = await fetch(`${gateway.url()}/health`);
    assert.equal(health.status, 200);
    const models = await fetch(`${gateway.url()}/v1/models`);
    assert.equal(models.status, 200);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await gateway.close();
  }
});

test("an error before headers are sent still yields a 502 JSON body", async () => {
  const backend: Backend = {
    ...midStreamFailureBackend(),
    chat: async () => {
      throw new Error("backend exploded before responding");
    }
  };
  const gateway = await startGateway({ backend });
  try {
    const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-model", messages: [] })
    });
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error?: { message?: string; type?: string } };
    assert.equal(body.error?.type, "upstream_error");
    assert.match(body.error?.message ?? "", /exploded/);
  } finally {
    await gateway.close();
  }
});
