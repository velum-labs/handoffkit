import type { ReasoningSelection } from "@velum-labs/routekit-contracts";

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
export type GoogleThoughtDetail = {
  type: "google_thought";
  index: number;
  thought?: string;
  thoughtSignature: string;
};

export function googleThoughtDetailsOf(value: unknown): GoogleThoughtDetail[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): GoogleThoughtDetail[] => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      return [];
    }
    const detail = candidate as Record<string, unknown>;
    if (
      detail.type !== "google_thought" ||
      !Number.isInteger(detail.index) ||
      (detail.index as number) < 0 ||
      typeof detail.thoughtSignature !== "string" ||
      detail.thoughtSignature.length === 0 ||
      (detail.thought !== undefined && typeof detail.thought !== "string")
    ) {
      return [];
    }
    return [{
      type: "google_thought",
      index: detail.index as number,
      ...(typeof detail.thought === "string" ? { thought: detail.thought } : {}),
      thoughtSignature: detail.thoughtSignature
    }];
  });
}

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
  "@velum-labs/routekit-gateway/anthropic-request-metadata"
);
export const ANTHROPIC_MESSAGE_CONTENT = Symbol.for(
  "@velum-labs/routekit-gateway/anthropic-message-content"
);
export const REASONING_SELECTION = Symbol.for(
  "@velum-labs/routekit-gateway/reasoning-selection"
);
export const REASONING_SELECTION_ERROR = Symbol.for(
  "@velum-labs/routekit-gateway/reasoning-selection-error"
);

/**
 * Opaque OpenAI Responses reasoning state carried only inside the gateway.
 * The symbol key survives in-process object spreads but is omitted by JSON,
 * while the value itself is plain serializable data for deterministic replay
 * by a Responses-capable provider backend.
 */
export const RESPONSES_REASONING_METADATA = Symbol.for(
  "@velum-labs/routekit-gateway/responses-reasoning-metadata"
);
export const GOOGLE_TOOL_CALL_INDEXES = Symbol.for(
  "@velum-labs/routekit-gateway/google-tool-call-indexes"
);

export type ResponsesReasoningItem = {
  type: "reasoning";
  id?: string;
  summary?: unknown;
  content?: unknown;
  encrypted_content: string;
};

export type ResponsesReasoningMetadata = {
  items: ResponsesReasoningItem[];
  includeEncryptedContent: boolean;
};

export function attachResponsesReasoningMetadata(
  target: Record<PropertyKey, unknown>,
  metadata: ResponsesReasoningMetadata
): void {
  const current = responsesReasoningMetadataOf(target);
  const combined = current === undefined
    ? metadata
    : {
        items: [...current.items, ...metadata.items],
        includeEncryptedContent:
          current.includeEncryptedContent || metadata.includeEncryptedContent
      };
  Object.defineProperty(target, RESPONSES_REASONING_METADATA, {
    value: combined,
    enumerable: true,
    configurable: true
  });
  const requestEnvelope = requestEnvelopeOf(target);
  const messageEnvelope = messageEnvelopeOf(target);
  updateExtension(target, {
    ...(requestEnvelope?.selection !== undefined ? { selection: requestEnvelope.selection } : {}),
    ...(requestEnvelope?.anthropic !== undefined ? { anthropic: requestEnvelope.anthropic } :
      messageEnvelope?.anthropic !== undefined ? { anthropic: messageEnvelope.anthropic } : {}),
    responses: combined
  });
}

function jsonCompatible(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => jsonCompatible(item, seen))
    : Object.entries(value as Record<string, unknown>).every(
        ([, item]) => jsonCompatible(item, seen)
      );
  seen.delete(value);
  return valid;
}

