/**
 * Per-provider outbound request shims for the OpenAI-compat routing path.
 *
 * Applies translation-risk mitigations from `docs/phase-2-providers.md` §5
 * before requests reach {@link OpenAiBackend}.
 */

import type { RoutingProviderKind } from "./providers.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

/** Fields Groq rejects with HTTP 400 ([OpenAI Compatibility](https://console.groq.com/docs/openai)). */
const GROQ_FORBIDDEN_TOP_LEVEL = new Set(["logprobs", "logit_bias", "top_logprobs"]);

/**
 * Strip OpenAI Chat fields that Groq documents as unsupported.
 */
export function sanitizeGroqRequest(body: Record<string, unknown>): Record<string, unknown> {
  const next = deepClone(body);
  for (const key of GROQ_FORBIDDEN_TOP_LEVEL) {
    delete next[key];
  }
  if (typeof next.n === "number" && next.n !== 1) {
    next.n = 1;
  }
  if (Array.isArray(next.messages)) {
    next.messages = next.messages.map((message) => {
      if (!isRecord(message)) return message;
      const copy = { ...message };
      delete copy.name;
      return copy;
    });
  }
  return next;
}

/**
 * Disable DeepSeek thinking mode by default to avoid `reasoning_content` round-trip
 * requirements on multi-turn tool loops ([Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)).
 */
export function sanitizeDeepSeekRequest(body: Record<string, unknown>): Record<string, unknown> {
  const next = deepClone(body);
  const existingExtra = isRecord(next.extra_body) ? { ...next.extra_body } : {};
  const existingThinking = isRecord(existingExtra.thinking) ? { ...existingExtra.thinking } : {};
  if (existingThinking.type === undefined) {
    existingThinking.type = "disabled";
  }
  existingExtra.thinking = existingThinking;
  next.extra_body = existingExtra;
  return next;
}

/**
 * Apply provider-specific outbound mutations to an OpenAI Chat Completions body.
 */
export function sanitizeProviderRequest(
  kind: RoutingProviderKind,
  body: unknown
): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new TypeError("provider request body must be an object");
  }
  switch (kind) {
    case "groq":
      return sanitizeGroqRequest(body);
    case "deepseek":
      return sanitizeDeepSeekRequest(body);
    default:
      return body;
  }
}
