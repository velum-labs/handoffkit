import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AnthropicBackend,
  CodexResponsesBackend,
  GoogleGenAiBackend
} from "../provider-backends.js";
import { SseParseError } from "../sse/parse.js";

function sse(
  events: readonly { event?: string; data: unknown }[],
  includeDone = false
): Response {
  const body = events
    .map(({ event, data }) =>
      `${event === undefined ? "" : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`
    )
    .join("") + (includeDone ? "data: [DONE]\n\n" : "");
  return new Response(body, {
    headers: { "content-type": "text/event-stream" }
  });
}

test("Anthropic egress preserves tools and normalizes the response", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      id: "msg_1",
      content: [
        { type: "text", text: "working" },
        { type: "tool_use", id: "tool_1", name: "read", input: { path: "a.ts" } }
      ],
      usage: { input_tokens: 4, output_tokens: 2 }
    });
  };
  try {
    const backend = new AnthropicBackend({
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "secret",
      defaultModel: "claude-test"
    });
    const response = await backend.chat({
      messages: [{ role: "user", content: "inspect" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "read a file",
            parameters: { type: "object" }
          }
        }
      ]
    });
    assert.equal(request?.url, "https://api.anthropic.test/v1/messages");
    assert.equal(request?.headers.get("x-api-key"), "secret");
    const outbound = (await request?.json()) as {
      tools: Array<{ name: string }>;
    };
    assert.equal(outbound.tools[0]?.name, "read");
    const body = (await response.json()) as {
      choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }>;
      usage: { input_tokens: number };
    };
    assert.equal(body.choices[0]?.message.tool_calls[0]?.function.name, "read");
    assert.equal(body.usage.input_tokens, 4);
  } finally {
    globalThis.fetch = original;
  }
});

