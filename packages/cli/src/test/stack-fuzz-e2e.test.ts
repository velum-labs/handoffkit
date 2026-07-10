/**
 * Hostile-input fuzzing of every gateway front door on the full stack (real
 * gateway -> real Python engine -> provider simulator).
 *
 * These tests exist because "every suite passes" was itself a red flag: the
 * scripted suites explore only well-formed request space. This suite explores
 * the complement, with expectation-free invariants instead of scripted
 * outcomes:
 *
 *  - a structurally malformed body is a 400 in the door's NATIVE error
 *    envelope, with ZERO provider fanout (no spend on garbage);
 *  - no response ever leaks JavaScript internals (TypeError text, stack
 *    frames) — the exact failure mode this fuzzing originally found;
 *  - every response (including for seeded random garbage) is parseable JSON
 *    or SSE, arrives within a bound, and leaves the gateway healthy.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { stackToolingSkip } from "@fusionkit/testkit";

import { startSimFusionStack } from "./sim-stack.js";
import type { SimFusionStack } from "./sim-stack.js";

const SKIP = stackToolingSkip();

const MEMBERS = [
  { id: "member", model: "fuzz-member", provider: "openai" },
  { id: "judge", model: "fuzz-judge", provider: "openai" }
] as const;

let stack: SimFusionStack;

test.before(async () => {
  if (SKIP !== false) return;
  stack = await startSimFusionStack({ members: [...MEMBERS], judgeId: "judge" });
});

test.after(async () => {
  if (SKIP !== false) return;
  await stack.close();
});

/** Text that must never appear in a wire response: leaked JS internals. */
const LEAKED_INTERNALS = /is not a function|is not iterable|Cannot read propert|undefined is not|\bTypeError\b|\bReferenceError\b|\bAttributeError\b|Traceback \(most recent call last\)|at .+\.js:\d+/;

type Probe = { status: number; text: string; parsed: "json" | "sse" | "unparseable"; elapsedMs: number };

