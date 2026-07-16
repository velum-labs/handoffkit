import assert from "node:assert/strict";
import { test } from "node:test";

import { opencodeConfig, opencodeModelArg, opencodeTool } from "../index.js";

test("opencodeConfig serializes neutral models and profiles", () => {
  const config = opencodeConfig({
    gatewayUrl: "http://127.0.0.1:9999",
    defaultModel: "primary",
    models: [
      { id: "primary", aliases: ["primary-alias"] },
      { id: "secondary", label: "Secondary" }
    ],
    agentProfiles: [
      {
        id: "reviewer",
        model: "secondary",
        description: "Review changes.",
        instructions: "Return concise findings."
      }
    ],
    auth: { token: "gateway-token" },
    args: []
  });
  const provider = config.provider as Record<string, Record<string, unknown>>;
  const entry = provider.routekit;
  assert.ok(entry);
  assert.deepEqual(entry.options, {
    baseURL: "http://127.0.0.1:9999/v1",
    apiKey: "gateway-token"
  });
  assert.deepEqual(entry.models, {
    primary: { name: "primary" },
    "primary-alias": { name: "primary-alias" },
    secondary: { name: "Secondary" }
  });
  assert.deepEqual(config.agent, {
    reviewer: {
      mode: "subagent",
      model: "routekit/secondary",
      description: "Review changes.",
      prompt: "Return concise findings."
    }
  });
});

test("opencodeModelArg namespaces opaque model ids", () => {
  assert.equal(opencodeModelArg("opaque-endpoint"), "routekit/opaque-endpoint");
});

test("OpenCode driver registration carries the gateway route", () => {
  assert.deepEqual(
    opencodeTool.driver.configForRoute({
      gatewayUrl: "http://127.0.0.1:9999",
      model: "opaque-endpoint",
      authToken: "gateway-token"
    }),
    {
      command: "opencode",
      gatewayUrl: "http://127.0.0.1:9999",
      model: "opaque-endpoint",
      providerId: "routekit",
      authToken: "gateway-token"
    }
  );
});
