import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, before, test } from "node:test";

import { generateText, jsonSchema, stepCountIs, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import { agents, handoff, localFirst, targets } from "@fusionkit/handoff";
import type { Handoff } from "@fusionkit/handoff";
import type { ToolJournal } from "@fusionkit/protocol";
import { makeRepo, startStack } from "@fusionkit/testkit";
import type { Stack } from "@fusionkit/testkit";

const POOL = "eng-prod";

let stack: Stack;
let repoDir: string;
let h: Handoff;

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined }
};

before(async () => {
  stack = await startStack({
    pool: POOL,
    startRunner: true,
    policy: (policy) => {
      policy.agents.allow = ["mock", "command"];
    }
  });
  repoDir = makeRepo({ files: { "README.md": "# golden fixture\n" } });
  h = handoff({
    workspace: repoDir,
    plane: { url: stack.planeUrl, adminToken: stack.adminToken },
    actor: { kind: "human", id: "golden-tester" },
    agent: agents.mock(),
    policy: localFirst({ allowPools: [POOL] })
  });
});

after(async () => {
  await stack.stop();
  rmSync(repoDir, { recursive: true, force: true });
});

test("the golden shape: generateText with h.tools, then h.needs/continueIn carrying the journal", async () => {
  // Local tools wrapped by the context: capture, not orchestration.
  const lookups: string[] = [];
  const tools = h.tools({
    lookup: tool({
      description: "look up a fact in the local knowledge base",
      inputSchema: jsonSchema<{ key: string }>({
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"]
      }),
      execute: async ({ key }) => {
        lookups.push(key);
        return { key, value: `fact-about-${key}` };
      }
    })
  });

  let modelCalls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      modelCalls++;
      if (modelCalls === 1) {
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "call-1",
              toolName: "lookup",
              input: JSON.stringify({ key: "deploy-window" })
            }
          ],
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage,
          warnings: []
        };
      }
      return {
        content: [{ type: "text" as const, text: "deploys are fine after 14:00" }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage,
        warnings: []
      };
    }
  });

  const result = await generateText({
    model,
    tools,
    prompt: "when can we deploy?",
    stopWhen: stepCountIs(2)
  });
  assert.equal(result.text, "deploys are fine after 14:00");
  assert.deepEqual(lookups, ["deploy-window"], "the tool executed locally");

  // The journaled call is in the local trace, hashes only.
  const toolEvents = h.trace().filter((e) => e.type === "tool.called");
  assert.equal(toolEvents.length, 1);

  // The golden gesture, guarded by the deterministic policy check.
  assert.equal(h.needs(targets.pool(POOL)), true);
  assert.equal(h.needs(targets.pool("not-allowlisted")), false);
  const run = await h.continueIn(targets.pool(POOL), {
    task: "apply the deploy-window fact to the rollout plan",
    reason: "loop established the fact; continue under governance"
  });
  const outcome = await run.wait({ timeoutMs: 60_000 });
  assert.equal(outcome.status, "completed");

  // The continuation carried the tool journal as content-addressed
  // semantic state, pinned via the envelope inside the signed contract.
  const journalHash = run.envelope.checkpoint.semantic?.toolJournalHash;
  assert.ok(journalHash, "checkpoint must reference the tool journal");
  const journal = JSON.parse(
    (await stack.client.getBlob(journalHash)).toString("utf8")
  ) as ToolJournal;
  assert.equal(journal.version, "warrant.tooljournal.v1");
  assert.equal(journal.entries.length, 1);
  const entry = journal.entries[0];
  assert.ok(entry);
  assert.equal(entry.toolName, "lookup");
  assert.deepEqual(entry.input, { key: "deploy-window" });
  assert.deepEqual(entry.output, { key: "deploy-window", value: "fact-about-deploy-window" });

  // And the summary recomputes the whole story.
  const summary = await h.summary();
  assert.equal(summary.toolCalls, 1);
  assert.equal(summary.checkpoints, 1);
  assert.equal(summary.continuations.planned >= 1, true);
  assert.equal(summary.runs.length, 1);
  const summaryRun = summary.runs[0];
  assert.ok(summaryRun);
  assert.equal(summaryRun.runId, run.runId);
  assert.equal(summaryRun.status, "completed");
  assert.equal(summaryRun.target, `pool:${POOL}`);
});
