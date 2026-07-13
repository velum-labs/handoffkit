/**
 * Model listing for OpenAI-compatible endpoints via the official `openai` SDK
 * (`client.models.list()` against a custom `baseURL`) — the one place the CLI
 * talks to a `/v1/models` surface. Listings ride the SDK; only genuinely
 * non-OpenAI surfaces (Anthropic/Google catalogs, per-provider key probes like
 * OpenRouter's `/v1/key`) stay on raw fetch.
 *
 * Retries are disabled and timeouts kept short on purpose: these calls back
 * interactive pickers and health checks, where failing fast into a fallback
 * beats the SDK's default retry cadence.
 */
import OpenAI from "openai";

type JsonRecord = Record<string, unknown>;

export type ListModelsOptions = {
  /** Provider base URL without the `/v1` suffix (the helper appends it). */
  baseUrl: string;
  /** Bearer credential; a `not-needed` placeholder is sent when absent (public listings tolerate it). */
  apiKey?: string;
  /** Extra headers (e.g. OpenRouter attribution). */
  headers?: Record<string, string>;
  /** Injected fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export const MODELS_TIMEOUT_MS = 5_000;

function clientFor(options: ListModelsOptions): OpenAI {
  const apiKey =
    options.apiKey !== undefined && options.apiKey.length > 0 ? options.apiKey : "not-needed";
  return new OpenAI({
    baseURL: `${options.baseUrl.replace(/\/+$/, "")}/v1`,
    apiKey,
    maxRetries: 0,
    timeout: options.timeoutMs ?? MODELS_TIMEOUT_MS,
    ...(options.headers !== undefined ? { defaultHeaders: options.headers } : {}),
    ...(options.fetchImpl !== undefined ? { fetch: options.fetchImpl } : {})
  });
}

/**
 * The endpoint's `/v1/models` entries as raw records (the SDK types only the
 * OpenAI core fields; providers like OpenRouter attach pricing/context extras
 * that survive at runtime). Throws on any HTTP or network failure.
 */
export async function listOpenAiCompatibleModels(
  options: ListModelsOptions
): Promise<JsonRecord[]> {
  const records: JsonRecord[] = [];
  for await (const model of clientFor(options).models.list()) {
    records.push(model as unknown as JsonRecord);
  }
  return records;
}

/** A non-throwing {@link listOpenAiCompatibleModels} outcome for health checks. */
export type ModelsProbeResult =
  | { kind: "ok"; models: JsonRecord[] }
  | { kind: "unauthorized"; status: number }
  | { kind: "http-error"; status: number }
  | { kind: "unreachable" };

/**
 * Probe an OpenAI-compatible endpoint by listing its models, mapping the SDK's
 * error taxonomy onto the outcomes health checks care about: reachable-and-
 * authorized (with the model list), key rejected (401/403), another HTTP
 * error, or not reachable at all.
 */
export async function probeOpenAiCompatibleModels(
  options: ListModelsOptions
): Promise<ModelsProbeResult> {
  try {
    return { kind: "ok", models: await listOpenAiCompatibleModels(options) };
  } catch (error) {
    if (error instanceof OpenAI.APIError && typeof error.status === "number") {
      return error.status === 401 || error.status === 403
        ? { kind: "unauthorized", status: error.status }
        : { kind: "http-error", status: error.status };
    }
    return { kind: "unreachable" };
  }
}
