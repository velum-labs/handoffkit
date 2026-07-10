/**
 * TypeScript mirror of the simulator's behavior JSON contract
 * (python/fusionkit-testkit — `fusionkit_testkit.behaviors`). These shapes are
 * what `POST /__sim/behaviors` accepts, so a Node test scripts the provider
 * exactly like a Python test does.
 */

/** One tool call the simulated model asks for. */
export type SimToolCall = {
  id: string;
  name: string;
  /** JSON-encoded arguments string, exactly as it should appear on the wire. */
  arguments?: string;
};

/** A provider-shaped error response (rendered into the dialect's native error body). */
export type SimError = {
  status?: number;
  code?: string;
  error_type?: string;
  message?: string;
  /** Emitted as a `retry-after` header (seconds). */
  retry_after?: number | null;
};

/**
 * How the simulator answers one model call. Queue these per model name (FIFO);
 * an unqueued call gets a deterministic echo default.
 */
export type SimBehavior = {
  reply?: string | null;
  tool_calls?: SimToolCall[];
  /** Out-of-band reasoning (OpenAI `reasoning_content` / Anthropic `thinking`). */
  reasoning?: string | null;
  error?: SimError | null;
  /** Sleep before answering (latency injection). */
  delay_s?: number;
  /** Pace between stream frames. */
  chunk_delay_s?: number;
  prompt_tokens?: number;
  completion_tokens?: number | null;
  /** Corrupt a streaming response: close mid-stream or emit an unparseable frame. */
  broken_stream?: "truncate" | "garbage" | null;
  /**
   * Re-split the streamed SSE bytes into wire chunks of exactly this size,
   * crossing frame and UTF-8 rune boundaries (providers make no
   * chunk-alignment promises; client reassembly must be byte-exact).
   */
  chunk_bytes?: number | null;
};

/** The provider wire dialects the simulator speaks (one per FusionKit client family). */
export type SimDialect = "openai-chat" | "anthropic-messages" | "openai-responses" | "google-generate";

/** One journal entry: what actually crossed the provider wire. */
export type SimJournalEntry = {
  seq: number;
  ts: number;
  dialect: SimDialect;
  path: string;
  model: string;
  stream: boolean;
  source: "queued" | "default";
  kind: "reply" | "tool_calls" | "error";
  status: number;
  auth: {
    authorization: string | null;
    x_api_key: string | null;
    x_goog_api_key: string | null;
    chatgpt_account_id: string | null;
  };
  request: Record<string, unknown>;
  reply_preview: string;
  tool_call_names: string[];
};

/** What `queue` accepts: a full behavior, or a plain string as a text reply. */
export type SimBehaviorInput = SimBehavior | string;

/** Coerce a scripted reply into the behavior JSON contract. */
export function asBehavior(input: SimBehaviorInput): SimBehavior {
  return typeof input === "string" ? { reply: input } : input;
}

/** Canned provider failures matching the real wire spellings FusionKit classifies. */
export const simErrors = {
  rateLimited(retryAfter = 0): SimError {
    return {
      status: 429,
      code: "rate_limit_exceeded",
      error_type: "rate_limit_error",
      message: "Rate limit reached, try again later.",
      retry_after: retryAfter
    };
  },
  quotaExhausted(): SimError {
    return {
      status: 429,
      code: "insufficient_quota",
      error_type: "insufficient_quota",
      message: "You exceeded your current quota, please check your plan and billing details."
    };
  },
  invalidApiKey(): SimError {
    return {
      status: 401,
      code: "invalid_api_key",
      error_type: "authentication_error",
      message: "Incorrect API key provided."
    };
  },
  contextOverflow(): SimError {
    return {
      status: 400,
      code: "context_length_exceeded",
      error_type: "invalid_request_error",
      message: "This model's maximum context length is exceeded."
    };
  },
  overloaded(): SimError {
    return { status: 529, code: "overloaded_error", error_type: "overloaded_error", message: "Overloaded" };
  },
  serverError(): SimError {
    return { status: 500, code: "internal_error", error_type: "api_error", message: "simulated provider error" };
  }
} as const;
