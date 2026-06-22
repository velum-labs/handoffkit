import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";

import {
  classifyProviderError,
  parseRoutingProviderSpec,
  requireProvider,
  resolveProviderBaseUrl,
  resolveRoutingProviders,
  RoutingBackend,
  RoutingProviderError,
  sanitizeDeepSeekRequest,
  sanitizeGroqRequest,
  parseScenarioRoutes
} from "../routing/index.js";

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

type MockCapture = {
  url: string;
  paths: () => string[];
  bodies: () => Record<string, unknown>[];
  close: () => Promise<void>;
};

async function startProviderMock(expectedPath: string): Promise<MockCapture> {
  const paths: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      paths.push(url.pathname);
      if (req.method === "POST" && url.pathname === expectedPath) {
        bodies.push(JSON.parse((await readAll(req)).toString("utf8")) as Record<string, unknown>);
        sendJson(res, 200, {
          id: "chatcmpl-mock",
          object: "chat.completion",
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
    paths: () => [...paths],
    bodies: () => [...bodies],
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  };
}

const PHASE2_PROVIDERS = [
  {
    kind: "openrouter" as const,
    keyEnv: "OPENROUTER_API_KEY",
    baseUrlSuffix: "/v1",
    chatPath: "/v1/chat/completions",
    model: "anthropic/claude-sonnet-4.6"
  },
  {
    kind: "deepseek" as const,
    keyEnv: "DEEPSEEK_API_KEY",
    baseUrlSuffix: "",
    chatPath: "/chat/completions",
    model: "deepseek-v4-flash"
  },
  {
    kind: "groq" as const,
    keyEnv: "GROQ_API_KEY",
    baseUrlSuffix: "/v1",
    chatPath: "/v1/chat/completions",
    model: "llama-3.3-70b-versatile"
  },
  {
    kind: "google-gemini" as const,
    keyEnv: "GEMINI_API_KEY",
    baseUrlSuffix: "/v1beta/openai",
    chatPath: "/v1beta/openai/chat/completions",
    model: "gemini-2.5-pro"
  }
];

for (const provider of PHASE2_PROVIDERS) {
  test(`parseRoutingProviderSpec accepts ${provider.kind} with default keyEnv`, () => {
    const spec = parseRoutingProviderSpec({ id: provider.kind, provider: provider.kind }, 0);
    assert.equal(spec.provider, provider.kind);
    assert.equal(spec.keyEnv, provider.keyEnv);
  });

  test(`RoutingBackend routes ${provider.kind} to ${provider.chatPath}`, async () => {
    const mock = await startProviderMock(provider.chatPath);
    const backend = new RoutingBackend({
      routes: parseScenarioRoutes({ default: `${provider.kind},${provider.model}` }, "test"),
      providers: [
        {
          id: provider.kind,
          provider: provider.kind,
          baseUrl: `${mock.url}${provider.baseUrlSuffix}`,
          keyEnv: provider.keyEnv
        }
      ],
      env: { [provider.keyEnv]: "test-key" }
    });
    try {
      const response = await backend.chat({
        messages: [{ role: "user", content: "hi" }]
      });
      assert.equal(response.status, 200);
      assert.ok(mock.paths().includes(provider.chatPath), mock.paths().join(","));
      assert.equal(mock.bodies()[0]?.model, provider.model);
    } finally {
      await mock.close();
    }
  });
}

test("parseRoutingProviderSpec rejects unknown provider kind", () => {
  assert.throws(
    () => parseRoutingProviderSpec({ id: "x", provider: "unknown-vendor" }, 0),
    RoutingProviderError
  );
});

test("resolveProviderBaseUrl keeps DeepSeek host root without /v1", () => {
  const spec = parseRoutingProviderSpec({ id: "ds", provider: "deepseek" }, 0);
  assert.equal(resolveProviderBaseUrl(spec), "https://api.deepseek.com");
});

test("resolveProviderBaseUrl normalizes google-gemini OpenAI prefix", () => {
  const spec = parseRoutingProviderSpec({ id: "g", provider: "google-gemini" }, 0);
  assert.equal(
    resolveProviderBaseUrl(spec),
    "https://generativelanguage.googleapis.com/v1beta/openai"
  );
});

test("resolveProviderBaseUrl uses defaults for openrouter and groq", () => {
  const openrouter = parseRoutingProviderSpec({ id: "or", provider: "openrouter" }, 0);
  assert.equal(resolveProviderBaseUrl(openrouter), "https://openrouter.ai/api/v1");

  const groq = parseRoutingProviderSpec({ id: "gq", provider: "groq" }, 0);
  assert.equal(resolveProviderBaseUrl(groq), "https://api.groq.com/openai/v1");
});

test("parseRoutingProviderSpec validates baseUrl and keyEnv", () => {
  assert.throws(
    () => parseRoutingProviderSpec({ id: "x", provider: "groq", baseUrl: "" }, 0),
    RoutingProviderError
  );
  assert.throws(
    () => parseRoutingProviderSpec({ id: "x", provider: "groq", keyEnv: "" }, 0),
    RoutingProviderError
  );
  assert.throws(() => parseRoutingProviderSpec("not-object", 0), RoutingProviderError);
});

test("classifyProviderError maps HTTP statuses per fallback design", () => {
  assert.equal(classifyProviderError(429), "fallback");
  assert.equal(classifyProviderError(402), "fallback");
  assert.equal(classifyProviderError(498), "fallback");
  assert.equal(classifyProviderError(401), "fatal");
  assert.equal(classifyProviderError(403), "fatal");
  assert.equal(classifyProviderError(503), "retry");
  assert.equal(classifyProviderError(400), "fatal");
  assert.equal(classifyProviderError(404), "fatal");
  assert.equal(
    classifyProviderError(413, { error: { message: "context length exceeded" } }),
    "fallback"
  );
});

test("sanitizeGroqRequest strips forbidden OpenAI fields", () => {
  const sanitized = sanitizeGroqRequest({
    model: "llama-3.3-70b-versatile",
    logprobs: true,
    logit_bias: { a: 1 },
    top_logprobs: 5,
    n: 3,
    messages: [{ role: "user", name: "alice", content: "hi" }]
  });
  assert.equal(sanitized.logprobs, undefined);
  assert.equal(sanitized.logit_bias, undefined);
  assert.equal(sanitized.top_logprobs, undefined);
  assert.equal(sanitized.n, 1);
  const messages = sanitized.messages as Array<Record<string, unknown>>;
  assert.equal(messages[0]?.name, undefined);
});

test("sanitizeDeepSeekRequest disables thinking by default", () => {
  const sanitized = sanitizeDeepSeekRequest({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "hi" }]
  });
  const extra = sanitized.extra_body as Record<string, unknown>;
  const thinking = extra.thinking as Record<string, unknown>;
  assert.equal(thinking.type, "disabled");
});

