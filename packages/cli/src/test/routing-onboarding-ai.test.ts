import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RoutingAiProposalError,
  buildRoutingPrompt,
  extractJsonObject,
  parseAiRoutingResponse,
  proposeAiRouting
} from "../fusion/routing-onboarding-ai.js";
import { ROUTING_API_KEY_ENVS } from "../fusion/routing-onboarding.js";
import type { RoutingOnboardingDetection } from "../fusion/routing-onboarding.js";

const VALID_AI_JSON = {
  routes: {
    default: "claude-sub,claude-sonnet-4-5",
    background: "groq,llama-3.1-8b-instant",
    longContext: "gemini,gemini-2.5-pro",
    longContextThreshold: 60_000,
    reasoning: "deepseek,deepseek-v4-pro",
    webSearch: "openrouter,anthropic/claude-sonnet-4.6"
  },
  providers: [
    { id: "claude-sub", provider: "anthropic" },
    { id: "groq", provider: "groq", keyEnv: "GROQ_API_KEY" },
    { id: "gemini", provider: "google-gemini", keyEnv: "GEMINI_API_KEY" },
    { id: "deepseek", provider: "deepseek", keyEnv: "DEEPSEEK_API_KEY" },
    { id: "openrouter", provider: "openrouter", keyEnv: "OPENROUTER_API_KEY" }
  ]
};

function emptyDetection(): RoutingOnboardingDetection {
  return {
    subscriptions: {
      "claude-code": { mode: "claude-code", available: true, expired: false },
      codex: { mode: "codex", available: false, expired: false }
    },
    apiKeys: Object.fromEntries(ROUTING_API_KEY_ENVS.map((key) => [key, false])) as RoutingOnboardingDetection["apiKeys"]
  };
}

test("buildRoutingPrompt includes subscriptions, keys, and scenarios", () => {
  const prompt = buildRoutingPrompt(
    emptyDetection()
  );
  assert.match(prompt, /claude-code: available/);
  assert.match(prompt, /ANTHROPIC_API_KEY:/);
  assert.match(prompt, /default:/);
  assert.match(prompt, /anthropic/);
});

test("extractJsonObject parses fenced JSON", () => {
  const raw = extractJsonObject(`Here you go:\n\`\`\`json\n${JSON.stringify(VALID_AI_JSON)}\n\`\`\``);
  assert.deepEqual(raw, VALID_AI_JSON);
});

test("extractJsonObject rejects non-JSON", () => {
  assert.throws(() => extractJsonObject("no json here"), RoutingAiProposalError);
});

test("parseAiRoutingResponse validates model output", () => {
  const config = parseAiRoutingResponse(JSON.stringify(VALID_AI_JSON));
  assert.equal(config.routes.default, "claude-sub,claude-sonnet-4-5");
  assert.equal(config.providers.length, 5);
});

test("proposeAiRouting returns AI config on first valid response", async () => {
  let calls = 0;
  const result = await proposeAiRouting(emptyDetection(), {
    generate: async () => {
      calls++;
      return JSON.stringify(VALID_AI_JSON);
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.source, "ai");
  assert.equal(result.config.routes.default, "claude-sub,claude-sonnet-4-5");
});

test("proposeAiRouting retries once then falls back to deterministic", async () => {
  let calls = 0;
  const result = await proposeAiRouting(
    {
      ...emptyDetection(),
      apiKeys: { ...emptyDetection().apiKeys, ANTHROPIC_API_KEY: true }
    },
    {
      generate: async (prompt) => {
        calls++;
        if (calls === 1) return "not json";
        assert.match(prompt, /Your previous JSON was invalid/);
        return "still not json";
      }
    }
  );
  assert.equal(calls, 2);
  assert.equal(result.source, "deterministic");
  assert.equal(result.config.routes.default, "claude-sub,claude-sonnet-4-5");
});

test("proposeAiRouting succeeds on second attempt after invalid JSON", async () => {
  let calls = 0;
  const result = await proposeAiRouting(emptyDetection(), {
    generate: async () => {
      calls++;
      return calls === 1 ? "{ invalid" : JSON.stringify(VALID_AI_JSON);
    }
  });
  assert.equal(calls, 2);
  assert.equal(result.source, "ai");
});
