import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";

import { OpenAiBackend } from "../backend.js";
import { startGateway } from "../server.js";

/**
 * Embeddings model handling. The mlx fork's /v1/embeddings rejects any model
 * that is not the configured embedding model id or the literal "default_model",
 * so the gateway must never inject the chat model id here.
 */

type Mock = {
  url: string;
  lastEmbedBody: () => Record<string, unknown> | undefined;
  close: () => Promise<void>;
};

async function readAll(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(Buffer.from(JSON.stringify(value), "utf8"));
}

async function startMock(): Promise<Mock> {
  let lastEmbedBody: Record<string, unknown> | undefined;
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "POST" && path === "/v1/embeddings") {
        lastEmbedBody = JSON.parse((await readAll(req)).toString("utf8")) as Record<string, unknown>;
        sendJson(res, 200, {
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
          model: lastEmbedBody.model,
          usage: { prompt_tokens: 1, total_tokens: 1 }
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
    lastEmbedBody: () => lastEmbedBody,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  };
}

test("embeddings inject 'default_model' when no embedding model is configured", async () => {
  const mock = await startMock();
  const gateway = await startGateway({
    backend: new OpenAiBackend({ baseUrl: `${mock.url}/v1`, defaultModel: "chat-model" })
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello" })
    });
    assert.equal(response.status, 200);
    // Not the chat model — the fork would reject that.
    assert.equal(mock.lastEmbedBody()?.model, "default_model");
  } finally {
    await gateway.close();
    await mock.close();
  }
});

test("embeddings inject the configured embedding model when set", async () => {
  const mock = await startMock();
  const gateway = await startGateway({
    backend: new OpenAiBackend({
      baseUrl: `${mock.url}/v1`,
      defaultModel: "chat-model",
      embeddingModel: "embed-model"
    })
  });
  try {
    await fetch(`${gateway.url()}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: ["a", "b"] })
    });
    assert.equal(mock.lastEmbedBody()?.model, "embed-model");
  } finally {
    await gateway.close();
    await mock.close();
  }
});

test("embeddings preserve an explicitly requested model", async () => {
  const mock = await startMock();
  const gateway = await startGateway({
    backend: new OpenAiBackend({ baseUrl: `${mock.url}/v1`, embeddingModel: "embed-model" })
  });
  try {
    await fetch(`${gateway.url()}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "default_model", input: "x" })
    });
    assert.equal(mock.lastEmbedBody()?.model, "default_model");
  } finally {
    await gateway.close();
    await mock.close();
  }
});
