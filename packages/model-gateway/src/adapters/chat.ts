/**
 * OpenAI Chat Completions surface. This is the gateway's "core" dialect: it is
 * what the owned mlx fork speaks, what opencode and the Cursor IDE plan panel
 * consume directly, and what the Anthropic and Responses adapters translate
 * down to. The handlers here are deliberately thin — the request is forwarded
 * to the backend and the upstream response (including SSE streams) is piped
 * straight back — so the only logic is filling in a default model.
 */

function asObject(body: unknown): Record<string, unknown> | undefined {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return undefined;
}

/** Fill in `model` from the backend default when the caller omitted it. */
export function withDefaultModel(body: unknown, defaultModel: string | undefined): unknown {
  if (defaultModel === undefined) return body;
  const obj = asObject(body);
  if (obj === undefined || obj.model !== undefined) return body;
  return { ...obj, model: defaultModel };
}

/** Whether a chat/completions request asked for a streamed response. */
export function isStream(body: unknown): boolean {
  return asObject(body)?.stream === true;
}

/** The model id a request will run as, after default injection. */
export function effectiveModel(body: unknown, defaultModel: string | undefined): string | undefined {
  const model = asObject(body)?.model;
  if (typeof model === "string") return model;
  return defaultModel;
}
