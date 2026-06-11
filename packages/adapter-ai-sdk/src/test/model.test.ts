import assert from "node:assert/strict";
import { test } from "node:test";

import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import { handoff, localFirst, targets, triggers } from "@warrant/handoff";
import type { ModelDecision } from "@warrant/handoff";

import { handoffModel, withModel } from "../model.js";

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined }
};

function textModel(id: string, text: string): MockLanguageModelV3 {
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

function failingModel(id: string, message: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    modelId: id,
    doGenerate: async () => {
      throw new Error(message);
    }
  });
}

test("local-first: healthy local model handles the call", async () => {
  const decisions: ModelDecision[] = [];
  const model = handoffModel({
    local: textModel("tiny-local", "answer from local"),
    cloud: textModel("frontier-cloud", "answer from cloud"),
    onDecision: (d) => decisions.push(d)
  });

  const result = await generateText({ model, prompt: "hello" });
  assert.equal(result.text, "answer from local");
  assert.deepEqual(decisions, [
    {
      model: "tiny-local",
      route: "local",
      escalated: false,
      reason: "local-first policy"
    }
  ]);
});

test("escalates on local failure, classifies overflow, and stays sticky", async () => {
  const decisions: ModelDecision[] = [];
  const model = handoffModel({
    local: failingModel("tiny-local", "prompt exceeds maximum context length"),
    cloud: textModel("frontier-cloud", "cloud handled it"),
    onDecision: (d) => decisions.push(d)
  });

  const first = await generateText({ model, prompt: "long prompt" });
  assert.equal(first.text, "cloud handled it");
  const escalation = decisions.find((d) => d.escalated);
  assert.ok(escalation);
  assert.equal(escalation.route, "cloud");
  assert.match(escalation.reason, /context-overflow/);

  // Sticky: the next call goes straight to cloud without touching local.
  const second = await generateText({ model, prompt: "another" });
  assert.equal(second.text, "cloud handled it");
  const last = decisions.at(-1);
  assert.ok(last);
  assert.equal(last.route, "cloud");
  assert.equal(last.escalated, false);
  assert.match(last.reason, /sticky/);
});

test("prompt-size threshold escalates before trying local", async () => {
  const decisions: ModelDecision[] = [];
  const model = handoffModel({
    local: failingModel("tiny-local", "should never be called"),
    cloud: textModel("frontier-cloud", "cloud handled the big prompt"),
    maxLocalPromptBytes: 8,
    onDecision: (d) => decisions.push(d)
  });
  const result = await generateText({
    model,
    prompt: "a prompt comfortably larger than eight bytes"
  });
  assert.equal(result.text, "cloud handled the big prompt");
  const decision = decisions[0];
  assert.ok(decision);
  assert.equal(decision.escalated, true);
  assert.match(decision.reason, /over the local threshold/);
});

test("withModel records routing in the trace and gates needs()", async () => {
  const h = withModel(
    handoff({
      workspace: ".",
      plane: { url: "http://127.0.0.1:9", adminToken: "unused" },
      policy: localFirst({ continueWhen: [triggers.modelEscalated()] })
    }),
    {
      local: failingModel("tiny-local", "boom"),
      cloud: textModel("frontier-cloud", "recovered in cloud")
    }
  );

  assert.equal(h.needs(targets.pool("eng-prod")), false, "nothing escalated yet");

  const result = await generateText({ model: h.model, prompt: "do the thing" });
  assert.equal(result.text, "recovered in cloud");

  const routed = h.trace().filter((event) => event.type === "model.routed");
  assert.ok(routed.some((event) => event.type === "model.routed" && event.escalated));
  assert.equal(
    h.needs(targets.pool("eng-prod")),
    true,
    "the escalation makes continuation needed"
  );
  const summary = await h.summary();
  assert.equal(summary.modelRoutes.escalations, 1);
});
