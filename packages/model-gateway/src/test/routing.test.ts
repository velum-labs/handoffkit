import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  countRequestTokens,
  detectRoutingScenario,
  extractRequestText,
  fallbackChain,
  formatRoutingDecision,
  hasWebSearchTools,
  isBackgroundRequest,
  isReasoningRequest,
  parseRouteTarget,
  parseRoutingProviderSpec,
  parseScenarioRoutes,
  previewRoutingForAnthropic,
  previewRoutingForChat,
  resolveRoutingDecision,
  resolveRoutingFallback,
  resolveRoutingProviders,
  RoutingBackend,
  RoutingConfigError,
  RoutingProviderError,
  DEFAULT_LONG_CONTEXT_THRESHOLD
} from "../routing/index.js";
import { sessionOverridePath } from "../session-override.js";

const FULL_ROUTES = parseScenarioRoutes(
  {
    default: "a,m1",
    background: "a,m2",
    longContext: "a,m3",
    reasoning: "a,m4",
    webSearch: "a,m5"
  },
  "test"
);

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(Buffer.from(JSON.stringify(value), "utf8"));
}

async function readAll(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function startStatusMock(statusByModel: Record<string, number>): Promise<{
  url: string;
  models: () => string[];
  close: () => Promise<void>;
}> {
  const models: string[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "POST" && path === "/v1/chat/completions") {
        const body = JSON.parse((await readAll(req)).toString("utf8")) as Record<string, unknown>;
        const model = typeof body.model === "string" ? body.model : "unknown";
        models.push(model);
        const status = statusByModel[model] ?? 200;
        sendJson(res, status, {
          id: "chatcmpl-mock",
          object: "chat.completion",
          model,
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }]
        });
        return;
      }
      sendJson(res, 404, { error: "not found" });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    models: () => [...models],
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  };
}

test("parseRouteTarget parses provider,model and bare model", () => {
  assert.deepEqual(parseRouteTarget("anthropic,claude-sonnet-4-5"), {
    providerId: "anthropic",
    model: "claude-sonnet-4-5"
  });
  assert.deepEqual(parseRouteTarget("gpt-4o"), { model: "gpt-4o" });
});

test("parseRouteTarget rejects empty and malformed specs", () => {
  assert.throws(() => parseRouteTarget(""), RoutingConfigError);
  assert.throws(() => parseRouteTarget("   "), RoutingConfigError);
  assert.throws(() => parseRouteTarget(",model"), RoutingConfigError);
  assert.throws(() => parseRouteTarget("provider,"), RoutingConfigError);
});

test("parseScenarioRoutes rejects invalid routing config", () => {
  assert.throws(() => parseScenarioRoutes({}, "cfg"), RoutingConfigError);
  assert.throws(() => parseScenarioRoutes({ default: "" }, "cfg"), RoutingConfigError);
  assert.throws(() => parseScenarioRoutes({ default: "a,m", background: 1 }, "cfg"), RoutingConfigError);
  assert.throws(
    () => parseScenarioRoutes({ default: "a,m", longContextThreshold: 0 }, "cfg"),
    RoutingConfigError
  );
  assert.throws(
    () => parseScenarioRoutes({ default: "a,m", fallbacks: { default: [1] } }, "cfg"),
    RoutingConfigError
  );
});

test("detectRoutingScenario prioritises webSearch then reasoning then longContext", () => {
  assert.equal(
    detectRoutingScenario(
      { messages: [{ role: "user", content: "hi" }], tools: [{ name: "web_search" }] },
      FULL_ROUTES
    ).scenario,
    "webSearch"
  );

  assert.equal(
    detectRoutingScenario(
      { messages: [{ role: "user", content: "hi" }], thinking: { type: "enabled", budget_tokens: 10000 } },
      FULL_ROUTES
    ).scenario,
    "reasoning"
  );

  assert.equal(
    detectRoutingScenario(
      { messages: [{ role: "user", content: "x".repeat(DEFAULT_LONG_CONTEXT_THRESHOLD * 4) }] },
      FULL_ROUTES,
      { tokenCount: DEFAULT_LONG_CONTEXT_THRESHOLD + 1 }
    ).scenario,
    "longContext"
  );

  assert.equal(
    detectRoutingScenario({ model: "background-task", messages: [] }, FULL_ROUTES).scenario,
    "background"
  );

  assert.equal(
    detectRoutingScenario({ messages: [{ role: "user", content: "hello" }] }, FULL_ROUTES).scenario,
    "default"
  );
});

