/**
 * The Claude Code binding: drives the claude-code harness through the AI SDK
 * harness abstraction inside a Vercel Sandbox microVM. The adapter bootstraps
 * the Claude Code runtime inside the sandbox itself (pinned bridge deps,
 * frozen lockfile), so the microVM needs no pre-baked vendor tooling.
 *
 * Status: experimental and integration-gated, like the plain vercel-sandbox
 * backend. It compiles against the real canary packages; running the real
 * path needs Vercel credentials plus a contract-released Anthropic or AI
 * Gateway credential. Non-claude-code executions are delegated unchanged to a
 * fallback backend (by default `vercelSandboxBackend()`), so a runner can
 * install this backend as its single "vercel-sandbox" tier.
 */
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createVercelSandbox } from "@ai-sdk/sandbox-vercel";
import type { RunContract } from "@fusionkit/protocol";
import type { SessionBackend } from "@fusionkit/runner";
import {
  toVercelNetwork,
  vercelCredentialsFromEnv,
  vercelSandboxBackend
} from "@fusionkit/session-vercel-sandbox";

import { claudeCodeAuthFromEnv } from "./auth.js";
import { AiSdkHarnessBackend, isAgentRunFor } from "./backend.js";
import type {
  CreateHarnessInput,
  CreateSandboxProviderInput,
  HarnessAdapter,
  HarnessBinding,
  HarnessSandboxProvider
} from "./backend.js";

const DEFAULT_RUNTIME = "node24";
const DEFAULT_BRIDGE_PORT = 4000;

// On top of the shared sandbox ignore set, the harness's own session-state
// directories are runtime plumbing, not workspace output.
const CLAUDE_CODE_EXTRA_IGNORES = [".claude", ".agent-runs"] as const;

export type ClaudeCodeBindingOptions = {
  /** Sandbox runtime image for the harness bridge. Defaults to node24. */
  runtime?: string;
  /** Sandbox port the in-VM bridge listens on. Defaults to 4000. */
  bridgePort?: number;
  /** Vercel credentials; fall back to the ambient environment. */
  token?: string;
  teamId?: string;
  projectId?: string;
  /** Anthropic model id passed to the claude-code runtime. */
  model?: string;
  /** Cap on internal harness turns before yielding. */
  maxTurns?: number;
  /** Extended-thinking behavior of the underlying runtime. */
  thinking?: "off" | "on" | "adaptive";
  /** Max milliseconds to wait for the in-sandbox bridge to start. */
  startupTimeoutMs?: number;
  /**
   * Test/extension seam: supply the harness adapter. The default builds
   * `createClaudeCode` with explicit auth from the session env (fail-closed,
   * see auth.ts); overrides take on that responsibility themselves.
   */
  createHarness?: (input: CreateHarnessInput) => HarnessAdapter;
  /**
   * Test/extension seam: supply the sandbox provider. The default builds
   * `createVercelSandbox` with the contract's network policy applied at VM
   * creation; overrides take on that responsibility themselves.
   */
  createSandboxProvider?: (input: CreateSandboxProviderInput) => HarnessSandboxProvider;
};

/** True when the contract asks for the claude-code agent harness. */
export function isClaudeCodeAgentRun(contract: RunContract): boolean {
  return isAgentRunFor(contract, "claude-code");
}

function defaultClaudeHarness(options: ClaudeCodeBindingOptions) {
  return (input: CreateHarnessInput): HarnessAdapter => {
    const auth = claudeCodeAuthFromEnv(input.env);
    const adapter = createClaudeCode({
      auth,
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
      ...(options.startupTimeoutMs !== undefined
        ? { startupTimeoutMs: options.startupTimeoutMs }
        : {})
    });
    // pnpm gives @ai-sdk/harness-claude-code its own @ai-sdk/harness instance
    // (different zod peer context), so its HarnessV1 is nominally distinct
    // from the agent's despite being byte-identical. Bridge that split here.
    return adapter as unknown as HarnessAdapter;
  };
}

function defaultClaudeSandbox(options: ClaudeCodeBindingOptions) {
  return (input: CreateSandboxProviderInput): HarnessSandboxProvider => {
    return createVercelSandbox({
      ...vercelCredentialsFromEnv(options),
      runtime: options.runtime ?? DEFAULT_RUNTIME,
      timeout: input.timeoutMs,
      ports: [options.bridgePort ?? DEFAULT_BRIDGE_PORT],
      // Deny-by-default egress from the signed contract, applied at the VM
      // boundary. The bridge bootstrap and the model API are subject to it:
      // a contract that wants this path live must allow the registry and
      // api.anthropic.com (or the gateway host) explicitly.
      networkPolicy: toVercelNetwork(input.contract.network)
    });
  };
}

/** The Claude Code harness binding (vercel-sandbox isolation tier). */
export function claudeCodeBinding(options: ClaudeCodeBindingOptions = {}): HarnessBinding {
  return {
    agentKind: "claude-code",
    isolation: "vercel-sandbox",
    extraIgnores: CLAUDE_CODE_EXTRA_IGNORES,
    createHarness: options.createHarness ?? defaultClaudeHarness(options),
    createSandboxProvider: options.createSandboxProvider ?? defaultClaudeSandbox(options)
  };
}

/**
 * Options for the backward-compatible `aiSdkHarnessBackend()` factory: the
 * Claude Code binding options plus a fallback backend.
 */
export type AiSdkHarnessBackendOptions = ClaudeCodeBindingOptions & {
  /**
   * Backend that executes everything this one does not (shell/argv
   * executions, other agent kinds). Defaults to `vercelSandboxBackend()` with
   * the same credentials, so installing this backend never narrows what the
   * "vercel-sandbox" tier could already run.
   */
  fallback?: SessionBackend;
};

/**
 * Create an AI SDK harness session backend for the Claude Code runtime. The
 * historical entry point; equivalent to hosting `claudeCodeBinding(options)`
 * with a vercel-sandbox fallback.
 */
export function aiSdkHarnessBackend(
  options: AiSdkHarnessBackendOptions = {}
): AiSdkHarnessBackend {
  const fallback =
    options.fallback ??
    vercelSandboxBackend({
      ...(options.token !== undefined ? { token: options.token } : {}),
      ...(options.teamId !== undefined ? { teamId: options.teamId } : {}),
      ...(options.projectId !== undefined ? { projectId: options.projectId } : {})
    });
  return new AiSdkHarnessBackend({ binding: claudeCodeBinding(options), fallback });
}
