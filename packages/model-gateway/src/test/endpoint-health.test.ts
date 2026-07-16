import assert from "node:assert/strict";
import { test } from "node:test";

import {
  endpointHealthProbe,
  probeEndpointHealth
} from "../endpoint-health.js";
import type { ModelEndpointConfig } from "../router.js";

function endpoint(
  provider: string,
  dialect: ModelEndpointConfig["dialect"],
  baseUrl: string
): ModelEndpointConfig {
  return {
    endpointId: `${provider}-endpoint`,
    model: `${provider}-model`,
    provider,
    dialect,
    baseUrl
  };
}

test("health probes use registry-native OpenAI, Anthropic, and Google authentication", () => {
  const openai = endpointHealthProbe(
    endpoint("openai", "openai", "https://api.openai.com/v1"),
    "openai-secret"
  );
  assert.equal(openai.supported, true);
  if (openai.supported) {
    assert.equal(new URL(openai.probe.url).pathname, "/v1/models");
    assert.equal(openai.probe.headers.authorization, "Bearer openai-secret");
  }

  const anthropic = endpointHealthProbe(
    endpoint("anthropic", "anthropic", "https://api.anthropic.com/v1"),
    "anthropic-secret"
  );
  assert.equal(anthropic.supported, true);
  if (anthropic.supported) {
    assert.equal(new URL(anthropic.probe.url).pathname, "/v1/models");
    assert.equal(anthropic.probe.headers["x-api-key"], "anthropic-secret");
    assert.equal(anthropic.probe.headers["anthropic-version"], "2023-06-01");
    assert.equal(anthropic.probe.headers.authorization, undefined);
  }

  const google = endpointHealthProbe(
    endpoint("google", "google", "https://generativelanguage.googleapis.com/v1beta"),
    "google-secret"
  );
  assert.equal(google.supported, true);
  if (google.supported) {
    assert.equal(new URL(google.probe.url).pathname, "/v1beta/models");
    assert.equal(google.probe.headers["x-goog-api-key"], "google-secret");
    assert.equal(google.probe.headers.authorization, undefined);
  }
});

test("custom endpoints use dialect rules while Codex avoids unsafe generation probes", async () => {
  const custom = endpointHealthProbe(
    endpoint("private-provider", "anthropic", "https://private.example/api/v1"),
    "private-secret"
  );
  assert.equal(custom.supported, true);
  if (custom.supported) {
    assert.equal(new URL(custom.probe.url).pathname, "/api/v1/models");
    assert.equal(custom.probe.headers["x-api-key"], "private-secret");
  }

  let requested = false;
  const result = await probeEndpointHealth(
    endpoint("codex", "openai", "https://chatgpt.com/backend-api/codex"),
    {
      credential: "codex-secret",
      fetchImpl: async () => {
        requested = true;
        return new Response(null, { status: 200 });
      }
    }
  );
  assert.equal(requested, false);
  assert.equal(result.kind, "unsupported");
  if (result.kind === "unsupported") assert.match(result.reason, /Codex responses provider/);
  assert.equal(JSON.stringify(result).includes("codex-secret"), false);

  const customCodex = endpointHealthProbe(
    endpoint("private-provider", "codex", "https://private.example/responses"),
    "private-secret"
  );
  assert.equal(customCodex.supported, false);
  if (!customCodex.supported) assert.match(customCodex.reason, /Codex responses dialect/);
});

test("health results classify native auth rejection without returning credentials", async () => {
  const result = await probeEndpointHealth(
    endpoint("google", "google", "https://generativelanguage.googleapis.com/v1beta"),
    {
      credential: "never-return-this",
      fetchImpl: async () => new Response(null, { status: 400 })
    }
  );
  assert.deepEqual(result, {
    kind: "response",
    ok: false,
    status: 400,
    authRejected: true
  });
  assert.equal(JSON.stringify(result).includes("never-return-this"), false);
});
