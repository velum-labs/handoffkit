import assert from "node:assert/strict";
import { test } from "node:test";

import { ATTR } from "@fusionkit/protocol";
import {
  emitFusionEvent,
  initFusionTracing,
  jsonAttr,
  newSessionCarrier,
  startFusionSpan
} from "@fusionkit/tracing";
import type { FusionTraceCarrier } from "@fusionkit/tracing";

import { anthropicToChat, openAiSseToAnthropic } from "../adapters/anthropic.js";
import { openAiSseToResponses, responsesToChat } from "../adapters/responses.js";
import {
  changedFiles,
  createNarratorState,
  createTurnNarrator,
  diffStat,
  mergeEventsWithNarration,
  narrationBeat,
  sanitizeGist,
  sseChunkHasPayload
} from "../frontdoor/narration.js";
import type { NarrationWriter, ReasoningDeltaEvent } from "../frontdoor/narration.js";
import { createChatNarrationWriter } from "../frontdoor/narration-writer.js";
import { FusionBackend } from "../fusion-backend.js";
import type { WireTrajectory } from "../fusion-backend.js";
import { startGateway } from "../server.js";

/**
 * Reasoning traces to the front doors: the panel/judge phase is narrated as
 * beats (bold present-tense headline + optional prose) that flow as
 * `delta.reasoning_content` chat chunks, which the Responses and Anthropic
 * translators render on their native reasoning/thinking channels.
 */

function sseStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
}

function chatChunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

// The narrator listens to real in-process spans/events, so tests need a provider.
initFusionTracing({ serviceName: "narration-test" });

type TestSession = { traceId: string; carrier: FusionTraceCarrier };

function emitTurnInfo(session: TestSession, environment: unknown, turn = 1): void {
  emitFusionEvent("gateway", "fusion.turn.info", session.carrier, {
    [ATTR.FUSION_DIALECT]: "fusion-step",
    [ATTR.FUSION_TURN]: turn,
    [ATTR.FUSION_ENVIRONMENT]: jsonAttr(environment)
  });
}

function emitCandidateStarted(session: TestSession, candidateId: string, modelId: string, turn = 1): void {
  emitFusionEvent("panel-model", "fusion.candidate.started", session.carrier, {
    [ATTR.FUSION_CANDIDATE_ID]: candidateId,
    [ATTR.FUSION_MODEL_ID]: modelId,
    [ATTR.FUSION_TURN]: turn
  });
}

function emitCandidateFinished(
  session: TestSession,
  input: {
    candidateId?: string;
    modelId: string;
    turn?: number;
    status?: string;
    stepCount?: number;
    preview?: string;
  }
): void {
  const span = startFusionSpan("panel-model", "fusion.candidate", session.carrier, {
    [ATTR.FUSION_CANDIDATE_ID]: input.candidateId,
    [ATTR.FUSION_MODEL_ID]: input.modelId,
    [ATTR.FUSION_TURN]: input.turn ?? 1
  });
  span.end({
    status: (input.status ?? "succeeded") === "succeeded" ? "succeeded" : "failed",
    attributes: {
      [ATTR.FUSION_STEP_COUNT]: input.stepCount,
      [ATTR.FUSION_FINAL_OUTPUT_PREVIEW]: input.preview
    }
  });
}

function emitJudgeRequest(session: TestSession, trajectories: unknown[], turn = 1, judgeModel = "gpt-5.5"): void {
  emitFusionEvent("judge", "fusion.judge.request", session.carrier, {
    [ATTR.FUSION_JUDGE_MODEL]: judgeModel,
    [ATTR.FUSION_TURN]: turn,
    [ATTR.FUSION_TRAJECTORIES]: jsonAttr(trajectories)
  });
}

const CALC_DIFF = [
  "diff --git a/calculator.js b/calculator.js",
  "--- a/calculator.js",
  "+++ b/calculator.js",
  "@@",
  "-exports.add = (l, r) => l - r;",
  "+exports.add = (l, r) => l + r;",
  ""
].join("\n");

// ---- Responses translator: reasoning item lifecycle ----

