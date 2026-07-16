import assert from "node:assert/strict";
import test from "node:test";

import { parseRouterConfig } from "@routekit/gateway";

import { buildToolLaunchSpec, routekitToolRegistry } from "../launch.js";

const config = parseRouterConfig({
  providers: { openai: {}, codex: {} },
  defaultModel: "codex/gpt-5.5"
});
const catalog = [
  {
    id: "openai/gpt-5.5",
    provider: "openai",
    capabilities: {
      streaming: "supported",
      tools: "degraded",
      images: "unsupported",
      reasoning_controls: "unknown"
    }
  },
  {
    id: "codex/gpt-5.5",
    provider: "codex",
    capabilities: {}
  }
] as const;

test("every canonical launcher receives the same live catalog specification", () => {
  assert.ok(routekitToolRegistry.list().length > 0);
  for (const tool of routekitToolRegistry.list()) {
    const spec = buildToolLaunchSpec({
      config,
      catalog,
      gatewayUrl: "http://127.0.0.1:8000",
      args: ["--example"]
    });
    assert.equal(spec.defaultModel, "codex/gpt-5.5", tool.id);
    assert.deepEqual(spec.models.map((entry) => entry.id), [
      "openai/gpt-5.5",
      "codex/gpt-5.5"
    ]);
    assert.deepEqual(spec.args, ["--example"]);
    assert.equal(spec.models[0]?.features?.streaming, "full");
    assert.equal(spec.models[0]?.features?.tools, "degraded");
    assert.equal(spec.models[0]?.features?.images, "unsupported");
  }
});

test("an explicitly requested model absent from the live catalog is rejected", () => {
  assert.throws(
    () =>
      buildToolLaunchSpec({
        config,
        catalog,
        gatewayUrl: "https://gateway.example",
        model: "openrouter/caller-provided",
        authToken: "private"
      }),
    /unknown model "openrouter\/caller-provided"/
  );
});
