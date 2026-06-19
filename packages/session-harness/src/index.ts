/**
 * @fusionkit/session-harness — drives vendor agent harnesses through the AI SDK
 * harness abstraction (`HarnessAgent`) inside a sandbox, under the same
 * governed-session contract as every other backend: workspace staged in,
 * structured evidence in the receipt, secrets via the broker.
 *
 * The generic backend is binding-driven. Two bindings ship here:
 *
 *  - `claudeCodeBinding` / `aiSdkHarnessBackend`: Claude Code in a Vercel
 *    Sandbox microVM (vercel-sandbox tier).
 *  - `piBinding` / `piHarnessBackend`: Pi on a local just-bash sandbox driving
 *    a local model (hermetic tier) — the cheap worker for a local swarm.
 */
export { AiSdkHarnessBackend, harnessBackend, isAgentRunFor } from "./backend.js";
export type {
  CreateHarnessInput,
  CreateSandboxProviderInput,
  HarnessAdapter,
  HarnessBinding,
  HarnessSandboxProvider
} from "./backend.js";
export {
  aiSdkHarnessBackend,
  claudeCodeBinding,
  isClaudeCodeAgentRun
} from "./claude-code.js";
export type {
  AiSdkHarnessBackendOptions,
  ClaudeCodeBindingOptions
} from "./claude-code.js";
export { isPiAgentRun, piBinding, piHarnessBackend } from "./pi.js";
export type { PiBindingOptions, PiHarnessBackendOptions } from "./pi.js";
export { claudeCodeAuthFromEnv, piAuthFromEnv } from "./auth.js";
export { TranscriptRecorder } from "./transcript.js";
export type { TranscriptLine } from "./transcript.js";