test("openAiSseToResponses renders reasoning_content as a reasoning summary item before the answer", async () => {
  const upstream = sseStream(
    chatChunk({ reasoning_content: "**Fanning out to 2 models**\n\n" }),
    chatChunk({ reasoning_content: "**Judging 2 candidates...**\n\n" }),
    chatChunk({ content: "the answer" }),
    chatChunk({}, "stop"),
    "data: [DONE]\n\n"
  );
  const text = await streamText(openAiSseToResponses(upstream, "fusion-panel"));

  assert.match(text, /event: response\.output_item\.added\ndata: \{[^\n]*"type":"reasoning"/);
  assert.match(text, /event: response\.reasoning_summary_part\.added/);
  assert.match(text, /event: response\.reasoning_summary_text\.delta/);
  assert.match(text, /"delta":"\*\*Fanning out to 2 models\*\*\\n\\n"/);
  assert.match(text, /event: response\.reasoning_summary_text\.done/);
  assert.match(text, /event: response\.reasoning_summary_part\.done/);

  // Reasoning opens, and closes, strictly before the first output text delta.
  const reasoningDelta = text.indexOf("response.reasoning_summary_text.delta");
  const reasoningDone = text.indexOf("response.reasoning_summary_text.done");
  const firstText = text.indexOf("response.output_text.delta");
  assert.ok(reasoningDelta >= 0 && reasoningDone >= 0 && firstText >= 0);
  assert.ok(reasoningDelta < reasoningDone && reasoningDone < firstText);

  // The final response object carries the reasoning item ahead of the message.
  const completed = text.slice(text.indexOf("event: response.completed"));
  const payload = JSON.parse(completed.slice(completed.indexOf("data: ") + 6, completed.indexOf("\n\n"))) as {
    response: { output: Array<{ type: string; summary?: Array<{ text: string }> }> };
  };
  assert.equal(payload.response.output[0]?.type, "reasoning");
  assert.match(payload.response.output[0]?.summary?.[0]?.text ?? "", /Fanning out to 2 models/);
  assert.equal(payload.response.output[1]?.type, "message");
});

test("openAiSseToResponses closes reasoning before a tool call and ignores late reasoning", async () => {
  const upstream = sseStream(
    chatChunk({ reasoning_content: "**Judging...**\n\n" }),
    chatChunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "run", arguments: "{}" } }] }),
    chatChunk({ reasoning_content: "late line (must be dropped)\n" }),
    chatChunk({}, "tool_calls"),
    "data: [DONE]\n\n"
  );
  const text = await streamText(openAiSseToResponses(upstream, "fusion-panel"));
  const reasoningDone = text.indexOf("response.reasoning_summary_text.done");
  const toolAdded = text.indexOf('"type":"function_call"');
  assert.ok(reasoningDone >= 0 && toolAdded >= 0 && reasoningDone < toolAdded);
  assert.ok(!text.includes("late line"), "reasoning after the answer starts is dropped");
});

test("openAiSseToResponses emits no reasoning events when the stream has none", async () => {
  const upstream = sseStream(chatChunk({ content: "plain" }), chatChunk({}, "stop"), "data: [DONE]\n\n");
  const text = await streamText(openAiSseToResponses(upstream, "fusion-panel"));
  assert.ok(!text.includes("reasoning"), "no reasoning item or events on a reasoning-free stream");
});

test("responsesToChat drops round-tripped reasoning items and non-iterable content", () => {
  // Codex echoes our reasoning item back verbatim on the next request, with
  // `content: null` — it must be dropped, never iterated or forwarded.
  const chat = responsesToChat(
    {
      input: [
        { type: "message", role: "user", content: "task" },
        {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "**Fanning out to 3 models**\n\n" }],
          content: null
        },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        { type: "message", role: "user", content: "follow-up" }
      ]
    },
    "fusion-panel"
  );
  const messages = chat.messages as Array<{ role: string; content: unknown }>;
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "user"]
  );
  assert.ok(!JSON.stringify(messages).includes("Fanning out"), "narration never leaks into the prompt");
});

// ---- Anthropic translator: thinking block lifecycle ----

test("openAiSseToAnthropic renders reasoning_content as a thinking block before the text block", async () => {
  const upstream = sseStream(
    chatChunk({ reasoning_content: "**Fanning out to the panel**\n\n" }),
    chatChunk({ content: "the answer" }),
    chatChunk({}, "stop"),
    "data: [DONE]\n\n"
  );
  const text = await streamText(openAiSseToAnthropic(upstream, "fusion-panel"));

  assert.match(text, /"content_block":\{"type":"thinking","thinking":""\}/);
  // The canonical narration is bold markdown; Claude renders thinking as plain
  // text, so the markers are stripped by the translator.
  assert.match(text, /"delta":\{"type":"thinking_delta","thinking":"Fanning out to the panel\\n\\n"\}/);

  const thinkingStart = text.indexOf('"type":"thinking"');
  const thinkingStop = text.indexOf('"type":"content_block_stop","index":0');
  const textStart = text.indexOf('"content_block":{"type":"text"');
  assert.ok(thinkingStart >= 0 && thinkingStop >= 0 && textStart >= 0);
  assert.ok(thinkingStart < thinkingStop && thinkingStop < textStart, "thinking closes before the text block opens");
});

