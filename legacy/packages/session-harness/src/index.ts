/**
 * @fusionkit/session-harness drives vendor agent harnesses through the AI SDK
 * harness abstraction inside a sandbox.
 *
 * It runs under the same governed-session contract as every other backend:
 * workspace staged in, structured evidence in the receipt, and secrets supplied
 * through the broker. The generic backend is binding-driven. Shipped bindings
 * cover Claude Code in a Vercel Sandbox microVM and Pi on a local just-bash
 * sandbox for a cheap local swarm worker.
 */
export {
  AiSdkHarnessBackend,
  harnessBackend,
  isAgentRunFor,
  runHarnessSession
} from "./backend.js";
export type {
  CreateHarnessInput,
  CreateSandboxProviderInput,
  HarnessAdapter,
  HarnessBinding,
  HarnessSandboxProvider,
  HarnessSessionRun
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
export { VERCEL_SANDBOX_CREDENTIAL_ENVS } from "@fusionkit/session-vercel-sandbox";
export { TranscriptRecorder } from "./transcript.js";
export type { TranscriptLine } from "./transcript.js";
