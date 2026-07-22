import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { parseRouterConfig } from "@routekit/gateway";

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
