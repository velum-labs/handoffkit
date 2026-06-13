/**
 * @warrant/model-gateway — a native local-model gateway.
 *
 * It fronts a single OpenAI Chat Completions backend (the owned
 * `velum-labs/mlx-lm` fork by default — "mlx_lm.server first") and exposes the
 * wire dialects each agent harness needs so a local model can transparently
 * back them with no change to the user's workflow:
 *
 *  - OpenAI Chat Completions (`/v1/chat/completions`) — opencode, Cursor IDE
 *    plan panel. Implemented (M1).
 *  - Anthropic Messages (`/v1/messages`) — Claude Code. Planned (M2).
 *  - OpenAI Responses (`/v1/responses`) — Codex. Planned (M3).
 *
 * See spec/2026-06-13-local-model-harness-bridge-spec.md.
 */
export { startGateway } from "./server.js";
export type { Gateway, GatewayOptions } from "./server.js";
export { joinPath, OpenAiBackend } from "./backend.js";
export type { Backend, OpenAiBackendOptions } from "./backend.js";
export { MlxBackend } from "./mlx-backend.js";
export type { MlxBackendOptions } from "./mlx-backend.js";
export { createBackend, DEFAULT_MLX_MODEL, resolveBackendConfig } from "./config.js";
export type { BackendConfig } from "./config.js";
export { effectiveModel, isStream, withDefaultModel } from "./adapters/chat.js";
export type { GatewayDialect, ModelCallRecord, ProvenanceSink } from "./provenance.js";
