import assert from "node:assert/strict";
import { test } from "node:test";

import { listOpenAiCompatibleModels, probeOpenAiCompatibleModels } from "../fusion/openai-models.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("listOpenAiCompatibleModels lists via the SDK against a custom base URL", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const models = await listOpenAiCompatibleModels({
    baseUrl: "http://127.0.0.1:8317",
    apiKey: "fk-test",
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return jsonResponse({ object: "list", data: [{ id: "a", object: "model" }, { id: "b", object: "model" }] });
    }
  });
  assert.deepEqual(seen, [{ url: "http://127.0.0.1:8317/v1/models", auth: "Bearer fk-test" }]);
  assert.deepEqual(models.map((model) => model.id), ["a", "b"]);
});

test("probeOpenAiCompatibleModels maps SDK errors onto health outcomes", async () => {
  const probeWith = (status: number): ReturnType<typeof probeOpenAiCompatibleModels> =>
    probeOpenAiCompatibleModels({
      baseUrl: "http://127.0.0.1:8317",
      apiKey: "fk-test",
      fetchImpl: async () => jsonResponse({ error: { message: "nope" } }, status)
    });

  assert.deepEqual((await probeWith(401)).kind, "unauthorized");
  assert.deepEqual((await probeWith(403)).kind, "unauthorized");
  assert.deepEqual((await probeWith(500)).kind, "http-error");

  const ok = await probeOpenAiCompatibleModels({
    baseUrl: "http://127.0.0.1:8317",
    apiKey: "fk-test",
    fetchImpl: async () => jsonResponse({ object: "list", data: [{ id: "a", object: "model" }] })
  });
  assert.equal(ok.kind, "ok");
  assert.equal(ok.kind === "ok" ? ok.models.length : 0, 1);

  const down = await probeOpenAiCompatibleModels({
    baseUrl: "http://127.0.0.1:8317",
    apiKey: "fk-test",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    }
  });
  assert.equal(down.kind, "unreachable");
});