test("longContextThreshold is honored and overridable", () => {
  const routes = parseScenarioRoutes(
    { default: "a,m1", longContext: "a,m3", longContextThreshold: 100 },
    "test"
  );
  assert.equal(
    detectRoutingScenario({ messages: [{ role: "user", content: "short" }] }, routes, { tokenCount: 50 })
      .scenario,
    "default"
  );
  assert.equal(
    detectRoutingScenario({ messages: [{ role: "user", content: "long" }] }, routes, { tokenCount: 101 })
      .scenario,
    "longContext"
  );
});

test("hasWebSearchTools detects web search tool name variants", () => {
  for (const name of ["web_search", "WebSearch", "web-fetch", "browser", "internet_search"]) {
    assert.equal(hasWebSearchTools({ tools: [{ name }] }), true, name);
  }
  assert.equal(hasWebSearchTools({ tools: [{ function: { name: "web_search" } }] }), true);
  assert.equal(hasWebSearchTools({ tools: [{ name: "read_file" }] }), false);
});

test("isReasoningRequest detects thinking budget and reasoning_effort", () => {
  assert.equal(isReasoningRequest({ thinking: { budget_tokens: 1024 } }), true);
  assert.equal(isReasoningRequest({ reasoning_effort: "high" }), true);
  assert.equal(isReasoningRequest({ model: "claude-opus-thinking" }), true);
  assert.equal(isReasoningRequest({ messages: [{ role: "user", content: "hi" }] }), false);
});

test("isBackgroundRequest detects header, marker, and model name", () => {
  assert.equal(
    isBackgroundRequest({ messages: [{ role: "user", content: "hi" }] }, { "x-ccr-agent-type": "background" }),
    true
  );
  assert.equal(
    isBackgroundRequest({
      messages: [{ role: "user", content: "please run <background_task> cleanup" }]
    }),
    true
  );
  assert.equal(isBackgroundRequest({ model: "my-background-agent", messages: [] }), true);
  assert.equal(isBackgroundRequest({ messages: [{ role: "user", content: "hello" }] }), false);
});

test("countRequestTokens uses tiktoken and includes tool_calls", () => {
  const count = countRequestTokens({ messages: [{ role: "user", content: "Hello, world!" }] });
  assert.ok(count > 0);
  assert.ok(count < 20);
  const withTools = countRequestTokens({
    messages: [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "1", function: { name: "grep", arguments: "{}" } }]
      }
    ]
  });
  assert.ok(withTools > count);
});

test("extractRequestText concatenates system, messages, tools", () => {
  const text = extractRequestText({
    system: "You are helpful",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "web_search" }]
  });
  assert.match(text, /You are helpful/);
  assert.match(text, /hello/);
  assert.match(text, /web_search/);
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

test("formatRoutingDecision renders a single-line summary", () => {
  const decision = resolveRoutingDecision({ messages: [{ role: "user", content: "hi" }] }, FULL_ROUTES);
  const line = formatRoutingDecision(decision);
  assert.match(line, /scenario=default/);
  assert.match(line, /fallback=0/);
});

test("parseRoutingProviderSpec validates provider entries", () => {
  const spec = parseRoutingProviderSpec(
    { id: "p1", provider: "anthropic", keyEnv: "ANTHROPIC_API_KEY" },
    0
  );
  assert.equal(spec.id, "p1");
  assert.throws(() => parseRoutingProviderSpec({ id: "", provider: "openai" }, 0), RoutingProviderError);
});

test("parseRoutingProviderSpec accepts Phase 2 provider kinds", () => {
  const openrouter = parseRoutingProviderSpec({ id: "or", provider: "openrouter" }, 0);
  assert.equal(openrouter.keyEnv, "OPENROUTER_API_KEY");

  const deepseek = parseRoutingProviderSpec({ id: "ds", provider: "deepseek" }, 0);
  assert.equal(deepseek.keyEnv, "DEEPSEEK_API_KEY");

  const groq = parseRoutingProviderSpec({ id: "gq", provider: "groq" }, 0);
  assert.equal(groq.keyEnv, "GROQ_API_KEY");

  const gemini = parseRoutingProviderSpec({ id: "gg", provider: "google-gemini" }, 0);
  assert.equal(gemini.keyEnv, "GEMINI_API_KEY");
});

test("parseRoutingProviderSpec rejects unknown provider kind", () => {
  assert.throws(
    () => parseRoutingProviderSpec({ id: "bad", provider: "not-a-provider" }, 0),
    RoutingProviderError
  );
});

