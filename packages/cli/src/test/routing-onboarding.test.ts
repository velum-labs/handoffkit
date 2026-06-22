import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ROUTING_API_KEY_ENVS,
  RoutingOnboardingError,
  detectRoutingContext,
  formatRoutingSection,
  proposeDeterministicRouting,
  validateRoutingProposal
} from "../fusion/routing-onboarding.js";
import type { RoutingOnboardingDetection } from "../fusion/routing-onboarding.js";

function detection(overrides: Partial<RoutingOnboardingDetection> = {}): RoutingOnboardingDetection {
  const base: RoutingOnboardingDetection = {
    subscriptions: {
      "claude-code": { mode: "claude-code", available: false, expired: false },
      codex: { mode: "codex", available: false, expired: false }
    },
    apiKeys: Object.fromEntries(ROUTING_API_KEY_ENVS.map((key) => [key, false])) as RoutingOnboardingDetection["apiKeys"]
  };
  return {
    ...base,
    ...overrides,
    subscriptions: { ...base.subscriptions, ...overrides.subscriptions },
    apiKeys: { ...base.apiKeys, ...overrides.apiKeys }
  };
}

test("detectRoutingContext reports API key presence without values", () => {
  const ctx = detectRoutingContext({
    ANTHROPIC_API_KEY: "secret",
    OPENAI_API_KEY: "",
    GROQ_API_KEY: undefined
  });
  assert.equal(ctx.apiKeys.ANTHROPIC_API_KEY, true);
  assert.equal(ctx.apiKeys.OPENAI_API_KEY, false);
  assert.equal(ctx.apiKeys.GROQ_API_KEY, false);
});

test("proposeDeterministicRouting prefers claude-code subscription for default", () => {
  const config = proposeDeterministicRouting(
    detection({
      subscriptions: {
        "claude-code": { mode: "claude-code", available: true, expired: false },
        codex: { mode: "codex", available: false, expired: false }
      },
      apiKeys: { ...detection().apiKeys, ANTHROPIC_API_KEY: false }
    })
  );
  assert.equal(config.routes.default, "claude-sub,claude-sonnet-4-5");
  const claude = config.providers.find((provider) => provider.id === "claude-sub");
  assert.deepEqual(claude, { id: "claude-sub", provider: "anthropic" });
  assert.equal(claude?.keyEnv, undefined);
  assert.equal(config.routes.longContextThreshold, 60_000);
});

test("proposeDeterministicRouting uses ANTHROPIC_API_KEY when no subscription", () => {
  const config = proposeDeterministicRouting(
    detection({ apiKeys: { ...detection().apiKeys, ANTHROPIC_API_KEY: true } })
  );
  assert.equal(config.routes.default, "claude-sub,claude-sonnet-4-5");
  const claude = config.providers.find((provider) => provider.id === "claude-sub");
  assert.equal(claude?.keyEnv, "ANTHROPIC_API_KEY");
});

test("proposeDeterministicRouting falls through to first API-key provider", () => {
  const config = proposeDeterministicRouting(
    detection({ apiKeys: { ...detection().apiKeys, GROQ_API_KEY: true } })
  );
  assert.equal(config.routes.default, "groq,openai/gpt-oss-120b");
  assert.equal(config.routes.background, "groq,llama-3.1-8b-instant");
});

test("proposeDeterministicRouting fills scenario matrix from available providers", () => {
  const config = proposeDeterministicRouting(
    detection({
      apiKeys: {
        ...detection().apiKeys,
        DEEPSEEK_API_KEY: true,
        OPENROUTER_API_KEY: true,
        GEMINI_API_KEY: true
      }
    })
  );
  assert.equal(config.routes.reasoning, "deepseek,deepseek-v4-pro");
  assert.equal(config.routes.longContext, "gemini,gemini-2.5-pro");
  assert.equal(config.routes.webSearch, "openrouter,anthropic/claude-sonnet-4.6");
});

test("proposeDeterministicRouting uses codex subscription for reasoning when present", () => {
  const config = proposeDeterministicRouting(
    detection({
      subscriptions: {
        "claude-code": { mode: "claude-code", available: true, expired: false },
        codex: { mode: "codex", available: true, expired: false }
      },
      apiKeys: { ...detection().apiKeys, ANTHROPIC_API_KEY: false }
    })
  );
  assert.match(config.routes.reasoning ?? "", /codex-sub/);
  const codex = config.providers.find((provider) => provider.id === "codex-sub");
  assert.equal(codex?.provider, "openai");
  assert.equal(codex?.keyEnv, undefined);
});

test("proposeDeterministicRouting throws when nothing is available", () => {
  assert.throws(() => proposeDeterministicRouting(detection()), RoutingOnboardingError);
});

test("validateRoutingProposal accepts a well-formed proposal", () => {
  const config = validateRoutingProposal(
    {
      routes: { default: "p,m1", background: "p,m2" },
      providers: [{ id: "p", provider: "openai", keyEnv: "OPENAI_API_KEY" }]
    },
    "test"
  );
  assert.equal(config.routes.default, "p,m1");
  assert.equal(config.providers.length, 1);
});

