import { randomUUID } from "node:crypto";

import {
  artifactHash,
  assertModelCallRecordV1,
  requestHash,
  responseHash
} from "@warrant/protocol";
import type {
  ModelCallRecordV1,
  ModelFusionChatMessage,
  ModelFusionError,
  ModelFusionStatus,
  JsonValue,
  ModelFusionUsage
} from "@warrant/protocol";

/** The wire dialect a request arrived on. */
export type GatewayDialect = "openai-chat" | "anthropic-messages" | "openai-responses";

export const MODEL_CALL_ID_HEADER = "x-velum-model-call-id";

export type ModelGatewayCallContext = {
  callId: string;
  dialect: GatewayDialect;
  requestedModel: string | undefined;
  model: string | undefined;
  stream: boolean;
  requestBody: unknown;
  startedAt: string;
  endpointId?: string;
};

export type ModelGatewayCallResult = {
  statusCode: number;
  responseBody?: Buffer;
  durationMs: number;
  error?: unknown;
};

/** One recorded model call observed at the gateway boundary. */
export type ModelCallRecord = ModelCallRecordV1;

/** Sink for gateway observations. All methods are optional. */
export type ProvenanceSink = {
  onModelCall?(record: ModelCallRecord): void;
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requestMessages(body: unknown): ModelFusionChatMessage[] {
  const obj = asObject(body);
  const messages = obj?.messages;
  if (Array.isArray(messages)) {
    const projected = messages
      .map((message): ModelFusionChatMessage | undefined => {
        const item = asObject(message);
        if (item === undefined) return undefined;
        const role = item?.role;
        if (
          role !== "system" &&
          role !== "user" &&
          role !== "assistant" &&
          role !== "tool"
        ) {
          return undefined;
        }
        return {
          role,
          content: requestHash(item.content ?? "")
        };
      })
      .filter((message): message is ModelFusionChatMessage => message !== undefined);
    if (projected.length > 0) return projected;
  }
  return [{ role: "user", content: requestHash(body) }];
}

function parseJson(buffer: Buffer | undefined): unknown {
  if (buffer === undefined || buffer.length === 0) return undefined;
  try {
    return JSON.parse(buffer.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function responseText(buffer: Buffer | undefined): string {
  return buffer?.toString("utf8") ?? "";
}

function usageFromObject(value: unknown): ModelFusionUsage | undefined {
  const obj = asObject(value);
  const usage = asObject(obj?.usage);
  if (usage === undefined) return undefined;
  const prompt =
    typeof usage.prompt_tokens === "number"
      ? usage.prompt_tokens
      : typeof usage.input_tokens === "number"
        ? usage.input_tokens
        : undefined;
  const completion =
    typeof usage.completion_tokens === "number"
      ? usage.completion_tokens
      : typeof usage.output_tokens === "number"
        ? usage.output_tokens
        : undefined;
  const total =
    typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : prompt !== undefined && completion !== undefined
        ? prompt + completion
        : undefined;
  if (prompt === undefined && completion === undefined && total === undefined) {
    return undefined;
  }
  return {
    ...(prompt !== undefined ? { prompt_tokens: prompt } : {}),
    ...(completion !== undefined ? { completion_tokens: completion } : {}),
    ...(total !== undefined ? { total_tokens: total } : {})
  };
}

function usageFromSse(text: string): ModelFusionUsage | undefined {
  let usage: ModelFusionUsage | undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") continue;
    const parsed = parseJson(Buffer.from(payload));
    const candidate = usageFromObject(parsed);
    if (candidate !== undefined) usage = candidate;
  }
  return usage;
}

function usageFromResponse(body: Buffer | undefined): ModelFusionUsage | undefined {
  const parsed = parseJson(body);
  return usageFromObject(parsed) ?? usageFromSse(responseText(body));
}

function observedModel(body: Buffer | undefined): string | undefined {
  return stringValue(asObject(parseJson(body))?.model);
}

function providerRequestId(body: Buffer | undefined): string | undefined {
  return stringValue(asObject(parseJson(body))?.id);
}

function errorKind(statusCode: number, error: unknown): ModelFusionError["kind"] {
  if (statusCode === 408) return "timeout";
  if (statusCode === 429) return "rate_limited";
  if (error !== undefined) return "provider_error";
  if (statusCode >= 400) return "provider_error";
  return "none";
}

function statusFor(statusCode: number, error: unknown): ModelFusionStatus {
  return statusCode >= 200 && statusCode < 400 && error === undefined ? "succeeded" : "failed";
}

export function buildModelCallRecord(
  context: ModelGatewayCallContext,
  result: ModelGatewayCallResult
): ModelCallRecord {
  const usage = usageFromResponse(result.responseBody);
  const status = statusFor(result.statusCode, result.error);
  const metadata: Record<string, JsonValue> = {
    dialect: context.dialect,
    stream: context.stream,
    http_status: result.statusCode,
    duration_ms: result.durationMs,
    requested_model: context.requestedModel ?? null,
    observed_model: observedModel(result.responseBody) ?? null,
    unknown_usage: usage === undefined,
    unknown_cost: true
  };
  const error: ModelFusionError | undefined =
    status === "failed"
      ? {
          kind: errorKind(result.statusCode, result.error),
          message:
            result.error instanceof Error
              ? result.error.message
              : result.error !== undefined
                ? String(result.error)
                : responseText(result.responseBody).slice(0, 500),
          retryable: result.statusCode >= 500
        }
      : undefined;
  const record: ModelCallRecord = {
    schema: "model-call-record.v1",
    schema_version: "v1",
    schema_bundle_hash: "sha256:75792f89c091b6ab4fd317a15fb03fd73438563dceff5ccf9f5d7c752dbf35f3",
    producer: "handoffkit-model-gateway",
    producer_version: "0.1.0",
    producer_git_sha: "0".repeat(40),
    created_at: context.startedAt,
    call_id: context.callId,
    endpoint_id: context.endpointId ?? context.dialect,
    ...(providerRequestId(result.responseBody)
      ? { provider_request_id: providerRequestId(result.responseBody) }
      : {}),
    model: context.model ?? context.requestedModel ?? "unknown",
    request_hash: requestHash(context.requestBody),
    ...(result.responseBody !== undefined
      ? { response_hash: responseHash(responseText(result.responseBody)) }
      : {}),
    messages: requestMessages(context.requestBody),
    status,
    side_effects: "none",
    started_at: context.startedAt,
    finished_at: new Date(new Date(context.startedAt).getTime() + result.durationMs).toISOString(),
    latency_ms: result.durationMs,
    ...(usage !== undefined ? { usage } : {}),
    ...(error !== undefined ? { error } : {}),
    metadata
  };
  assertModelCallRecordV1(record);
  return record;
}

export function modelCallId(): string {
  return `model_call_${randomUUID()}`;
}

export function responseBodyHash(body: Buffer): string {
  return artifactHash(body);
}