test("openAiSseToAnthropic closes thinking before a tool_use block", async () => {
  const upstream = sseStream(
    chatChunk({ reasoning_content: "**Judging...**\n\n" }),
    chatChunk({ tool_calls: [{ index: 0, id: "toolu_1", function: { name: "run", arguments: "{}" } }] }),
    chatChunk({}, "tool_calls"),
    "data: [DONE]\n\n"
  );
  const text = await streamText(openAiSseToAnthropic(upstream, "fusion-panel"));
  const thinkingStop = text.indexOf('"type":"content_block_stop","index":0');
  const toolStart = text.indexOf('"type":"tool_use"');
  assert.ok(thinkingStop >= 0 && toolStart >= 0 && thinkingStop < toolStart);
});

test("anthropicToChat drops round-tripped thinking blocks from assistant messages", () => {
  const chat = anthropicToChat(
    {
      messages: [
        { role: "user", content: "task" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Fanning out to 3 models\n" },
            { type: "text", text: "the answer" }
          ]
        },
        { role: "user", content: "follow-up" }
      ]
    },
    "fusion-panel"
  );
  const messages = chat.messages as Array<{ role: string; content: unknown }>;
  assert.equal(messages[1]?.role, "assistant");
  assert.equal(messages[1]?.content, "the answer", "thinking text never leaks into the conversation");
});

// ---- formatting helpers ----

test("sanitizeGist strips markdown, collapses whitespace, and caps hostile input", () => {
  assert.equal(sanitizeGist("Fix `add()` to use **+**\nsecond line"), "Fix add() to use +");
  assert.equal(sanitizeGist("\n\n   \n# Heading > quote | pipe"), "Heading quote pipe");
  assert.equal(sanitizeGist(""), undefined);
  const long = sanitizeGist(`${"x".repeat(500)} tail`);
  assert.ok(long !== undefined && long.length === 90 && long.endsWith("…"), "hard length cap");
});

test("diffStat and changedFiles parse a unified diff", () => {
  assert.deepEqual(diffStat(CALC_DIFF), { files: 1, added: 1, removed: 1 });
  assert.deepEqual(changedFiles(CALC_DIFF), ["calculator.js"]);
  assert.equal(diffStat(undefined), undefined);
  assert.equal(diffStat(""), undefined);
});

// ---- the beat engine (pure) ----

test("narrationBeat tells the race: fan-out, first finisher, survivors, judging", () => {
  const state = createNarratorState({ turn: 1, judgeModel: "gpt-5.5" });
  const roster = [
    { id: "gpt", model: "gpt-5.5" },
    { id: "sonnet", model: "claude-sonnet-4-6" },
    { id: "gemini", model: "gemini-2.5-pro" }
  ];

  const fanout = narrationBeat(state, { kind: "fanout", roster, at: 0 });
  assert.equal(fanout?.headline, "Fanning out to 3 models");
  assert.equal(
    fanout?.prose,
    "gpt-5.5, claude-sonnet-4-6, and gemini-2.5-pro are each taking a shot in isolated worktrees."
  );
  assert.equal(narrationBeat(state, { kind: "fanout", roster, at: 1 }), null, "fan-out narrates once");

  const first = narrationBeat(state, {
    kind: "finish",
    finish: { id: "sonnet", ok: true, elapsedMs: 42_000, steps: 14, gist: "switch add() to use +" },
    at: 42_000
  });
  assert.equal(first?.headline, "sonnet is back first — 42s");
  assert.equal(first?.prose, "Proposes: switch add() to use + (14 steps, 42s)");

  const timeout = narrationBeat(state, {
    kind: "finish",
    finish: { id: "gemini", ok: false, finishReason: "timeout" },
    at: 90_000
  });
  assert.equal(timeout?.headline, "gemini timed out — gpt still working");

  const last = narrationBeat(state, {
    kind: "finish",
    finish: { id: "gpt", ok: true, elapsedMs: 51_000, steps: 9, gist: "same fix" },
    at: 51_000
  });
  assert.equal(last?.headline, "All 3 candidates in");
  assert.equal(last?.prose, "gpt proposes: same fix (9 steps, 51s)");

  const judging = narrationBeat(state, {
    kind: "judging",
    candidates: [
      { id: "sonnet", ok: true, diff: CALC_DIFF, verificationStatus: "passed" },
      { id: "gpt", ok: true, diff: CALC_DIFF, verificationStatus: "passed" },
      { id: "gemini", ok: false }
    ],
    at: 95_000
  });
  assert.equal(judging?.headline, "Judging the 2 survivors with gpt-5.5");
  assert.equal(
    judging?.prose,
    "sonnet's patch: +1/-1 across 1 file, tests pass. gpt's patch: +1/-1 across 1 file, tests pass. " +
      "sonnet and gpt touch the same files."
  );
});

