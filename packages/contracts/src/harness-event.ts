import type { JsonValue } from "./jcs.js";

export type HarnessApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export type HarnessRequestType =
  | "exec_command_approval"
  | "file_change_approval"
  | "file_read_approval"
  | "tool_approval"
  | "tool_user_input";

export type HarnessEventRaw = {
  source: string;
  method?: string;
  payload?: JsonValue;
};

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

type BaseHarnessEvent<K extends string> = {
  kind: K;
  sessionId: string;
  turnId?: string;
  itemId?: string;
  at: string;
  raw?: HarnessEventRaw;
};

export type HarnessEvent<K extends string = string> =
  | (BaseHarnessEvent<K> & { type: "session.started"; resumed: boolean })
  | (BaseHarnessEvent<K> & { type: "session.closed"; reason?: string })
  | (BaseHarnessEvent<K> & { type: "turn.started" })
  | (BaseHarnessEvent<K> & {
      type: "turn.completed";
      endReason: HarnessTurnEndReason;
      usage?: HarnessTokenUsage;
    })
  | (BaseHarnessEvent<K> & { type: "turn.failed"; errorCode: string; message: string })
  | (BaseHarnessEvent<K> & { type: "item.started"; itemType: HarnessItemType; title?: string })
  | (BaseHarnessEvent<K> & {
      type: "item.completed";
      itemType: HarnessItemType;
      status: "completed" | "failed";
      detail?: string;
    })
  | (BaseHarnessEvent<K> & { type: "content.delta"; stream: HarnessContentStream; text: string })
  | (BaseHarnessEvent<K> & {
      type: "tool.call";
      requestId?: string;
      name: string;
      input?: JsonValue;
    })
  | (BaseHarnessEvent<K> & {
      type: "tool.result";
      requestId?: string;
      name: string;
      output?: JsonValue;
      isError: boolean;
    })
  | (BaseHarnessEvent<K> & {
      type: "request.opened";
      requestId: string;
      requestType: HarnessRequestType;
      detail?: string;
      input?: JsonValue;
    })
  | (BaseHarnessEvent<K> & {
      type: "request.resolved";
      requestId: string;
      decision: HarnessApprovalDecision;
    })
  | (BaseHarnessEvent<K> & { type: "token.usage"; usage: HarnessTokenUsage })
  | (BaseHarnessEvent<K> & {
      type: "stderr";
      text: string;
      severity: "warning" | "error";
    });

export type HarnessEventType = HarnessEvent["type"];
