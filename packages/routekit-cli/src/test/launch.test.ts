import assert from "node:assert/strict";
import test from "node:test";

import { parseRouterConfig } from "@routekit/gateway";

import { buildToolLaunchSpec, routekitToolRegistry } from "../launch.js";

const config = parseRouterConfig({
  endpoints: [
    {
      endpointId: "opaque-a",
      model: "upstream-a",
      baseUrl: "https://a.example/v1",
      capabilities: {
        streaming: "supported",
        tools: "degraded",
        images: "unsupported",
        reasoning_controls: "unknown"
      }
    },
    {
      endpointId: "opaque-b",
      model: "upstream-b",
      baseUrl: "https://b.example/v1"
    }
  ],
  defaultEndpointId: "opaque-b"
});

test("every canonical launcher receives the same neutral launch specification", () => {
  assert.ok(routekitToolRegistry.list().length > 0);
  for (const tool of routekitToolRegistry.list()) {
    const spec = buildToolLaunchSpec({
      config,
      gatewayUrl: "http://127.0.0.1:8000",
      args: ["--example"]
    });
    assert.equal(spec.defaultModel, "opaque-b", tool.id);
    assert.deepEqual(spec.models.map((entry) => entry.id), ["opaque-a", "opaque-b"]);
    assert.deepEqual(spec.args, ["--example"]);
    assert.equal(spec.models[0]?.features?.streaming, "full");
    assert.equal(spec.models[0]?.features?.tools, "degraded");
    assert.equal(spec.models[0]?.features?.images, "unsupported");
  }
});

test("an explicitly requested generic opaque model is advertised", () => {
  const spec = buildToolLaunchSpec({
    config,
    gatewayUrl: "https://gateway.example",
    model: "caller-provided",
    authToken: "private"
  });
  assert.equal(spec.defaultModel, "caller-provided");
  assert.ok(spec.models.some((entry) => entry.id === "caller-provided"));
  assert.equal(spec.auth?.token, "private");
});
