import assert from "node:assert/strict";
import { test } from "node:test";

import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import { loadRouterCard, routedModel, withRoutedModel } from "../routed-model.js";
import type { RouteDecision, RouterCard } from "../routed-model.js";

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

// Two clusters in a 2-d embedding space: axis 0 = "math", axis 1 = "code".
// math-llm aces cluster 0 and fails cluster 1; code-llm mirrors; generalist
// is mediocre everywhere but cheap.
const CARD: RouterCard = loadRouterCard({
  version: "uniroute.router.v1",
  embedder: { model: "fake-embedder", dims: 2 },
  lambda: 0,
  assignment: {
    type: "centroids",
    centroids: [
      [1, 0],
      [0, 1]
    ]
  },
  models: [
    { id: "math-llm", psi: [0.05, 0.9], cost: 2 },
    { id: "code-llm", psi: [0.9, 0.05], cost: 2 },
    { id: "generalist", psi: [0.4, 0.4], cost: 0.1 }
  ]
});

/** The fake embedder the card was "fitted" with: keyword axes. */
async function embed(text: string): Promise<number[]> {
  return [text.includes("math") ? 1 : 0, text.includes("code") ? 1 : 0];
}

test("routes each prompt to its cluster specialist", async () => {
  const decisions: RouteDecision[] = [];
  const model = routedModel({
    card: CARD,
    candidates: {
      "math-llm": textModel("math-llm", "from math"),
      "code-llm": textModel("code-llm", "from code"),
      generalist: textModel("generalist", "from generalist")
    },
    embed,
    onDecision: (d) => decisions.push(d)
  });

  const math = await generateText({ model, prompt: "math: integrate x^2" });
  assert.equal(math.text, "from math");
  const code = await generateText({ model, prompt: "code: write a loop" });
  assert.equal(code.text, "from code");

  assert.equal(decisions.length, 2);
  assert.deepEqual(
    decisions.map((d) => d.model),
    ["math-llm", "code-llm"]
  );
  assert.equal(decisions[0]?.fallback, false);
  assert.ok(Math.abs((decisions[0]?.predictedError ?? 0) - 0.05) < 1e-9);
});

test("lambda trades quality for cost: large lambda picks the cheap generalist", async () => {
  const model = routedModel({
    card: CARD,
    candidates: {
      "math-llm": textModel("math-llm", "from math"),
      "code-llm": textModel("code-llm", "from code"),
      generalist: textModel("generalist", "from generalist")
    },
    embed,
    lambda: 1 // 1 * cost(2) overwhelms any gamma difference in [0,1]
  });
  const result = await generateText({ model, prompt: "math: integrate x^2" });
  assert.equal(result.text, "from generalist");
});

test("falls back to the next-best candidate when the chosen one fails", async () => {
  const decisions: RouteDecision[] = [];
  const model = routedModel({
    card: CARD,
    candidates: {
      "math-llm": failingModel("math-llm", "server crashed"),
      "code-llm": textModel("code-llm", "from code"),
      generalist: textModel("generalist", "from generalist")
    },
    embed,
    onDecision: (d) => decisions.push(d)
  });

  const result = await generateText({ model, prompt: "math: integrate x^2" });
  // Next-best for the math cluster at lambda 0 is the generalist (0.4 < 0.9).
  assert.equal(result.text, "from generalist");
  assert.equal(decisions.length, 2);
  assert.match(decisions[0]?.reason ?? "", /call failed: server crashed/);
  assert.equal(decisions[1]?.fallback, true);
  assert.match(decisions[1]?.reason ?? "", /fallback/);
});

test("fallback: false surfaces the failure", async () => {
  const model = routedModel({
    card: CARD,
    candidates: {
      "math-llm": failingModel("math-llm", "server crashed"),
      "code-llm": textModel("code-llm", "x"),
      generalist: textModel("generalist", "x")
    },
    embed,
    fallback: false
  });
  await assert.rejects(
    generateText({ model, prompt: "math: integrate x^2" }),
    /server crashed/
  );
});

