export type OpenAiToolCall = {
  id?: string;
  index?: number;
  function?: { name?: string; arguments?: string };
};

// Reasoning rides two distinct wire fields: `reasoning_content` carries
// Gateway narration beats, while `reasoning` carries upstream model thinking.
export type OpenAiDelta = {
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  tool_calls?: OpenAiToolCall[];
};

export type OpenAiChoice = {
  delta?: OpenAiDelta;
  message?: {
    content?: string | null;
    reasoning?: string | null;
    reasoning_content?: string | null;
    tool_calls?: OpenAiToolCall[];
  };
  finish_reason?: string | null;
};
