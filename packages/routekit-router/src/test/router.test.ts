import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { parseRouterConfig } from "@velum-labs/routekit-gateway";

import { startRouter } from "../index.js";

async function withDiscoveryServer(
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createServer((request, response) => {
    if (request.url === "/v1/models") {
      if (request.headers.authorization !== "Bearer test") {
        response.statusCode = 401;
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "gpt-live" }] }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve)
  );
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    );
  }
}

const config = parseRouterConfig({
  providers: { openai: {} },
  defaultModel: "openai/gpt-live"
});

test("SDK starts only after live provider discovery", async () => {
  await withDiscoveryServer(async (baseUrl) => {
    const running = await startRouter({
      config,
      host: "127.0.0.1",
      port: 0,
      env: { OPENAI_API_KEY: "test", OPENAI_BASE_URL: `${baseUrl}/v1` }
    });
    try {
      const response = await fetch(`${running.url}/v1/models`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { data: Array<{ id: string }> };
      assert.deepEqual(
        body.data.map((model) => model.id),
        ["openai/gpt-live"]
      );
      const usageResponse = await fetch(`${running.url}/usage`);
      assert.equal(usageResponse.status, 200);
      assert.deepEqual(await usageResponse.json(), { accountSets: [] });
    } finally {
      await running.close();
    }
  });
});

test("SDK serves an empty catalog when no providers are configured", async () => {
  const running = await startRouter({
    config: parseRouterConfig({ providers: {} }),
    host: "127.0.0.1",
    port: 0,
    env: {}
  });
  try {
    assert.equal((await fetch(`${running.url}/health`)).status, 200);
    const modelsResponse = await fetch(`${running.url}/v1/models`);
    assert.equal(modelsResponse.status, 200);
    const models = (await modelsResponse.json()) as {
      data: unknown[];
      models: unknown[];
    };
    assert.deepEqual(models.data, []);
    assert.deepEqual(models.models, []);
    assert.deepEqual(await running.providerStatuses(), []);

    const unavailable = await fetch(`${running.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] })
    });
    assert.equal(unavailable.status, 503);
    assert.match(await unavailable.text(), /no model is available/);

    const anthropicUnavailable = await fetch(`${running.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }]
      })
    });
    assert.equal(anthropicUnavailable.status, 503);
    assert.deepEqual(await anthropicUnavailable.json(), {
      type: "error",
      error: {
        type: "unavailable",
        message: "no model is available; configure a provider"
      }
    });

    const responsesUnavailable = await fetch(`${running.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello" })
    });
    assert.equal(responsesUnavailable.status, 503);
    assert.deepEqual(await responsesUnavailable.json(), {
      error: {
        type: "unavailable",
        message: "no model is available; configure a provider"
      }
    });

    const responsesUnknown = await fetch(`${running.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/not-configured", input: "hello" })
    });
    assert.equal(responsesUnknown.status, 400);
    assert.deepEqual(await responsesUnknown.json(), {
      error: {
        type: "invalid_request_error",
        code: "model_not_found",
        param: "model",
        message: "unknown model: openai/not-configured"
      }
    });

    const anthropicUnknown = await fetch(`${running.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/not-configured",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }]
      })
    });
    assert.equal(anthropicUnknown.status, 400);
    assert.deepEqual(await anthropicUnknown.json(), {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "unknown model: anthropic/not-configured"
      }
    });

    const countTokensUnknown = await fetch(
      `${running.url}/v1/messages/count_tokens`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "anthropic/not-configured",
          messages: [{ role: "user", content: "hello" }]
        })
      }
    );
    assert.equal(countTokensUnknown.status, 400);
    assert.deepEqual(await countTokensUnknown.json(), {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "unknown model: anthropic/not-configured"
      }
    });

    const unknown = await fetch(`${running.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/not-configured",
        messages: [{ role: "user", content: "hello" }]
      })
    });
    assert.equal(unknown.status, 400);
    assert.match(await unknown.text(), /unknown model/);
  } finally {
    await running.close();
  }
});

test("SDK requires authentication for non-loopback router binds", async () => {
  await assert.rejects(
    startRouter({ config, host: "0.0.0.0", port: 0 }),
    /binding to non-loopback host "0\.0\.0\.0" requires an auth token/
  );

  await withDiscoveryServer(async (baseUrl) => {
    const authenticated = await startRouter({
      config,
      host: "0.0.0.0",
      port: 0,
      authToken: "secret",
      env: { OPENAI_API_KEY: "test", OPENAI_BASE_URL: `${baseUrl}/v1` }
    });
    try {
      assert.equal((await fetch(`${authenticated.url}/usage`)).status, 401);
      const usageResponse = await fetch(`${authenticated.url}/usage`, {
        headers: { authorization: "Bearer secret" }
      });
      assert.equal(usageResponse.status, 200);
      assert.deepEqual(await usageResponse.json(), { accountSets: [] });
    } finally {
      await authenticated.close();
    }
  });
});
