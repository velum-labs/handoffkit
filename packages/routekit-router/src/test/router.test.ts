import assert from "node:assert/strict";
import test from "node:test";

import { parseRouterConfig } from "@routekit/gateway";

import { startRouter } from "../index.js";

const config = parseRouterConfig({
  endpoints: [
    {
      endpointId: "opaque",
      model: "provider-model",
      baseUrl: "http://127.0.0.1:9",
      dialect: "openai"
    }
  ],
  defaultEndpointId: "opaque"
});

test("SDK composes an embedded router without CLI state", async () => {
  const running = await startRouter({
    config,
    host: "127.0.0.1",
    port: 0
  });
  try {
    const response = await fetch(`${running.url}/v1/models`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    assert.deepEqual(body.data.map((model) => model.id), ["opaque"]);
  } finally {
    await running.close();
  }
});

test("SDK requires authentication for non-loopback router binds", async () => {
  await assert.rejects(
    startRouter({ config, host: "0.0.0.0", port: 0 }),
    /binding to non-loopback host "0\.0\.0\.0" requires an auth token/
  );

  const authenticated = await startRouter({
    config,
    host: "0.0.0.0",
    port: 0,
    authToken: "secret"
  });
  await authenticated.close();
});