test("narrationBeat: ordinal progress headline names who is still out", () => {
  const state = createNarratorState({ turn: 1 });
  narrationBeat(state, {
    kind: "fanout",
    roster: [{ id: "gpt" }, { id: "sonnet" }, { id: "gemini" }],
    at: 0
  });
  narrationBeat(state, { kind: "finish", finish: { id: "sonnet", ok: true }, at: 1 });
  const second = narrationBeat(state, { kind: "finish", finish: { id: "gpt", ok: true, gist: "a fix" }, at: 2 });
  assert.equal(second?.headline, "2 of 3 done — waiting on gemini");
  assert.equal(second?.prose, "gpt proposes: a fix");
});

test("narrationBeat: cached-candidate continuation and last-pick opener", () => {
  const continuation = createNarratorState({ turn: 3, judgeModel: "gpt-5.5" });
  const judging = narrationBeat(continuation, { kind: "judging", candidates: [], at: 0 });
  assert.equal(judging?.headline, "Continuing turn 3 — candidates cached, judging with gpt-5.5");

  const opener = createNarratorState({ turn: 2, lastPick: "sonnet" });
  const fanout = narrationBeat(opener, { kind: "fanout", roster: [{ id: "gpt" }], at: 0 });
  assert.equal(fanout?.headline, "Last round the judge picked sonnet — fanning out again");
});

test("narrationBeat: quiet beats name the stragglers and the judging phase", () => {
  const state = createNarratorState({ turn: 1, judgeModel: "gpt-5.5" });
  assert.equal(narrationBeat(state, { kind: "quiet", at: 0 }), null, "silent before any panel activity");
  narrationBeat(state, { kind: "fanout", roster: [{ id: "gpt" }, { id: "sonnet" }], at: 0 });
  narrationBeat(state, { kind: "finish", finish: { id: "gpt", ok: true }, at: 10_000 });
  const quiet = narrationBeat(state, { kind: "quiet", at: 70_000 });
  assert.equal(quiet?.headline, "Still working — waiting on sonnet (1m10s)");

  narrationBeat(state, { kind: "finish", finish: { id: "sonnet", ok: true }, at: 80_000 });
  assert.equal(narrationBeat(state, { kind: "quiet", at: 90_000 }), null, "silent once everyone is in");
  narrationBeat(state, { kind: "judging", candidates: [], at: 95_000 });
  const judgingQuiet = narrationBeat(state, { kind: "quiet", at: 130_000 });
  assert.equal(judgingQuiet?.headline, "Still judging — gpt-5.5 at work (2m10s)");
});

// ---- the live narrator (trace events -> beats) ----

test("createTurnNarrator narrates the race from finished spans and filters other sessions/turns", async () => {
  const session = newSessionCarrier();
  const other = newSessionCarrier();
  const narrator = createTurnNarrator({ traceId: session.traceId, turn: 1, judgeModel: "gpt-5.5" });

  emitTurnInfo(session, {
    models: [
      { id: "gpt", model: "gpt-5.5" },
      { id: "sonnet", model: "claude-sonnet-4-6" }
    ]
  });
  emitCandidateStarted(session, "cand_gpt", "gpt");
  emitCandidateFinished(session, {
    candidateId: "cand_gpt",
    modelId: "gpt",
    stepCount: 4,
    preview: "Fix `add()` to use +\nmore"
  });
  // A different session and a different turn are both ignored.
  emitCandidateFinished(other, { modelId: "intruder" });
  emitCandidateFinished(session, { modelId: "stale", turn: 7 });
  emitJudgeRequest(session, [
    { trajectory_id: "t_gpt", model_id: "gpt", status: "succeeded", diff: CALC_DIFF },
    { trajectory_id: "t_sonnet", model_id: "sonnet", status: "succeeded" }
  ]);
  narrator.close();

  const beats: string[] = [];
  for await (const event of narrator.events) beats.push(event.text);
  assert.equal(beats.length, 3, "fan-out, one finisher, judging — starts and other sessions are silent");
  assert.equal(
    beats[0],
    "**Fanning out to 2 models**\n\ngpt-5.5 and claude-sonnet-4-6 are each taking a shot in isolated worktrees.\n\n"
  );
  assert.match(beats[1] ?? "", /^\*\*gpt is back first — \d+s\*\*\n\nProposes: Fix add\(\) to use \+ \(4 steps, \d+s\)\n\n$/);
  assert.equal(beats[2], "**Judging 2 candidates with gpt-5.5**\n\ngpt's patch: +1/-1 across 1 file.\n\n");
});

