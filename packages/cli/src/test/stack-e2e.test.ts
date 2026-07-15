/**
 * Cross-process stack matrix: every gateway front door x {JSON, SSE,
 * multi-turn tool loop}, generated from the testkit's `DOOR_PROFILES` axis —
 * driving the REAL Node fusion gateway -> REAL Python engine
 * (`fusionkit serve`) -> scripted provider simulator, with a panel spanning
 * every provider client family (`OpenAI`, Anthropic, Google, Codex). Nothing
 * between the tool's HTTP request and the provider wire is mocked; every wire
 * call is asserted through the journal.
 *
 * Door-agnostic behaviors are matrix-generated; genuinely door-specific
 * surfaces (discovery shapes, count_tokens, embeddings) and cross-door
 * invariants (per-provider passthrough, degradation) follow as targeted
 * tests. Skipped (with the reason) where the Python toolchain is
 * unavailable; the `stack-e2e` CI job runs them for real.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  DOOR_PROFILES,
  callDoor,
  doorFrames,
  simErrors,
  stackToolingSkip
} from "@fusionkit/testkit";

import { startSimFusionStack } from "./sim-stack.js";
import type { SimFusionStack } from "./sim-stack.js";

const SKIP = stackToolingSkip();

/** One panel member per provider client family, plus a dedicated judge. */
const MEMBERS = [
  { id: "alpha", model: "gpt-panel-a", provider: "openai" },
  { id: "beta", model: "claude-panel-b", provider: "anthropic" },
  { id: "gamma", model: "gemini-panel-c", provider: "google" },
  { id: "delta", model: "gpt-codex-panel-d", provider: "codex" },
  { id: "judge", model: "gpt-judge", provider: "openai" }
] as const;

const PANEL_MODELS = ["gpt-panel-a", "claude-panel-b", "gemini-panel-c", "gpt-codex-panel-d"];
const PANEL_ENDPOINT_IDS = ["alpha", "beta", "gamma", "delta"];

const CANDIDATES = Object.fromEntries(
  PANEL_MODELS.map((model) => [model, `candidate from ${model}`])
);

let stack: SimFusionStack;

before(async function () {
  if (SKIP !== false) return;
  stack = await startSimFusionStack({ members: [...MEMBERS], judgeId: "judge" });
});

after(async () => {
  if (SKIP !== false) return;
  await stack.close();
});

async function assertFullPanelOnTheWire(): Promise<void> {
  const journal = await stack.sim.journal();
  const dialects = new Map(journal.map((entry) => [entry.model, entry.dialect]));
  assert.equal(dialects.get("gpt-panel-a"), "openai-chat", await stack.sim.describeJournal());
  assert.equal(dialects.get("claude-panel-b"), "anthropic-messages");
  assert.equal(dialects.get("gemini-panel-c"), "google-generate");
  assert.equal(dialects.get("gpt-codex-panel-d"), "openai-responses");
  assert.equal(
    (await stack.sim.calls({ model: "gpt-judge" })).length,
    2,
    "judge analyzes then synthesizes"
  );
}

// --- the door matrix: fused JSON + fused SSE + multi-turn tool loop per door -------

