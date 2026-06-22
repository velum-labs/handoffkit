import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { after, test } from "node:test";

import { probeOllama } from "../fusion/ollama.js";

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(Buffer.from(JSON.stringify(value), "utf8"));
}

async function withOllamaMock(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (url: string) => Promise<void>
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${port}/api/tags`;
  try {
    await run(url);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

after(() => {
  // no shared state
});

test("probeOllama returns models when tags endpoint is reachable", async () => {
  await withOllamaMock((req, res) => {
    if (req.url === "/api/tags") {
      sendJson(res, 200, { models: [{ name: "llama3.2" }, { name: "qwen2.5" }] });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  }, async (url) => {
    const result = await probeOllama({ tagsUrl: url, timeoutMs: 1000 });
    assert.equal(result.reachable, true);
    assert.deepEqual(result.models, ["llama3.2", "qwen2.5"]);
  });
});

test("probeOllama returns unreachable when tags endpoint is down", async () => {
  const result = await probeOllama({
    tagsUrl: "http://127.0.0.1:1/api/tags",
    timeoutMs: 200
  });
  assert.equal(result.reachable, false);
  assert.deepEqual(result.models, []);
});
