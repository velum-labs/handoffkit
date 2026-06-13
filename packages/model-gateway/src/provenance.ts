/**
 * Provenance hook for the gateway. Every harness's model traffic flows through
 * the gateway, so this is the one place that can record what model was called,
 * over which dialect, and at what cost. v1 keeps this a pure observation sink
 * (off unless a sink is supplied); a fast-follow wires these records into the
 * receipt machinery in `@warrant/protocol` so a local model backing a vendor
 * harness produces signed, offline-verifiable evidence of every call.
 */

/** The wire dialect a request arrived on. */
export type GatewayDialect = "openai-chat" | "anthropic-messages" | "openai-responses";

/** One recorded model call observed at the gateway boundary. */
export type ModelCallRecord = {
  dialect: GatewayDialect;
  /** Model id requested by the caller (after default-model injection). */
  model: string | undefined;
  stream: boolean;
  /** HTTP status returned by the backend. */
  status: number;
  /** Wall-clock time from request receipt to backend response headers. */
  durationMs: number;
};

/** Sink for gateway observations. All methods are optional. */
export type ProvenanceSink = {
  onModelCall?(record: ModelCallRecord): void;
};