for (const door of DOOR_PROFILES) {
  test(`[${door.id}] fused turn fans out across all four provider dialects`, { skip: SKIP }, async () => {
    await stack.scriptFusedTurn({ candidates: CANDIDATES, answer: `fused via ${door.id}` });
    const response = await callDoor(stack.gatewayUrl, door, {
      model: "fusion-panel",
      user: "what approach should we take?"
    });
    assert.equal(response.status, 200);
    assert.match(door.textOf(await response.json()), new RegExp(`fused via ${door.id}`));
    await assertFullPanelOnTheWire();
    // k=1 proposal contract: members saw the caller's message verbatim.
    const memberCall = (await stack.sim.calls({ model: "gpt-panel-a" }))[0];
    assert.ok(JSON.stringify(memberCall?.request).includes("what approach should we take?"));
  });

  test(`[${door.id}] fused streaming closes with the door's native marker`, { skip: SKIP }, async () => {
    if (!door.supportsStreaming) return;
    await stack.scriptFusedTurn({ candidates: CANDIDATES, answer: `streamed via ${door.id}` });
    const response = await callDoor(stack.gatewayUrl, door, {
      model: "fusion-panel",
      user: "stream the fused answer",
      stream: true
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const { frames } = await doorFrames(response);
    assert.match(door.streamTextOf(frames), new RegExp(`streamed via ${door.id}`));
    assert.ok(door.streamClosed(frames), `${door.id} stream must close with its native marker`);
  });

  test(
    `[${door.id}] candidate, judge, narration, and synthesizer reasoning survive fusion`,
    { skip: SKIP },
    async () => {
      await stack.scriptFusedTurn({
        candidates: Object.fromEntries(
          PANEL_MODELS.map((model, index) => [
            model,
            {
              reply: `candidate ${index}`,
              reasoning: `PANEL_REASON_${index}_${model}`
            }
          ])
        ),
        answer: {
          reply: `reasoned answer via ${door.id}`,
          reasoning: `SYNTH_REASON_${door.id}`
        }
      });
      const response = await callDoor(stack.gatewayUrl, door, {
        model: "fusion-panel",
        user: "reason carefully and expose the supported reasoning channel",
        stream: true
      });
      assert.equal(response.status, 200);
      const { frames, raw } = await doorFrames(response);
      const reasoning = door.streamReasoningOf(frames);
      assert.match(
        reasoning,
        new RegExp(`SYNTH_REASON_${door.id}`),
        `${door.id} must carry the synthesizer model's own reasoning: ${raw}`
      );
      assert.match(
        reasoning,
        /Fanning out to 4 models/,
        `${door.id} must carry fusion progress narration`
      );
      assert.match(reasoning, /Weighing the candidates/, "judge analysis must be visible");

      // Panel reasoning is evidence for the judge, not only display metadata.
      const judgeRequest = (await stack.sim.calls({ model: "gpt-judge" }))[0];
      const judgeWire = JSON.stringify(judgeRequest?.request);
      for (let index = 0; index < PANEL_MODELS.length; index += 1) {
        assert.ok(
          judgeWire.includes(`PANEL_REASON_${index}_`),
          `candidate ${index}'s reasoning must reach the judge wire`
        );
      }
    }
  );

  test(`[${door.id}] multi-turn fused tool loop round-trips the door's tool dialect`, { skip: SKIP }, async () => {
    // Turn 1: members propose; the fuse step commits a tool call.
    await stack.scriptFusedTurn({
      candidates: CANDIDATES,
      answer: {
        tool_calls: [{ id: "call_cfg", name: "read_file", arguments: '{"path": "config.yaml"}' }]
      }
    });
    const turn1 = await callDoor(stack.gatewayUrl, door, {
      model: "fusion-panel",
      user: "why is the port wrong?",
      withTools: true
    });
    assert.equal(turn1.status, 200);
    const call = door.toolCallOf(await turn1.json());
    assert.ok(call, `${door.id} must surface the committed tool call natively`);
    assert.equal(call.name, "read_file");
    assert.deepEqual(JSON.parse(call.arguments), { path: "config.yaml" });
    // k=1 proposal contract (spec B7): every member was offered the caller's
    // tools verbatim, whichever door the tools arrived through.
    for (const model of PANEL_MODELS) {
      const memberCall = (await stack.sim.calls({ model }))[0];
      assert.ok(
        JSON.stringify(memberCall?.request).includes("read_file"),
        `${model} must be offered the caller's tools via ${door.id}`
      );
    }

    // Turn 2: the caller executed the tool; the loop closes on a fused answer
    // and the tool output must reach the second-round panel wire.
    await stack.scriptFusedTurn({
      candidates: CANDIDATES,
      answer: `final via ${door.id}: port is 8081`
    });
    const turn2 = await callDoor(stack.gatewayUrl, door, {
      model: "fusion-panel",
      user: "why is the port wrong?",
      withTools: true,
      toolExchange: { call, result: "port: 8081" }
    });
    assert.equal(turn2.status, 200);
    assert.match(door.textOf(await turn2.json()), new RegExp(`final via ${door.id}`));
    const memberTurn2 = (await stack.sim.calls({ model: "gpt-panel-a" }))[0];
    assert.ok(
      JSON.stringify(memberTurn2?.request).includes("port: 8081"),
      `tool output must reach the panel wire via ${door.id}: ${await stack.sim.describeJournal()}`
    );
  });
}

// --- cross-door invariants: per-provider vendor passthrough -----------------------------

test("RouteKit endpoint passthrough routes each opaque id to its provider dialect", { skip: SKIP }, async () => {
  await stack.sim.reset();
  const expected: Array<[string, string, string]> = [
    ["alpha", "gpt-panel-a", "openai-chat"],
    ["beta", "claude-panel-b", "anthropic-messages"],
    ["gamma", "gemini-panel-c", "google-generate"],
    ["delta", "gpt-codex-panel-d", "openai-responses"]
  ];
  for (const [, providerModel] of expected) {
    await stack.sim.queue(providerModel, [`${providerModel} passthrough`]);
  }
  for (const [endpointId, providerModel, dialect] of expected) {
    const response = await stack.door.chat({
      model: endpointId,
      messages: [{ role: "user", content: `direct to ${endpointId}` }]
    });
    assert.equal(response.status, 200, `${endpointId} passthrough must succeed`);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    assert.match(body.choices[0]?.message.content ?? "", new RegExp(`${providerModel} passthrough`));
    const calls = await stack.sim.calls({ model: providerModel });
    assert.equal(calls.length, 1, await stack.sim.describeJournal());
    assert.equal(calls[0]?.dialect, dialect);
  }
});

// --- door-specific surfaces --------------------------------------------------------------

test("model discovery doors advertise the fused model and every member", { skip: SKIP }, async () => {
  const models = (await (await stack.door.models()).json()) as { data: Array<{ id: string }> };
  const ids = new Set(models.data.map((entry) => entry.id));
  assert.ok(ids.has("fusion-panel"), "fused ensemble model must be advertised");
  for (const endpointId of PANEL_ENDPOINT_IDS) {
    assert.ok(ids.has(endpointId), `${endpointId} must be advertised as a passthrough`);
  }
  assert.ok(PANEL_MODELS.every((model) => !ids.has(model)), "provider model names stay behind RouteKit");

  // Claude Code's discovery probe (anthropic-version header) gets the Anthropic shape.
  const anthropicModels = (await (await stack.door.models({ anthropicShape: true })).json()) as {
    data: Array<{ id: string }>;
  };
  assert.ok(anthropicModels.data.length > 0);

  // Claude Code's single-model validation probe echoes any advertised id.
  const single = (await (await stack.door.model("fusion-panel")).json()) as { type: string; id: string };
  assert.equal(single.type, "model");
  assert.equal(single.id, "fusion-panel");

  // Cursor probes the models list relative to its BYOK base URL.
  const cursorModels = (await (await stack.door.cursorModels()).json()) as { data: Array<{ id: string }> };
  assert.ok(cursorModels.data.some((entry) => entry.id === "fusion-panel"));
});

test("count_tokens door answers Claude Code's preflight and scales with input", { skip: SKIP }, async () => {
  const count = async (content: string): Promise<number> => {
    const response = await stack.door.countTokens({
      model: "fusion-panel",
      messages: [{ role: "user", content }]
    });
    assert.equal(response.status, 200);
    return ((await response.json()) as { input_tokens: number }).input_tokens;
  };
  const short = await count("hi");
  const long = await count("a much longer message ".repeat(50));
  assert.ok(short > 0);
  assert.ok(long > short * 5, `token estimate must scale with input (short=${short}, long=${long})`);
});

test("embeddings door states its unsupported contract instead of hanging", { skip: SKIP }, async () => {
  const response = await stack.door.embeddings({ model: "fusion-panel", input: "embed me" });
  assert.ok(response.status >= 400, "fusion gateway documents embeddings as unsupported");
  const body = (await response.json()) as { error?: { message?: string } };
  assert.match(body.error?.message ?? "", /not supported/);
});

// --- degradation ---------------------------------------------------------------------------

test("panel degradation: one member's provider 401 still yields a fused answer", { skip: SKIP }, async () => {
  await stack.scriptFusedTurn({
    candidates: {
      "gpt-panel-a": { error: simErrors.invalidApiKey() },
      "claude-panel-b": "the surviving candidate",
      "gemini-panel-c": "another survivor",
      "gpt-codex-panel-d": "a third survivor"
    },
    answer: "fused from the survivors"
  });
  const response = await stack.door.chat({
    model: "fusion-panel",
    messages: [{ role: "user", content: "degrade gracefully" }]
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  assert.match(body.choices[0]?.message.content ?? "", /fused from the survivors/);
  const failed = await stack.sim.calls({ model: "gpt-panel-a" });
  assert.deepEqual(failed.map((entry) => entry.status), [401], "permanent auth failure is not retried");
});