test("Google GenAI egress maps content, usage, and API-key auth", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      candidates: [{ content: { parts: [{ text: "answer" }] } }],
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 1,
        totalTokenCount: 4
      }
    });
  };
  try {
    const backend = new GoogleGenAiBackend({
      baseUrl: "https://generativelanguage.test/v1beta",
      apiKey: "google-secret",
      defaultModel: "gemini-test"
    });
    const response = await backend.chat({
      messages: [{ role: "user", content: "hello" }]
    });
    assert.match(request?.url ?? "", /models\/gemini-test:generateContent$/);
    assert.equal(request?.headers.get("x-goog-api-key"), "google-secret");
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { total_tokens: number };
    };
    assert.equal(body.choices[0]?.message.content, "answer");
    assert.equal(body.usage.total_tokens, 4);
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex Responses egress preserves subscription auth and tool output", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      id: "resp_1",
      output: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "considering the fix" }]
        },
        { type: "message", content: [{ type: "output_text", text: "done" }] },
        {
          type: "function_call",
          call_id: "call_1",
          name: "apply",
          arguments: "{\"patch\":\"x\"}"
        }
      ],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 }
    });
  };
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      accountId: "account",
      defaultModel: "codex-test"
    });
    const response = await backend.chat({
      messages: [{ role: "user", content: "fix it" }],
      tools: [{ type: "function", function: { name: "apply" } }]
    });
    assert.equal(request?.url, "https://chatgpt.test/backend-api/codex/responses");
    assert.equal(request?.headers.get("authorization"), "Bearer oauth");
    assert.equal(request?.headers.get("chatgpt-account-id"), "account");
    const body = (await response.json()) as {
      choices: Array<{
        message: { content: string; reasoning: string; tool_calls: unknown[] };
      }>;
    };
    assert.equal(body.choices[0]?.message.content, "done");
    assert.equal(body.choices[0]?.message.reasoning, "considering the fix");
    assert.equal(body.choices[0]?.message.tool_calls.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("Anthropic streaming egress preserves tool calls and terminal usage", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sse([
      {
        event: "content_block_start",
        data: {
          index: 0,
          content_block: { type: "tool_use", id: "tool_1", name: "read", input: {} }
        }
      },
      {
        event: "content_block_delta",
        data: { index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a.ts\"}" } }
      },
      {
        event: "message_delta",
        data: {
          delta: { stop_reason: "tool_use" },
          usage: { input_tokens: 4, output_tokens: 2 }
        }
      }
    ], true);
  try {
    const backend = new AnthropicBackend({
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "secret",
      defaultModel: "claude-test"
    });
    const response = await backend.chat({
      stream: true,
      messages: [{ role: "user", content: "inspect" }],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }]
    });
    const text = await response.text();
    assert.match(text, /"name":"read"/);
    assert.match(text, /\\"path\\":\\"a\.ts\\"/);
    assert.match(text, /"finish_reason":"tool_calls"/);
    assert.match(text, /"input_tokens":4/);
    assert.match(text, /data: \[DONE\]/);
    assert.equal(text.match(/data: \[DONE\]/g)?.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("Google streaming egress preserves function history, tools, and usage", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return sse([
      {
        data: {
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: "search", args: { query: "routekit" } } }]
              },
              finishReason: "STOP"
            }
          ],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 1,
            totalTokenCount: 6
          }
        }
      }
    ]);
  };
  try {
    const backend = new GoogleGenAiBackend({
      baseUrl: "https://generativelanguage.test/v1beta",
      apiKey: "google-secret",
      defaultModel: "gemini-test"
    });
    const response = await backend.chat({
      stream: true,
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              function: { name: "search", arguments: "{\"query\":\"first\"}" }
            }
          ]
        },
        { role: "tool", tool_call_id: "call_1", content: "first result" }
      ],
      tools: [
        {
          type: "function",
          function: { name: "search", parameters: { type: "object" } }
        }
      ]
    });
    assert.match(request?.url ?? "", /models\/gemini-test:streamGenerateContent\?alt=sse$/);
    const outbound = (await request?.json()) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
      tools: Array<{ functionDeclarations: Array<{ name: string }> }>;
    };
    assert.equal(outbound.tools[0]?.functionDeclarations[0]?.name, "search");
    assert.ok(outbound.contents.some((content) => content.parts.some((part) => "functionCall" in part)));
    assert.ok(outbound.contents.some((content) => content.parts.some((part) => "functionResponse" in part)));
    const text = await response.text();
    assert.match(text, /"name":"search"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /"total_tokens":6/);
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex streaming egress preserves Responses tool history and deltas", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return sse([
      {
        event: "response.reasoning_summary_text.delta",
        data: { delta: "considering the patch" }
      },
      {
        event: "response.output_item.added",
        data: {
          output_index: 0,
          item: {
            type: "function_call",
            id: "item_1",
            call_id: "call_2",
            name: "apply"
          }
        }
      },
      {
        event: "response.function_call_arguments.delta",
        data: { output_index: 0, delta: "{\"patch\":\"x\"}" }
      },
      {
        event: "response.completed",
        data: {
          response: {
            usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 }
          }
        }
      }
    ]);
  };
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      accountId: "account",
      defaultModel: "codex-test"
    });
    const response = await backend.chat({
      stream: true,
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              function: { name: "read", arguments: "{\"path\":\"a.ts\"}" }
            }
          ]
        },
        { role: "tool", tool_call_id: "call_1", content: "source" }
      ],
      tools: [
        {
          type: "function",
          function: { name: "apply", parameters: { type: "object" } }
        }
      ]
    });
    const outbound = (await request?.json()) as {
      input: Array<Record<string, unknown>>;
      tools: Array<Record<string, unknown>>;
    };
    assert.ok(outbound.input.some((item) => item.type === "function_call"));
    assert.ok(outbound.input.some((item) => item.type === "function_call_output"));
    assert.deepEqual(outbound.tools[0], {
      type: "function",
      name: "apply",
      parameters: { type: "object" }
    });
    const text = await response.text();
    assert.match(text, /"reasoning":"considering the patch"/);
    assert.match(text, /"name":"apply"/);
    assert.match(text, /\\"patch\\":\\"x\\"/);
    assert.match(text, /"finish_reason":"tool_calls"/);
    assert.match(text, /"total_tokens":9/);
  } finally {
    globalThis.fetch = original;
  }
});

test("provider streaming surfaces malformed and truncated SSE", async () => {
  const original = globalThis.fetch;
  const backend = new CodexResponsesBackend({
    baseUrl: "https://chatgpt.test/backend-api/codex",
    apiKey: "oauth",
    defaultModel: "codex-test"
  });
  try {
    for (const body of [
      "event: response.output_text.delta\ndata: {malformed}\n\n",
      'event: response.output_text.delta\ndata: {"delta":"partial"}'
    ]) {
      globalThis.fetch = async () =>
        new Response(body, {
          headers: { "content-type": "text/event-stream" }
        });
      const response = await backend.chat({
        stream: true,
        messages: [{ role: "user", content: "hello" }]
      });
      await assert.rejects(response.text(), SseParseError);
    }
  } finally {
    globalThis.fetch = original;
  }
});