test("resolveRoutingProviders rejects duplicate ids and missing keys", () => {
  const providers = resolveRoutingProviders(
    [{ id: "p1", provider: "openai", keyEnv: "OPENAI_API_KEY" }],
    { OPENAI_API_KEY: "test" }
  );
  assert.equal(providers.size, 1);
  assert.throws(
    () =>
      resolveRoutingProviders(
        [
          { id: "p1", provider: "openai", keyEnv: "OPENAI_API_KEY" },
          { id: "p1", provider: "anthropic", keyEnv: "ANTHROPIC_API_KEY" }
        ],
        { OPENAI_API_KEY: "a", ANTHROPIC_API_KEY: "b" }
      ),
    RoutingProviderError
  );
  assert.throws(
    () => resolveRoutingProviders([{ id: "p1", provider: "openai", keyEnv: "MISSING" }], {}),
    RoutingProviderError
  );
});

test("RoutingBackend lists configured models", () => {
  const backend = new RoutingBackend({
    routes: parseScenarioRoutes({ default: "p,m1", webSearch: "p,m2" }, "test"),
    providers: [{ id: "p", provider: "openai", keyEnv: "OPENAI_API_KEY" }],
    env: { OPENAI_API_KEY: "test-key" }
  });
  assert.deepEqual([...backend.listModelIds()].sort(), ["m1", "m2"]);
});

test("RoutingBackend does not fall back on primary HTTP 400", async () => {
  const primary = await startStatusMock({ "gpt-4o": 400 });
  const fallback = await startStatusMock({ "claude-haiku": 200 });
  const backend = new RoutingBackend({
    routes: parseScenarioRoutes(
      {
        default: "primary,gpt-4o",
        fallbacks: { default: ["fallback,claude-haiku"] }
      },
      "test"
    ),
    providers: [
      { id: "primary", provider: "openai", baseUrl: `${primary.url}/v1`, keyEnv: "OPENAI_API_KEY" },
      { id: "fallback", provider: "anthropic", baseUrl: `${fallback.url}/v1`, keyEnv: "ANTHROPIC_API_KEY" }
    ],
    env: { OPENAI_API_KEY: "a", ANTHROPIC_API_KEY: "b" }
  });
  try {
    const response = await backend.chat({
      messages: [{ role: "user", content: "hi" }]
    });
    assert.equal(response.status, 400);
    assert.deepEqual(primary.models(), ["gpt-4o"]);
    assert.deepEqual(fallback.models(), []);
  } finally {
    await primary.close();
    await fallback.close();
  }
});

test("RoutingBackend falls back on primary HTTP 429", async () => {
  const primary = await startStatusMock({ "gpt-4o": 429 });
  const fallback = await startStatusMock({ "claude-haiku": 200 });
  const backend = new RoutingBackend({
    routes: parseScenarioRoutes(
      {
        default: "primary,gpt-4o",
        fallbacks: { default: ["fallback,claude-haiku"] }
      },
      "test"
    ),
    providers: [
      { id: "primary", provider: "openai", baseUrl: `${primary.url}/v1`, keyEnv: "OPENAI_API_KEY" },
      { id: "fallback", provider: "anthropic", baseUrl: `${fallback.url}/v1`, keyEnv: "ANTHROPIC_API_KEY" }
    ],
    env: { OPENAI_API_KEY: "a", ANTHROPIC_API_KEY: "b" }
  });
  try {
    const response = await backend.chat({
      messages: [{ role: "user", content: "hi" }]
    });
    assert.equal(response.status, 200);
    assert.deepEqual(primary.models(), ["gpt-4o"]);
    assert.deepEqual(fallback.models(), ["claude-haiku"]);
  } finally {
    await primary.close();
    await fallback.close();
  }
});

test("RoutingBackend falls back on primary HTTP 502", async () => {
  const primary = await startStatusMock({ "gpt-4o": 502 });
  const fallback = await startStatusMock({ "claude-haiku": 200 });
  const backend = new RoutingBackend({
    routes: parseScenarioRoutes(
      {
        default: "primary,gpt-4o",
        fallbacks: { default: ["fallback,claude-haiku"] }
      },
      "test"
    ),
    providers: [
      { id: "primary", provider: "openai", baseUrl: `${primary.url}/v1`, keyEnv: "OPENAI_API_KEY" },
      { id: "fallback", provider: "anthropic", baseUrl: `${fallback.url}/v1`, keyEnv: "ANTHROPIC_API_KEY" }
    ],
    env: { OPENAI_API_KEY: "a", ANTHROPIC_API_KEY: "b" }
  });
  try {
    const response = await backend.chat({
      messages: [{ role: "user", content: "hi" }]
    });
    assert.equal(response.status, 200);
    assert.deepEqual(primary.models(), ["gpt-4o"]);
    assert.deepEqual(fallback.models(), ["claude-haiku"]);
  } finally {
    await primary.close();
    await fallback.close();
  }
});

