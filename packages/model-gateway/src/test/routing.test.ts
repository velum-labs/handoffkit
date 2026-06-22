import assert from "node:assert/strict";
import { test } from "node:test";

import {
  countRequestTokens,
  detectRoutingScenario,
  fallbackChain,
  hasWebSearchTools,
  isBackgroundRequest,
  isReasoningRequest,
  parseRouteTarget,
  parseScenarioRoutes,
  resolveRoutingDecision,
  resolveRoutingFallback,
  RoutingBackend,
  DEFAULT_LONG_CONTEXT_THRESHOLD
} from "../routing/index.js";

test("parseRouteTarget parses provider,model and bare model", () => {
  assert.deepEqual(parseRouteTarget("anthropic,claude-sonnet-4-5"), {
    providerId: "anthropic",
    model: "claude-sonnet-4-5"
  });
  assert.deepEqual(parseRouteTarget("gpt-4o"), { model: "gpt-4o" });
});

test("detectRoutingScenario prioritises webSearch then reasoning then longContext", () => {
  const routes = parseScenarioRoutes(
    {
      default: "a,m1",
      background: "a,m2",
      longContext: "a,m3",
      reasoning: "a,m4",
      webSearch: "a,m5"
    },
    "test"
  );

  assert.equal(
    detectRoutingScenario(
      { messages: [{ role: "user", content: "hi" }], tools: [{ name: "web_search" }] },
      routes
    ).scenario,
    "webSearch"
  );

  assert.equal(
    detectRoutingScenario(
      { messages: [{ role: "user", content: "hi" }], thinking: { type: "enabled", budget_tokens: 10000 } },
      routes
    ).scenario,
    "reasoning"
  );

  assert.equal(
    detectRoutingScenario(
      { messages: [{ role: "user", content: "x".repeat(DEFAULT_LONG_CONTEXT_THRESHOLD * 4) }] },
      routes,
      { tokenCount: DEFAULT_LONG_CONTEXT_THRESHOLD + 1 }
    ).scenario,
    "longContext"
  );

  assert.equal(
    detectRoutingScenario({ model: "background-task", messages: [] }, routes).scenario,
    "background"
  );

  assert.equal(
    detectRoutingScenario({ messages: [{ role: "user", content: "hello" }] }, routes).scenario,
    "default"
  );
});

test("countRequestTokens uses tiktoken", () => {
  const count = countRequestTokens({ messages: [{ role: "user", content: "Hello, world!" }] });
  assert.ok(count > 0);
  assert.ok(count < 20);
});

test("fallbackChain deduplicates targets", () => {
  const routes = parseScenarioRoutes(
    {
      default: "openai,gpt-4o",
      fallbacks: { default: ["openai,gpt-4o", "anthropic,claude-haiku"] }
    },
    "test"
  );
  const chain = fallbackChain(routes, "default");
  assert.equal(chain.length, 2);
});

test("resolveRoutingFallback walks the chain", () => {
  const routes = parseScenarioRoutes(
    {
      default: "openai,gpt-4o",
      fallbacks: { default: ["anthropic,claude-haiku"] }
    },
    "test"
  );
  const primary = resolveRoutingDecision({ messages: [{ role: "user", content: "hi" }] }, routes);
  const fallback = resolveRoutingFallback(primary, routes, 1);
  assert.equal(fallback?.target.providerId, "anthropic");
  assert.equal(fallback?.fallbackIndex, 1);
});

test("RoutingBackend lists configured models", () => {
  const backend = new RoutingBackend({
    routes: parseScenarioRoutes({ default: "p,m1", webSearch: "p,m2" }, "test"),
    providers: [{ id: "p", provider: "openai", keyEnv: "OPENAI_API_KEY" }],
    env: { OPENAI_API_KEY: "test-key" }
  });
  assert.deepEqual(backend.listModelIds().sort(), ["m1", "m2"]);
});

test("hasWebSearchTools and isReasoningRequest heuristics", () => {
  assert.equal(hasWebSearchTools({ tools: [{ name: "WebSearch" }] }), true);
  assert.equal(isReasoningRequest({ model: "claude-opus-thinking" }), true);
  assert.equal(isBackgroundRequest({ model: "my-background-agent" }), true);
});
