import { rmSync } from "node:fs";

import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3 } from "@ai-sdk/provider";

import { withModel } from "@warrant/adapter-ai-sdk";
import { handoff, localFirst, targets, triggers } from "@warrant/handoff";
import { makeRepo, startStack } from "@warrant/testkit";

import { banner, detail, finale, ok, resolveDemoModels, step } from "@warrant/example-utils";

const POOL = "eng-prod";

const usage = {
  inputTokens: {
    total: 4,
    noCache: 4,
    cacheRead: undefined,
    cacheWrite: undefined
  },
  outputTokens: { total: 4, text: 4, reasoning: undefined }
};

function mockModel(id: string, text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    modelId: id,
    doGenerate: async () => ({
      content: [{ type: "text" as const, text }],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage,
      warnings: []
    })
  });
}

const DEMO_ID = "12";
const DEMO_TITLE = "model escalation";
const DEMO_SUMMARY =
  "h.model starts on the local model and escalates to cloud under deterministic conditions — here, a prompt-size threshold standing in for 'context too large'. Every routing decision lands in the trace, and escalation makes continuation 'needed'.";

async function main(): Promise<void> {
  banner(DEMO_ID, DEMO_TITLE, DEMO_SUMMARY);

  const stack = await startStack({ pool: POOL, startRunner: true });
  const repo = makeRepo({ files: { "notes.md": "# scratch\n" } });
  try {
    step("two models: a small local one and a cloud one (real when configured)");
    const resolved = resolveDemoModels();
    detail(resolved.description);
    const local: LanguageModelV3 =
      (resolved.source === "live" ? resolved.local : undefined) ??
      mockModel("tiny-local-8b", "Quick local answer: the notes file is fine.");
    const cloud: LanguageModelV3 =
      (resolved.source === "live" ? resolved.cloud : undefined) ??
      mockModel(
        "frontier-cloud",
        "Here is the migration plan, computed with the larger context."
      );

    step("h = withModel(handoff({ … continueWhen: [triggers.modelEscalated()] }), { local, cloud, maxLocalPromptBytes: 600 })");
    const h = withModel(
      handoff({
        workspace: repo,
        plane: { url: stack.planeUrl, adminToken: stack.adminToken },
        actor: { kind: "human", id: "dana@example.com" },
        policy: localFirst({
          allowPools: [POOL],
          continueWhen: [triggers.modelEscalated()]
        })
      }),
      { local, cloud, maxLocalPromptBytes: 600 }
    );
    detail(`h.model = ${h.model.modelId}`);
    detail(`h.needs(targets.pool("${POOL}")) before any call → ${h.needs(targets.pool(POOL))}`);

    step("a small prompt stays on the local model");
    const small = await generateText({
      model: h.model,
      prompt: "In one short sentence: is notes.md worth keeping?"
    });
    ok(`local answer: "${small.text.trim().slice(0, 100)}"`);

    step("a prompt past the local threshold escalates to the cloud model");
    const bigPrompt =
      "Analyze the repository and produce a migration plan. Context dump: " +
      "module inventory and dependency edges ".repeat(20);
    const big = await generateText({ model: h.model, prompt: bigPrompt });
    ok(`cloud answer: "${big.text.trim().slice(0, 100)}"`);

    step("the decision trace explains why the model boundary moved");
    for (const event of h.trace()) {
      if (event.type !== "model.routed") continue;
      detail(
        `model.routed → ${event.route}:${event.model}${event.escalated ? " (ESCALATED)" : ""} — ${event.reason}`
      );
    }

    step("escalation makes continuation 'needed'; the golden gesture follows");
    const needed = h.needs(targets.pool(POOL));
    detail(`h.needs(targets.pool("${POOL}")) after escalation → ${needed}`);
    detail(`fired triggers: ${h.firedTriggers().map((f) => f.reason).join("; ")}`);
    if (!needed) throw new Error("escalation must make continuation needed");
    const run = await h.continueIn(targets.pool(POOL), {
      task: "carry the migration plan forward under governance",
      reason: "local model could not hold the context; work moved to cloud"
    });
    await run.wait();
    ok(`continuation ${run.runId} completed — ${run.url}`);

    const summary = await h.summary();
    detail(
      `summary: ${summary.modelRoutes.local} local route(s), ${summary.modelRoutes.cloud} cloud route(s), ${summary.modelRoutes.escalations} escalation(s)`
    );
    finale("escalation is honest: between calls, deterministic, and fully explained in the trace");
  } finally {
    await stack.stop();
    rmSync(repo, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
