import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseRouterConfig } from "@velum-labs/routekit-gateway";
import type {
  ApiProviderId,
  BackendRequestOptions,
  ProviderSource
} from "@velum-labs/routekit-gateway";

import { startRouter } from "../index.js";

type PaidProviderCall = {
  provider: ApiProviderId;
  operation: "chat" | "embeddings";
};

function recordingPaidSource(
  provider: ApiProviderId,
  calls: PaidProviderCall[]
): ProviderSource {
  return {
    sourceId: provider,
    async discoverModels() {
      return [{ id: "gpt-subscription" }];
    },
    async chat(
      _body: unknown,
      _signal?: AbortSignal,
      _options?: BackendRequestOptions
    ) {
      calls.push({ provider, operation: "chat" });
      return Response.json({ provider });
    },
    async embeddings() {
      calls.push({ provider, operation: "embeddings" });
      return Response.json({ provider });
    }
  };
}

test("subscription exhaustion never calls a configured paid API provider", async () => {
  const routekitHome = mkdtempSync(
    join(tmpdir(), "routekit-no-paid-fallback-")
  );
  const accountDirectory = join(routekitHome, "subscriptions", "codex");
  mkdirSync(accountDirectory, { recursive: true });
  writeFileSync(
    join(accountDirectory, "exhausted.json"),
    JSON.stringify({
      tokens: {
        access_token: "eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.",
        account_id: "acct-exhausted"
      }
    }),
    { mode: 0o600 }
  );

  const originalFetch = globalThis.fetch;
  const paidCalls: PaidProviderCall[] = [];
  let subscriptionCalls = 0;
  const resetAt = Math.floor(Date.now() / 1000) + 1_800;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith("https://chatgpt.com/backend-api/codex/")) {
      throw new Error(`unexpected external request: ${url}`);
    }
    if (new URL(url).pathname.endsWith("/models")) {
      return Response.json({ models: [{ slug: "gpt-subscription" }] });
    }
    subscriptionCalls += 1;
    return Response.json(
      {
        error: {
          type: "usage_limit_reached",
          message: "subscription usage limit reached",
          resets_at: resetAt
        }
      },
      {
        status: 429,
        headers: {
          "retry-after": "1800"
        }
      }
    );
  };

  const paidProviders = [
    "openai",
    "anthropic",
    "openrouter"
  ] as const satisfies readonly ApiProviderId[];
  const sources = Object.fromEntries(
    paidProviders.map((provider) => [
      provider,
      recordingPaidSource(provider, paidCalls)
    ])
  );
  let router: Awaited<ReturnType<typeof startRouter>> | undefined;

  try {
    router = await startRouter({
      config: parseRouterConfig({
        providers: {
          codex: {},
          openai: {},
          anthropic: {},
          openrouter: {}
        },
        defaultModel: "codex/gpt-subscription"
      }),
      host: "127.0.0.1",
      port: 0,
      env: { ROUTEKIT_HOME: routekitHome },
      sources
    });

    const modelsResponse = await originalFetch(`${router.url}/v1/models`);
    assert.equal(modelsResponse.status, 200);
    const modelsPayload = (await modelsResponse.json()) as {
      data: Array<{ id: string }>;
    };
    const modelIds = new Set(modelsPayload.data.map((model) => model.id));
    assert.ok(modelIds.has("codex/gpt-subscription"));
    for (const provider of paidProviders) {
      assert.ok(
        modelIds.has(`${provider}/gpt-subscription`),
        `${provider} paid route must be configured`
      );
    }

    const response = await originalFetch(
      `${router.url}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "codex/gpt-subscription",
          messages: [{ role: "user", content: "prove fail-closed routing" }]
        })
      }
    );
    const payload = (await response.json()) as {
      error: { type: string; resets_at?: number };
    };

    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get("retry-after")) > 0);
    assert.equal(payload.error.type, "rate_limit_error");
    assert.equal(payload.error.resets_at, resetAt);
    assert.equal(subscriptionCalls, 1);
    assert.deepEqual(paidCalls, []);
  } finally {
    globalThis.fetch = originalFetch;
    try {
      await router?.close();
    } finally {
      rmSync(routekitHome, { recursive: true, force: true });
    }
  }
});
