import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveSession } from "../lib/sessions";
import { stored, syntheticSession } from "./fixture";

test("deriveSession folds a full synthetic session", () => {
  const traceId = "11111111111111111111111111110001";
  const detail = deriveSession(traceId, stored(syntheticSession(traceId)));

  assert.equal(detail.traceId, traceId);
  assert.equal(detail.status, "succeeded");
  assert.equal(detail.dialect, "codex");
  assert.equal(detail.promptPreview, "Fix the add() sign bug so npm test passes.");
  assert.equal(detail.environment?.repo, "/tmp/fusion-sample");
  assert.equal(detail.environment?.judgeModel, "gpt-5.5");
  assert.deepEqual(detail.environment?.harnesses, ["agent"]);
  assert.equal(detail.environment?.models?.length, 2);
  assert.equal(detail.environment?.models?.find((model) => model.id === "gpt")?.provider, "openai");

  // Candidates: live steps ordered, terminal facts from the candidate span.
  assert.equal(detail.candidates.length, 2);
  const gpt = detail.candidates.find((candidate) => candidate.candidateId === "cand_gpt");
  assert.ok(gpt);
  assert.equal(gpt.status, "succeeded");
  assert.equal(gpt.verificationStatus, "passed");
  assert.deepEqual(
    gpt.steps.map((step) => step.index),
    [0, 1, 2]
  );
  assert.equal(gpt.steps[0].type, "reasoning");
  assert.equal(gpt.steps[1].tool_name, "apply_patch");
  assert.equal(gpt.systemPrompt, "You are a coding agent working in a real repository checkout.");
  assert.equal(gpt.prompt, "Fix the add() sign bug so npm test passes.");
  assert.equal(gpt.finalOutput, "Fixed add() to use left + right.");

  // Model calls: the chat span pairs with its start marker.
  const call = detail.modelCalls.find((entry) => entry.candidateId === "cand_gpt");
  assert.ok(call);
  assert.equal(call.status, "succeeded");
  assert.equal(call.latencyS, 0.35);
  assert.equal((call.usage as { total_tokens?: number }).total_tokens, 920);
  assert.equal(call.provider, "openai");

  // Judge flow: thinking -> scored -> synthesis markers + the judge span.
  assert.match(detail.judge.thinking?.raw ?? "", /regression test/);
  assert.equal(detail.judge.scored?.inputIds?.length, 2);
  assert.equal(detail.judge.synthesis?.empty, false);
  assert.equal(detail.judge.final?.decision, "synthesize");
  assert.match(detail.finalOutput ?? "", /left \+ right/);
  assert.deepEqual(detail.evidence, ["npm test passed on fused output"]);

  // Judge steps group under the gateway judge span (Python markers included).
  assert.equal(detail.judgeSteps.length, 1);
  assert.equal(detail.judgeSteps[0].kind, "final");
  assert.equal(detail.judgeSteps[0].turn, 1);
  assert.ok(detail.judgeSteps[0].prompt, "the request marker fills the step prompt");
  assert.match(detail.judgeSteps[0].thinking?.raw ?? "", /regression test/);

  // Narration, cost, counters, duration.
  assert.equal(detail.narration.length, 2);
  assert.equal(detail.narration[0].headline, "Fanning out to 2 models");
  assert.ok(detail.costUsd !== undefined && Math.abs(detail.costUsd - 0.0193) < 1e-9);
  assert.equal(detail.costIncomplete, undefined);
  assert.equal(detail.spanCounts["fusion.candidate.step"], 5);
  assert.equal(detail.spanCounts.chat, 1);
  assert.ok(detail.durationMs > 0);
});

test("deriveSession recovers the prompt from the judge request when no model call carries one", () => {
  const traceId = "11111111111111111111111111110002";
  const spans = stored(
    syntheticSession(traceId).filter((span) => span.name !== "fusion.model_call.started")
  );
  const detail = deriveSession(traceId, spans);
  assert.equal(detail.prompt, "Fix the add() sign bug so npm test passes.");
});

test("deriveSession reports a session with no terminal span as running", () => {
  const traceId = "11111111111111111111111111110003";
  const terminal = new Set(["fusion.run", "fusion.judge", "fusion.fuse"]);
  const spans = stored(syntheticSession(traceId).filter((span) => !terminal.has(span.name)));
  const detail = deriveSession(traceId, spans);
  assert.equal(detail.status, "running");
  assert.equal(detail.judge.final, undefined);
  assert.ok(detail.candidates.length >= 1);
});

test("deriveSession lets the fuse span speak when no gateway judge span exists", () => {
  const traceId = "11111111111111111111111111110004";
  const spans = stored(
    syntheticSession(traceId).filter((span) => span.name !== "fusion.judge" && span.name !== "fusion.run")
  );
  const detail = deriveSession(traceId, spans);
  assert.equal(detail.judge.final?.decision, "synthesize");
  assert.match(detail.finalOutput ?? "", /left \+ right/);
  assert.equal(detail.status, "succeeded");
});

test("a failed candidate and an error chat span surface as failures", () => {
  const traceId = "11111111111111111111111111110005";
  const spans = stored(
    syntheticSession(traceId).map((span) => {
      if (span.name === "fusion.candidate" && span.attributes["fusion.candidate.id"] === "cand_opus") {
        return {
          ...span,
          status: "error" as const,
          attributes: { ...span.attributes, "fusion.status": "failed", "fusion.finish_reason": "timeout" }
        };
      }
      if (span.name.startsWith("chat")) {
        return {
          ...span,
          status: "error" as const,
          attributes: { ...span.attributes, "fusion.error": "upstream 500" }
        };
      }
      return span;
    })
  );
  const detail = deriveSession(traceId, spans);
  const opus = detail.candidates.find((candidate) => candidate.candidateId === "cand_opus");
  assert.equal(opus?.status, "failed");
  assert.equal(opus?.finishReason, "timeout");
  const call = detail.modelCalls.find((entry) => entry.candidateId === "cand_gpt");
  assert.equal(call?.status, "failed");
  assert.equal(call?.error, "upstream 500");
});