test("softmax assignment cards route through the learned map", async () => {
  // theta rows (with bias column) reproduce the keyword axes sharply.
  const card = loadRouterCard({
    version: "uniroute.router.v1",
    embedder: { model: "fake-embedder", dims: 2 },
    lambda: 0,
    assignment: {
      type: "softmax",
      theta: [
        [10, -10, 0],
        [-10, 10, 0]
      ]
    },
    models: [
      { id: "math-llm", psi: [0.05, 0.9], cost: 1 },
      { id: "code-llm", psi: [0.9, 0.05], cost: 1 }
    ]
  });
  const model = routedModel({
    card,
    candidates: {
      "math-llm": textModel("math-llm", "from math"),
      "code-llm": textModel("code-llm", "from code")
    },
    embed
  });
  const result = await generateText({ model, prompt: "code: refactor this" });
  assert.equal(result.text, "from code");
});

test("card validation fails closed", () => {
  assert.throws(
    () =>
      loadRouterCard({
        version: "uniroute.router.v2",
        embedder: { model: "e", dims: 2 },
        lambda: 0,
        assignment: { type: "centroids", centroids: [[0, 0]] },
        models: [{ id: "a", psi: [0], cost: 1 }]
      }),
    /version/
  );
  assert.throws(
    () =>
      loadRouterCard({
        version: "uniroute.router.v1",
        embedder: { model: "e", dims: 3 }, // centroids are 2-wide
        lambda: 0,
        assignment: { type: "centroids", centroids: [[0, 0]] },
        models: [{ id: "a", psi: [0], cost: 1 }]
      }),
    /dims/
  );
  assert.throws(
    () =>
      loadRouterCard({
        version: "uniroute.router.v1",
        embedder: { model: "e", dims: 2 },
        lambda: 0,
        assignment: { type: "centroids", centroids: [[0, 0]] },
        models: [{ id: "a", psi: [0, 0], cost: 1 }] // psi length != clusters
      }),
    /psi length/
  );
});

test("a candidate missing for a card model is rejected at construction", () => {
  assert.throws(
    () =>
      routedModel({
        card: CARD,
        candidates: { "math-llm": textModel("math-llm", "x") },
        embed
      }),
    /without candidates: code-llm, generalist/
  );
});

test("embedding dimension mismatches are rejected per call", async () => {
  const model = routedModel({
    card: CARD,
    candidates: {
      "math-llm": textModel("math-llm", "x"),
      "code-llm": textModel("code-llm", "x"),
      generalist: textModel("generalist", "x")
    },
    embed: async () => [1, 0, 0] // 3 dims against a 2-dim card
  });
  await assert.rejects(generateText({ model, prompt: "math" }), /dims/);
});

test("withRoutedModel reports decisions into the handoff trace shape", async () => {
  const noted: unknown[] = [];
  const stubHandoff = {
    noteModelDecision: (decision: unknown) => noted.push(decision)
  };
  const h = withRoutedModel(
    // Only noteModelDecision is exercised by the wiring under test.
    stubHandoff as unknown as Parameters<typeof withRoutedModel>[0],
    {
      card: CARD,
      candidates: {
        "math-llm": failingModel("math-llm", "boom"),
        "code-llm": textModel("code-llm", "x"),
        generalist: textModel("generalist", "from generalist")
      },
      embed,
      localModels: ["math-llm", "generalist"]
    }
  );

  const result = await generateText({ model: h.model, prompt: "math: 1+1" });
  assert.equal(result.text, "from generalist");
  assert.deepEqual(
    noted.map((d) => {
      const decision = d as { model: string; route: string; escalated: boolean };
      return [decision.model, decision.route, decision.escalated];
    }),
    [
      ["math-llm", "local", false],
      ["generalist", "local", true]
    ]
  );
});