async function probe(path: string, body: string, headers: Record<string, string> = {}): Promise<Probe> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("fuzz probe exceeded 15s")), 15_000);
  try {
    const response = await fetch(`${stack.gatewayUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      signal: controller.signal
    });
    const text = await response.text();
    let parsed: Probe["parsed"] = "unparseable";
    try {
      JSON.parse(text);
      parsed = "json";
    } catch {
      if (text.startsWith("data:") || text.startsWith("event:")) parsed = "sse";
    }
    return { status: response.status, text, parsed, elapsedMs: performance.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function journalCount(): Promise<number> {
  return (await stack.sim.journal()).length;
}

async function assertGatewayHealthy(): Promise<void> {
  const models = await fetch(`${stack.gatewayUrl}/v1/models`);
  assert.equal(models.status, 200, "gateway must stay alive after hostile input");
}

// ---- deterministic rejection matrix: malformed bodies per door -------------

type RejectCase = { name: string; path: string; body: unknown; envelope: "openai" | "anthropic" };

const REJECTS: RejectCase[] = [
  // OpenAI chat door
  { name: "chat empty body", path: "/v1/chat/completions", body: {}, envelope: "openai" },
  { name: "chat null messages", path: "/v1/chat/completions", body: { model: "fusion-panel", messages: null }, envelope: "openai" },
  { name: "chat string messages", path: "/v1/chat/completions", body: { model: "fusion-panel", messages: "hi" }, envelope: "openai" },
  { name: "chat empty messages", path: "/v1/chat/completions", body: { model: "fusion-panel", messages: [] }, envelope: "openai" },
  { name: "chat role-less message", path: "/v1/chat/completions", body: { model: "fusion-panel", messages: [{ content: "x" }] }, envelope: "openai" },
  { name: "chat numeric content", path: "/v1/chat/completions", body: { model: "fusion-panel", messages: [{ role: "user", content: 42 }] }, envelope: "openai" },
  { name: "chat tool message without call id", path: "/v1/chat/completions", body: { model: "fusion-panel", messages: [{ role: "tool", content: "result" }] }, envelope: "openai" },
  { name: "chat array model", path: "/v1/chat/completions", body: { model: ["fusion-panel"], messages: [{ role: "user", content: "x" }] }, envelope: "openai" },
  { name: "chat string stream", path: "/v1/chat/completions", body: { model: "fusion-panel", messages: [{ role: "user", content: "x" }], stream: "yes" }, envelope: "openai" },
  { name: "chat string tools", path: "/v1/chat/completions", body: { model: "fuzz-member", messages: [{ role: "user", content: "x" }], tools: "read" }, envelope: "openai" },
  { name: "chat negative max_tokens", path: "/v1/chat/completions", body: { model: "fusion-panel", messages: [{ role: "user", content: "x" }], max_tokens: -5 }, envelope: "openai" },
  // Anthropic messages door
  { name: "messages empty body", path: "/v1/messages", body: {}, envelope: "anthropic" },
  { name: "messages null messages", path: "/v1/messages", body: { model: "fusion-panel", max_tokens: 100, messages: null }, envelope: "anthropic" },
  { name: "messages array model", path: "/v1/messages", body: { model: ["x"], max_tokens: 100, messages: [{ role: "user", content: "hi" }] }, envelope: "anthropic" },
  { name: "messages string max_tokens", path: "/v1/messages", body: { model: "fusion-panel", max_tokens: "lots", messages: [{ role: "user", content: "hi" }] }, envelope: "anthropic" },
  { name: "messages string tools", path: "/v1/messages", body: { model: "fusion-panel", max_tokens: 100, tools: "hammer", messages: [{ role: "user", content: "hi" }] }, envelope: "anthropic" },
  { name: "count_tokens empty body", path: "/v1/messages/count_tokens", body: {}, envelope: "anthropic" },
  { name: "count_tokens malformed item", path: "/v1/messages/count_tokens", body: { messages: [42] }, envelope: "anthropic" },
  { name: "count_tokens null content", path: "/v1/messages/count_tokens", body: { messages: [{ role: "assistant", content: null }] }, envelope: "anthropic" },
  // Responses door
  { name: "responses empty body", path: "/v1/responses", body: {}, envelope: "openai" },
  { name: "responses numeric input", path: "/v1/responses", body: { model: "fusion-panel", input: 42 }, envelope: "openai" },
  { name: "responses object model", path: "/v1/responses", body: { model: { a: 1 }, input: "hi" }, envelope: "openai" },
  { name: "responses negative max_output_tokens", path: "/v1/responses", body: { model: "fusion-panel", input: "hi", max_output_tokens: -1 }, envelope: "openai" },
  { name: "responses string tools", path: "/v1/responses", body: { model: "fusion-panel", input: "hi", tools: "hammer" }, envelope: "openai" },
  // Passes door validation (items may be unknown types) but translates to an
  // empty fused turn — the FusionBackend's own boundary guard must answer 400.
  { name: "responses unknown-only input", path: "/v1/responses", body: { model: "fusion-panel", input: [{ type: "quantum" }] }, envelope: "openai" },
  // Cursor door (bogus + hybrid that translates to nothing)
  { name: "cursor no messages/input", path: "/v1/cursor/chat/completions", body: { weird: true }, envelope: "openai" },
  { name: "cursor string tools", path: "/v1/cursor/chat/completions", body: { model: "fusion-panel", input: "hi", tools: "hammer" }, envelope: "openai" },
  { name: "cursor unknown-only input", path: "/v1/cursor/chat/completions", body: { model: "fusion-panel", input: [{ type: "quantum" }] }, envelope: "openai" }
];

for (const hostile of REJECTS) {
  test(`[fuzz] ${hostile.name} -> 400 in the native envelope, zero provider fanout`, { skip: SKIP }, async () => {
    const before = await journalCount();
    const result = await probe(hostile.path, JSON.stringify(hostile.body));
    assert.equal(result.status, 400, `${hostile.name}: ${result.text.slice(0, 200)}`);
    assert.equal(result.parsed, "json", hostile.name);
    assert.doesNotMatch(result.text, LEAKED_INTERNALS, hostile.name);
    const envelope = JSON.parse(result.text) as { type?: string; error?: { type?: string; message?: string } };
    if (hostile.envelope === "anthropic") {
      assert.equal(envelope.type, "error", hostile.name);
      assert.equal(envelope.error?.type, "invalid_request_error", hostile.name);
    } else {
      assert.equal(envelope.error?.type, "invalid_request_error", hostile.name);
    }
    assert.equal(await journalCount(), before, `${hostile.name}: a rejected body must never fan out to providers`);
    await assertGatewayHealthy();
  });
}

test("[fuzz] syntactically invalid JSON is a 400 on every door", { skip: SKIP }, async () => {
  for (const path of ["/v1/chat/completions", "/v1/messages", "/v1/responses", "/v1/cursor/chat/completions"]) {
    const result = await probe(path, '{"model":');
    assert.equal(result.status, 400, path);
    assert.equal(result.parsed, "json", path);
  }
});

// ---- accepted-garbage set: shapes real providers accept must still work ----

test("[fuzz] tolerated oddities still complete (weird-but-valid is not rejected)", { skip: SKIP }, async () => {
  const tolerated: Array<[string, unknown]> = [
    ["null-byte + astral unicode content", { model: "fusion-panel", messages: [{ role: "user", content: "a\u0000b \u{1F600} \u4E16\u754C" }] }],
    ["deeply nested unknown field", { model: "fusion-panel", messages: [{ role: "user", content: "x" }], fusion: Array(200).fill(0).reduce((acc: unknown) => ({ nested: acc }), {}) }],
    ["large content (256 KiB)", { model: "fusion-panel", messages: [{ role: "user", content: "A".repeat(256 * 1024) }] }]
  ];
  for (const [name, body] of tolerated) {
    const result = await probe("/v1/chat/completions", JSON.stringify(body));
    assert.equal(result.status, 200, `${name}: ${result.text.slice(0, 200)}`);
    assert.equal(result.parsed, "json", name);
  }
  await assertGatewayHealthy();
});

// ---- seeded random structural fuzz -----------------------------------------

/** Deterministic PRNG (mulberry32) so a failure reproduces from the logged seed. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

const MODEL_VALUES = ["fusion-panel", "fuzz-member", "no-such-model", "", 42, null, ["a"], { id: "x" }] as const;
const ROLE_VALUES = ["user", "assistant", "system", "tool", "attacker", "", 7, null] as const;
const CONTENT_VALUES = ["hello", "", "\u0000\uFFFD\u{10FFFF}", 13, null, ["not a part"], [{ type: "text", text: "x" }], { deep: true }] as const;
const EXTRA_FIELDS = [
  {},
  { stream: true },
  { stream: "maybe" },
  { max_tokens: -1 },
  { max_tokens: "many" },
  { tools: [] },
  { tools: "hammer" },
  { tool_choice: { type: "function" } },
  { temperature: Number.NaN },
  { fusion: { mode: "bogus" } }
] as const;

function randomBody(random: () => number): unknown {
  const messages: unknown[] = [];
  const count = Math.floor(random() * 4);
  for (let index = 0; index < count; index += 1) {
    if (random() < 0.15) {
      messages.push(pick(random, ["not-an-object", 42, null] as const));
    } else {
      messages.push({ role: pick(random, ROLE_VALUES), content: pick(random, CONTENT_VALUES) });
    }
  }
  return {
    model: pick(random, MODEL_VALUES),
    messages: random() < 0.1 ? pick(random, [null, "hi", 42] as const) : messages,
    ...pick(random, EXTRA_FIELDS)
  };
}

function randomResponsesBody(random: () => number): unknown {
  return {
    model: pick(random, MODEL_VALUES),
    input: pick(random, [
      "hello",
      "",
      42,
      null,
      [],
      [{ type: "message", role: "user", content: "hello" }],
      [{ type: "quantum" }],
      ["not-an-object"]
    ] as const),
    ...pick(random, [
      {},
      { stream: true },
      { stream: "maybe" },
      { max_output_tokens: -1 },
      { max_output_tokens: 32 },
      { tools: "hammer" }
    ] as const)
  };
}

const RANDOM_DOORS: ReadonlyArray<{
  path: string;
  body: (random: () => number) => unknown;
}> = [
  { path: "/v1/chat/completions", body: randomBody },
  { path: "/v1/messages", body: randomBody },
  {
    path: "/v1/messages/count_tokens",
    body: (random) => {
      const candidate = randomBody(random) as { messages?: unknown };
      return { messages: candidate.messages };
    }
  },
  { path: "/v1/responses", body: randomResponsesBody },
  { path: "/v1/cursor/chat/completions", body: randomResponsesBody }
];

test("[fuzz] seeded random bodies across every door: parseable, bounded, no leaks, gateway survives", { skip: SKIP }, async () => {
  const seed = 0xf0510;
  const random = mulberry32(seed);
  for (const door of RANDOM_DOORS) {
    for (let round = 0; round < 16; round += 1) {
      const body = door.body(random);
      const result = await probe(door.path, JSON.stringify(body));
      const detail = `seed=${seed} door=${door.path} round=${round} body=${JSON.stringify(body).slice(0, 300)} -> ${result.status} ${result.text.slice(0, 200)}`;
      assert.ok(result.parsed !== "unparseable", detail);
      assert.doesNotMatch(result.text, LEAKED_INTERNALS, detail);
      assert.ok(result.elapsedMs < 15_000, detail);
      // 200 = tolerated shape completes; 400/422 = structural rejection; 502 =
      // valid-shape garbage the providers themselves rejected (panel failed).
      assert.ok([200, 400, 422, 502].includes(result.status), `unexpected status class: ${detail}`);
    }
  }
  await assertGatewayHealthy();
});
