import { rmSync } from "node:fs";

import { generateText, jsonSchema, stepCountIs, tool } from "ai";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import { withCompute } from "@warrant/adapter-compute";
import { agents, handoff, localFirst, targets } from "@warrant/handoff";
import type { ToolJournal } from "@warrant/protocol";
import { makeRepo, startStack } from "@warrant/testkit";

import { banner, detail, finale, ok, resolveDemoModels, step } from "@warrant/example-utils";

const POOL = "eng-prod";

const usage = {
  inputTokens: {
    total: 9,
    noCache: 9,
    cacheRead: undefined,
    cacheWrite: undefined
  },
  outputTokens: { total: 5, text: 5, reasoning: undefined }
};

const DEMO_ID = "11";
const DEMO_TITLE = "the golden interface";
const DEMO_SUMMARY =
  "The predecessor spec's golden shape, built on Warrant primitives: h.tools wraps your AI SDK tools (journaled semantic state), h.needs gates the boundary, h.continueIn moves the work, h.compute is the sandbox surface, h.summary explains it all.";

async function main(): Promise<void> {
  banner(DEMO_ID, DEMO_TITLE, DEMO_SUMMARY);

  const stack = await startStack({
    pool: POOL,
    startRunner: true,
    policy: (policy) => {
      policy.agents.allow = ["mock", "command"];
    }
  });
  const repo = makeRepo({
    files: { "rollout.md": "# rollout plan\nstatus: drafting\n" }
  });
  try {
    step("one context: h = withCompute(handoff({ workspace, plane, policy: localFirst() }), { pool })");
    const h = withCompute(
      handoff({
        workspace: repo,
        plane: { url: stack.planeUrl, adminToken: stack.adminToken },
        actor: { kind: "human", id: "dana@example.com" },
        agent: agents.mock(),
        policy: localFirst({ allowPools: [POOL] })
      }),
      { pool: POOL }
    );

    step("your AI SDK loop, your tools — wrapped once with h.tools(...)");
    const tools = h.tools({
      lookupOwner: tool({
        description: "find the owning team for a service",
        inputSchema: jsonSchema<{ service: string }>({
          type: "object",
          properties: { service: { type: "string" } },
          required: ["service"]
        }),
        execute: async ({ service }) => ({ service, owner: "platform-team" })
      })
    });

    const resolved = resolveDemoModels();
    detail(resolved.description);
    let model: LanguageModel;
    if (resolved.source === "live") {
      model = resolved.loop;
    } else {
      let calls = 0;
      model = new MockLanguageModelV3({
        doGenerate: async () => {
          calls++;
          if (calls === 1) {
            return {
              content: [
                {
                  type: "tool-call" as const,
                  toolCallId: "call-1",
                  toolName: "lookupOwner",
                  input: JSON.stringify({ service: "checkout" })
                }
              ],
              finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
              usage,
              warnings: []
            };
          }
          return {
            content: [
              { type: "text" as const, text: "checkout is owned by platform-team" }
            ],
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage,
            warnings: []
          };
        }
      });
    }

    const result = await generateText({
      model,
      tools,
      prompt:
        "Use the lookupOwner tool to find the owning team of the 'checkout' service, then state the owner.",
      stopWhen: stepCountIs(4)
    });
    ok(`model: "${result.text.trim().slice(0, 120)}" — the tool ran locally, journaled by the context`);
    if (h.trace().filter((e) => e.type === "tool.called").length === 0) {
      throw new Error("the model never used the journaled tool");
    }

    step("the golden gesture, gated by policy: if (h.needs(target)) await h.continueIn(target)");
    const target = targets.pool(POOL);
    detail(`h.needs(targets.pool("${POOL}"))          → ${h.needs(target)}`);
    detail(`h.needs(targets.pool("somewhere-else"))  → ${h.needs(targets.pool("somewhere-else"))} (not allowlisted)`);
    const run = await h.continueIn(target, {
      task: "update rollout.md with the owning team and next steps",
      reason: "fact established locally; the edit runs under governance"
    });
    await run.wait();
    ok(`run ${run.runId} completed on the governed runner`);

    step("the continuation carried the tool journal as content-addressed semantic state");
    const journalHash = run.envelope.checkpoint.semantic?.toolJournalHash ?? "";
    const journal = JSON.parse(
      (await stack.client.getBlob(journalHash)).toString("utf8")
    ) as ToolJournal;
    for (const entry of journal.entries) {
      detail(
        `journal[${entry.seq}] ${entry.toolName}(${JSON.stringify(entry.input)}) → ${JSON.stringify(entry.output)}`
      );
    }
    ok(`journal ${journalHash.slice(0, 12)} is pinned via the envelope inside the signed contract`);

    step("h.compute: the ComputeSDK-shaped surface on the same context");
    const sandbox = await h.compute.sandbox.create();
    const wc = await sandbox.runCommand("wc -l rollout.md");
    detail(`sandbox.runCommand("wc -l rollout.md") → ${wc.output.trim()}`);

    step("h.summary(): the recomputed story of this context");
    const summary = await h.summary();
    detail(`workspace:     ${summary.workspace}`);
    detail(`tool calls:    ${summary.toolCalls}`);
    detail(`checkpoints:   ${summary.checkpoints}`);
    detail(`continuations: ${summary.continuations.planned} planned, ${summary.continuations.denied} denied`);
    detail(`pulls:         ${summary.pulls}`);
    for (const r of summary.runs) {
      detail(`run:           ${r.runId} [${r.status}] → ${r.target}`);
    }

    finale("golden shape, honest substrate: every gesture is a contract, an envelope, or a receipt");
  } finally {
    await stack.stop();
    rmSync(repo, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
