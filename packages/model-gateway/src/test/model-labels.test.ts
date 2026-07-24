import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatBillingModeLabel,
  formatBillingSourceLabel,
  formatModelHumanName,
  formatPickerLabel,
  providerBillingMetadata,
  sanitizeModelLabel
} from "../model-labels.js";

test("formatModelHumanName renders common native model slugs", () => {
  assert.equal(formatModelHumanName("claude-sonnet-4-5"), "Claude Sonnet 4.5");
  assert.equal(formatModelHumanName("gpt-5.5"), "GPT-5.5");
  assert.equal(
    formatModelHumanName("anthropic/claude-opus-4-8"),
    "Claude Opus 4.8"
  );
});

test("formatPickerLabel differentiates dual Anthropic API and Claude Max routes", () => {
  assert.equal(
    formatPickerLabel({
      provider: "anthropic",
      nativeModel: "claude-sonnet-4-5"
    }),
    "Claude Sonnet 4.5 · Anthropic API"
  );
  assert.equal(
    formatPickerLabel({
      provider: "claude-code",
      nativeModel: "claude-sonnet-4-5"
    }),
    "Claude Sonnet 4.5 · Claude Max"
  );
});

test("formatPickerLabel differentiates Codex subscription and OpenAI API routes", () => {
  assert.equal(
    formatPickerLabel({
      provider: "codex",
      nativeModel: "gpt-5.5"
    }),
    "GPT-5.5 · ChatGPT subscription"
  );
  assert.equal(
    formatPickerLabel({
      provider: "openai",
      nativeModel: "gpt-5.5"
    }),
    "GPT-5.5 · OpenAI API"
  );
});

test("sanitizeModelLabel strips credential-like material", () => {
  const dirty =
    "GPT-5.5 · OpenAI API sk-proj-abcdefghijklmnopqrstuvwxyz Bearer deadbeef token=supersecret";
  const sanitized = sanitizeModelLabel(dirty);
  assert.doesNotMatch(sanitized, /sk-proj-/);
  assert.doesNotMatch(sanitized, /Bearer/);
  assert.doesNotMatch(sanitized, /supersecret/);
  assert.match(sanitized, /GPT-5\.5 · OpenAI API/);
});

test("providerBillingMetadata maps API and subscription providers", () => {
  assert.deepEqual(providerBillingMetadata("anthropic"), {
    accountClass: "api-key",
    billingMode: "metered-api"
  });
  assert.deepEqual(providerBillingMetadata("claude-code"), {
    accountClass: "subscription",
    billingMode: "subscription"
  });
  assert.equal(formatBillingSourceLabel({ provider: "openrouter", nativeModel: "x" }), "OpenRouter credits");
  assert.equal(formatBillingModeLabel("metered-api"), "metered API");
});
