import { rmSync } from "node:fs";

import { generateText, stepCountIs } from "ai";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import { remoteTools } from "@warrant/adapter-ai-sdk";
import { makeRepo, startStack } from "@warrant/testkit";

import { banner, detail, finale, ok, resolveDemoModels, step } from "@warrant/example-utils";

const usage = {
  inputTokens: {
    total: 12,
    noCache: 12,
    cacheRead: undefined,
    cacheWrite: undefined
  },
  outputTokens: { total: 6, text: 6, reasoning: undefined }
};

const DEMO_ID = "09";
const DEMO_TITLE = "AI SDK app-owned loop with governed remote tools";
const DEMO_SUMMARY =
  "Your generateText loop, your model — Warrant governs the tool boundary: every tool call is a signed contract executed on a runner, returned with a verifiable receipt. Honestly labeled: no durability claim attaches to the loop itself.";

async function main(): Promise<void> {
  banner(DEMO_ID, DEMO_TITLE, DEMO_SUMMARY);

  step("boot a plane + runner; the org policy allows only the command harness");
  const stack = await startStack({
    pool: "eng-prod",
    startRunner: true,
    policy: (policy) => {
      policy.agents.allow = ["command"];
    }
  });
  const repo = makeRepo({
    files: { "data.csv": "region,revenue\nemea,120\namer,340\napac,95\n" }
  });
  try {
    step("wrap AI SDK tools: rt = remoteTools({ workspace, plane, pool })");
    const rt = remoteTools({
      workspace: repo,
      plane: { url: stack.planeUrl, adminToken: stack.adminToken },
      pool: "eng-prod",
      actor: { kind: "human", id: "dana@example.com" }
    });

    // Real models when configured (see models.ts), a scripted mock
    // otherwise — the governance is identical in both modes.
    const resolved = resolveDemoModels();
    detail(resolved.description);
    const command = "tail -n +2 data.csv | wc -l > rows.txt && cat rows.txt";
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
                  toolName: "shell",
                  input: JSON.stringify({ command })
                }
              ],
              finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
              usage,
              warnings: []
            };
          }
          return {
            content: [
              { type: "text" as const, text: "There are 3 data rows in data.csv." }
            ],
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage,
            warnings: []
          };
        }
      });
    }

    step("run a completely ordinary AI SDK loop: generateText({ model, tools: rt.tools, … })");
    const result = await generateText({
      model,
      tools: rt.tools,
      prompt:
        "How many data rows are in data.csv (skip the header)? Use the shell tool to count them, then state the number.",
      stopWhen: stepCountIs(4)
    });
    ok(`model answered: "${result.text.trim().slice(0, 120)}"`);

    step("the tool call itself ran on a governed runner, with evidence");
    const calls = rt.calls();
    if (calls.length === 0) {
      throw new Error("the model never used the governed shell tool");
    }
    for (const call of calls) {
      detail(`command: ${call.command}`);
      detail(
        `run ${call.runId}: ${call.status}, exit ${call.exitCode}, contract ${call.contractHash.slice(0, 12)}`
      );
      detail(
        `receipt verified offline: ${call.receiptVerified} · results pulled: ${call.pullMode}`
      );
    }
    const verified = calls.every((call) => call.receiptVerified);
    if (!verified) throw new Error("every tool call must carry a verified receipt");
    ok("the loop stayed app-owned; the execution boundary became governed");
    finale(
      "AI SDK adapter: replace tools with rt.tools and every tool call gains a contract and a receipt"
    );
  } finally {
    await stack.stop();
    rmSync(repo, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
