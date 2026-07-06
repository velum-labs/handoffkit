/**
 * The single entry point for running one panel round. Callers (the fusion
 * gateway) never choose an execution mechanism — they describe the full
 * situation (repo, history, tools, panel, k) and `k` decides, per the k
 * algebra (`@fusionkit/protocol` panel-k).
 *
 * There are exactly two mechanisms, and the split is load-bearing, not
 * incidental — they satisfy different fidelity contracts and must not merge:
 *
 *  - k = 1 (proposal mode, `runProposalPanels`): members must see the
 *    caller's `(messages, tools)` **verbatim on the wire** (spec B7) — no
 *    re-rendering, no harness framing — which is why this path is a raw
 *    chat-completions call, never an agent-framework loop. Nothing executes,
 *    so the executor-only options (repo, prompt, worktrees, fused sub-agents,
 *    resume cursors, panel trust) are stripped here, mechanically.
 *  - k > 1 / ∞ (rollout mode, `runFusionPanels`): members need an executor,
 *    and an executor can only run tools it owns (spec A4) — so members see a
 *    harness *rendering* (flattened task prompt + the harness's own toolset)
 *    and never the caller's tools (spec B20), stripped here, mechanically.
 */

import { isLookaheadK, isProposalK } from "@fusionkit/protocol";
import type { WireTrajectory } from "@fusionkit/protocol";

import { harnessSupportsFiniteK } from "./harness-factories.js";
import { runProposalPanels } from "./panel-propose.js";
import { runFusionPanels } from "./panel-orchestration.js";
import type { FusionPanelOptions } from "./panel-orchestration.js";

/**
 * One panel round, described honestly: the shared core plus the fields each
 * mechanism consumes. Proposal fields matter only at k = 1; executor fields
 * (`repo`, `outputRoot`, `prompt`, ...) are required exactly when a managed
 * harness will run (k ≠ 1) and may be omitted entirely for proposal rounds —
 * a k = 1 caller writes `runPanelRound({ models, fusionBackendUrl, k: 1,
 * messages, tools })` and nothing more.
 */
export type PanelRoundOptions = Omit<FusionPanelOptions, "repo" | "outputRoot" | "prompt"> & {
  /** Coding workspace for rollout worktrees. Required when k ≠ 1. */
  repo?: string;
  /** Artifact output root for rollout runs. Required when k ≠ 1. */
  outputRoot?: string;
  /** The harness rendering of the task (flattened prompt). Required when k ≠ 1. */
  prompt?: string;
  /** The caller's message history, verbatim. Required when k = 1. */
  messages?: readonly unknown[];
  /** The caller's tool definitions / tool_choice, verbatim (k = 1 only). */
  tools?: unknown;
  toolChoice?: unknown;
};

export async function runPanelRound(options: PanelRoundOptions): Promise<WireTrajectory[]> {
  // Validate at the entry point, before any harness/provider resolution: a
  // bounded lookahead needs a member loop fusionkit owns (B17).
  const harness = options.harness ?? "agent";
  if (isLookaheadK(options.k) && !harnessSupportsFiniteK(harness)) {
    throw new Error(
      `finite k (k=${options.k}) is not supported by the "${harness}" harness: only the generic ` +
        `"agent" harness can stop at a step boundary. Use k=1 (harness-independent) or unset k.`
    );
  }
  if (isProposalK(options.k)) {
    if (options.messages === undefined || options.messages.length === 0) {
      throw new Error(
        "proposal mode (k=1) needs the caller's `messages`: members are single completions " +
          "over the caller's exact history. Rollout modes render `prompt` instead."
      );
    }
    return runProposalPanels({
      models: options.models,
      messages: options.messages,
      fusionBackendUrl: options.fusionBackendUrl,
      ...(options.id !== undefined ? { id: options.id } : {}),
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
      ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
      ...(options.modelEndpoints !== undefined ? { modelEndpoints: options.modelEndpoints } : {}),
      ...(options.fusionApiKey !== undefined ? { fusionApiKey: options.fusionApiKey } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
      ...(options.parentSpanId !== undefined ? { parentSpanId: options.parentSpanId } : {}),
      ...(options.turn !== undefined ? { turn: options.turn } : {})
    });
  }
  // Rollout mode: strip the caller-fidelity fields so B20 ("rollout members
  // never see caller tools") holds by construction, not by downstream care —
  // and require the executor fields with actionable guidance.
  const { messages: _messages, tools: _tools, toolChoice: _toolChoice, repo, outputRoot, prompt, ...rest } = options;
  if (repo === undefined || outputRoot === undefined || prompt === undefined) {
    throw new Error(
      `rollout mode (k=${options.k ?? "∞"}) needs \`repo\`, \`outputRoot\`, and \`prompt\`: members ` +
        "run in managed worktree harnesses over the repo. Provide them, or use k=1 (proposal " +
        "mode), which needs only `messages`."
    );
  }
  return runFusionPanels({ repo, outputRoot, prompt, ...rest });
}
