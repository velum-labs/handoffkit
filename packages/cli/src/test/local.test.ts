import assert from "node:assert/strict";
import { test } from "node:test";

import {
  claudeEnv,
  codexConfigToml,
  cursorInstructions,
  opencodeConfig,
  opencodeModelArg,
  runDirect
} from "../local.js";

/**
 * Coverage for the pure shim builders used by `fusionkit <tool> --direct`. The
 * spawn/exec path needs the real vendor binaries and is exercised manually.
 */

test("claudeEnv points Claude Code at the gateway's Anthropic surface", () => {
  const env = claudeEnv("http://127.0.0.1:9000", "tok");
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9000");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "tok");
  assert.equal(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
});

test("claudeEnv falls back to a placeholder auth token", () => {
  const env = claudeEnv("http://127.0.0.1:9000");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "fusionkit-local");
});

test("codexConfigToml declares a Responses provider at the gateway", () => {
  const toml = codexConfigToml("http://127.0.0.1:9000", "local-model");
  assert.ok(toml.includes('model = "local-model"'));
  assert.ok(toml.includes("[model_providers.fusionkit-local]"));
  assert.ok(toml.includes('base_url = "http://127.0.0.1:9000/v1"'));
  assert.ok(toml.includes('wire_api = "responses"'));
  assert.ok(toml.includes("requires_openai_auth = false"));
});

test("opencodeConfig registers an OpenAI-compatible provider", () => {
  const config = opencodeConfig("http://127.0.0.1:9000", "local-model") as {
    provider: Record<string, { npm: string; options: { baseURL: string }; models: Record<string, unknown> }>;
  };
  const provider = config.provider["fusionkit-local"];
  assert.equal(provider?.npm, "@ai-sdk/openai-compatible");
  assert.equal(provider?.options.baseURL, "http://127.0.0.1:9000/v1");
  assert.ok("local-model" in (provider?.models ?? {}));
  assert.equal(opencodeModelArg("local-model"), "fusionkit-local/local-model");
});

test("cursorInstructions surfaces the public URL and plan-mode caveat", () => {
  const text = cursorInstructions("https://abc.example", "local-model");
  assert.ok(text.includes("https://abc.example/v1/cursor"));
  assert.ok(text.includes("local-model"));
  assert.ok(text.toLowerCase().includes("plan"));
  // No token configured: any placeholder key works.
  assert.ok(text.includes("any non-empty value"));
});

test("cursorInstructions prints the gateway bearer token as the API key when set", () => {
  const text = cursorInstructions("https://abc.example", "fusion-panel", [], "fk_secret123");
  assert.ok(text.includes("OpenAI API Key           : fk_secret123"));
  assert.ok(!text.includes("any non-empty value"));
});

test("direct serve handles SIGINT through finally and closes the gateway", async () => {
  const listenersBefore = new Set(process.listeners("SIGINT"));
  let closeCalls = 0;
  const pending = runDirect("serve", [], {
    config: {
      kind: "openai",
      baseUrl: "http://127.0.0.1:1/v1",
      defaultModel: "local-test"
    },
    startGateway: async () => ({
      url: "http://127.0.0.1:12345",
      close: async () => {
        closeCalls += 1;
      }
    }),
    log: () => undefined
  });

  let interrupt: ((...args: never[]) => unknown) | undefined;
  const deadline = Date.now() + 1_000;
  while (interrupt === undefined && Date.now() < deadline) {
    interrupt = process
      .listeners("SIGINT")
      .find((listener) => !listenersBefore.has(listener)) as
      | ((...args: never[]) => unknown)
      | undefined;
    if (interrupt === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(interrupt !== undefined, "runDirect must install a SIGINT cleanup handler");
  interrupt();

  assert.equal(await pending, 130);
  assert.equal(closeCalls, 1);
});