test("createTurnNarrator emits escalating quiet beats while candidates are out", async () => {
  const session = newSessionCarrier();
  const narrator = createTurnNarrator({
    traceId: session.traceId,
    turn: 1,
    quietDelaysMs: [60, 120, 240]
  });
  emitTurnInfo(session, { models: [{ id: "gpt", model: "gpt-5.5" }] });
  await new Promise((resolve) => setTimeout(resolve, 250));
  narrator.close();

  const beats: string[] = [];
  for await (const event of narrator.events) beats.push(event.text);
  const quiets = beats.filter((beat) => beat.includes("Still working"));
  assert.ok(quiets.length >= 1, "at least one quiet beat fires during silence");
  assert.match(quiets[0] ?? "", /\*\*Still working — waiting on gpt \(\d+s\)\*\*/);
  assert.equal(new Set(beats).size, beats.length, "no beat is ever repeated verbatim");
});

test("closing the narrator detaches its listener (later spans are dropped)", async () => {
  const session = newSessionCarrier();
  const narrator = createTurnNarrator({ traceId: session.traceId, turn: 1 });
  narrator.close();
  emitCandidateFinished(session, { modelId: "gpt" });
  const beats: string[] = [];
  for await (const event of narrator.events) beats.push(event.text);
  assert.equal(beats.length, 0);
});

// ---- NarrationWriter: prose from a model, guardrails from the engine ----

/** Drive one full turn (finish + judge request) through a narrator with `writer`. */
async function narrateTurnWith(writer: NarrationWriter, timeoutMs = 60): Promise<string[]> {
  const session = newSessionCarrier();
  const narrator = createTurnNarrator({
    traceId: session.traceId,
    turn: 1,
    judgeModel: "gpt-5.5",
    writer,
    writerTimeoutMs: timeoutMs
  });
  emitCandidateFinished(session, { modelId: "gpt", preview: "raw model words" });
  emitJudgeRequest(session, [
    { trajectory_id: "t_gpt", model_id: "gpt", status: "succeeded", diff: CALC_DIFF, final_output: "ok" }
  ]);
  // Let the serialized chain drain (writer budget + slack), then close.
  await new Promise((resolve) => setTimeout(resolve, timeoutMs * 3 + 60));
  narrator.close();
  const beats: string[] = [];
  for await (const event of narrator.events) beats.push(event.text);
  return beats;
}

test("a writer's sentences replace the templated prose (sanitized), in order", async () => {
  const writer: NarrationWriter = {
    candidateGist: async () => "rewrote **add()** to sum\nsecond line ignored",
    compareCandidates: async () => "`gpt` stands alone with a verified one-line fix"
  };
  const beats = await narrateTurnWith(writer);
  assert.equal(beats.length, 2);
  assert.equal(beats[0], "**gpt is back first**\n\nProposes: rewrote add() to sum\n\n");
  assert.equal(beats[1], "**Judging 1 candidate with gpt-5.5**\n\ngpt stands alone with a verified one-line fix\n\n");
});

