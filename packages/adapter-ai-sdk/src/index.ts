/**
 * @warrant/adapter-ai-sdk — the AI SDK side of Warrant for app-owned loops.
 *
 * The application keeps its own `generateText`/`streamText` loop and its own
 * model; Warrant governs the execution boundary. `remoteTools(...)` returns
 * AI SDK-compatible tools whose calls run as signed contracts in governed
 * runner sessions and return with offline-verifiable receipts.
 */
export { remoteTools } from "./remote-tools.js";
export type {
  RemoteToolCallRecord,
  RemoteTools,
  RemoteToolsConfig,
  RemoteToolSet,
  ShellToolInput,
  ShellToolOutput
} from "./remote-tools.js";
