import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AnthropicBackend,
  CodexResponsesBackend,
  GoogleGenAiBackend
} from "../provider-backends.js";
import { anthropicToChat } from "../adapters/anthropic.js";
import { attachReasoningSelection } from "../adapters/openai-chat-wire.js";
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

test("Anthropic egress preserves native thinking controls, signed history, and buffered blocks", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      id: "msg_think",
      content: [
        {
          type: "thinking",
          thinking: "native thought",
          signature: "sig-response"
        },
        { type: "redacted_thinking", data: "opaque-redaction" },
        {
          type: "tool_use",
          id: "tool_2",
          name: "read",
          input: { path: "b.ts" }
        }
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 8, output_tokens: 5 }
    });
  };
  try {
    const backend = new AnthropicBackend({
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "secret",
      defaultModel: "claude-test"
    });
    const chat = anthropicToChat(
      {
        model: "claude-test",
        max_tokens: 4096,
        thinking: {
          type: "enabled",
          budget_tokens: 2048,
          display: "summarized"
        },
        output_config: { effort: "high" },
        messages: [
          { role: "user", content: "inspect" },
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "prior thought",
                signature: "sig-prior"
              },
              { type: "redacted_thinking", data: "prior-redaction" },
              {
                type: "tool_use",
                id: "tool_1",
                name: "read",
                input: { path: "a.ts" }
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_1",
                content: "source"
              }
            ]
          }
        ],
        tools: [
          {
            name: "read",
            input_schema: { type: "object" }
          }
        ],
        tool_choice: { type: "tool", name: "read", disable_parallel_tool_use: true }
      },
      "claude-test"
    );
    const response = await backend.chat(chat);
    const outbound = (await request?.json()) as {
      max_tokens: number;
      thinking: Record<string, unknown>;
      output_config: Record<string, unknown>;
      tool_choice: Record<string, unknown>;
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    assert.equal(outbound.max_tokens, 4096);
    assert.deepEqual(outbound.thinking, {
      type: "enabled",
      budget_tokens: 2048,
      display: "summarized"
    });
    assert.deepEqual(outbound.output_config, { effort: "high" });
    assert.deepEqual(outbound.tool_choice, {
      type: "tool",
      name: "read",
      disable_parallel_tool_use: true
    });
    assert.deepEqual(
      outbound.messages[1]?.content.map((block) => block.type),
      ["thinking", "redacted_thinking", "tool_use"]
    );
    assert.equal(outbound.messages[1]?.content[0]?.signature, "sig-prior");

    const normalized = (await response.json()) as {
      choices: Array<{
        finish_reason: string;
        message: {
          content: string | null;
          reasoning: string;
          reasoning_details: Array<Record<string, unknown>>;
        };
      }>;
    };
    assert.equal(normalized.choices[0]?.finish_reason, "tool_calls");
    assert.equal(normalized.choices[0]?.message.content, null);
    assert.equal(normalized.choices[0]?.message.reasoning, "native thought");
    assert.deepEqual(
      normalized.choices[0]?.message.reasoning_details.map((detail) => detail.type),
      ["thinking", "redacted_thinking"]
    );
    assert.equal(
      normalized.choices[0]?.message.reasoning_details[0]?.signature,
      "sig-response"
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("Anthropic egress preserves opaque effort and rejects impossible explicit budgets", async () => {
  const requests: Request[] = [];
  const backend = new AnthropicBackend({
    baseUrl: "https://api.anthropic.test/v1",
    apiKey: "secret",
    defaultModel: "claude-test",
    transport: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn"
      });
    }
  });
  const valid = await backend.chat({
    max_completion_tokens: 5000,
    reasoning_effort: "ultra",
    messages: [{ role: "user", content: "think" }]
  });
  assert.equal(valid.status, 200);
  const outbound = (await requests[0]?.json()) as {
    max_tokens: number;
    thinking: { type: string };
    output_config: { effort: string };
  };
  assert.equal(outbound.max_tokens, 5000);
  assert.deepEqual(outbound.thinking, { type: "adaptive" });
  assert.deepEqual(outbound.output_config, { effort: "ultra" });

  const invalidBody: Record<PropertyKey, unknown> = {
    max_completion_tokens: 1024,
    messages: [{ role: "user", content: "think" }]
  };
  attachReasoningSelection(invalidBody, {
    mode: "budget",
    budgetTokens: 1024
  });
  const invalid = await backend.chat(invalidBody);
  assert.equal(invalid.status, 400);
  assert.equal(requests.length, 1, "invalid thinking must fail before transport");
  assert.match(await invalid.text(), /less than max_tokens/);
});

test("Anthropic egress preserves native stop reasons and stop sequences", async () => {
  const backend = new AnthropicBackend({
    baseUrl: "https://api.anthropic.test/v1",
    apiKey: "secret",
    defaultModel: "claude-test",
    transport: async () =>
      Response.json({
        content: [{ type: "text", text: "bounded" }],
        stop_reason: "stop_sequence",
        stop_sequence: "<END>"
      })
  });
  const response = await backend.chat({
    messages: [{ role: "user", content: "bounded answer" }]
  });
  const canonical = (await response.json()) as {
    choices: Array<Record<string, unknown>>;
  };
  assert.equal(canonical.choices[0]?.finish_reason, "stop");
  assert.equal(canonical.choices[0]?.anthropic_stop_reason, "stop_sequence");
  assert.equal(canonical.choices[0]?.anthropic_stop_sequence, "<END>");
});