test("a slow writer falls back to templated prose without reordering beats", async () => {
  const writer: NarrationWriter = {
    candidateGist: () => new Promise(() => {}), // never resolves; ignores its signal
    compareCandidates: () => new Promise(() => {})
  };
  const beats = await narrateTurnWith(writer);
  assert.equal(beats.length, 2);
  assert.equal(beats[0], "**gpt is back first**\n\nProposes: raw model words\n\n", "template gist ships");
  assert.match(beats[1] ?? "", /^\*\*Judging 1 candidate with gpt-5\.5\*\*\n\ngpt's patch/, "template comparison ships");
});

test("a throwing writer falls back to templated prose", async () => {
  const writer: NarrationWriter = {
    candidateGist: async () => {
      throw new Error("writer boom");
    },
    compareCandidates: async () => {
      throw new Error("writer boom");
    }
  };
  const beats = await narrateTurnWith(writer);
  assert.equal(beats.length, 2);
  assert.match(beats[0] ?? "", /Proposes: raw model words/);
  assert.match(beats[1] ?? "", /gpt's patch/);
});

test("close aborts an in-flight writer call and flushes the beat with template prose", async () => {
  let sawAbort = false;
  const writer: NarrationWriter = {
    candidateGist: (_input, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          sawAbort = true;
          reject(new Error("aborted"));
        });
      }),
    compareCandidates: async () => undefined
  };
  const session = newSessionCarrier();
  const narrator = createTurnNarrator({
    traceId: session.traceId,
    turn: 1,
    writer,
    writerTimeoutMs: 5_000
  });
  emitCandidateFinished(session, { modelId: "gpt", preview: "x" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  narrator.close(); // aborts the writer; the enqueued beat flushes with template prose
  const beats: string[] = [];
  for await (const event of narrator.events) beats.push(event.text);
  assert.equal(sawAbort, true, "close() aborted the in-flight writer call");
  assert.deepEqual(beats, ["**gpt is back first**\n\nProposes: x\n\n"], "the beat still ships, templated");
});

// ---- the chat-backed writer ----

function chatStub(reply: unknown, status = 200): { fn: (body: unknown) => Promise<Response>; bodies: unknown[] } {
  const bodies: unknown[] = [];
  return {
    bodies,
    fn: async (body: unknown) => {
      bodies.push(body);
      return new Response(JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
    }
  };
}

function chatReply(content: string): unknown {
  return { choices: [{ message: { role: "assistant", content } }] };
}

test("createChatNarrationWriter sends one-sentence prompts with thinking disabled", async () => {
  const stub = chatStub(chatReply("Fixed the retry loop."));
  const writer = createChatNarrationWriter({
    chat: stub.fn,
    model: "qwen-narrator",
    chatTemplateKwargs: { enable_thinking: false }
  });

  const gist = await writer.candidateGist({ id: "gpt", finalOutput: "long output" }, new AbortController().signal);
  assert.equal(gist, "Fixed the retry loop.");

  const body = stub.bodies[0] as {
    model: string;
    messages: Array<{ role: string; content: string }>;
    max_tokens: number;
    temperature: number;
    chat_template_kwargs?: { enable_thinking?: boolean };
  };
  assert.equal(body.model, "qwen-narrator");
  assert.equal(body.temperature, 0);
  assert.ok(body.max_tokens <= 64);
  assert.equal(body.chat_template_kwargs?.enable_thinking, false);
  assert.match(body.messages[0]?.content ?? "", /exactly ONE plain sentence/);
  assert.match(body.messages[1]?.content ?? "", /long output/);

  const compare = await writer.compareCandidates(
    { candidates: [{ id: "gpt", finalOutput: "fixed it", diff: CALC_DIFF, verificationStatus: "passed" }] },
    new AbortController().signal
  );
  assert.equal(compare, "Fixed the retry loop.");
  const compareBody = stub.bodies[1] as { messages: Array<{ content: string }> };
  assert.match(compareBody.messages[1]?.content ?? "", /- gpt: verification: passed \| says: fixed it \| patch:/);
});

test("createChatNarrationWriter keeps the body cloud-safe when no template kwargs are given", async () => {
  // Cloud providers reject unknown fields, so the local-server kwarg must be
  // strictly opt-in.
  const stub = chatStub(chatReply("Compared the candidates."));
  const writer = createChatNarrationWriter({ chat: stub.fn, model: "narrator" });

  await writer.candidateGist({ id: "gpt", finalOutput: "output" }, new AbortController().signal);

  const body = stub.bodies[0] as Record<string, unknown>;
  assert.equal(body.model, "narrator");
  assert.ok(!("chat_template_kwargs" in body));
});

test("createChatNarrationWriter strips leading think blocks and rejects bad replies", async () => {
  const thinking = chatStub(chatReply("<think>hmm let me think</think>\nRenamed the helper."));
  const writer = createChatNarrationWriter({ chat: thinking.fn, model: "m" });
  assert.equal(
    await writer.candidateGist({ id: "a", finalOutput: "x" }, new AbortController().signal),
    "Renamed the helper."
  );

  const empty = createChatNarrationWriter({ chat: chatStub(chatReply("")).fn, model: "m" });
  assert.equal(await empty.candidateGist({ id: "a", finalOutput: "x" }, new AbortController().signal), undefined);

  const error = createChatNarrationWriter({ chat: chatStub({ error: "boom" }, 500).fn, model: "m" });
  assert.equal(await error.candidateGist({ id: "a", finalOutput: "x" }, new AbortController().signal), undefined);

  const malformed = createChatNarrationWriter({
    chat: async () => new Response("not json", { status: 200 }),
    model: "m"
  });
  assert.equal(await malformed.candidateGist({ id: "a", finalOutput: "x" }, new AbortController().signal), undefined);
});

// ---- Merge: narration interleaves, then stops at the first judge byte ----

test("mergeEventsWithNarration drains narration before judge chunks, never after", async () => {
  const session = newSessionCarrier();
  const narrator = createTurnNarrator({ traceId: session.traceId, turn: 1 });
  async function* main(): AsyncGenerator<{ type: "sse.chunk"; data: string }> {
    // Panel phase: narration lands while the main stream is pending.
    emitCandidateFinished(session, { modelId: "gpt" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    yield { type: "sse.chunk", data: "judge-bytes-1" };
    // Narration arriving after the first judge chunk must be dropped.
    emitCandidateFinished(session, { modelId: "sonnet" });
    yield { type: "sse.chunk", data: "judge-bytes-2" };
  }

  const seen: string[] = [];
  for await (const event of mergeEventsWithNarration(main(), narrator)) {
    if (event.type === "sse.chunk") seen.push(`chunk:${event.data}`);
    else if (event.type === "reasoning.delta") seen.push(`reasoning:${(event as ReasoningDeltaEvent).text.trim()}`);
  }
  assert.deepEqual(seen, ["reasoning:**gpt is back first**", "chunk:judge-bytes-1", "chunk:judge-bytes-2"]);
});

test("mergeEventsWithNarration survives the role-announce handshake chunk", async () => {
  // The Python step endpoint emits an empty `{"delta":{"role":"assistant"}}`
  // chunk the instant the POST connects — beats racing that handshake (the
  // judging beat, typically) must still flow until real judge bytes arrive.
  const session = newSessionCarrier();
  const narrator = createTurnNarrator({ traceId: session.traceId, turn: 1 });
  const handshake =
    'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n';
  const judgeBytes =
    'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"thinking"},"finish_reason":null}]}\n\n';
  async function* main(): AsyncGenerator<{ type: "sse.chunk"; data: string }> {
    yield { type: "sse.chunk", data: handshake };
    // The beat lands after the handshake but before any judge output.
    emitCandidateFinished(session, { modelId: "gpt" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    yield { type: "sse.chunk", data: judgeBytes };
  }
  const seen: string[] = [];
  for await (const event of mergeEventsWithNarration(main(), narrator)) {
    if (event.type === "sse.chunk") seen.push("chunk");
    else if (event.type === "reasoning.delta") seen.push(`reasoning:${(event as ReasoningDeltaEvent).text.trim()}`);
  }
  assert.deepEqual(seen, ["chunk", "reasoning:**gpt is back first**", "chunk"]);
});

test("sseChunkHasPayload separates handshake and keepalive from judge output", () => {
  const frame = (body: string): string => `data: ${body}\n\n`;
  assert.equal(sseChunkHasPayload(frame('{"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}')), false);
  assert.equal(sseChunkHasPayload(": keepalive\n\n"), false);
  assert.equal(sseChunkHasPayload(""), false);
  assert.equal(sseChunkHasPayload(frame('{"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}')), true);
  assert.equal(sseChunkHasPayload(frame('{"choices":[{"delta":{"reasoning_content":"x"},"finish_reason":null}]}')), true);
  assert.equal(sseChunkHasPayload(frame('{"choices":[{"delta":{},"finish_reason":"stop"}]}')), true);
  assert.equal(sseChunkHasPayload(frame('{"error":{"message":"boom"}}')), true);
  assert.equal(sseChunkHasPayload("data: [DONE]\n\n"), true);
  assert.equal(sseChunkHasPayload("raw-judge-bytes"), true);
});

// ---- End to end: FusionBackend streaming turn narrates on both doors ----

function fakePanelRunner(): (input: {
  trace: FusionTraceCarrier;
  turn: number;
  sessionKey: string;
}) => Promise<WireTrajectory[]> {
  return async (input) => {
    const session = { traceId: "", carrier: input.trace };
    emitCandidateStarted(session, "cand_gpt", "gpt", input.turn);
    emitCandidateFinished(session, {
      candidateId: "cand_gpt",
      modelId: "gpt",
      turn: input.turn,
      stepCount: 2,
      preview: "ok patch"
    });
    return [{ trajectory_id: "t_gpt", model_id: "gpt", status: "succeeded", final_output: "ok" }];
  };
}

function fakeStreamingFuse(): () => Promise<Response> {
  const sse =
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "fused answer" }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
    "data: [DONE]\n\n";
  return async () => {
    // A touch of judge TTFT so the judging beat (an async chain hop) lands
    // before the first content byte, as it does against the real engine.
    await new Promise((resolve) => setTimeout(resolve, 25));
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

test("a streaming fused turn narrates reasoning before content on the chat door", async () => {
  const backend = new FusionBackend({
    stepUrl: "http://127.0.0.1:1/unused",
    runPanels: fakePanelRunner(),
    runFuseStep: fakeStreamingFuse(),
    defaultModel: "fusion-panel",
    judgeModel: "gpt-5.5"
  });
  const response = await backend.chat({
    messages: [{ role: "user", content: "do the task" }],
    stream: true
  });
  assert.equal(response.status, 200);
  const text = await response.text();

  assert.match(text, /"reasoning_content":"\*\*gpt is back first/);
  assert.match(text, /\*\*Judging 1 candidate with gpt-5\.5\*\*/);
  const firstReasoning = text.indexOf("reasoning_content");
  const firstContent = text.indexOf('"content":"fused answer"');
  assert.ok(firstReasoning >= 0 && firstContent >= 0 && firstReasoning < firstContent);
  const lastReasoning = text.lastIndexOf("reasoning_content");
  assert.ok(lastReasoning < firstContent, "no reasoning chunks after the judge's first content chunk");
});

test("a streaming fused turn narrates on the Responses door as a reasoning item", async () => {
  const backend = new FusionBackend({
    stepUrl: "http://127.0.0.1:1/unused",
    runPanels: fakePanelRunner(),
    runFuseStep: fakeStreamingFuse(),
    defaultModel: "fusion-panel",
    judgeModel: "gpt-5.5"
  });
  const gateway = await startGateway({ backend });
  try {
    const response = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fusion-panel", stream: true, input: "do the task" })
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /event: response\.reasoning_summary_text\.delta/);
    assert.match(text, /gpt is back first/);
    const reasoningDone = text.indexOf("response.reasoning_summary_text.done");
    const firstText = text.indexOf("response.output_text.delta");
    assert.ok(reasoningDone >= 0 && firstText >= 0 && reasoningDone < firstText);
    assert.match(text, /"delta":"fused answer"/);
  } finally {
    await gateway.close();
  }
});

test("an injected narration writer's sentences flow to the chat door", async () => {
  const writer: NarrationWriter = {
    candidateGist: async () => "handcrafted gist from the writer",
    compareCandidates: async () => "handcrafted comparison from the writer"
  };
  const backend = new FusionBackend({
    stepUrl: "http://127.0.0.1:1/unused",
    runPanels: fakePanelRunner(),
    runFuseStep: fakeStreamingFuse(),
    defaultModel: "fusion-panel",
    judgeModel: "gpt-5.5",
    narrationWriter: writer
  });
  const response = await backend.chat({
    messages: [{ role: "user", content: "do the task" }],
    stream: true
  });
  const text = await response.text();
  assert.match(text, /"reasoning_content":"\*\*gpt is back first[^"]*Proposes: handcrafted gist from the writer/);
  assert.match(text, /handcrafted comparison from the writer/);
  assert.match(text, /"content":"fused answer"/);
});

test("reasoningTraces: false keeps the stream silent until the judge's first token", async () => {
  const backend = new FusionBackend({
    stepUrl: "http://127.0.0.1:1/unused",
    runPanels: fakePanelRunner(),
    runFuseStep: fakeStreamingFuse(),
    defaultModel: "fusion-panel",
    reasoningTraces: false
  });
  const response = await backend.chat({
    messages: [{ role: "user", content: "do the task" }],
    stream: true
  });
  const text = await response.text();
  assert.ok(!text.includes("reasoning_content"), "narration is off");
  assert.match(text, /"content":"fused answer"/);
});
