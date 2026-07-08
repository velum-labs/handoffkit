import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { test } from "node:test";

import { CodexBackendRelay, codexRelayAuth, startGateway } from "../index.js";
import type { Backend, CodexCatalogEntry, Gateway } from "../index.js";

/**
 * Regression (ENG-620): a Codex client pointed at the gateway keeps its own
 * stock models. The relay merges the client's live stock catalog into
 * `GET /v1/models` and forwards stock-model Responses requests verbatim to the
 * Codex backend using the auth material the client itself attached.
 */

const CHATGPT_HEADERS = {
  authorization: "Bearer chatgpt-token-redacted",
  "chatgpt-account-id": "acct_123",
  originator: "codex_cli_rs",
  "openai-beta": "responses=v1"
};

const STOCK = [
  { slug: "gpt-5.5", display_name: "GPT-5.5", description: "Flagship", visibility: "list", priority: 0 },
  { slug: "gpt-5.3-codex", display_name: "gpt-5.3-codex", description: "Coding", visibility: "list", priority: 1 }
];

const FALLBACK_STOCK = [
  { slug: "gpt-5.5-cached", display_name: "GPT-5.5 (cached)", description: "Snapshot", visibility: "list", priority: 0 }
];

type MockBackend = {
  url: string;
  modelsRequests: Array<{ headers: Record<string, string | string[] | undefined>; search: string }>;
  responsesRequests: Array<{ headers: Record<string, string | string[] | undefined>; body: unknown }>;
  failModels: boolean;
  close: () => Promise<void>;
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

/** A stand-in for the ChatGPT Codex backend (`/models` + streaming `/responses`). */
async function startMockCodexBackend(): Promise<MockBackend> {
  const state: MockBackend = {
    url: "",
    modelsRequests: [],
    responsesRequests: [],
    failModels: false,
    close: async () => {}
  };
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/models") {
        state.modelsRequests.push({ headers: req.headers, search: url.search });
        if (state.failModels) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unavailable" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json", etag: 'W/"models-v1"' });
        res.end(JSON.stringify({ models: STOCK }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/responses") {
        state.responsesRequests.push({ headers: req.headers, body: JSON.parse(await readBody(req)) });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('event: response.output_text.delta\ndata: {"delta":"STOCK_OK"}\n\n');
        res.write('event: response.completed\ndata: {"response":{"id":"resp_relay"}}\n\n');
        res.end();
        return;
      }
      res.writeHead(404).end();
    })().catch((error: unknown) => res.writeHead(500).end(String(error)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);
  state.url = `http://127.0.0.1:${address.port}`;
  state.close = () => closeServer(server);
  return state;
}

/** The merged-catalog builder a host would wire in (fusion entry first). */
function catalog(template: CodexCatalogEntry, stock: readonly CodexCatalogEntry[]): CodexCatalogEntry[] {
  const fusion = { ...template, slug: "fusion-panel", display_name: "fusion-panel (fusion)", priority: 0 };
  const rest = stock.filter((entry) => entry.slug !== "fusion-panel");
  return [fusion, ...rest];
}

