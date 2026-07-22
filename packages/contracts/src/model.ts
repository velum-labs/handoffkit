import type { JsonValue } from "./jcs.js";

export type CapabilityStatus = "supported" | "unsupported" | "degraded" | "unknown";

export type ModelCallStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "requires_action"
  | "skipped"
  | "unsupported";

export type ModelCallSideEffects =
  | "none"
  | "read_only"
  | "writes_workspace"
  | "network"
  | "tool_execution"
  | "unknown";

export type ModelChatRole = "system" | "user" | "assistant" | "tool";

export type ModelChatMessage = {
  role: ModelChatRole;
  content: string;
};

export type ModelUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type RequestBillingMode = "api_key" | "subscription" | "client_auth";

/**
 * Sanitized, per-request routing attribution. This intentionally contains no
 * credentials, request headers, filesystem paths, or provider response text.
 */
export type RequestAttribution = {
  effective_model: string;
  native_model?: string;
  provider: string;
  billing_mode: RequestBillingMode;
  account?: {
    /** Operator-assigned local label for the selected subscription seat. */
    label: string;
  };
  attempts: number;
  retries: number;
  account_failovers: number;
};

export type ProviderErrorKind =
  | "none"
  | "provider_error"
  | "validation_error"
  | "timeout"
  | "rate_limited"
  | "capability_missing"
  | "internal_error";

export type ProviderError = {
  kind: ProviderErrorKind;
  message?: string;
  retryable?: boolean;
};

export type ProviderFailureCategory =
  | "transient"
  | "quota_exhausted"
  | "auth_permanent"
  | "context_overflow"
  | "unknown";

export type ProviderFailure = {
  category: ProviderFailureCategory;
  message: string;
  status?: number;
  retryAfter?: number;
  resetsAt?: number;
  provider?: string;
};

export class ProviderFailureError extends Error {
  readonly failure: ProviderFailure;

  constructor(failure: ProviderFailure) {
    super(failure.message);
    this.name = "ProviderFailureError";
    this.failure = failure;
  }
}

export function isRetryableProviderFailure(category: ProviderFailureCategory): boolean {
  switch (category) {
    case "transient":
    case "quota_exhausted":
      return true;
    case "auth_permanent":
    case "context_overflow":
    case "unknown":
      return false;
    default: {
      const unreachable: never = category;
      throw new Error(`unhandled provider failure category: ${String(unreachable)}`);
    }
  }
}

/** Parse an HTTP Retry-After value into non-negative seconds. */
export function parseRetryAfterSeconds(
  value: string | null | undefined,
  now: () => number = Date.now
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  const seconds = Number(normalized);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds : undefined;
  const date = Date.parse(normalized);
  return Number.isFinite(date) ? Math.max(0, (date - now()) / 1000) : undefined;
}

export function classifyProviderFailure(
  status: number | undefined,
  message: string,
  options: {
    provider?: string;
    retryAfter?: number;
    resetsAt?: number;
    category?: ProviderFailureCategory;
  } = {}
): ProviderFailure {
  const category =
    options.category ??
    (status === 401 || status === 403
      ? "auth_permanent"
      : status === 408 || status === 429 || (status !== undefined && status >= 500)
        ? "transient"
        : /context|token limit|too long/i.test(message)
          ? "context_overflow"
          : "unknown");
  return {
    category,
    message,
    ...(status !== undefined ? { status } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.retryAfter !== undefined ? { retryAfter: options.retryAfter } : {}),
    ...(options.resetsAt !== undefined ? { resetsAt: options.resetsAt } : {})
  };
}

export type ModelEndpoint = {
  endpointId: string;
  model: string;
  provider?: string;
  baseUrl?: string;
  capabilities?: Readonly<Record<string, CapabilityStatus>>;
};

export type ModelCallContract<E extends { kind: string } = ProviderError> = {
  call_id: string;
  endpoint_id: string;
  provider_request_id?: string;
  model: string;
  request_hash: string;
  response_hash?: string;
  messages: ModelChatMessage[];
  status: ModelCallStatus;
  side_effects: ModelCallSideEffects;
  started_at: string;
  finished_at?: string;
  latency_ms?: number;
  usage?: ModelUsage;
  output_text?: string;
  error?: E;
  metadata?: Record<string, JsonValue>;
};