test("RoutingBackend falls back when primary returns non-2xx", async () => {
  const primary = await startStatusMock({ "gpt-4o": 500 });
  const fallback = await startStatusMock({ "claude-haiku": 200 });
  const backend = new RoutingBackend({
    routes: parseScenarioRoutes(
      {
        default: "primary,gpt-4o",
        fallbacks: { default: ["fallback,claude-haiku"] }
      },
      "test"
    ),
    providers: [
      { id: "primary", provider: "openai", baseUrl: `${primary.url}/v1`, keyEnv: "OPENAI_API_KEY" },
      { id: "fallback", provider: "anthropic", baseUrl: `${fallback.url}/v1`, keyEnv: "ANTHROPIC_API_KEY" }
    ],
    env: { OPENAI_API_KEY: "a", ANTHROPIC_API_KEY: "b" }
  });
  try {
    const response = await backend.chat({
      messages: [{ role: "user", content: "hi" }]
    });
    assert.equal(response.status, 200);
    assert.deepEqual(primary.models(), ["gpt-4o"]);
    assert.deepEqual(fallback.models(), ["claude-haiku"]);
  } finally {
    await primary.close();
    await fallback.close();
  }
});

test("RoutingBackend returns last response when fallback chain is exhausted", async () => {
  const primary = await startStatusMock({ "gpt-4o": 503 });
  const backend = new RoutingBackend({
    routes: parseScenarioRoutes({ default: "primary,gpt-4o" }, "test"),
    providers: [{ id: "primary", provider: "openai", baseUrl: `${primary.url}/v1`, keyEnv: "OPENAI_API_KEY" }],
    env: { OPENAI_API_KEY: "a" }
  });
  try {
    const response = await backend.chat({
      messages: [{ role: "user", content: "hi" }]
    });
    assert.equal(response.status, 503);
    assert.deepEqual(primary.models(), ["gpt-4o"]);
  } finally {
    await primary.close();
  }
});

test("RoutingBackend routes webSearch scenario to configured target", async () => {
  const mock = await startStatusMock({ "search-model": 200 });
  const decisions: string[] = [];
  const backend = new RoutingBackend({
    routes: parseScenarioRoutes(
      { default: "p,default-model", webSearch: "p,search-model" },
      "test"
    ),
    providers: [{ id: "p", provider: "openai", baseUrl: `${mock.url}/v1`, keyEnv: "OPENAI_API_KEY" }],
    env: { OPENAI_API_KEY: "a" },
    onDecision: (decision) => decisions.push(decision.scenario)
  });
  try {
    const response = await backend.chat({
      messages: [{ role: "user", content: "find docs" }],
      tools: [{ name: "web_search" }]
    });
    assert.equal(response.status, 200);
    assert.deepEqual(mock.models(), ["search-model"]);
    assert.deepEqual(decisions, ["webSearch"]);
  } finally {
    await mock.close();
  }
});

test("RoutingBackend chatAnthropic and preview helpers resolve scenarios", async () => {
  const mock = await startStatusMock({ "sonnet": 200 });
  const backend = new RoutingBackend({
    routes: parseScenarioRoutes({ default: "p,sonnet", reasoning: "p,sonnet" }, "test"),
    providers: [{ id: "p", provider: "openai", baseUrl: `${mock.url}/v1`, keyEnv: "OPENAI_API_KEY" }],
    env: { OPENAI_API_KEY: "a" },
    requestHeaders: { "x-ccr-agent-type": "background" }
  });
  const routes = parseScenarioRoutes({ default: "p,sonnet", background: "p,haiku" }, "test");
  const chatPreview = previewRoutingForChat(
    { messages: [{ role: "user", content: "bg" }] },
    routes,
    { "x-ccr-agent-type": "background" }
  );
  assert.equal(chatPreview.scenario, "background");

  const anthropicPreview = previewRoutingForAnthropic(
    {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "<background_task> sweep" }],
      max_tokens: 100
    },
    routes,
    { "x-ccr-agent-type": "background" }
  );
  assert.equal(anthropicPreview.scenario, "background");

  const reasoningPreview = previewRoutingForChat(
    { messages: [{ role: "user", content: "think" }], thinking: { budget_tokens: 5000 } },
    routes
  );
  assert.equal(reasoningPreview.scenario, "reasoning");

  try {
    const response = await backend.chatAnthropic({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100
    });
    assert.equal(response.status, 200);
    const modelsResponse = await backend.models();
    assert.equal(modelsResponse.status, 200);
    const embeddingsResponse = await backend.embeddings();
    assert.equal(embeddingsResponse.status, 501);
    assert.equal(backend.resolveModel(undefined), "sonnet");
  } finally {
    await mock.close();
  }
});

