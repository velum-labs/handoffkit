import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  artifactHash,
  assertModelCallRecordV1,
  MODEL_FUSION_SCHEMA_BUNDLE_HASH,
  requestHash,
  responseHash
} from "@fusionkit/protocol";
import type {
  ModelCallRecordV1,
  ModelFusionChatMessage,
  ModelFusionError,
  ModelFusionStatus,
  JsonValue,
  ModelFusionUsage
} from "@fusionkit/protocol";

/** The wire dialect a request arrived on. */
export type GatewayDialect = "openai-chat" | "anthropic-messages" | "openai-responses";

export const MODEL_CALL_ID_HEADER = "x-velum-model-call-id";

// --- WS7: real-lite producer provenance -----------------------------------

/**
 * The sentinel emitted for `producer_git_sha` when no real SHA is resolvable.
 * Deliberately NOT 40 zeros: an all-zero SHA reads as a valid (null) git object
 * and was the old "faked provenance" placeholder. The protocol's
 * `producer_git_sha` validator accepts this literal as a clearly-marked unknown.
 */
export const UNKNOWN_GIT_SHA = "unknown";

const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

/** This module's own directory (works in dev `src` and built `dist`). */
function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Resolve a producer's real git SHA, real-lite (WS7). Resolution order:
 *   1. a build/publish-time stamp (`FUSIONKIT_BUILD_GIT_SHA`) — baked in when the
 *      package is built so an installed artifact still carries real provenance;
 *   2. a runtime `git rev-parse HEAD` — only when running from a source checkout
 *      (the module path is NOT under `node_modules`), so an installed copy never
 *      mis-reports the *consuming project's* repo SHA as the producer's;
 *   3. the {@link UNKNOWN_GIT_SHA} sentinel — never 40 zeros.
 */
export function resolveProducerGitSha(fromDir: string = moduleDir()): string {
  const stamped = process.env.FUSIONKIT_BUILD_GIT_SHA?.trim();
  if (stamped !== undefined && GIT_SHA_PATTERN.test(stamped)) return stamped;
  if (!fromDir.includes("node_modules")) {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: fromDir, encoding: "utf8" });
    if (result.status === 0) {
      const sha = result.stdout.trim();
      if (GIT_SHA_PATTERN.test(sha)) return sha;
    }
  }
  return UNKNOWN_GIT_SHA;
}

/** Read a producer's real version from the nearest ancestor `package.json`. */
export function readProducerVersion(fromDir: string = moduleDir(), fallback = "0.0.0"): string {
  let dir = fromDir;
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown };
      if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
    } catch {
      // No package.json here (or unreadable); keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fallback;
}

const PRODUCER = "handoffkit-model-gateway";
const PRODUCER_VERSION = readProducerVersion();
const PRODUCER_GIT_SHA = resolveProducerGitSha();

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
  /**
   * Unredacted, in-process observation of one model call: the raw request body
   * (full message array incl. tool calls + tool results) and raw response body.
   * Used to reconstruct a native agent trajectory from the wire traffic without
   * per-CLI stdout parsing. Never persisted by the gateway; the caller decides.
   */
  onModelCallRaw?(context: ModelGatewayCallContext, result: ModelGatewayCallResult): void;
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
    schema_bundle_hash: MODEL_FUSION_SCHEMA_BUNDLE_HASH,
    producer: PRODUCER,
    producer_version: PRODUCER_VERSION,
    producer_git_sha: PRODUCER_GIT_SHA,
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
