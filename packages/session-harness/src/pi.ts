/**
 * The Pi binding: drives the Pi coding harness through the AI SDK harness
 * abstraction on a local just-bash sandbox. Pi is a *host-runtime* harness —
 * it runs in the runner's own Node process and uses the sandbox only as a
 * virtual filesystem and shell, so there is no microVM and no per-run image
 * to provision. That makes it the cheap worker for a swarm of local models.
 *
 * Two honest limits, stated here and in the README:
 *
 *  - just-bash is a *simulated* shell over a virtual filesystem. A Pi worker
 *    can read, write, edit, grep, and glob the staged workspace, but cannot
 *    run real builds or test suites. Acceptance of a worker's output is
 *    judged from evidence (the diff and receipt), and work that genuinely
 *    needs execution is escalated to a real-OS tier (claude-code on
 *    process/vercel). A Pi binding over `createVercelSandbox` is possible
 *    through the same seam when a worker truly needs execution; it is not the
 *    default.
 *  - Because Pi runs on the host, its model API call leaves from the host
 *    process, not through the just-bash interpreter's network allowlist. The
 *    contract's network policy therefore does not gate Pi's model traffic;
 *    the governed boundary here is the workspace and the released credential
 *    (the local endpoint URL), recorded in the receipt as every other run.
 *
 * Non-pi executions are delegated to a fallback backend (by default
 * `hermeticBackend()`), so a runner can install this backend as its single
 * "hermetic" tier.
 */
import type { RunContract } from "@warrant/protocol";
import type { SessionBackend } from "@warrant/runner";
import { hermeticBackend } from "@warrant/session-hermetic";

import { piAuthFromEnv } from "./auth.js";
import { AiSdkHarnessBackend, isAgentRunFor } from "./backend.js";
import type {
  CreateHarnessInput,
  CreateSandboxProviderInput,
  HarnessAdapter,
  HarnessBinding,
  HarnessSandboxProvider
} from "./backend.js";

// Pi keeps its own per-session state under these directories; they are
// runtime plumbing, not workspace output, so they are excluded from staging
// and mirror-back on top of the shared sandbox ignore set.
const PI_EXTRA_IGNORES = [".pi", ".agent-runs"] as const;

export type PiBindingOptions = {
  /** Pi model id (or name) sent to the local endpoint. */
  model?: string;
  /** Pi's extended-thinking budget level. */
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /**
   * Test/extension seam: supply the harness adapter. The default builds
   * `createPi` with explicit auth from the session env (fail-closed, see
   * auth.ts); overrides take on that responsibility themselves.
   */
  createHarness?: (input: CreateHarnessInput) => HarnessAdapter;
  /**
   * Test/extension seam: supply the sandbox provider. The default builds a
   * fresh just-bash sandbox per session; overrides take on that themselves.
   */
  createSandboxProvider?: (input: CreateSandboxProviderInput) => HarnessSandboxProvider;
};

// The default factories load the AI SDK Pi wrappers lazily, on first use,
// rather than with a top-of-module import. This is deliberate and is the one
// sanctioned exception to the imports-at-top rule in this package:
//
//   - `@ai-sdk/harness-pi` statically imports `@earendil-works/pi-coding-agent`
//     (a ~12 MB host coding-agent runtime) at its own module top level, and
//     `@ai-sdk/sandbox-just-bash` statically imports `just-bash`. Both are
//     genuine *host* runtimes for the real Pi path only.
//   - The governed-plane code, the unit tests (piAuthFromEnv), and the
//     fake-harness e2e path must not require those runtimes to be installed —
//     exactly as the claude-code path never requires `@anthropic-ai/claude-agent-sdk`
//     on the host (it bootstraps inside the sandbox). Both missing peers are
//     declared ignorable in pnpm-workspace.yaml.
//   - A top-level import here would force-load pi-coding-agent the moment
//     anything imports this module, defeating that. So the runtime values are
//     loaded only when a default Pi binding actually executes a run; the types
//     come from `import type` (erased, no runtime cost) at call sites.

function defaultPiHarness(options: PiBindingOptions) {
  return async (input: CreateHarnessInput): Promise<HarnessAdapter> => {
    const { createPi } = await import("@ai-sdk/harness-pi");
    const auth = piAuthFromEnv(input.env);
    const adapter = createPi({
      auth,
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.thinking !== undefined ? { thinkingLevel: options.thinking } : {})
    });
    // Same instance-split bridge as the claude-code binding: harness-pi
    // resolves its own @ai-sdk/harness peer, nominally distinct from the
    // agent's despite the exact-version alignment.
    return adapter as unknown as HarnessAdapter;
  };
}

function defaultPiSandbox(_options: PiBindingOptions) {
  return async (_input: CreateSandboxProviderInput): Promise<HarnessSandboxProvider> => {
    const { createJustBashSandbox } = await import("@ai-sdk/sandbox-just-bash");
    // just-bash exposes no ports and no real network, so there is nothing to
    // configure from the contract here: a fresh virtual filesystem per
    // session is the whole substrate. The workspace is staged into it by the
    // generic backend's onSandboxSession hook.
    return createJustBashSandbox();
  };
}

/** True when the contract asks for the pi agent harness. */
export function isPiAgentRun(contract: RunContract): boolean {
  return isAgentRunFor(contract, "pi");
}

/** The Pi harness binding (hermetic isolation tier). */
export function piBinding(options: PiBindingOptions = {}): HarnessBinding {
  return {
    agentKind: "pi",
    isolation: "hermetic",
    extraIgnores: PI_EXTRA_IGNORES,
    createHarness: options.createHarness ?? defaultPiHarness(options),
    createSandboxProvider: options.createSandboxProvider ?? defaultPiSandbox(options)
  };
}

export type PiHarnessBackendOptions = PiBindingOptions & {
  /**
   * Backend that executes everything this one does not (shell commands, other
   * agent kinds). Defaults to `hermeticBackend()`, so installing this backend
   * never narrows what the "hermetic" tier could already run.
   */
  fallback?: SessionBackend;
};

/**
 * Create an AI SDK harness session backend for the Pi runtime: hosts
 * `piBinding(options)` with a hermetic fallback. This is the runner's single
 * "hermetic" tier when local-model swarm workers are in play.
 */
export function piHarnessBackend(
  options: PiHarnessBackendOptions = {}
): AiSdkHarnessBackend {
  const fallback = options.fallback ?? hermeticBackend();
  return new AiSdkHarnessBackend({ binding: piBinding(options), fallback });
}
