import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { artifactHash, requestHash, responseHash } from "@routekit/contracts";
import type {
  JsonValue,
  ModelCallContract,
  ModelChatMessage,
  ModelUsage,
  ProviderError,
  RequestAttribution
} from "@routekit/contracts";

import { meterCall, parseUsage, parseUsageFromSse } from "./cost.js";

export type GatewayDialect =
  | "openai-chat"
  | "openai-embeddings"
  | "anthropic-messages"
  | "openai-responses";

export const MODEL_CALL_ID_HEADER = "x-routekit-model-call-id";
export const UNKNOWN_GIT_SHA = "unknown";

const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export function resolveProducerGitSha(fromDir: string = moduleDir()): string {
  const stamped = process.env.ROUTEKIT_BUILD_GIT_SHA?.trim();
  if (stamped !== undefined && GIT_SHA_PATTERN.test(stamped)) return stamped;
  if (!fromDir.includes("node_modules")) {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: fromDir, encoding: "utf8" });
    if (result.status === 0 && GIT_SHA_PATTERN.test(result.stdout.trim())) {
      return result.stdout.trim();
    }
  }
  return UNKNOWN_GIT_SHA;
}

export function readProducerVersion(fromDir: string = moduleDir(), fallback = "0.0.0"): string {
  let dir = fromDir;
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        version?: unknown;
      };
      if (typeof parsed.version === "string" && parsed.version.length > 0) return parsed.version;
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fallback;
}

export type ModelGatewayCallContext = {
  callId: string;
  dialect: GatewayDialect;
  requestedModel: string | undefined;
  model: string | undefined;
  stream: boolean;
  requestBody: unknown;
  startedAt: string;
  endpointId?: string;
  attribution?: RequestAttribution;
};

export type ModelGatewayCallResult = {
  statusCode: number;
  responseBody?: Buffer;
  durationMs: number;
  error?: unknown;
};

export type ModelCallRecord = ModelCallContract;

export type ProvenanceSink = {
  onModelCall?(record: ModelCallRecord): void;
  onModelCallRaw?(context: ModelGatewayCallContext, result: ModelGatewayCallResult): void;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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

function requestMessages(body: unknown): ModelChatMessage[] {
  const messages = asRecord(body)?.messages;
  if (!Array.isArray(messages)) return [{ role: "user", content: requestHash(body) }];
  const projected = messages.flatMap((message): ModelChatMessage[] => {
    const item = asRecord(message);
    const role = item?.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") return [];
    return [{ role, content: requestHash(item?.content ?? "") }];
  });
  return projected.length > 0 ? projected : [{ role: "user", content: requestHash(body) }];
}

function usageFromResponse(body: Buffer | undefined): ModelUsage | undefined {
  const parsed = asRecord(parseJson(body));
  const usage = parseUsage(parsed?.usage) ?? parseUsageFromSse(responseText(body));
  if (usage === undefined) return undefined;
  return {
    ...(usage.promptTokens !== undefined ? { prompt_tokens: usage.promptTokens } : {}),
    ...(usage.completionTokens !== undefined ? { completion_tokens: usage.completionTokens } : {}),
    ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {})
  };
}

function providerRequestId(body: Buffer | undefined): string | undefined {
  const id = asRecord(parseJson(body))?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function providerError(result: ModelGatewayCallResult): ProviderError | undefined {
  if (result.error === undefined && result.statusCode >= 200 && result.statusCode < 400) {
    return undefined;
  }
  const responseError = asRecord(asRecord(parseJson(result.responseBody))?.error);
  const noModelAvailable =
    result.statusCode === 503 &&
    responseError?.type === "unavailable" &&
    responseError.message === "no model is available; configure a provider";
  const kind =
    noModelAvailable
      ? "capability_missing"
      : result.statusCode === 408
      ? "timeout"
      : result.statusCode === 429
        ? "rate_limited"
        : result.statusCode === 400 || result.statusCode === 422
          ? "validation_error"
          : "provider_error";
  const message =
    kind === "capability_missing"
      ? "no model route is configured"
      : kind === "timeout"
      ? "provider request timed out"
      : kind === "rate_limited"
        ? "provider rate limited the request"
        : kind === "validation_error"
          ? "provider rejected the request"
          : "provider request failed";
  return {
    kind,
    message,
    retryable:
      !noModelAvailable &&
      (result.statusCode === 408 || result.statusCode === 429 || result.statusCode >= 500)
  };
}

export function buildModelCallRecord(
  context: ModelGatewayCallContext,
  result: ModelGatewayCallResult
): ModelCallRecord {
  const usage = usageFromResponse(result.responseBody);
  const callCost = meterCall({
    model: context.model ?? context.requestedModel ?? "unknown",
    usage:
      usage === undefined
        ? undefined
        : {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens
          }
  });
  const error = providerError(result);
  const metadata: Record<string, JsonValue> = {
    dialect: context.dialect,
    stream: context.stream,
    http_status: result.statusCode,
    duration_ms: result.durationMs,
    requested_model: context.requestedModel ?? null,
    unknown_usage: callCost.unknownUsage,
    unknown_cost: callCost.unknownCost,
    ...(context.attribution !== undefined
      ? {
          attribution: {
            effective_model: context.attribution.effective_model,
            ...(context.attribution.native_model !== undefined
              ? { native_model: context.attribution.native_model }
              : {}),
            provider: context.attribution.provider,
            billing_mode: context.attribution.billing_mode,
            ...(context.attribution.account !== undefined
              ? { account: { seat: context.attribution.account.seat } }
              : {}),
            attempts: context.attribution.attempts,
            retries: context.attribution.retries,
            account_failovers: context.attribution.account_failovers
          }
        }
      : {}),
    ...(callCost.costUsd !== undefined ? { cost_estimate_usd: callCost.costUsd } : {})
  };
  return {
    call_id: context.callId,
    endpoint_id: context.endpointId ?? context.dialect,
    ...(providerRequestId(result.responseBody) !== undefined
      ? { provider_request_id: providerRequestId(result.responseBody) }
      : {}),
    model: context.model ?? context.requestedModel ?? "unknown",
    request_hash: requestHash(context.requestBody),
    ...(result.responseBody !== undefined
      ? { response_hash: responseHash(responseText(result.responseBody)) }
      : {}),
    messages: requestMessages(context.requestBody),
    status: error === undefined ? "succeeded" : "failed",
    side_effects: "none",
    started_at: context.startedAt,
    finished_at: new Date(new Date(context.startedAt).getTime() + result.durationMs).toISOString(),
    latency_ms: result.durationMs,
    ...(usage !== undefined ? { usage } : {}),
    ...(error !== undefined ? { error } : {}),
    metadata
  };
}

export function modelCallId(): string {
  return `model_call_${randomUUID()}`;
}

export function responseBodyHash(body: Buffer): string {
  return artifactHash(body);
}