test("validateRoutingProposal rejects invalid routes", () => {
  assert.throws(
    () => validateRoutingProposal({ routes: { default: "" }, providers: [{ id: "p", provider: "openai" }] }, "test"),
    RoutingOnboardingError
  );
});

test("proposeDeterministicRouting ignores expired claude subscription for anthropic provider", () => {
  const config = proposeDeterministicRouting(
    detection({
      subscriptions: {
        "claude-code": { mode: "claude-code", available: true, expired: true },
        codex: { mode: "codex", available: false, expired: false }
      },
      apiKeys: { ...detection().apiKeys, OPENROUTER_API_KEY: true }
    })
  );
  assert.equal(config.routes.default, "openrouter,anthropic/claude-sonnet-4.6");
});

test("proposeDeterministicRouting uses openai key when only OPENAI_API_KEY is set", () => {
  const config = proposeDeterministicRouting(
    detection({ apiKeys: { ...detection().apiKeys, OPENAI_API_KEY: true } })
  );
  assert.equal(config.routes.default, "openai,gpt-4o");
});

test("validateRoutingProposal rejects non-object input", () => {
  assert.throws(() => validateRoutingProposal("nope", "test"), RoutingOnboardingError);
});

test("validateRoutingProposal rejects missing providers", () => {
  assert.throws(
    () => validateRoutingProposal({ routes: { default: "p,m" }, providers: [] }, "test"),
    RoutingOnboardingError
  );
});

test("proposeDeterministicRouting uses openrouter for longContext when gemini key is absent", () => {
  const config = proposeDeterministicRouting(
    detection({ apiKeys: { ...detection().apiKeys, OPENROUTER_API_KEY: true } })
  );
  assert.equal(config.routes.longContext, "openrouter,google/gemini-2.5-pro");
});

test("proposeDeterministicRouting uses groq compound for webSearch when only groq is available", () => {
  const config = proposeDeterministicRouting(
    detection({ apiKeys: { ...detection().apiKeys, GROQ_API_KEY: true } })
  );
  assert.equal(config.routes.webSearch, "groq,groq/compound");
});

test("proposeDeterministicRouting uses gemini for webSearch when only gemini key is set", () => {
  const config = proposeDeterministicRouting(
    detection({ apiKeys: { ...detection().apiKeys, GEMINI_API_KEY: true } })
  );
  assert.equal(config.routes.webSearch, "gemini,gemini-2.5-flash");
});

test("proposeDeterministicRouting uses openrouter for reasoning when it is the only key", () => {
  const config = proposeDeterministicRouting(
    detection({ apiKeys: { ...detection().apiKeys, OPENROUTER_API_KEY: true } })
  );
  assert.equal(config.routes.reasoning, "openrouter,anthropic/claude-sonnet-4.6");
});

test("proposeDeterministicRouting uses claude opus for reasoning with subscription only", () => {
  const config = proposeDeterministicRouting(
    detection({
      subscriptions: {
        "claude-code": { mode: "claude-code", available: true, expired: false },
        codex: { mode: "codex", available: false, expired: false }
      },
      apiKeys: { ...detection().apiKeys, ANTHROPIC_API_KEY: false }
    })
  );
  assert.equal(config.routes.reasoning, "claude-sub,claude-opus-4-5");
});

test("validateRoutingProposal rejects invalid provider entries", () => {
  assert.throws(
    () =>
      validateRoutingProposal(
        { routes: { default: "p,m" }, providers: [{ id: "", provider: "openai" }] },
        "test"
      ),
    RoutingOnboardingError
  );
  assert.throws(
    () =>
      validateRoutingProposal(
        { routes: { default: "p,m" }, providers: [{ id: "p", provider: "nope" }] },
        "test"
      ),
    RoutingOnboardingError
  );
  assert.throws(
    () =>
      validateRoutingProposal(
        { routes: { default: "p,m" }, providers: "bad" },
        "test"
      ),
    RoutingOnboardingError
  );
  assert.throws(
    () =>
      validateRoutingProposal(
        { routes: { default: "p,m" }, providers: [null] },
        "test"
      ),
    RoutingOnboardingError
  );
  assert.throws(
    () =>
      validateRoutingProposal(
        {
          routes: { default: "p,m" },
          providers: [{ id: "p", provider: "openai", baseUrl: "" }]
        },
        "test"
      ),
    RoutingOnboardingError
  );
  assert.throws(
    () =>
      validateRoutingProposal(
        {
          routes: { default: "p,m" },
          providers: [{ id: "p", provider: "openai", keyEnv: "" }]
        },
        "test"
      ),
    RoutingOnboardingError
  );
});

test("formatRoutingSection wraps config for display", () => {
  const text = formatRoutingSection({
    routes: { default: "p,m" },
    providers: [{ id: "p", provider: "openai" }]
  });
  assert.match(text, /"routing"/);
  assert.match(text, /"default": "p,m"/);
});
