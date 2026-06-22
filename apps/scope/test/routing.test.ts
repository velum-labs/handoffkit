import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FUSION_CONFIG_DIRNAME, FUSION_CONFIG_BASENAME } from "../lib/routing/config";
import { publishRoutingDecision, recentRoutingDecisions } from "../lib/routing/decisions";
import type { RoutingDecision } from "../lib/routing/types";

const SAMPLE_ROUTING = {
  routes: {
    default: "claude-sub,claude-sonnet-4-5",
    background: "claude-sub,claude-haiku-4-5",
    longContext: "claude-sub,claude-sonnet-4-5",
    longContextThreshold: 60000,
    reasoning: "claude-sub,claude-opus-4-5",
    webSearch: "claude-sub,claude-sonnet-4-5",
    fallbacks: {
      default: ["openrouter,anthropic/claude-sonnet-4.6"]
    }
  },
  providers: [
    { id: "claude-sub", provider: "anthropic", keyEnv: "ANTHROPIC_API_KEY" },
    { id: "openrouter", provider: "openrouter", keyEnv: "OPENROUTER_API_KEY" },
    { id: "deepseek", provider: "deepseek", keyEnv: "DEEPSEEK_API_KEY" },
    { id: "groq", provider: "groq", keyEnv: "GROQ_API_KEY" },
    {
      id: "google-gemini",
      provider: "google-gemini",
      keyEnv: "GEMINI_API_KEY"
    }
  ]
};

function writeFusionConfig(repoRoot: string): void {
  mkdirSync(join(repoRoot, FUSION_CONFIG_DIRNAME), { recursive: true });
  writeFileSync(
    join(repoRoot, FUSION_CONFIG_DIRNAME, FUSION_CONFIG_BASENAME),
    JSON.stringify({
      version: "fusionkit.fusion.v2",
      routing: SAMPLE_ROUTING
    })
  );
}

test("GET /api/routing/config returns parsed routing config", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "scope-routing-"));
  writeFusionConfig(repoRoot);
  process.env.SCOPE_REPO_ROOT = repoRoot;

  const { GET } = await import("../app/api/routing/config/route");
  const response = await GET();
  const body = (await response.json()) as {
    routing: { routes: { default: string }; providers: Array<{ id: string }> };
  };

  assert.equal(response.status, 200);
  assert.equal(body.routing.routes.default, "claude-sub,claude-sonnet-4-5");
  assert.equal(body.routing.providers.length, 5);
});

test("GET /api/routing/providers returns provider rows", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "scope-routing-"));
  writeFusionConfig(repoRoot);
  process.env.SCOPE_REPO_ROOT = repoRoot;

  const { GET } = await import("../app/api/routing/providers/route");
  const response = await GET(new Request("http://localhost/api/routing/providers?ping=0"));
  const body = (await response.json()) as { providers: Array<{ id: string; kind: string }> };

  assert.equal(response.status, 200);
  assert.equal(body.providers.length, 5);
  assert.ok(body.providers.some((provider) => provider.id === "google-gemini"));
  assert.ok(body.providers.some((provider) => provider.kind === "deepseek"));
});

test("routing decision bus replays to SSE subscribers", async () => {
  const sample: RoutingDecision = {
    scenario: "default",
    target: { providerId: "claude-sub", model: "claude-sonnet-4-5" },
    tokenCount: 42,
    reason: "standard request",
    fallbackIndex: 0
  };
  publishRoutingDecision(sample);
  assert.equal(recentRoutingDecisions().length >= 1, true);

  const { GET, POST } = await import("../app/api/routing/decisions/route");
  const postResponse = await POST(
    new Request("http://localhost/api/routing/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sample)
    })
  );
  assert.equal(postResponse.status, 200);

  const controller = new AbortController();
  const sseResponse = await GET(
    new Request("http://localhost/api/routing/decisions", { signal: controller.signal })
  );
  assert.equal(sseResponse.status, 200);
  assert.match(sseResponse.headers.get("content-type") ?? "", /text\/event-stream/);

  const reader = sseResponse.body?.getReader();
  assert.ok(reader);
  const { value } = await reader.read();
  const chunk = new TextDecoder().decode(value);
  assert.match(chunk, /event: routing\.decision/);
  assert.match(chunk, /claude-sonnet-4-5/);
  controller.abort();
  await reader.cancel();
});

test("GET /api/routing/config 404s when fusion.json is missing", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "scope-routing-empty-"));
  process.env.SCOPE_REPO_ROOT = repoRoot;

  const { GET } = await import("../app/api/routing/config/route");
  const response = await GET();
  assert.equal(response.status, 404);
});
