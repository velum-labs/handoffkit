/**
 * The live swarm cockpit: a terminal UI around a cloud orchestrator harness
 * that drives a governed local Pi swarm through `swarmTools()`.
 *
 * This is the integration-gated counterpart to the deterministic `run.ts`
 * walkthrough. The whole stack here is AI SDK 7 end to end:
 *
 *   @ai-sdk/tui terminal
 *     -> HarnessAgent orchestrator (Claude Code dynamic workflow / Codex goal)
 *        -> host-executed swarmTools()
 *           -> governed pi workers on a local model + a claude-code cloud target
 *
 * The orchestration loop is the vendor harness's own; Warrant contributes the
 * governed boundary (every worker and escalation a signed run with a receipt)
 * and a human gate: escalate_task — the only tool that spends cloud money —
 * pauses for terminal y/n approval, while the policy-bounded, receipt-backed
 * swarm tools auto-approve.
 *
 * Requires (operator-provided): a running plane + a runner pool with a pi
 * harness backend; Vercel credentials for the orchestrator sandbox; an
 * Anthropic or AI Gateway key for the orchestrator; and the local model
 * endpoint released to the worker pool as the plane secrets OPENAI_BASE_URL
 * and OPENAI_API_KEY (a dummy key is fine for Ollama / mlx-lm). The pi worker
 * never reads the host environment — the endpoint flows through the broker.
 */
import { HarnessAgent } from "@ai-sdk/harness/agent";
import type { HarnessAgentAdapter, HarnessAgentSession } from "@ai-sdk/harness/agent";
import { claudeCode } from "@ai-sdk/harness-claude-code";
import { createVercelSandbox } from "@ai-sdk/sandbox-vercel";
import { runAgentTUI } from "@ai-sdk/tui";
import type { AgentTUIAgent } from "@ai-sdk/tui";

import { swarmTools } from "@fusionkit/adapter-ai-sdk";

const ORCHESTRATOR_INSTRUCTIONS = `You orchestrate a swarm of cheap local coding agents.
Run the task as a workflow: use dispatch_workers to fan independent, file-disjoint
subtasks out across the local swarm, worker_status to watch them, and pull_worker to
review each one from its evidence and compose the clean results. If a worker fails or
its output overlaps already-pulled files, use escalate_task to redo it on the capable
cloud agent. Prefer the local swarm; escalate only what needs it.`;

function required(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/**
 * Wrap the `HarnessAgent` in the small `AgentTUIAgent` adapter the terminal UI
 * expects: a single session is injected into every generate/stream call for
 * the lifetime of the terminal run (per the AI SDK harness terminal-UI guide).
 */
function createTUIAgent(input: {
  agent: HarnessAgent<any, any, any>;
  session: HarnessAgentSession;
}): AgentTUIAgent {
  const { agent, session } = input;
  return {
    version: "agent-v1",
    id: agent.id,
    tools: agent.tools,
    generate: (request) =>
      agent.generate({ ...request, session } as Parameters<typeof agent.generate>[0]),
    stream: (request) =>
      agent.stream({ ...request, session } as Parameters<typeof agent.stream>[0])
  } as AgentTUIAgent;
}

async function main(): Promise<void> {
  const planeUrl = required("WARRANT_PLANE_URL");
  const adminToken = required("WARRANT_ADMIN_TOKEN");
  const workerPool = required("WARRANT_SWARM_WORKER_POOL");
  const cloudPool = required("WARRANT_SWARM_CLOUD_POOL");
  const workspace = required("WARRANT_WORKSPACE") ?? process.cwd();

  if (!planeUrl || !adminToken || !workerPool || !cloudPool) {
    console.error(
      [
        "The live swarm cockpit is integration-gated. Set:",
        "  WARRANT_PLANE_URL          a running plane",
        "  WARRANT_ADMIN_TOKEN        admin token for that plane",
        "  WARRANT_SWARM_WORKER_POOL  a runner pool with a pi harness backend",
        "  WARRANT_SWARM_CLOUD_POOL   a runner pool for claude-code escalations",
        "  WARRANT_WORKSPACE          git workspace to operate on (default: cwd)",
        "",
        "Plus, for the orchestrator harness: Vercel credentials (VERCEL_TOKEN or",
        "VERCEL_OIDC_TOKEN) and an Anthropic/AI Gateway key. Release the local",
        "model endpoint to the worker pool as plane secrets OPENAI_BASE_URL and",
        "OPENAI_API_KEY.",
        "",
        "For a key-free walkthrough of the same governed swarm loop, run: pnpm demo 14"
      ].join("\n")
    );
    return;
  }

  // The governed dispatch surface. Workers are pi on the hermetic tier driving
  // the local model released to the pool; escalations run claude-code on the
  // cloud pool. The local endpoint arrives via the broker as released secrets.
  const swarm = swarmTools({
    workspace,
    plane: { url: planeUrl, adminToken },
    workerPool,
    cloudPool,
    secrets: ["OPENAI_BASE_URL", "OPENAI_API_KEY"],
    workerSession: "hermetic",
    cloudSession: "vercel-sandbox"
  });

  // The orchestrator: Claude Code through the AI SDK harness abstraction. Swap
  // `claudeCode` for `codex` from @ai-sdk/harness-codex to drive the swarm
  // under a Codex goal instead of a dynamic workflow — the flow is identical.
  const agent: HarnessAgent<any, any, any> = new HarnessAgent({
    // pnpm resolves @ai-sdk/harness-claude-code's @ai-sdk/harness peer in a
    // different zod context than the agent's, so the adapter is nominally
    // distinct despite being byte-identical — the same instance-split bridge
    // the session-harness backend performs.
    harness: claudeCode as unknown as HarnessAgentAdapter<any>,
    sandbox: createVercelSandbox({ runtime: "node24", ports: [4000] }),
    instructions: ORCHESTRATOR_INSTRUCTIONS,
    // Cross-version boundary: swarmTools' AI SDK tools are pinned to the
    // adapter's `ai` (v6) while the harness/TUI use `ai` (v7 canary). The
    // tools are structurally AI SDK tools; this bridge is the same kind of
    // pnpm-instance cast the harness backend already performs.
    tools: swarm.tools as unknown as Record<string, never>,
    // The human gate sits on cloud spend only: escalate_task pauses for a
    // terminal y/n. The swarm tools are already policy-bounded and
    // receipt-backed, so they run without a prompt.
    toolApproval: {
      dispatch_workers: "approved",
      worker_status: "approved",
      pull_worker: "approved",
      escalate_task: "user-approval"
    }
  });

  const session = await agent.createSession();
  try {
    await runAgentTUI({
      title: "Warrant swarm — cloud orchestrator, local workers",
      agent: createTUIAgent({ agent, session }),
      tools: "auto-collapsed",
      reasoning: "collapsed"
    });
  } finally {
    await session.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