test("Anthropic egress replays signed canonical reasoning_details from OpenAI clients", async () => {
  let request: Request | undefined;
  const backend = new AnthropicBackend({
    baseUrl: "https://api.anthropic.test/v1",
    apiKey: "secret",
    defaultModel: "claude-test",
    transport: async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn"
      });
    }
  });
  await backend.chat({
    messages: [
      {
        role: "assistant",
        content: null,
        reasoning: "prior",
        reasoning_details: [
          {
            type: "thinking",
            index: 0,
            thinking: "prior",
            signature: "sig-canonical"
          }
        ],
        tool_calls: [
          {
            id: "tool_1",
            function: { name: "read", arguments: '{"path":"a.ts"}' }
          }
        ]
      },
      { role: "tool", tool_call_id: "tool_1", content: "source" }
    ]
  });
  const outbound = (await request?.json()) as {
    messages: Array<{ content: Array<Record<string, unknown>> }>;
  };
  assert.deepEqual(
    outbound.messages[0]?.content.map((block) => block.type),
    ["thinking", "tool_use"]
  );
  assert.equal(outbound.messages[0]?.content[0]?.signature, "sig-canonical");
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
      reasoning_effort: "deliberate",
      messages: [{ role: "user", content: "hello" }]
    });
    assert.match(request?.url ?? "", /models\/gemini-test:generateContent$/);
    assert.equal(request?.headers.get("x-goog-api-key"), "google-secret");
    const outbound = (await request?.json()) as {
      generationConfig: { thinkingConfig: { thinkingLevel: string } };
    };
    assert.equal(
      outbound.generationConfig.thinkingConfig.thinkingLevel,
      "deliberate"
    );
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
      reasoning_effort: "deep",
      messages: [{ role: "user", content: "fix it" }],
      tools: [{ type: "function", function: { name: "apply" } }]
    });
    assert.equal(request?.url, "https://chatgpt.test/backend-api/codex/responses");
    assert.equal(request?.headers.get("authorization"), "Bearer oauth");
    assert.equal(request?.headers.get("chatgpt-account-id"), "account");
    const upstreamBody = (await request?.json()) as Record<string, unknown> | undefined;
    assert.equal(upstreamBody?.store, false);
    assert.deepEqual(upstreamBody?.reasoning, { effort: "deep" });
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

test("Codex subscription egress forces SSE and omits unsupported sampling", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return sse([
      {
        event: "response.completed",
        data: {
          response: {
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "done" }]
              }
            ],
            usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 }
          }
        }
      }
    ]);
  };
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      defaultModel: "codex-test",
      forceStream: true,
      omitSampling: true
    });
    const response = await backend.chat({
      stream: false,
      max_tokens: 16,
      temperature: 0,
      messages: [{ role: "user", content: "reply" }]
    });
    const outbound = (await request?.json()) as Record<string, unknown>;
    assert.equal(outbound.stream, true);
    assert.equal("max_output_tokens" in outbound, false);
    assert.equal("temperature" in outbound, false);
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(body.choices[0]?.message.content, "done");
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex subscription egress recovers output from completed stream items", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sse([
      {
        data: {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ok" }]
          },
          output_index: 0
        }
      },
      {
        data: {
          type: "response.completed",
          response: {
            output: [],
            usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13 }
          }
        }
      }
    ]);
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      defaultModel: "gpt-5.4-mini",
      forceStream: true,
      omitSampling: true
    });
    const response = await backend.chat({
      stream: false,
      messages: [{ role: "user", content: "Say ok" }]
    });
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { completion_tokens: number };
    };
    assert.equal(body.choices[0]?.message.content, "ok");
    assert.equal(body.usage.completion_tokens, 5);
  } finally {
    globalThis.fetch = original;
  }
});

test("Anthropic streaming egress preserves tool calls and terminal usage", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sse([
      {
        event: "message_start",
        data: {
          message: { usage: { input_tokens: 4 } }
        }
      },
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
          usage: { output_tokens: 2 }
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
    assert.match(text, /"output_tokens":2/);
    assert.match(text, /data: \[DONE\]/);
    assert.equal(text.match(/data: \[DONE\]/g)?.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("Anthropic streaming egress preserves thinking lifecycle, signatures, and redactions", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sse([
      {
        event: "content_block_start",
        data: {
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" }
        }
      },
      {
        event: "content_block_delta",
        data: {
          index: 0,
          delta: { type: "thinking_delta", thinking: "native thought" }
        }
      },
      {
        event: "content_block_delta",
        data: {
          index: 0,
          delta: { type: "signature_delta", signature: "sig-stream" }
        }
      },
      { event: "content_block_stop", data: { index: 0 } },
      {
        event: "content_block_start",
        data: {
          index: 1,
          content_block: {
            type: "redacted_thinking",
            data: "opaque-stream"
          }
        }
      },
      { event: "content_block_stop", data: { index: 1 } },
      {
        event: "content_block_start",
        data: { index: 2, content_block: { type: "text", text: "" } }
      },
      {
        event: "content_block_delta",
        data: { index: 2, delta: { type: "text_delta", text: "answer" } }
      },
      { event: "content_block_stop", data: { index: 2 } },
      {
        event: "message_delta",
        data: {
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 4, output_tokens: 5 }
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
      messages: [{ role: "user", content: "think" }]
    });
    const text = await response.text();
    assert.match(text, /"reasoning":"native thought"/);
    assert.match(text, /"phase":"start"/);
    assert.match(text, /"phase":"signature","signature":"sig-stream"/);
    assert.match(text, /"phase":"stop"/);
    assert.match(text, /"type":"redacted_thinking"/);
    assert.match(text, /"data":"opaque-stream"/);
    assert.match(text, /"content":"answer"/);
    assert.match(text, /"finish_reason":"stop"/);
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
