import type { ReasoningSelection } from "@routekit/contracts";

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
    effort?: string | null;
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
export const REASONING_SELECTION = Symbol.for(
  "@routekit/gateway/reasoning-selection"
);
export const REASONING_SELECTION_ERROR = Symbol.for(
  "@routekit/gateway/reasoning-selection-error"
);

export function attachReasoningSelection(
  target: Record<PropertyKey, unknown>,
  selection: ReasoningSelection
): void {
  Object.defineProperty(target, REASONING_SELECTION, {
    value: selection,
    enumerable: true
  });
}

export function attachReasoningSelectionError(
  target: Record<PropertyKey, unknown>,
  message: string
): void {
  Object.defineProperty(target, REASONING_SELECTION_ERROR, {
    value: message,
    enumerable: true
  });
}

export function reasoningSelectionErrorOf(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<PropertyKey, unknown>;
  const attachedError = record[REASONING_SELECTION_ERROR];
  if (typeof attachedError === "string") return attachedError;
  if (
    Object.hasOwn(record, "reasoning_effort") &&
    (typeof record.reasoning_effort !== "string" ||
      record.reasoning_effort.length === 0)
  ) {
    return "reasoning_effort must be a non-empty string";
  }
  return undefined;
}

export function reasoningSelectionOf(value: unknown): ReasoningSelection {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<PropertyKey, unknown>;
    const attached = record[REASONING_SELECTION];
    if (
      attached !== null &&
      typeof attached === "object" &&
      !Array.isArray(attached) &&
      typeof (attached as { mode?: unknown }).mode === "string"
    ) {
      return attached as ReasoningSelection;
    }
    if (
      typeof record.reasoning_effort === "string" &&
      record.reasoning_effort.length > 0
    ) {
      return { mode: "effort", effort: record.reasoning_effort };
    }
  }
  return { mode: "auto" };
}

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
