import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  SubscriptionAccountBackend,
  SubscriptionAccountSet,
  subscriptionProvider
} from "../index.js";

test("Claude account backend serves OpenAI chat with managed auth and normalized usage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-account-backend-"));
  writeFileSync(
    join(directory, "primary.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "claude-oauth",
        refreshToken: "refresh",
        expiresAt: Date.now() + 3_600_000
      }
    })
  );
  const accounts = await SubscriptionAccountSet.open(
    subscriptionProvider("claude-code"),
    { mode: "claude-code", source: { kind: "directory", path: directory } }
  );
  const backend = new SubscriptionAccountBackend({
    accountSet: accounts,
    model: "claude-sonnet-4-5"
  });
  const originalFetch = globalThis.fetch;
  let seenHeaders: Headers | undefined;
  let seenBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_url, init) => {
    seenHeaders = new Headers(init?.headers);
    seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      content: [{ type: "text", text: "POOLED" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 2 }
    });
  };
  try {
    const response = await backend.chat({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hello" }]
    });
    const payload = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: Record<string, number>;
    };
    assert.equal(seenHeaders?.get("authorization"), "Bearer claude-oauth");
    assert.equal(seenHeaders?.has("x-api-key"), false);
    assert.match(
      JSON.stringify(seenBody?.system),
      /official CLI for Claude/
    );
    assert.equal(payload.choices[0]?.message.content, "POOLED");
    assert.deepEqual(
      {
        prompt_tokens: payload.usage.prompt_tokens,
        completion_tokens: payload.usage.completion_tokens,
        total_tokens: payload.usage.total_tokens
      },
      { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
    );
  } finally {
    globalThis.fetch = originalFetch;
    await accounts.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Codex account backend translates OpenAI chat through the managed Responses account", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-account-backend-"));
  writeFileSync(
    join(directory, "primary.json"),
    JSON.stringify({
      tokens: {
        access_token: "eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.",
        refresh_token: "refresh",
        account_id: "acct-primary"
      }
    })
  );
  const accounts = await SubscriptionAccountSet.open(subscriptionProvider("codex"), {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  const backend = new SubscriptionAccountBackend({
    accountSet: accounts,
    model: "gpt-5.5"
  });
  const originalFetch = globalThis.fetch;
  let seenHeaders: Headers | undefined;
  globalThis.fetch = async (_url, init) => {
    seenHeaders = new Headers(init?.headers);
    return Response.json({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "CODEX_POOLED" }]
        }
      ],
      usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 }
    });
  };
  try {
    const response = await backend.chat({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }]
    });
    const payload = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: Record<string, number>;
    };
    assert.equal(
      seenHeaders?.get("authorization"),
      "Bearer eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9."
    );
    assert.equal(seenHeaders?.get("chatgpt-account-id"), "acct-primary");
    assert.equal(payload.choices[0]?.message.content, "CODEX_POOLED");
    assert.equal(payload.usage.prompt_tokens, 4);
    assert.equal(payload.usage.completion_tokens, 3);
  } finally {
    globalThis.fetch = originalFetch;
    await accounts.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
