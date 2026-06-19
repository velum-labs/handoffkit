import { generateText } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";

import { withModel } from "@fusionkit/adapter-ai-sdk";
import { handoff, localFirst, targets, triggers } from "@fusionkit/handoff";
import { withStackAndRepo } from "@fusionkit/testkit";

import {
  demoBanner,
  detail,
  finale,
  mockTextModel,
  ok,
  resolveDemoModels,
  step
} from "@fusionkit/example-utils";

const POOL = "eng-prod";

async function main(): Promise<void> {
  demoBanner("12");

  await withStackAndRepo({ pool: POOL, startRunner: true, files: { "notes.md": "# scratch\n" } }, async ({ stack, repo }) => {
    step("two models: a small local one and a cloud one (real when configured)");
    const resolved = resolveDemoModels();
    detail(resolved.description);
    const local: LanguageModelV3 =
      (resolved.source === "live" ? resolved.local : undefined) ??
      mockTextModel("tiny-local-8b", "Quick local answer: the notes file is fine.");
    const cloud: LanguageModelV3 =
      (resolved.source === "live" ? resolved.cloud : undefined) ??
      mockTextModel(
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
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
