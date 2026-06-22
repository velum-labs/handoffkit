/**
 * HTTP error classification for cross-provider fallback decisions.
 *
 * See `docs/phase-2-providers.md` §6 for the recommended trigger matrix.
 */

/** Action the routing layer should take after a provider error. */
export type ProviderErrorAction = "retry" | "fallback" | "fatal";

const CONTEXT_LENGTH_PATTERN =
  /context\s*length|maximum\s*context|too\s*many\s*tokens|token\s*limit|max(?:imum)?\s*tokens/i;

function errorMessage(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const nested = error as Record<string, unknown>;
    if (typeof nested.message === "string") return nested.message;
  }
  if (typeof record.message === "string") return record.message;
  return "";
}

/**
 * Classify an upstream provider HTTP response for retry / fallback handling.
 *
 * @param status - HTTP status code from the provider.
 * @param body - Parsed JSON error body when available.
 */
export function classifyProviderError(status: number, body: unknown = undefined): ProviderErrorAction {
  if (status === 429 || status === 402 || status === 498) return "fallback";
  if (status === 401 || status === 403) return "fallback";
  if (status === 500 || status === 502 || status === 503 || status === 504) return "retry";
  if (status === 413 || status === 422) {
    if (CONTEXT_LENGTH_PATTERN.test(errorMessage(body))) return "fallback";
    return "fatal";
  }
  if (status === 400 || status === 404 || status === 408) return "fatal";
  if (status >= 200 && status < 300) return "fatal";
  if (status >= 500) return "retry";
  return "fallback";
}
