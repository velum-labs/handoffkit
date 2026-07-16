import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { test } from "node:test";

import {
  addSpanListener,
  attrJson,
  attrNum,
  attrStr,
  initFusionTracing,
  newSessionCarrier,
  removeSpanListener,
  spanTraceId
} from "@fusionkit/tracing";
import type { ReadableSpan } from "@fusionkit/tracing";

import { runProposalPanels } from "../panel-propose.js";

initFusionTracing({ serviceName: "panel-propose-test" });

type RecordedRequest = { url: string; body: Record<string, unknown> };

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

/** A fake OpenAI-compatible endpoint scripted per requested model id. */
async function startEndpoint(
  respond: (model: string) => Record<string, unknown> | { status: number; body: string }
): Promise<{ url: string; requests: RecordedRequest[]; close: () => Promise<void> }> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readJson(req);
      requests.push({ url: req.url ?? "", body });
      const reply = respond(body.model as string);
      if ("status" in reply && typeof reply.status === "number") {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(reply.body);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

const CALLER_MESSAGES = [
  { role: "system", content: "You are a coding agent." },
  { role: "user", content: "fix the bug" },
  { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c1", content: "file contents" }
];

const CALLER_TOOLS = [
  { type: "function", function: { name: "write_file", parameters: { type: "object", properties: {} } } }
];

test("members receive the caller's messages and tools verbatim, one completion each", async () => {
  const endpoint = await startEndpoint(() => ({
    id: "response-id",
    model: "effective/model",
    provider: "FirstParty",
    choices: [{ message: { content: "an answer" } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    provider_cost: { source: "provider", cost_usd: 0.01 }
  }));
  try {
    const wires = await runProposalPanels({
      id: "t",
      models: [
        { id: "alpha", model: "provider/alpha" },
        { id: "beta", model: "provider/beta" }
      ],
      messages: CALLER_MESSAGES,
      tools: CALLER_TOOLS,
      toolChoice: "auto",
      temperature: 0.6,
      topP: 0.9,
      maxCompletionTokens: 4096,
      seed: 7,
      reasoning: { effort: "high" },
      provider: { order: ["FirstParty"], allow_fallbacks: false },
      usage: { include: true },
      parallelToolCalls: false,
      fusionBackendUrl: endpoint.url
    });

    assert.equal(endpoint.requests.length, 2);
    for (const request of endpoint.requests) {
      assert.equal(request.url, "/v1/chat/completions");
      assert.deepEqual(request.body.messages, CALLER_MESSAGES, "messages must be verbatim");
      assert.deepEqual(request.body.tools, CALLER_TOOLS, "tools must be verbatim");
      assert.equal(request.body.tool_choice, "auto");
      assert.equal(request.body.temperature, 0.6);
      assert.equal(request.body.top_p, 0.9);
      assert.equal(request.body.max_completion_tokens, 4096);
      assert.equal(request.body.seed, 7);
      assert.deepEqual(request.body.reasoning, { effort: "high" });
      assert.deepEqual(request.body.provider, {
        order: ["FirstParty"],
        allow_fallbacks: false
      });
      assert.deepEqual(request.body.usage, { include: true });
      assert.equal(request.body.parallel_tool_calls, false);
      assert.equal(request.body.stream, false);
    }
    assert.deepEqual(new Set(endpoint.requests.map((r) => r.body.model)), new Set(["alpha", "beta"]));
    assert.deepEqual(wires[0]?.metadata, {
      provider_cost: { source: "provider", cost_usd: 0.01 },
      raw_response: {
        id: "response-id",
        model: "effective/model",
        provider: "FirstParty"
      }
    });

    assert.equal(wires.length, 2);
    for (const wire of wires) {
      assert.equal(wire.status, "succeeded");
      assert.equal(wire.final_output, "an answer");
      // No harness produced this candidate; the contract field stays unset.
      assert.equal(wire.harness_kind, undefined);
      assert.deepEqual(wire.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    }
  } finally {
    await endpoint.close();
  }
});

test("a member's tool calls become function_call proposal items (batch preserved)", async () => {
  const endpoint = await startEndpoint(() => ({
    choices: [
      {
        message: {
          content: "let me edit",
          tool_calls: [
            { id: "call_a", function: { name: "write_file", arguments: '{"path":"a.ts"}' } },
            { id: "call_b", function: { name: "run", arguments: '{"command":"pnpm test"}' } }
          ]
        }
      }
    ]
  }));
  try {
    const wires = await runProposalPanels({
      models: [{ id: "alpha", model: "provider/alpha" }],
      messages: CALLER_MESSAGES,
      tools: CALLER_TOOLS,
      fusionBackendUrl: endpoint.url
    });

    assert.equal(wires.length, 1);
    const items = wires[0]?.items ?? [];
    assert.deepEqual(
      items.map((item) => item.type),
      ["message", "function_call", "function_call"]
    );
    assert.deepEqual(items[1], {
      index: 1,
      type: "function_call",
      call_id: "call_a",
      name: "write_file",
      arguments: '{"path":"a.ts"}'
    });
    assert.deepEqual(items[2], {
      index: 2,
      type: "function_call",
      call_id: "call_b",
      name: "run",
      arguments: '{"command":"pnpm test"}'
    });
    assert.equal(wires[0]?.final_output, "let me edit");
  } finally {
    await endpoint.close();
  }
});

test("finished trace payloads carry the structural narration fields", async () => {
  const endpoint = await startEndpoint(() => ({
    choices: [
      {
        message: {
          content: "editing now",
          tool_calls: [{ id: "c1", function: { name: "write_file", arguments: '{"path":"a.ts"}' } }]
        }
      }
    ]
  }));
  const session = newSessionCarrier();
  const spans: ReadableSpan[] = [];
  const listener = (span: ReadableSpan): void => {
    if (span.name === "fusion.candidate" && spanTraceId(span) === session.traceId) spans.push(span);
  };
  addSpanListener(listener);
  try {
    await runProposalPanels({
      models: [{ id: "alpha", model: "provider/alpha" }],
      messages: [{ role: "user", content: "go" }],
      fusionBackendUrl: endpoint.url,
      trace: session.carrier
    });
    const candidate = spans[0];
    assert.ok(candidate, "the proposer emitted its candidate span");
    assert.equal(attrStr(candidate, "fusion.finish_reason"), "tool_calls");
    assert.equal(attrStr(candidate, "fusion.final_output_preview"), "editing now");
    assert.deepEqual(attrJson(candidate, "fusion.proposed_calls"), [
      { name: "write_file", arguments_preview: '{"path":"a.ts"}' }
    ]);
    assert.equal(attrNum(candidate, "fusion.tool_call_count"), 1);
  } finally {
    removeSpanListener(listener);
    await endpoint.close();
  }
});

test("per-member endpoints route by model id; a failing member degrades with attribution", async () => {
  const good = await startEndpoint(() => ({ choices: [{ message: { content: "ok" } }] }));
  const bad = await startEndpoint(() => ({ status: 500, body: "boom" }));
  try {
    const wires = await runProposalPanels({
      models: [
        { id: "alpha", model: "provider/alpha" },
        { id: "beta", model: "provider/beta" }
      ],
      messages: [{ role: "user", content: "hi" }],
      fusionBackendUrl: good.url,
      modelEndpoints: { beta: bad.url }
    });

    const byId = new Map(wires.map((wire) => [wire.model_id, wire]));
    assert.equal(byId.get("alpha")?.status, "succeeded");
    assert.equal(byId.get("beta")?.status, "failed");
    assert.match(byId.get("beta")?.final_output ?? "", /beta.*500/s);
    assert.equal(good.requests.length, 1);
    assert.equal(bad.requests.length, 1);
  } finally {
    await good.close();
    await bad.close();
  }
});
