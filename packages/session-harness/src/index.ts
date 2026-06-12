/**
 * @warrant/session-harness — drives vendor agent harnesses through the AI
 * SDK harness abstraction (HarnessAgent + @ai-sdk/harness-claude-code)
 * inside Vercel Sandbox microVMs, under the same governed-session contract
 * as every other backend: workspace staged in, egress policy at the VM
 * boundary, secrets via the broker, structured evidence in the receipt.
 */
export {
  AiSdkHarnessBackend,
  aiSdkHarnessBackend,
  executionSpecFor,
  isClaudeCodeAgentRun
} from "./backend.js";
export type {
  AiSdkHarnessBackendOptions,
  CreateHarnessInput,
  CreateSandboxProviderInput,
  HarnessAdapter
} from "./backend.js";
export { claudeCodeAuthFromEnv, SUPPORTED_AUTH_VARS } from "./auth.js";
export type { ClaudeCodeAuth } from "./auth.js";
export { TranscriptRecorder } from "./transcript.js";
export type { TranscriptLine } from "./transcript.js";
