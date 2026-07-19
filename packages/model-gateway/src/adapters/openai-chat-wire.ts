export type OpenAiToolCall = {
  id?: string;
  index?: number;
  function?: { name?: string; arguments?: string };
};

/**
 * Lossless Anthropic reasoning metadata carried beside the portable
 * `reasoning` string. Native Anthropic streams need block lifecycle and opaque
 * signatures to survive a round trip; other dialects can ignore this field.
 */
export type AnthropicReasoningDetail =
  | {
      type: "thinking";
      index: number;
      phase?: "start" | "delta" | "signature" | "stop";
      thinking?: string;
      signature?: string;
    }
  | {
      type: "redacted_thinking";
      index: number;
      phase?: "block";
      data: string;
    };

export function anthropicReasoningDetailsOf(
  value: unknown,
  mode: "message" | "stream"
): AnthropicReasoningDetail[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): AnthropicReasoningDetail[] => {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return [];
    }
    const detail = candidate as Record<string, unknown>;
    if (
      !Number.isInteger(detail.index) ||
      (detail.index as number) < 0
    ) {
      return [];
    }
    const index = detail.index as number;
    if (detail.type === "redacted_thinking") {
      if (
        typeof detail.data !== "string" ||
        (mode === "stream" && detail.phase !== "block") ||
        (mode === "message" && detail.phase !== undefined)
      ) {
        return [];
      }
      return [
        {
          type: "redacted_thinking",
          index,
          ...(mode === "stream" ? { phase: "block" as const } : {}),
          data: detail.data
        }
      ];
    }
    if (detail.type !== "thinking") return [];
    if (mode === "message") {
      if (
        detail.phase !== undefined ||
        typeof detail.thinking !== "string" ||
        typeof detail.signature !== "string"
      ) {
        return [];
      }
      return [
        {
          type: "thinking",
          index,
          thinking: detail.thinking,
          signature: detail.signature
        }
      ];
    }
    if (detail.phase === "start") {
      if (
        detail.signature !== undefined &&
        typeof detail.signature !== "string"
      ) {
        return [];
      }
      return [
        {
          type: "thinking",
          index,
          phase: "start",
          ...(typeof detail.signature === "string"
            ? { signature: detail.signature }
            : {})
        }
      ];
    }
    if (detail.phase === "delta" && typeof detail.thinking === "string") {
      return [
        {
          type: "thinking",
          index,
          phase: "delta",
          thinking: detail.thinking
        }
      ];
    }
    if (
      detail.phase === "signature" &&
      typeof detail.signature === "string"
    ) {
      return [
        {
          type: "thinking",
          index,
          phase: "signature",
          signature: detail.signature
        }
      ];
    }
    if (detail.phase === "stop") {
      return [{ type: "thinking", index, phase: "stop" }];
    }
    return [];
  });
}

export type AnthropicThinkingConfig =
  | { type: "enabled"; budget_tokens: number; display?: "summarized" | "omitted" | null }
  | { type: "adaptive"; display?: "summarized" | "omitted" | null }
  | { type: "disabled" };

export type AnthropicRequestMetadata = {
  thinking?: AnthropicThinkingConfig;
  output_config?: {
    effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
    [key: string]: unknown;
  } | null;
};

/**
 * Symbol-keyed metadata stays in-process through object spreads while
 * JSON.stringify omits it. This lets an Anthropic backend receive exact native
 * controls/history without leaking Anthropic-only fields to OpenAI providers.
 */
export const ANTHROPIC_REQUEST_METADATA = Symbol.for(
  "@routekit/gateway/anthropic-request-metadata"
);
export const ANTHROPIC_MESSAGE_CONTENT = Symbol.for(
  "@routekit/gateway/anthropic-message-content"
);

export type AnthropicNativeContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

// Reasoning rides two distinct wire fields: `reasoning_content` carries
// Gateway narration beats, while `reasoning` carries upstream model thinking.
export type OpenAiDelta = {
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  reasoning_details?: AnthropicReasoningDetail[];
  tool_calls?: OpenAiToolCall[];
};

export type OpenAiChoice = {
  delta?: OpenAiDelta;
  message?: {
    content?: string | null;
    reasoning?: string | null;
    reasoning_content?: string | null;
    reasoning_details?: AnthropicReasoningDetail[];
    tool_calls?: OpenAiToolCall[];
  };
  finish_reason?: string | null;
  anthropic_stop_reason?: string | null;
  anthropic_stop_sequence?: string | null;
};
