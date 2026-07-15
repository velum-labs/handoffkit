import assert from "node:assert/strict";
import test from "node:test";

import { parseRouterConfig } from "@routekit/gateway";

import { startRouter } from "../index.js";

test("SDK composes an embedded router without CLI state", async () => {
  const running = await startRouter({
    config: parseRouterConfig({
      endpoints: [
        {
          endpointId: "opaque",
          model: "provider-model",
          baseUrl: "http://127.0.0.1:9",
          dialect: "openai"
        }
      ],
      defaultEndpointId: "opaque"
    }),
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
