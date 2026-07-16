import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CLIPROXY_API_KEY_ENV,
  cliproxyApiKey,
  ensureCliproxyConfig
} from "@routekit/accounts";
import { parseRouterConfig } from "@routekit/gateway";

import { startRouter } from "../serve.js";

async function upstream(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url?.endsWith("/models") === true) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "upstream-model", object: "model" }]
        })
      );
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "upstream-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop"
          }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    })
  };
}

test("serve exposes OpenAI, Anthropic, Responses, and Cursor dialects", async () => {
  const provider = await upstream();
  const config = parseRouterConfig({
    providers: { openai: {} },
    defaultModel: "openai/upstream-model"
  });
  const router = await startRouter({
    config,
    port: 0,
    register: false,
    env: {
      OPENAI_API_KEY: "test",
      OPENAI_BASE_URL: provider.url
    }
  });
  try {
    const models = await fetch(`${router.url}/v1/models`);
    assert.equal(models.status, 200);
    assert.match(await models.text(), /openai\/upstream-model/);

    const openai = await fetch(`${router.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/upstream-model",
        messages: [{ role: "user", content: "hi" }]
      })
    });
    assert.equal(openai.status, 200);

    const anthropic = await fetch(`${router.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/upstream-model",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }]
      })
    });
    assert.equal(anthropic.status, 200);
    assert.equal((await anthropic.json() as { type: string }).type, "message");

    const responses = await fetch(`${router.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/upstream-model", input: "hi" })
    });
    assert.equal(responses.status, 200);

    const cursor = await fetch(`${router.url}/v1/cursor/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/upstream-model", input: "hi" })
    });
    assert.equal(cursor.status, 200);
  } finally {
    await router.close();
    await provider.close();
  }
});

test("serve resolves the managed cliproxy credential without printing or exporting it", async () => {
  const previousHome = process.env.ROUTEKIT_HOME;
  const previousKey = process.env[CLIPROXY_API_KEY_ENV];
  const stateHome = mkdtempSync(join(tmpdir(), "routekit-managed-cliproxy-"));
  process.env.ROUTEKIT_HOME = stateHome;
  delete process.env[CLIPROXY_API_KEY_ENV];
  let authorization: string | undefined;
  const server = createServer((request, response) => {
    authorization = request.headers.authorization;
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") {
      response.end(
        JSON.stringify({ object: "list", data: [{ id: "upstream" }] })
      );
      return;
    }
    response.end(JSON.stringify({
      id: "managed",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop"
        }
      ]
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  ensureCliproxyConfig();
  const expected = cliproxyApiKey();
  const config = parseRouterConfig({
    providers: { cliproxy: {} },
    defaultModel: "cliproxy/upstream"
  });
  const router = await startRouter({
    config,
    port: 0,
    register: false,
    env: {
      ROUTEKIT_CLIPROXY_BASE_URL: `http://127.0.0.1:${port}`
    }
  });
  try {
    await fetch(`${router.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "cliproxy/upstream",
        messages: [{ role: "user", content: "hi" }]
      })
    });
    assert.equal(authorization, `Bearer ${expected}`);
    assert.equal(process.env[CLIPROXY_API_KEY_ENV], undefined);
  } finally {
    await router.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
    if (previousHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousHome;
    if (previousKey === undefined) delete process.env[CLIPROXY_API_KEY_ENV];
    else process.env[CLIPROXY_API_KEY_ENV] = previousKey;
    rmSync(stateHome, { recursive: true, force: true });
  }
});
