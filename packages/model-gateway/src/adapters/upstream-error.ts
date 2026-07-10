/**
 * Unwrap a backend error body for re-emission on a translated door.
 *
 * The Anthropic/Responses adapters run over the OpenAI-chat backend; when it
 * fails, its body is already an OpenAI error envelope. Re-wrapping that JSON
 * string as the `message` of a fresh `api_error` (the old behavior) both
 * double-encodes the message and misclassifies caller errors — a 400
 * `invalid_request_error` from the backend must stay an
 * `invalid_request_error` on the door.
 */
export function unwrapUpstreamError(detail: string): { type: string; message: string } {
  try {
    const parsed = JSON.parse(detail) as { error?: { type?: unknown; message?: unknown } };
    if (typeof parsed.error?.message === "string") {
      return {
        type: typeof parsed.error.type === "string" ? parsed.error.type : "api_error",
        message: parsed.error.message
      };
    }
  } catch {
    // not JSON — fall through to the raw detail
  }
  return { type: "api_error", message: detail.slice(0, 2000) };
}
