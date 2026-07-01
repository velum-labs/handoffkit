import assert from "node:assert/strict";
import { test } from "node:test";

import { KernelBackend } from "../kernel-backend.js";
import { createKernelFuseStepRunner } from "../kernel-gateway.js";
import { captureWireResponse } from "../wire-artifacts.js";

test("captureWireResponse buffers a non-streaming JSON response into a typed value", async () => {
  const original = new Response(JSON.stringify({ ok: true, n: 3 }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  const { value, response } = await captureWireResponse(original);
  assert.equal(value.streaming, false);
  assert.equal(value.status, 200);
  assert.deepEqual(value.body, { ok: true, n: 3 });
  // The rebuilt response is still readable by the caller.
  assert.deepEqual(await response.json(), { ok: true, n: 3 });
});

test("captureWireResponse passes a streaming response through untouched", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
      controller.close();
    }
  });
  const original = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
  const { value, response } = await captureWireResponse(original);
  assert.equal(value.streaming, true);
  assert.equal(value.body, undefined);
  assert.equal(response, original, "the live streaming response is not consumed");
  assert.match(await response.text(), /data: hi/);
});

test("KernelBackend executes chat through the kernel and returns the response", async () => {
  const inner = {
    defaultModel: "m",
    listModelIds: () => ["m"],
    resolveModel: (requested: string | undefined) => requested ?? "m",
    chat: () =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "kernel-owned" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      ),
    models: () => Promise.resolve(new Response("{}", { status: 200 })),
    embeddings: () => Promise.resolve(new Response("{}", { status: 200 }))
  };
  const backend = new KernelBackend(inner);
  const res = await backend.chat({ model: "m", messages: [] });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  assert.equal(body.choices[0]?.message.content, "kernel-owned");
});

test("createKernelFuseStepRunner routes the fuse step through a kernel operator", async () => {
  let seenUrl = "";
  const runner = createKernelFuseStepRunner((request) => {
    seenUrl = request.stepUrl;
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: "fused" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
  });
  const res = await runner({
    stepUrl: "http://example/v1/fusion/trajectories:fuse",
    headers: { "content-type": "application/json" },
    body: "{}",
    streaming: false
  });
  assert.equal(seenUrl, "http://example/v1/fusion/trajectories:fuse");
  const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  assert.equal(body.choices[0]?.message.content, "fused");
});