test("RoutingBackend applies Groq shim on outbound chat body", async () => {
  const mock = await startProviderMock("/v1/chat/completions");
  const backend = new RoutingBackend({
    routes: parseScenarioRoutes({ default: "groq,llama-3.3-70b-versatile" }, "test"),
    providers: [
      {
        id: "groq",
        provider: "groq",
        baseUrl: `${mock.url}/v1`,
        keyEnv: "GROQ_API_KEY"
      }
    ],
    env: { GROQ_API_KEY: "test-key" }
  });
  try {
    await backend.chat({
      model: "llama-3.3-70b-versatile",
      logprobs: true,
      messages: [{ role: "user", name: "bob", content: "hi" }]
    });
    const body = mock.bodies()[0];
    assert.equal(body?.logprobs, undefined);
    const messages = (body?.messages ?? []) as Array<Record<string, unknown>>;
    assert.equal(messages[0]?.name, undefined);
  } finally {
    await mock.close();
  }
});

test("RoutingBackend applies DeepSeek thinking shim on outbound chat body", async () => {
  const mock = await startProviderMock("/chat/completions");
  const backend = new RoutingBackend({
    routes: parseScenarioRoutes({ default: "deepseek,deepseek-v4-flash" }, "test"),
    providers: [
      {
        id: "deepseek",
        provider: "deepseek",
        baseUrl: mock.url,
        keyEnv: "DEEPSEEK_API_KEY"
      }
    ],
    env: { DEEPSEEK_API_KEY: "test-key" }
  });
  try {
    await backend.chat({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }]
    });
    const extra = mock.bodies()[0]?.extra_body as Record<string, unknown>;
    const thinking = extra.thinking as Record<string, unknown>;
    assert.equal(thinking.type, "disabled");
  } finally {
    await mock.close();
  }
});

test("requireProvider throws for unknown provider id", () => {
  const providers = resolveRoutingProviders(
    [parseRoutingProviderSpec({ id: "or", provider: "openrouter" }, 0)],
    { OPENROUTER_API_KEY: "test" }
  );
  const resolved = requireProvider(providers, "or");
  assert.equal(resolved.id, "or");
  assert.throws(() => requireProvider(providers, "missing"), RoutingProviderError);
});

test("resolveRoutingProviders rejects duplicate provider ids", () => {
  assert.throws(
    () =>
      resolveRoutingProviders(
        [
          { id: "p1", provider: "openrouter", keyEnv: "OPENROUTER_API_KEY" },
          { id: "p1", provider: "groq", keyEnv: "GROQ_API_KEY" }
        ],
        { OPENROUTER_API_KEY: "a", GROQ_API_KEY: "b" }
      ),
    RoutingProviderError
  );
});

test("resolveRoutingProviders rejects missing API keys for keyed providers", () => {
  assert.throws(
    () =>
      resolveRoutingProviders(
        [parseRoutingProviderSpec({ id: "or", provider: "openrouter" }, 0)],
        {}
      ),
    RoutingProviderError
  );
});