/** A minimal backend that serves exactly one fused model + one native id. */
function fakeBackend(): Backend & { chatModels: string[] } {
  const chatModels: string[] = [];
  return {
    chatModels,
    defaultModel: "fusion-panel",
    listModelIds: () => ["fusion-panel", "gpt-native"],
    resolveModel: (requested) => (requested === "gpt-native" ? "gpt-native" : "fusion-panel"),
    servesModel: (model) => model === "fusion-panel" || model === "gpt-native",
    chat(body) {
      const model = (body as { model?: string }).model ?? "fusion-panel";
      chatModels.push(model);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "chatcmpl_local",
            object: "chat.completion",
            created: 0,
            model,
            choices: [{ index: 0, message: { role: "assistant", content: "LOCAL_OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    },
    models: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              { id: "fusion-panel", object: "model" },
              { id: "gpt-native", object: "model" }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      ),
    embeddings: () => Promise.resolve(new Response("{}", { status: 501 }))
  };
}

async function startRelayGateway(
  backendUrl: string,
  authToken?: string
): Promise<{ gateway: Gateway; backend: Backend & { chatModels: string[] } }> {
  const backend = fakeBackend();
  const gateway = await startGateway({
    backend,
    ...(authToken !== undefined ? { authToken } : {}),
    codexRelay: new CodexBackendRelay({
      backendUrl,
      catalog,
      fallbackStock: () => FALLBACK_STOCK,
      logger: { warn: () => {}, error: () => {} }
    })
  });
  return { gateway, backend };
}

test("codexRelayAuth only accepts the ChatGPT bearer + account-id pair", () => {
  assert.ok(codexRelayAuth(CHATGPT_HEADERS));
  assert.equal(codexRelayAuth({ authorization: "Bearer sk-api-key" }), undefined);
  assert.equal(codexRelayAuth({ "chatgpt-account-id": "acct_123" }), undefined);
  assert.equal(codexRelayAuth({ authorization: "Basic abc", "chatgpt-account-id": "acct_123" }), undefined);
  assert.equal(codexRelayAuth({}), undefined);
});

test("GET /v1/models with ChatGPT auth merges the LIVE stock catalog behind the fusion entries", async () => {
  const upstream = await startMockCodexBackend();
  const { gateway } = await startRelayGateway(upstream.url);
  try {
    const response = await fetch(`${gateway.url()}/v1/models?client_version=0.142.5`, {
      headers: CHATGPT_HEADERS
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("etag"), 'W/"models-v1"', "upstream ETag forwarded");
    const body = (await response.json()) as {
      data: Array<{ id: string }>;
      models: Array<Record<string, unknown>>;
    };
    // Codex's ModelInfo catalog: fusion first, then the live stock list.
    assert.deepEqual(
      body.models.map((entry) => entry.slug),
      ["fusion-panel", "gpt-5.5", "gpt-5.3-codex"]
    );
    // OpenAI-shape clients still see `data`, extended with the stock slugs.
    assert.deepEqual(
      body.data.map((entry) => entry.id),
      ["fusion-panel", "gpt-native", "gpt-5.5", "gpt-5.3-codex"]
    );
    // The upstream fetch carried the client's own auth + originator headers.
    const seen = upstream.modelsRequests[0];
    assert.ok(seen);
    assert.equal(seen.headers.authorization, CHATGPT_HEADERS.authorization);
    assert.equal(seen.headers["chatgpt-account-id"], CHATGPT_HEADERS["chatgpt-account-id"]);
    assert.equal(seen.headers.originator, "codex_cli_rs");
    assert.equal(seen.search, "?client_version=0.142.5", "query forwarded verbatim");
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test("GET /v1/models falls back to the stock snapshot without auth or when upstream fails", async () => {
  const upstream = await startMockCodexBackend();
  const { gateway } = await startRelayGateway(upstream.url);
  try {
    // No relayable auth: no upstream call, snapshot merge instead.
    const anonymous = (await (await fetch(`${gateway.url()}/v1/models`)).json()) as {
      models: Array<Record<string, unknown>>;
    };
    assert.deepEqual(
      anonymous.models.map((entry) => entry.slug),
      ["fusion-panel", "gpt-5.5-cached"]
    );
    assert.equal(upstream.modelsRequests.length, 0);
    // Upstream down: authenticated fetch degrades to the same snapshot merge.
    upstream.failModels = true;
    const degraded = (await (
      await fetch(`${gateway.url()}/v1/models`, { headers: CHATGPT_HEADERS })
    ).json()) as { models: Array<Record<string, unknown>> };
    assert.deepEqual(
      degraded.models.map((entry) => entry.slug),
      ["fusion-panel", "gpt-5.5-cached"]
    );
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test("POST /v1/responses relays a stock-model pick verbatim under the client's own auth", async () => {
  const upstream = await startMockCodexBackend();
  const { gateway, backend } = await startRelayGateway(upstream.url);
  try {
    const response = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { ...CHATGPT_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.3-codex", input: "hello", stream: true, store: false })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await response.text();
    assert.match(text, /STOCK_OK/);
    assert.match(text, /response\.completed/);
    // The upstream saw the exact body and the client's own auth headers.
    const seen = upstream.responsesRequests[0];
    assert.ok(seen);
    assert.equal(seen.headers.authorization, CHATGPT_HEADERS.authorization);
    assert.equal(seen.headers["chatgpt-account-id"], CHATGPT_HEADERS["chatgpt-account-id"]);
    assert.deepEqual(seen.body, { model: "gpt-5.3-codex", input: "hello", stream: true, store: false });
    // Nothing leaked into the local backend: no fusion run for a stock pick.
    assert.deepEqual(backend.chatModels, []);
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test("POST /v1/responses keeps locally served models local and unknown models local without auth", async () => {
  const upstream = await startMockCodexBackend();
  const { gateway, backend } = await startRelayGateway(upstream.url);
  try {
    // A gateway-served model with ChatGPT auth attached: handled locally.
    const local = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { ...CHATGPT_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-native", input: "hello", stream: false })
    });
    assert.equal(local.status, 200);
    assert.match(await local.text(), /LOCAL_OK/);
    // An unknown model WITHOUT relayable auth: historical fold-to-default.
    const anonymous = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.3-codex", input: "hello", stream: false })
    });
    assert.equal(anonymous.status, 200);
    assert.match(await anonymous.text(), /LOCAL_OK/);
    assert.equal(upstream.responsesRequests.length, 0, "nothing was relayed");
    assert.deepEqual(backend.chatModels, ["gpt-native", "fusion-panel"]);
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test("a gateway auth token disables the relay entirely", async () => {
  const upstream = await startMockCodexBackend();
  const { gateway } = await startRelayGateway(upstream.url, "gateway-token");
  try {
    const models = (await (
      await fetch(`${gateway.url()}/v1/models`, { headers: { authorization: "Bearer gateway-token" } })
    ).json()) as { data: Array<{ id: string }>; models?: unknown };
    assert.equal(models.models, undefined, "no merged catalog under gateway auth");
    assert.deepEqual(
      models.data.map((entry) => entry.id),
      ["fusion-panel", "gpt-native"]
    );
    assert.equal(upstream.modelsRequests.length, 0);
  } finally {
    await gateway.close();
    await upstream.close();
  }
});
