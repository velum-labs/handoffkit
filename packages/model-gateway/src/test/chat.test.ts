import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";

import { OpenAiBackend } from "../backend.js";
import { MODEL_CALL_ID_HEADER } from "../provenance.js";
import type { ModelCallRecord } from "../provenance.js";
import { startGateway } from "../server.js";

/**
 * M1 coverage: the OpenAI chat surface against a mock upstream. No mlx process
 * is started — these tests exercise the gateway routing, default-model
 * injection, streaming passthrough, provenance, auth, and the not-yet-built
 * dialect stubs using a plain OpenAI-compatible mock as the backend.
 */

type Mock = {
  url: string;
  lastChatBody: () => Record<string, unknown> | undefined;
  lastModelCallId: () => string | undefined;
  close: () => Promise<void>;
};

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(Buffer.from(JSON.stringify(value), "utf8"));
}

async function readAll(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function captureStderr<T>(run: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await run(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

async function startMock(): Promise<Mock> {
  let lastChatBody: Record<string, unknown> | undefined;
  let lastModelCallId: string | undefined;
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "GET" && path === "/v1/models") {
        sendJson(res, 200, { object: "list", data: [{ id: "mock-model", object: "model" }] });
        return;
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        const body = JSON.parse((await readAll(req)).toString("utf8")) as Record<string, unknown>;
        lastChatBody = body;
        lastModelCallId =
          typeof req.headers[MODEL_CALL_ID_HEADER] === "string"
            ? req.headers[MODEL_CALL_ID_HEADER]
            : undefined;
        if (body.model === "fail-model") {
          sendJson(res, 500, { error: { message: "upstream failed" } });
          return;
        }
        if (body.stream === true) {
          res.statusCode = 200;
          res.setHeader("content-type", "text/event-stream");
          res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
          res.write('data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n');
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        sendJson(res, 200, {
          id: "chatcmpl-mock",
          object: "chat.completion",
          model: body.model,
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
        });
        return;
      }
      sendJson(res, 404, { error: "not found" });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    lastChatBody: () => lastChatBody,
    lastModelCallId: () => lastModelCallId,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  };
}

test("injects the default model and pipes the completion back", async () => {
  const mock = await startMock();
  const backend = new OpenAiBackend({ baseUrl: `${mock.url}/v1`, defaultModel: "mlx-default" });
  const records: ModelCallRecord[] = [];
  const gateway = await startGateway({
    backend,
    provenance: { onModelCall: (record) => records.push(record) }
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(response.status, 200);
    const callId = response.headers.get(MODEL_CALL_ID_HEADER);
    assert.ok(callId?.startsWith("model_call_"));
    assert.equal(mock.lastModelCallId(), callId);
    const json = (await response.json()) as Record<string, unknown>;
    assert.equal(json.object, "chat.completion");
    assert.equal(mock.lastChatBody()?.model, "mlx-default");
    assert.equal(records.length, 1);
    assert.equal(records[0]?.call_id, callId);
    assert.equal(records[0]?.metadata?.dialect, "openai-chat");
    assert.equal(records[0]?.model, "mlx-default");
    assert.equal(records[0]?.metadata?.stream, false);
    assert.equal(records[0]?.usage?.total_tokens, 5);
    assert.equal(records[0]?.metadata?.unknown_usage, false);
    assert.equal(records[0]?.metadata?.unknown_cost, true);
    assert.ok(!JSON.stringify(records[0]).includes('"hi"'));
    assert.ok(!JSON.stringify(records[0]).includes('"ok"'));
  } finally {
    await gateway.close();
    await mock.close();
  }
});

test("records failed upstream responses as failed model-call records", async () => {
  const mock = await startMock();
  const records: ModelCallRecord[] = [];
  const gateway = await startGateway({
    backend: new OpenAiBackend({ baseUrl: `${mock.url}/v1` }),
    provenance: { onModelCall: (record) => records.push(record) }
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fail-model", messages: [{ role: "user", content: "fail" }] })
    });
    assert.equal(response.status, 500);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "failed");
    assert.equal(records[0]?.error?.kind, "provider_error");
  } finally {
    await gateway.close();
    await mock.close();
  }
});

test("redacts thrown backend failures from stderr and the wire response", async () => {
  const secret = "sk-live-secret-from-upstream";
  const records: ModelCallRecord[] = [];
  const gateway = await startGateway({
    backend: {
      defaultModel: "throw-model",
      chat: async () => {
        throw new Error(`backend exploded with ${secret}`);
      },
      models: async () => new Response("{}", { status: 200 }),
      embeddings: async () => new Response("{}", { status: 200 })
    },
    provenance: { onModelCall: (record) => records.push(record) }
  });
  try {
    const { result: response, stderr } = await captureStderr(async () => {
      return await fetch(`${gateway.url()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "fail" }] })
      });
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: { message: "upstream request failed", type: "upstream_error" }
    });
    assert.match(stderr, /routekit gateway upstream error: type=Error/);
    assert.equal(stderr.includes(secret), false);
    assert.equal(stderr.includes("backend exploded"), false);
    assert.equal(response.headers.get(MODEL_CALL_ID_HEADER), records[0]?.call_id);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "failed");
    assert.equal(records[0]?.error?.kind, "provider_error");
    assert.equal(records[0]?.metadata?.unknown_usage, true);
  } finally {
    await gateway.close();
  }
});

test("preserves an explicitly requested model", async () => {
  const mock = await startMock();
  const gateway = await startGateway({
    backend: new OpenAiBackend({ baseUrl: `${mock.url}/v1`, defaultModel: "mlx-default" })
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "explicit-model", messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(response.status, 200);
    assert.equal(mock.lastChatBody()?.model, "explicit-model");
  } finally {
    await gateway.close();
    await mock.close();
  }
});

test("forceModel overrides the requested model on every upstream call", async () => {
  const mock = await startMock();
  const gateway = await startGateway({
    backend: new OpenAiBackend({ baseUrl: `${mock.url}/v1`, defaultModel: "advertised", forceModel: "routed-endpoint" })
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "whatever-the-cli-picked", messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(response.status, 200);
    // The driving client's model is ignored; the dedicated capture gateway routes
    // every call to its candidate's real endpoint id.
    assert.equal(mock.lastChatBody()?.model, "routed-endpoint");
  } finally {
    await gateway.close();
    await mock.close();
  }
});

test("lists models from the backend", async () => {
  const mock = await startMock();
  const gateway = await startGateway({
    backend: new OpenAiBackend({ baseUrl: `${mock.url}/v1` })
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/models`);
    assert.equal(response.status, 200);
    const json = (await response.json()) as { data: unknown[] };
    assert.equal(json.data.length, 1);
  } finally {
    await gateway.close();
    await mock.close();
  }
});

test("streams server-sent events straight through", async () => {
  const mock = await startMock();
  const gateway = await startGateway({
    backend: new OpenAiBackend({ baseUrl: `${mock.url}/v1`, defaultModel: "mlx-default" })
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const text = await response.text();
    assert.ok(text.includes("data: [DONE]"));
  } finally {
    await gateway.close();
    await mock.close();
  }
});

test("returns 404 for an unknown route", async () => {
  const gateway = await startGateway({
    backend: new OpenAiBackend({ baseUrl: "http://127.0.0.1:1/v1" })
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/unknown`, { method: "POST", body: "{}" });
    assert.equal(response.status, 404);
  } finally {
    await gateway.close();
  }
});

test("rejects malformed JSON with 400", async () => {
  const gateway = await startGateway({
    backend: new OpenAiBackend({ baseUrl: "http://127.0.0.1:1/v1" })
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json"
    });
    assert.equal(response.status, 400);
  } finally {
    await gateway.close();
  }
});

test("enforces the auth token when configured", async () => {
  const mock = await startMock();
  const gateway = await startGateway({
    backend: new OpenAiBackend({ baseUrl: `${mock.url}/v1`, defaultModel: "mlx-default" }),
    authToken: "secret"
  });
  try {
    const unauthorized = await fetch(`${gateway.url()}/v1/models`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${gateway.url()}/v1/models`, {
      headers: { authorization: "Bearer secret" }
    });
    assert.equal(authorized.status, 200);

    const health = await fetch(`${gateway.url()}/health`);
    assert.equal(health.status, 200);
  } finally {
    await gateway.close();
    await mock.close();
  }
});
