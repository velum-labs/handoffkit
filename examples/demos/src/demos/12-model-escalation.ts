import { rmSync } from "node:fs";

import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import { withModel } from "@warrant/adapter-ai-sdk";
import { handoff, localFirst, targets, triggers } from "@warrant/handoff";
import { makeRepo, startStack } from "@warrant/testkit";

import { banner, detail, finale, ok, step } from "../narrate.js";
import type { Demo } from "../registry.js";

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

export const demo: Demo = {
  id: "12",
  title: "model escalation",
  summary:
    "h.model starts on the local model and escalates to cloud under deterministic conditions — a local failure, a context overflow, a prompt-size threshold. Every routing decision lands in the trace, and escalation makes continuation 'needed'.",
  async run() {
    banner(this.id, this.title, this.summary);

    const stack = await startStack({ pool: POOL, startRunner: true });
    const repo = makeRepo({ files: { "notes.md": "# scratch\n" } });
    try {
      step("two models: a small local one (which will choke) and a cloud one");
      const local = new MockLanguageModelV3({
        modelId: "tiny-local-8b",
        doGenerate: async () => {
          throw new Error("prompt exceeds maximum context length of 2048 tokens");
        }
      });
      const cloud = new MockLanguageModelV3({
        modelId: "frontier-cloud",
        doGenerate: async () => ({
          content: [
            {
              type: "text" as const,
              text: "Here is the migration plan, computed with the larger context."
            }
          ],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage,
          warnings: []
        })
      });

      step("h = withModel(handoff({ … continueWhen: [triggers.modelEscalated()] }), { local, cloud })");
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
        { local, cloud }
      );
      detail(`h.model = ${h.model.modelId}`);
      detail(`h.needs(targets.pool("${POOL}")) before any call → ${h.needs(targets.pool(POOL))}`);

      step("one ordinary generateText call — the local model fails, h.model escalates");
      const result = await generateText({
        model: h.model,
        prompt: "analyze the whole repo and produce a migration plan"
      });
      ok(`answer (from cloud): "${result.text}"`);

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
};
