/**
 * Candidate-structural narration: beats render the candidate wire (proposals,
 * executed evidence, answers) with no mode enum — one rule covers k=1, finite
 * k>1, and k=∞. Only the fan-out/quiet phase copy consumes k (it must speak
 * before candidates exist).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createNarratorState,
  executedEvidence,
  narrationBeat,
  proposalsAgree,
  renderProposal,
  terminalProposal
} from "../frontdoor/narration.js";
import type { JudgeCandidate, NarratorState } from "../frontdoor/narration.js";
import { FusionSessionManager, InMemoryFusionBackendKernelStateStore } from "../fusion-session.js";
import { defaultFusionGatewayLogger } from "../logger.js";

// ---- structure helpers ------------------------------------------------------

const PROPOSAL_WIRE = {
  items: [
    { index: 0, type: "message", text: "let me check" },
    { index: 1, type: "function_call", call_id: "c1", name: "get_weather", arguments: '{"city":"Paris"}' }
  ]
};

const LOOKAHEAD_WIRE = {
  // Finite k: executed call + observation, then the captured k-th batch and
  // the empty trailing output marker the bounded rollout appends.
  items: [
    { index: 0, type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' },
    { index: 1, type: "function_call_output", call_id: "c1", text: "contents" },
    { index: 2, type: "function_call", call_id: "c2", name: "write_file", arguments: '{"path":"a.ts"}' },
    { index: 3, type: "message", text: "" }
  ]
};

const ANSWER_WIRE = {
  items: [
    { index: 0, type: "function_call", call_id: "c1", name: "run", arguments: "{}" },
    { index: 1, type: "function_call_output", call_id: "c1", text: "ok" },
    { index: 2, type: "message", text: "All tests pass." }
  ]
};

test("terminalProposal reads the trailing unexecuted batch across wire shapes", () => {
  assert.deepEqual(terminalProposal(PROPOSAL_WIRE), [
    { name: "get_weather", arguments: '{"city":"Paris"}' }
  ]);
  // Finite k: trailing empty message marker is skipped; the executed call is not proposed.
  assert.deepEqual(terminalProposal(LOOKAHEAD_WIRE), [
    { name: "write_file", arguments: '{"path":"a.ts"}' }
  ]);
  // A completed rollout ends in an answer: no proposal.
  assert.deepEqual(terminalProposal(ANSWER_WIRE), []);
  assert.deepEqual(terminalProposal({}), []);
});

test("executedEvidence counts observations", () => {
  assert.deepEqual(executedEvidence(PROPOSAL_WIRE), { observations: 0 });
  assert.deepEqual(executedEvidence(LOOKAHEAD_WIRE), { observations: 1 });
});

test("proposalsAgree normalizes argument JSON and ignores batch order", () => {
  const a = [{ name: "f", arguments: '{"x": 1, "y": 2}' }];
  const b = [{ name: "f", arguments: '{"x":1,"y":2}' }];
  assert.equal(proposalsAgree(a, b), true);
  assert.equal(proposalsAgree(a, [{ name: "g", arguments: '{"x":1,"y":2}' }]), false);
  assert.equal(proposalsAgree([], []), false);
  const batch1 = [
    { name: "f", arguments: "{}" },
    { name: "g", arguments: "{}" }
  ];
  const batch2 = [
    { name: "g", arguments: "{}" },
    { name: "f", arguments: "{}" }
  ];
  assert.equal(proposalsAgree(batch1, batch2), true);
});

test("renderProposal renders and caps a batch", () => {
  assert.equal(
    renderProposal([{ name: "get_weather", arguments: '{"city":"Paris"}' }]),
    'get_weather({"city":"Paris"})'
  );
  assert.match(renderProposal([{ name: "x", arguments: "y".repeat(200) }]), /…$/);
});

// ---- beats ------------------------------------------------------------------

function judging(state: NarratorState, candidates: JudgeCandidate[]): { headline: string; prose?: string } {
  state.sawPanel = true;
  const beat = narrationBeat(state, { kind: "judging", candidates, at: 1 });
  assert.ok(beat !== null);
  return beat;
}

test("k=1 fan-out narrates proposing, not worktrees; quiet follows suit", () => {
  const state = createNarratorState({ turn: 1, k: 1 });
  const beat = narrationBeat(state, {
    kind: "fanout",
    roster: [
      { id: "kimi", model: "kimi-k2" },
      { id: "qwen3", model: "qwen3-coder" }
    ],
    at: 1
  });
  assert.equal(beat?.headline, "Fanning out to 2 models");
  assert.equal(beat?.prose, "kimi-k2 and qwen3-coder are each proposing one step.");

  const quiet = narrationBeat(state, { kind: "quiet", at: 30_000 });
  assert.match(quiet?.headline ?? "", /^Still proposing — waiting on kimi and qwen3/);
});

test("unset k keeps the worktree copy byte-identical", () => {
  const state = createNarratorState({ turn: 1 });
  const beat = narrationBeat(state, {
    kind: "fanout",
    roster: [
      { id: "kimi", model: "kimi-k2" },
      { id: "qwen3", model: "qwen3-coder" }
    ],
    at: 1
  });
  assert.equal(beat?.prose, "kimi-k2 and qwen3-coder are each taking a shot in isolated worktrees.");
  const quiet = narrationBeat(state, { kind: "quiet", at: 30_000 });
  assert.match(quiet?.headline ?? "", /^Still working/);
});

test("a finish with a proposal renders the concrete step as its gist", () => {
  const state = createNarratorState({ turn: 1, k: 1 });
  state.roster = [{ id: "kimi" }, { id: "qwen3" }];
  state.sawPanel = true;
  const beat = narrationBeat(state, {
    kind: "finish",
    finish: { id: "kimi", ok: true, elapsedMs: 3000, proposal: [{ name: "get_weather", arguments: '{"city":"Paris"}' }] },
    at: 1
  });
  assert.equal(beat?.headline, "kimi is back first — 3s");
  assert.equal(beat?.prose, 'Proposes: get_weather({"city":"Paris"}) (3s)');
});

test("judging unanimous proposals narrates the shared step", () => {
  const state = createNarratorState({ turn: 1 });
  const proposal = [{ name: "get_weather", arguments: '{"city":"Paris"}' }];
  const beat = judging(state, [
    { id: "kimi", ok: true, proposal },
    { id: "qwen3", ok: true, proposal: [{ name: "get_weather", arguments: '{"city": "Paris"}' }] }
  ]);
  assert.equal(beat.headline, "Judging 2 proposals");
  assert.equal(beat.prose, 'kimi and qwen3 propose the same step: get_weather({"city":"Paris"}).');
});

test("judging divergent proposals narrates each side", () => {
  const state = createNarratorState({ turn: 1 });
  const beat = judging(state, [
    { id: "kimi", ok: true, proposal: [{ name: "write_file", arguments: '{"path":"a.ts"}' }] },
    { id: "qwen3", ok: true, proposal: [{ name: "run", arguments: '{"command":"pnpm test"}' }] }
  ]);
  assert.equal(beat.headline, "Judging 2 proposals");
  assert.match(beat.prose ?? "", /kimi proposes write_file/);
  assert.match(beat.prose ?? "", /qwen3 proposes run/);
});

test("a lone proposer among text answers narrates the split", () => {
  const state = createNarratorState({ turn: 1 });
  const beat = judging(state, [
    { id: "kimi", ok: true, proposal: [{ name: "run", arguments: "{}" }] },
    { id: "qwen3", ok: true, finalOutput: "the answer is 42" }
  ]);
  assert.equal(beat.headline, "Judging 2 candidates");
  assert.match(beat.prose ?? "", /kimi proposes run\(\{\}\); qwen3 answers in text\./);
});

test("finite-k candidates narrate lookahead evidence and proposal together", () => {
  const state = createNarratorState({ turn: 1, k: 3 });
  const diff = "diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+new line\n";
  const beat = judging(state, [
    { id: "kimi", ok: true, diff, proposal: [{ name: "run", arguments: '{"command":"pnpm test"}' }] },
    { id: "qwen3", ok: true, diff, proposal: [{ name: "run", arguments: '{"command":"pnpm test"}' }] }
  ]);
  assert.equal(beat.headline, "Judging 2 proposals");
  assert.match(beat.prose ?? "", /propose the same step/);
  assert.match(beat.prose ?? "", /kimi's patch: \+1\/-0 across 1 file/);
  assert.match(beat.prose ?? "", /touch the same files/);
});

test("k=∞ judging output is unchanged (no proposals anywhere)", () => {
  const state = createNarratorState({ turn: 1 });
  const beat = judging(state, [
    { id: "kimi", ok: true, finalOutput: "answer a" },
    { id: "qwen3", ok: true, finalOutput: "answer b" }
  ]);
  assert.equal(beat.headline, "Judging 2 candidates");
  assert.equal(beat.prose, undefined);
});

test("fan-out openers: judge pick wins, panel agreement is the tie opener", () => {
  const picked = createNarratorState({ turn: 1, k: 1, lastPick: "kimi" });
  const pickedBeat = narrationBeat(picked, { kind: "fanout", roster: [{ id: "kimi" }], at: 1 });
  assert.equal(pickedBeat?.headline, "Last round the judge picked kimi — fanning out again");

  const agreed = createNarratorState({
    turn: 1,
    k: 1,
    lastAgreed: 'get_weather({"city":"Paris"})'
  });
  const agreedBeat = narrationBeat(agreed, { kind: "fanout", roster: [{ id: "kimi" }], at: 1 });
  assert.equal(
    agreedBeat?.headline,
    'Last round the panel agreed on get_weather({"city":"Paris"}) — fanning out again'
  );
});

test("round > 1 prefixes headlines; round 1 does not", () => {
  const first = createNarratorState({ turn: 1, k: 1, round: 1 });
  const beat1 = narrationBeat(first, { kind: "fanout", roster: [{ id: "kimi" }], at: 1 });
  assert.equal(beat1?.headline.startsWith("Step"), false);

  const third = createNarratorState({ turn: 1, k: 1, round: 3 });
  const beat3 = narrationBeat(third, { kind: "fanout", roster: [{ id: "kimi" }], at: 1 });
  assert.match(beat3?.headline ?? "", /^Step 3 — /);
});

// ---- round counter ----------------------------------------------------------

test("nextNarrationRound counts per session+turn", () => {
  const manager = new FusionSessionManager({
    ttlMs: 60_000,
    runPanels: async () => [],
    mintTraceId: () => "trace",
    kernelStateStore: new InMemoryFusionBackendKernelStateStore(),
    sessionMeta: {},
    logger: defaultFusionGatewayLogger
  });
  assert.equal(manager.nextNarrationRound("s1", 1), 1);
  assert.equal(manager.nextNarrationRound("s1", 1), 2);
  assert.equal(manager.nextNarrationRound("s1", 2), 1);
  assert.equal(manager.nextNarrationRound("s2", 1), 1);
});
