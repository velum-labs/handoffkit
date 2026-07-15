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