function jsonCompatibilityErrorOf(
  value: unknown,
  path: string,
  seen = new Set<object>()
): { path: string; message: string } | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) ? undefined : { path, message: `${path} must be JSON-safe` };
  }
  if (typeof value !== "object") return { path, message: `${path} must be JSON-safe` };
  try {
    if (seen.has(value)) return { path, message: `${path} must not contain cycles` };
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
      return { path, message: `${path} must be a plain JSON object` };
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return { path, message: `${path} must not contain symbol keys` };
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)) {
      return { path, message: `${path} must not contain accessor properties` };
    }
    seen.add(value);
    const entries: ReadonlyArray<readonly [string, unknown]> = Array.isArray(value)
      ? Array.from(value.entries(), ([index, item]) => [String(index), item] as const)
      : Object.entries(value as Record<string, unknown>);
    for (const [key, item] of entries) {
      const itemPath = Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`;
      const error = jsonCompatibilityErrorOf(item, itemPath, seen);
      if (error !== undefined) {
        seen.delete(value);
        return error;
      }
    }
    seen.delete(value);
    return undefined;
  } catch {
    seen.delete(value);
    return { path, message: `${path} must be safely inspectable JSON` };
  }
}

function responsesReasoningMetadataSource(value: unknown): unknown {
  const target = objectRecord(value);
  return target?.[RESPONSES_REASONING_METADATA] ??
    objectRecord(target?.[ROUTEKIT_EXTENSION_KEY])?.responses;
}

export function responsesReasoningMetadataErrorOf(value: unknown): string | undefined {
  const metadata = responsesReasoningMetadataSource(value);
  if (metadata === undefined) return undefined;
  const record = objectRecord(metadata);
  if (record === undefined) return "x_routekit.responses must be an object";
  if (!Array.isArray(record.items)) return "x_routekit.responses.items must be an array";
  if (typeof record.includeEncryptedContent !== "boolean") {
    return "x_routekit.responses.includeEncryptedContent must be a boolean";
  }
  for (let index = 0; index < record.items.length; index += 1) {
    const item = objectRecord(record.items[index]);
    const prefix = `x_routekit.responses.items[${index}]`;
    if (item === undefined) return `${prefix} must be an object`;
    if (item.type !== "reasoning") return `${prefix}.type must be "reasoning"`;
    if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) {
      return `${prefix}.encrypted_content must be a non-empty string`;
    }
    if (Object.hasOwn(item, "id") &&
      (typeof item.id !== "string" || item.id.length === 0)) {
      return `${prefix}.id must be a non-empty string`;
    }
    for (const field of ["summary", "content"] as const) {
      if (Object.hasOwn(item, field) && !jsonCompatible(item[field])) {
        return `${prefix}.${field} must be JSON-compatible`;
      }
    }
    for (const [key, field] of Object.entries(item)) {
      if (!jsonCompatible(field)) return `${prefix}.${key} must be JSON-compatible`;
    }
  }
  return undefined;
}

export function responsesReasoningMetadataOf(
  value: unknown
): ResponsesReasoningMetadata | undefined {
  const metadata = responsesReasoningMetadataSource(value);
  if (metadata === undefined || responsesReasoningMetadataErrorOf(value) !== undefined) {
    return undefined;
  }
  const record = metadata as { items: ResponsesReasoningItem[]; includeEncryptedContent: boolean };
  return { items: record.items, includeEncryptedContent: record.includeEncryptedContent };
}

/**
 * Explicitly namespaced, JSON-safe fidelity metadata. Chat providers must strip
 * this extension before egress; compound/proxy layers may serialize it while
 * reconstructing a request for another RouteKit gateway.
 */
export type RouteKitReasoningEnvelope = {
  version: 1;
  selection?: ReasoningSelection;
  anthropic?: { request?: AnthropicRequestMetadata };
  responses?: ResponsesReasoningMetadata;
};

export type RouteKitMessageEnvelope = {
  version: 1;
  anthropic?: { content?: AnthropicNativeContentBlock[] };
  responses?: ResponsesReasoningMetadata;
  google?: { toolCallIndexes?: Record<string, number> };
};

export const ROUTEKIT_EXTENSION_KEY = "x_routekit" as const;

function objectRecord(value: unknown): Record<PropertyKey, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<PropertyKey, unknown>)
    : undefined;
}

function requestEnvelopeOf(value: unknown): RouteKitReasoningEnvelope | undefined {
  const extension = objectRecord(objectRecord(value)?.[ROUTEKIT_EXTENSION_KEY]);
  return extension?.version === 1 ? (extension as RouteKitReasoningEnvelope) : undefined;
}

function messageEnvelopeOf(value: unknown): RouteKitMessageEnvelope | undefined {
  const extension = objectRecord(objectRecord(value)?.[ROUTEKIT_EXTENSION_KEY]);
  return extension?.version === 1 ? (extension as RouteKitMessageEnvelope) : undefined;
}

function updateExtension(
  target: Record<PropertyKey, unknown>,
  update: Record<string, unknown>
): void {
  const current = objectRecord(target[ROUTEKIT_EXTENSION_KEY]);
  target[ROUTEKIT_EXTENSION_KEY] = { ...current, version: 1, ...update };
}

export function attachAnthropicRequestMetadata(
  target: Record<PropertyKey, unknown>,
  metadata: AnthropicRequestMetadata
): void {
  Object.defineProperty(target, ANTHROPIC_REQUEST_METADATA, {
    value: metadata,
    enumerable: true
  });
  const envelope = requestEnvelopeOf(target);
  updateExtension(target, {
    anthropic: { ...envelope?.anthropic, request: metadata }
  });
}

export function anthropicRequestMetadataOf(value: unknown): AnthropicRequestMetadata | undefined {
  const record = objectRecord(value);
  const symbolValue = record?.[ANTHROPIC_REQUEST_METADATA];
  if (objectRecord(symbolValue) !== undefined) return symbolValue as AnthropicRequestMetadata;
  const request = requestEnvelopeOf(value)?.anthropic?.request;
  return objectRecord(request) !== undefined ? request : undefined;
}

function anthropicRequestMetadataValueErrorOf(
  value: unknown,
  path: string
): RouteKitRequestValidationError | undefined {
  const metadata = objectRecord(value);
  const invalid = (suffix: string, message: string): RouteKitRequestValidationError => ({
    code: "invalid_reasoning_metadata",
    path: `${path}${suffix}`,
    message: `${path}${suffix} ${message}`
  });
  if (metadata === undefined) return invalid("", "must be an object");
  const unsafe = jsonCompatibilityErrorOf(metadata, path);
  if (unsafe !== undefined) return { code: "invalid_reasoning_metadata", ...unsafe };
  if (Object.hasOwn(metadata, "thinking")) {
    const thinking = objectRecord(metadata.thinking);
    if (thinking === undefined) return invalid(".thinking", "must be an object");
    if (thinking.type !== "enabled" && thinking.type !== "adaptive" && thinking.type !== "disabled") {
      return invalid(".thinking.type", 'must be "enabled", "adaptive", or "disabled"');
    }
    if (thinking.type === "enabled") {
      if (!Number.isInteger(thinking.budget_tokens) || (thinking.budget_tokens as number) <= 0) {
        return invalid(".thinking.budget_tokens", "must be a positive integer");
      }
    } else if (Object.hasOwn(thinking, "budget_tokens")) {
      return invalid(".thinking.budget_tokens", `is not allowed when thinking.type is "${thinking.type}"`);
    }
    if (thinking.type === "disabled" && Object.hasOwn(thinking, "display")) {
      return invalid(".thinking.display", 'is not allowed when thinking.type is "disabled"');
    }
    if (
      thinking.type !== "disabled" &&
      Object.hasOwn(thinking, "display") &&
      thinking.display !== null &&
      thinking.display !== "summarized" &&
      thinking.display !== "omitted"
    ) {
      return invalid(".thinking.display", 'must be "summarized", "omitted", or null');
    }
  }
  if (Object.hasOwn(metadata, "output_config") && metadata.output_config !== null) {
    const output = objectRecord(metadata.output_config);
    if (output === undefined) return invalid(".output_config", "must be an object or null");
    if (
      Object.hasOwn(output, "effort") &&
      output.effort !== null &&
      (typeof output.effort !== "string" || output.effort.length === 0)
    ) {
      return invalid(".output_config.effort", "must be a non-empty string or null");
    }
    if (typeof output.effort === "string" &&
      (!Object.hasOwn(metadata, "thinking") ||
        (objectRecord(metadata.thinking)?.type !== "enabled" &&
          objectRecord(metadata.thinking)?.type !== "adaptive"))) {
      return invalid(".output_config.effort", "requires enabled or adaptive thinking");
    }
  }
  return undefined;
}

function anthropicSelectionOf(metadata: AnthropicRequestMetadata): ReasoningSelection | undefined {
  const thinking = metadata.thinking;
  const effort = metadata.output_config?.effort;
  if (thinking?.type === "disabled") return { mode: "disabled" };
  if (typeof effort === "string" && effort.length > 0) return { mode: "effort", effort };
  if (thinking?.type === "enabled") {
    return { mode: "budget", budgetTokens: thinking.budget_tokens };
  }
  if (thinking?.type === "adaptive") return { mode: "adaptive" };
  return undefined;
}

function sameReasoningSelection(left: ReasoningSelection, right: ReasoningSelection): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode === "effort" && right.mode === "effort") return left.effort === right.effort;
  if (left.mode === "budget" && right.mode === "budget") {
    return left.budgetTokens === right.budgetTokens;
  }
  return true;
}

function explicitReasoningSelectionOf(value: unknown): ReasoningSelection | undefined {
  const attached = attachedReasoningSelection(value);
  if (attached === undefined) return undefined;
  const validated = validateReasoningSelection(attached);
  return "selection" in validated ? validated.selection : undefined;
}
export function hasExplicitReasoningSelection(value: unknown): boolean {
  return explicitReasoningSelectionOf(value) !== undefined;
}


function anthropicControlConflictErrorOf(value: unknown): RouteKitRequestValidationError | undefined {
  const record = objectRecord(value);
  if (record === undefined) return undefined;
  const metadata = anthropicRequestMetadataOf(record);
  const nativeSelection = metadata === undefined ? undefined : anthropicSelectionOf(metadata);
  const canonical = explicitReasoningSelectionOf(record);
  if (canonical !== undefined && nativeSelection !== undefined &&
    !sameReasoningSelection(canonical, nativeSelection)) {
    return {
      code: "invalid_reasoning_control",
      path: "x_routekit.anthropic.request",
      message: "x_routekit.anthropic.request conflicts with x_routekit.selection"
    };
  }
  if (canonical === undefined && Object.hasOwn(record, "reasoning_effort") &&
    typeof record.reasoning_effort === "string" && record.reasoning_effort.length > 0) {
    const legacy: ReasoningSelection = { mode: "effort", effort: record.reasoning_effort };
    if (nativeSelection !== undefined && !sameReasoningSelection(nativeSelection, legacy)) {
      return {
        code: "invalid_reasoning_control",
        path: "reasoning_effort",
        message: "reasoning_effort conflicts with x_routekit.anthropic.request"
      };
    }
  }
  return undefined;
}

function anthropicRequestMetadataErrorOf(value: unknown): RouteKitRequestValidationError | undefined {
  const record = objectRecord(value);
  if (record === undefined) return undefined;
  const path = "x_routekit.anthropic.request";
  if (Object.hasOwn(record, ANTHROPIC_REQUEST_METADATA)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, ANTHROPIC_REQUEST_METADATA);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      return { code: "invalid_reasoning_metadata", path, message: `${path} must not be accessor-backed` };
    }
    const error = anthropicRequestMetadataValueErrorOf(descriptor?.value, path);
    if (error !== undefined) return error;
  }
  if (!Object.hasOwn(record, ROUTEKIT_EXTENSION_KEY)) return undefined;
  const envelope = objectRecord(record[ROUTEKIT_EXTENSION_KEY]);
  const anthropic = objectRecord(envelope?.anthropic);
  if (envelope !== undefined && Object.hasOwn(envelope, "anthropic") && anthropic === undefined) {
    return { code: "invalid_reasoning_metadata", path: "x_routekit.anthropic", message: "x_routekit.anthropic must be an object" };
  }
  if (anthropic !== undefined && Object.hasOwn(anthropic, "request")) {
    return anthropicRequestMetadataValueErrorOf(anthropic.request, path);
  }
  return undefined;
}

export function attachAnthropicMessageContent(
  target: Record<PropertyKey, unknown>,
  content: readonly AnthropicNativeContentBlock[]
): void {
  const copy = [...content];
  Object.defineProperty(target, ANTHROPIC_MESSAGE_CONTENT, { value: copy, enumerable: true });
  const envelope = messageEnvelopeOf(target);
  updateExtension(target, {
    anthropic: { ...envelope?.anthropic, content: copy }
  });
}

export function anthropicMessageContentOf(
  value: unknown
): AnthropicNativeContentBlock[] | undefined {
  const record = objectRecord(value);
  const symbolValue = record?.[ANTHROPIC_MESSAGE_CONTENT];
  if (Array.isArray(symbolValue)) return symbolValue as AnthropicNativeContentBlock[];
  const content = messageEnvelopeOf(value)?.anthropic?.content;
  return Array.isArray(content) ? content : undefined;
}

export function attachGoogleToolCallIndexes(
  target: Record<PropertyKey, unknown>,
  indexes: Readonly<Record<string, number>>
): void {
  const copy = { ...indexes };
  Object.defineProperty(target, GOOGLE_TOOL_CALL_INDEXES, {
    value: copy,
    enumerable: true,
    configurable: true
  });
  const envelope = messageEnvelopeOf(target);
  updateExtension(target, { google: { ...envelope?.google, toolCallIndexes: copy } });
}

export function googleToolCallIndexesOf(value: unknown): Readonly<Record<string, number>> {
  const record = objectRecord(value);
  const source = record?.[GOOGLE_TOOL_CALL_INDEXES] ?? messageEnvelopeOf(value)?.google?.toolCallIndexes;
  const indexes = objectRecord(source);
  if (indexes === undefined) return {};
  return Object.fromEntries(
    Object.entries(indexes).filter(
      (entry): entry is [string, number] => Number.isInteger(entry[1]) && (entry[1] as number) >= 0
    )
  );
}

/** Remove the private namespaced extension at a final non-RouteKit provider boundary. */
export function withoutRouteKitExtensions(value: unknown): unknown {
  const record = objectRecord(value);
  if (record === undefined) return value;
  const clean: Record<PropertyKey, unknown> = { ...record };
  delete clean[ROUTEKIT_EXTENSION_KEY];
  if (Array.isArray(clean.messages)) {
    clean.messages = clean.messages.map((message) => {
      const item = objectRecord(message);
      if (item === undefined || !Object.hasOwn(item, ROUTEKIT_EXTENSION_KEY)) return message;
      const stripped = { ...item };
      delete stripped[ROUTEKIT_EXTENSION_KEY];
      return stripped;
    });
  }
  return clean;
}

export function attachReasoningSelection(
  target: Record<PropertyKey, unknown>,
  selection: ReasoningSelection
): void {
  Object.defineProperty(target, REASONING_SELECTION, {
    value: selection,
    enumerable: true
  });
  updateExtension(target, { selection });
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

/**
 * Replace all request-local reasoning state with one authoritative selection.
 *
 * The clone is intentional: attached symbol metadata is non-configurable on
 * its source object, while object spread creates replaceable own properties.
 */
export function withReasoningSelection(
  target: Record<string, unknown>,
  selection: ReasoningSelection
): Record<string, unknown> {
  const replaced: Record<PropertyKey, unknown> = { ...target };
  delete replaced[REASONING_SELECTION_ERROR];
  if (selection.mode === "effort") {
    replaced["reasoning_effort"] = selection.effort;
  } else {
    delete replaced["reasoning_effort"];
  }
  attachReasoningSelection(replaced, selection);
  return replaced as Record<string, unknown>;
}

function validateReasoningSelection(value: unknown):
  | { selection: ReasoningSelection }
  | { error: string } {
  const selection = objectRecord(value);
  if (selection === undefined) return { error: "x_routekit.selection must be an object" };
  const mode = selection.mode;
  if (typeof mode !== "string") return { error: "x_routekit.selection.mode must be a string" };
  if (mode === "auto" || mode === "disabled" || mode === "adaptive") {
    if (Object.hasOwn(selection, "effort") || Object.hasOwn(selection, "budgetTokens")) {
      return { error: `x_routekit.selection mode "${mode}" does not accept effort or budgetTokens` };
    }
    return { selection: { mode } };
  }
  if (mode === "effort") {
    if (typeof selection.effort !== "string" || selection.effort.length === 0) {
      return { error: "x_routekit.selection effort must be a non-empty string" };
    }
    if (Object.hasOwn(selection, "budgetTokens")) {
      return { error: 'x_routekit.selection mode "effort" does not accept budgetTokens' };
    }
    return { selection: { mode, effort: selection.effort } };
  }
  if (mode === "budget") {
    if (!Number.isInteger(selection.budgetTokens) || (selection.budgetTokens as number) <= 0) {
      return { error: "x_routekit.selection budgetTokens must be a positive integer" };
    }
    if (Object.hasOwn(selection, "effort")) {
      return { error: 'x_routekit.selection mode "budget" does not accept effort' };
    }
    return { selection: { mode, budgetTokens: selection.budgetTokens as number } };
  }
  return { error: `x_routekit.selection.mode is unsupported: ${JSON.stringify(mode)}` };
}

function attachedReasoningSelection(value: unknown): unknown {
  const record = objectRecord(value);
  if (record === undefined) return undefined;
  if (record[REASONING_SELECTION] !== undefined) return record[REASONING_SELECTION];
  return requestEnvelopeOf(record)?.selection;
}

export type RouteKitRequestValidationError = {
  code: "invalid_reasoning_control" | "invalid_reasoning_metadata";
  path: string;
  message: string;
};

function prefixMetadataError(message: string, prefix: string): string {
  return message.startsWith("x_routekit") ? `${prefix}${message.slice("x_routekit".length)}` : `${prefix}: ${message}`;
}

function anthropicContentErrorOf(
  value: unknown,
  path: string
): RouteKitRequestValidationError | undefined {
  const invalid = (suffix: string, message: string): RouteKitRequestValidationError => ({
    code: "invalid_reasoning_metadata",
    path: `${path}${suffix}`,
    message: `${path}${suffix} ${message}`
  });
  if (!Array.isArray(value)) return invalid("", "must be an array");
  for (let index = 0; index < value.length; index += 1) {
    const blockPath = `${path}[${index}]`;
    const block = objectRecord(value[index]);
    if (block === undefined) return invalid(`[${index}]`, "must be an object");
    if (typeof block.type !== "string" || block.type.length === 0) {
      return invalid(`[${index}].type`, "must be a non-empty string");
    }
    if (block.type === "text" && typeof block.text !== "string") {
      return invalid(`[${index}].text`, "must be a string");
    }
    if (block.type === "thinking") {
      if (typeof block.thinking !== "string") return invalid(`[${index}].thinking`, "must be a string");
      if (typeof block.signature !== "string" || block.signature.length === 0) {
        return invalid(`[${index}].signature`, "must be a non-empty string");
      }
    }
    if (block.type === "redacted_thinking" &&
      (typeof block.data !== "string" || block.data.length === 0)) {
      return invalid(`[${index}].data`, "must be a non-empty string");
    }
    if (block.type === "tool_use") {
      if (typeof block.id !== "string" || block.id.length === 0) {
        return invalid(`[${index}].id`, "must be a non-empty string");
      }
      if (typeof block.name !== "string" || block.name.length === 0) {
        return invalid(`[${index}].name`, "must be a non-empty string");
      }
      if (!Object.hasOwn(block, "input")) return invalid(`[${index}].input`, "is required");
    }
    const unsafe = jsonCompatibilityErrorOf(block, blockPath);
    if (unsafe !== undefined) return { code: "invalid_reasoning_metadata", ...unsafe };
  }
  return undefined;
}

function messageEnvelopeErrorOf(value: unknown, path: string): RouteKitRequestValidationError | undefined {
  const record = objectRecord(value);
  if (record === undefined) return undefined;
  const contentPath = `${path}.anthropic.content`;
  if (Object.hasOwn(record, ANTHROPIC_MESSAGE_CONTENT)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, ANTHROPIC_MESSAGE_CONTENT);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      return { code: "invalid_reasoning_metadata", path: contentPath, message: `${contentPath} must not be accessor-backed` };
    }
    const error = anthropicContentErrorOf(descriptor?.value, contentPath);
    if (error !== undefined) return error;
  }
  if (!Object.hasOwn(record, ROUTEKIT_EXTENSION_KEY)) return undefined;
  const envelope = objectRecord(record[ROUTEKIT_EXTENSION_KEY]);
  if (envelope === undefined) {
    return { code: "invalid_reasoning_metadata", path, message: `${path} must be an object` };
  }
  if (envelope.version !== 1) {
    return { code: "invalid_reasoning_metadata", path: `${path}.version`, message: `${path}.version must be 1` };
  }
  const responsesError = responsesReasoningMetadataErrorOf(record);
  if (responsesError !== undefined) {
    return {
      code: "invalid_reasoning_metadata",
      path: `${path}.responses`,
      message: prefixMetadataError(responsesError, path)
    };
  }
  if (Object.hasOwn(envelope, "google")) {
    const google = objectRecord(envelope.google);
    if (google === undefined) return { code: "invalid_reasoning_metadata", path: `${path}.google`, message: `${path}.google must be an object` };
    if (Object.hasOwn(google, "toolCallIndexes")) {
      const indexes = objectRecord(google.toolCallIndexes);
      if (indexes === undefined || Object.entries(indexes).some(([id, index]) => id.length === 0 || !Number.isInteger(index) || (index as number) < 0)) {
        return { code: "invalid_reasoning_metadata", path: `${path}.google.toolCallIndexes`, message: `${path}.google.toolCallIndexes must map non-empty call ids to non-negative integers` };
      }
    }
  }
  if (Object.hasOwn(envelope, "anthropic")) {
    const anthropic = objectRecord(envelope.anthropic);
    if (anthropic === undefined) return { code: "invalid_reasoning_metadata", path: `${path}.anthropic`, message: `${path}.anthropic must be an object` };
    if (Object.hasOwn(anthropic, "content")) {
      return anthropicContentErrorOf(anthropic.content, contentPath);
    }
  }
  return undefined;
}

export function routeKitRequestValidationErrorOf(value: unknown): RouteKitRequestValidationError | undefined {
  const record = objectRecord(value);
  if (record === undefined) return undefined;
  const anthropicError = anthropicRequestMetadataErrorOf(value);
  if (anthropicError !== undefined) return anthropicError;
  const topError = reasoningSelectionErrorOf(value);
  if (topError !== undefined) {
    const metadata = responsesReasoningMetadataErrorOf(value);
    return {
      code: metadata !== undefined ? "invalid_reasoning_metadata" : "invalid_reasoning_control",
      path: metadata !== undefined ? "x_routekit.responses" : "x_routekit.selection",
      message: topError
    };
  }
  const conflictError = anthropicControlConflictErrorOf(value);
  if (conflictError !== undefined) return conflictError;
  if (!Array.isArray(record.messages)) return undefined;
  for (let index = 0; index < record.messages.length; index += 1) {
    const nested = messageEnvelopeErrorOf(record.messages[index], `messages[${index}].x_routekit`);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function reasoningSelectionErrorOf(value: unknown): string | undefined {
  const record = objectRecord(value);
  if (record === undefined) return undefined;
  if (Object.hasOwn(record, ROUTEKIT_EXTENSION_KEY)) {
    const envelope = objectRecord(record[ROUTEKIT_EXTENSION_KEY]);
    if (envelope === undefined) return "x_routekit must be an object";
    if (envelope.version !== 1) return "x_routekit.version must be 1";
  }
  const metadataError = responsesReasoningMetadataErrorOf(record);
  if (metadataError !== undefined) return metadataError;
  const attachedError = record[REASONING_SELECTION_ERROR];
  if (typeof attachedError === "string") return attachedError;
  const attached = attachedReasoningSelection(record);
  if (attached !== undefined) {
    const validated = validateReasoningSelection(attached);
    if ("error" in validated) return validated.error;
  }
  if (
    Object.hasOwn(record, "reasoning_effort") &&
    (typeof record.reasoning_effort !== "string" || record.reasoning_effort.length === 0)
  ) {
    return "reasoning_effort must be a non-empty string";
  }
  return undefined;
}

export function reasoningSelectionOf(value: unknown): ReasoningSelection {
  const record = objectRecord(value);
  if (record !== undefined) {
    const attached = attachedReasoningSelection(record);
    if (attached !== undefined) {
      const validated = validateReasoningSelection(attached);
      if ("selection" in validated) return validated.selection;
      return { mode: "auto" };
    }
    if (typeof record.reasoning_effort === "string" && record.reasoning_effort.length > 0) {
      return { mode: "effort", effort: record.reasoning_effort };
    }
    const metadata = anthropicRequestMetadataOf(record);
    if (metadata !== undefined) {
      const selection = anthropicSelectionOf(metadata);
      if (selection !== undefined) return selection;
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
export type CanonicalReasoningDetail = AnthropicReasoningDetail | GoogleThoughtDetail;

export type OpenAiDelta = {
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  reasoning_details?: CanonicalReasoningDetail[];
  tool_calls?: OpenAiToolCall[];
};

export type OpenAiChoice = {
  delta?: OpenAiDelta;
  message?: {
    content?: string | null;
    reasoning?: string | null;
    reasoning_content?: string | null;
    reasoning_details?: CanonicalReasoningDetail[];
    tool_calls?: OpenAiToolCall[];
  };
  finish_reason?: string | null;
  anthropic_stop_reason?: string | null;
  anthropic_stop_sequence?: string | null;
};
