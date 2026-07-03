import type { JsonValue } from "@fusionkit/protocol";

import type { HarnessKind } from "./kinds.js";
import type { ApprovalDecision, HarnessRequestType } from "./approvals.js";

/**
 * The raw provider payload an event was normalized from. Normalize *and*
 * keep receipts: downstream consumers work against the canonical union, and
 * debugging/forensics read the raw envelope.
 */
export type HarnessEventRaw = {
  /** Tagged origin, e.g. `codex.exec.json`, `acp.jsonrpc`, `claude.stream-json`. */
  source: string;
  method?: string;
  payload?: JsonValue;
};

/** Canonical item categories, mapped from each provider's tool vocabulary. */
export type HarnessItemType =
  | "assistant_message"
  | "reasoning"
  | "command_execution"
  | "file_change"
  | "web_search"
  | "dynamic_tool_call";

export type HarnessContentStream =
  | "assistant_text"
  | "reasoning_text"
  | "command_output"
  | "tool_output";

export type HarnessTurnEndReason =
  | "completed"
  | "interrupted"
  | "timeout"
  | "aborted"
  | "error";

export type HarnessTokenUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  contextWindow?: number;
};

type BaseEvent = {
  kind: HarnessKind;
  sessionId: string;
  turnId?: string;
  itemId?: string;
  at: string;
  raw?: HarnessEventRaw;
};

export type HarnessEvent =
  | (BaseEvent & { type: "session.started"; resumed: boolean })
  | (BaseEvent & { type: "session.closed"; reason?: string })
  | (BaseEvent & { type: "turn.started" })
  | (BaseEvent & {
      type: "turn.completed";
      endReason: HarnessTurnEndReason;
      usage?: HarnessTokenUsage;
    })
  | (BaseEvent & { type: "turn.failed"; errorCode: string; message: string })
  | (BaseEvent & { type: "item.started"; itemType: HarnessItemType; title?: string })
  | (BaseEvent & {
      type: "item.completed";
      itemType: HarnessItemType;
      status: "completed" | "failed";
      detail?: string;
    })
  | (BaseEvent & { type: "content.delta"; stream: HarnessContentStream; text: string })
  | (BaseEvent & {
      type: "tool.call";
      requestId?: string;
      name: string;
      input?: JsonValue;
    })
  | (BaseEvent & {
      type: "tool.result";
      requestId?: string;
      name: string;
      output?: JsonValue;
      isError: boolean;
    })
  | (BaseEvent & {
      type: "request.opened";
      requestId: string;
      requestType: HarnessRequestType;
      detail?: string;
      input?: JsonValue;
    })
  | (BaseEvent & {
      type: "request.resolved";
      requestId: string;
      decision: ApprovalDecision;
    })
  | (BaseEvent & { type: "token.usage"; usage: HarnessTokenUsage })
  | (BaseEvent & { type: "stderr"; text: string; severity: "warning" | "error" });

export type HarnessEventType = HarnessEvent["type"];

export type { HarnessRequestType } from "./approvals.js";