test("RoutingBackend throws when route target omits provider id", async () => {
  const backend = new RoutingBackend({
    routes: parseScenarioRoutes({ default: "bare-model-only" }, "test"),
    providers: [{ id: "p", provider: "openai", keyEnv: "OPENAI_API_KEY" }],
    env: { OPENAI_API_KEY: "a" }
  });
  await assert.rejects(
    () => backend.chat({ messages: [{ role: "user", content: "hi" }] }),
    RoutingProviderError
  );
});

test("RoutingBackend falls back when primary provider throws", async () => {
  const fallback = await startStatusMock({ "claude-haiku": 200 });
  const backend = new RoutingBackend({
    routes: parseScenarioRoutes(
      {
        default: "primary,gpt-4o",
        fallbacks: { default: ["fallback,claude-haiku"] }
      },
      "test"
    ),
    providers: [
      { id: "primary", provider: "openai", baseUrl: "http://127.0.0.1:1/v1", keyEnv: "OPENAI_API_KEY" },
      { id: "fallback", provider: "anthropic", baseUrl: `${fallback.url}/v1`, keyEnv: "ANTHROPIC_API_KEY" }
    ],
    env: { OPENAI_API_KEY: "a", ANTHROPIC_API_KEY: "b" }
  });
  try {
    const response = await backend.chat({
      messages: [{ role: "user", content: "hi" }]
    });
    assert.equal(response.status, 200);
    assert.deepEqual(fallback.models(), ["claude-haiku"]);
  } finally {
    await fallback.close();
  }
});

test("RoutingBackend honors session override provider id", async () => {
  const home = mkdtempSync(join(tmpdir(), "fusion-session-override-"));
  mkdirSync(join(home, ".fusionkit"), { recursive: true });
  writeFileSync(
    sessionOverridePath(home),
    JSON.stringify({ modelId: "claude-sub", setAt: "2026-06-22T00:00:00.000Z" }) + "\n"
  );
  const mock = await startStatusMock({ "claude-sonnet-4-5": 200 });
  const backend = new RoutingBackend({
    routes: parseScenarioRoutes(
      {
        default: "claude-sub,claude-sonnet-4-5",
        webSearch: "other,gpt-4o"
      },
      "test"
    ),
    providers: [
      { id: "claude-sub", provider: "anthropic", baseUrl: `${mock.url}/v1`, keyEnv: "ANTHROPIC_API_KEY" },
      { id: "other", provider: "openai", baseUrl: "http://127.0.0.1:1/v1", keyEnv: "OPENAI_API_KEY" }
    ],
    env: { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "b" },
    homeDir: home,
    onDecision: (decision) => {
      assert.equal(decision.reason, "session model override");
      assert.equal(decision.target.providerId, "claude-sub");
      assert.equal(decision.scenario, "default");
    }
  });
  try {
    const response = await backend.chat({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "web_search", parameters: {} } }]
    });
    assert.equal(response.status, 200);
    assert.deepEqual(mock.models(), ["claude-sonnet-4-5"]);
  } finally {
    await mock.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("RoutingBackend uses normal routing when session override modelId is null", async () => {
  const home = mkdtempSync(join(tmpdir(), "fusion-session-override-null-"));
  mkdirSync(join(home, ".fusionkit"), { recursive: true });
  writeFileSync(
    sessionOverridePath(home),
    JSON.stringify({ modelId: null, setAt: "2026-06-22T00:00:00.000Z" }) + "\n"
  );
  const mock = await startStatusMock({ "gpt-4o": 200 });
  const backend = new RoutingBackend({
    routes: parseScenarioRoutes({ default: "openai,gpt-4o" }, "test"),
    providers: [{ id: "openai", provider: "openai", baseUrl: `${mock.url}/v1`, keyEnv: "OPENAI_API_KEY" }],
    env: { OPENAI_API_KEY: "a" },
    homeDir: home,
    onDecision: (decision) => {
      assert.equal(decision.reason, "standard request");
    }
  });
  try {
    const response = await backend.chat({
      messages: [{ role: "user", content: "hi" }]
    });
    assert.equal(response.status, 200);
    assert.deepEqual(mock.models(), ["gpt-4o"]);
  } finally {
    await mock.close();
    rmSync(home, { recursive: true, force: true });
  }
});
