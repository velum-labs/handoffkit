import { generateText, stepCountIs } from "ai";
import type { LanguageModel } from "ai";

import { remoteTools } from "@warrant/adapter-ai-sdk";
import { withStackAndRepo } from "@warrant/testkit";

import {
  demoBanner,
  detail,
  finale,
  mockToolThenTextModel,
  ok,
  resolveDemoModels,
  step
} from "@warrant/example-utils";

async function main(): Promise<void> {
  demoBanner("09");

  step("boot a plane + runner; the org policy allows only the command harness");
  await withStackAndRepo({
    pool: "eng-prod",
    startRunner: true,
    policy: (policy) => {
      policy.agents.allow = ["command"];
    },
    files: { "data.csv": "region,revenue\nemea,120\namer,340\napac,95\n" }
  }, async ({ stack, repo }) => {
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
    const model: LanguageModel =
      resolved.source === "live"
        ? resolved.loop
        : mockToolThenTextModel({
            toolName: "shell",
            input: { command },
            text: "There are 3 data rows in data.csv."
          });

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
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
