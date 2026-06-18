import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { startGateway } from "../server.js";
import { FusionBackend } from "../fusion-backend.js";
import type { PanelRunInput, WireTrajectory } from "../fusion-backend.js";

/**
 * A stand-in FusionKit `trajectory:step`: it records every request and replies
 * with a scripted OpenAI chat completion. The script emits a tool call until it
 * sees a tool result in the conversation, then returns the final answer — so a
 * driver can run the full front-door agent loop deterministically.
 */
async function startFakeStepServer(): Promise<{
  url: string;
  requests: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: Array<{ role: string }>;
        trajectories?: unknown[];
      };
      requests.push(body as Record<string, unknown>);
      const sawToolResult = (body.messages ?? []).some((message) => message.role === "tool");
      const completion = sawToolResult
        ? {
            id: "chatcmpl-final",
            object: "chat.completion",
            created: 0,
            model: "fusion-panel",
            choices: [
              { index: 0, message: { role: "assistant", content: "DONE: applied the fix" }, finish_reason: "stop" }
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          }
        : {
            id: "chatcmpl-tool",
            object: "chat.completion",
            created: 0,
            model: "fusion-panel",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: "write_file", arguments: '{"path":"calculator.js"}' }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          };
      const payload = JSON.stringify(completion);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

const CANDIDATES: WireTrajectory[] = [
  { trajectory_id: "t_gpt", model_id: "gpt", status: "succeeded", final_output: "fixed via +" },
  { trajectory_id: "t_opus", model_id: "opus", status: "succeeded", final_output: "fixed and added a test" }
];

/** A streaming `trajectory:step` stand-in that emits a keepalive comment + a tool_call chunk. */
async function startStreamingStepServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": keepalive\n\n");
      res.write(
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"write_file","arguments":"{}"}}]},"finish_reason":null}]}\n\n'
      );
      res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

test("fusion front door runs panels once and loops tool calls to a final answer", async () => {
  const step = await startFakeStepServer();
  let panelRuns = 0;
  const panelInputs: PanelRunInput[] = [];

  const backend = new FusionBackend({
    stepUrl: `${step.url}/v1/fusion/trajectory:step`,
    defaultModel: "fusion-panel",
    mintTraceId: () => "trace_test",
    runPanels: async (input) => {
      panelRuns += 1;
      panelInputs.push(input);
      return CANDIDATES;
    }
  });

  const gateway = await startGateway({ backend, host: "127.0.0.1", port: 0 });
  const url = `${gateway.url()}/v1/chat/completions`;
  const tools = [
    { type: "function", function: { name: "write_file", parameters: { type: "object", properties: {} } } }
  ];

  try {
    // Turn 1: initial task -> the judge proposes a tool call.
    const first = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fusion-panel",
        tools,
        messages: [
          { role: "system", content: "You are a coding agent." },
          { role: "user", content: "Fix the add() bug in calculator.js" }
        ]
      })
    });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as {
      choices: Array<{ message: { tool_calls?: Array<{ function: { name: string } }> }; finish_reason: string }>;
    };
    const firstChoice = firstBody.choices[0];
    assert.ok(firstChoice);
    assert.equal(firstChoice.finish_reason, "tool_calls");
    assert.equal(firstChoice.message.tool_calls?.[0]?.function.name, "write_file");

    // Turn 2: harness executed the tool and returns the result -> final answer.
    const second = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fusion-panel",
        tools,
        messages: [
          { role: "system", content: "You are a coding agent." },
          { role: "user", content: "Fix the add() bug in calculator.js" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "write_file", arguments: '{"path":"calculator.js"}' } }
            ]
          },
          { role: "tool", tool_call_id: "call_1", content: "exit_code=0\n1 passing" }
        ]
      })
    });
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    };
    const secondChoice = secondBody.choices[0];
    assert.ok(secondChoice);
    assert.equal(secondChoice.finish_reason, "stop");
    assert.match(secondChoice.message.content, /DONE/);

    // Panels ran exactly once across both turns (session reuse by prefix).
    assert.equal(panelRuns, 1);
    const firstPanel = panelInputs[0];
    assert.ok(firstPanel);
    assert.equal(firstPanel.traceId, "trace_test");
    assert.match(firstPanel.task, /add\(\) bug/);

    // The judge step received the candidate trajectories and the harness tools.
    const lastRequest = step.requests.at(-1) as { trajectories?: unknown[]; tools?: unknown[] };
    assert.equal((lastRequest.trajectories ?? []).length, 2);
    assert.ok(Array.isArray(lastRequest.tools) && lastRequest.tools.length === 1);
  } finally {
    await gateway.close();
    await step.close();
  }
});

test("chat (cursor) front door streams tool_calls and keepalive through unchanged", async () => {
  const step = await startStreamingStepServer();
  const backend = new FusionBackend({
    stepUrl: `${step.url}/v1/fusion/trajectory:step`,
    defaultModel: "fusion-panel",
    mintTraceId: () => "trace_chat",
    runPanels: async () => CANDIDATES
  });
  const gateway = await startGateway({ backend, host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fusion-panel",
        stream: true,
        tools: [{ type: "function", function: { name: "write_file", parameters: { type: "object", properties: {} } } }],
        messages: [
          { role: "system", content: "agent" },
          { role: "user", content: "fix it" }
        ]
      })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const text = await response.text();
    // The chat path is a pass-through, so the cursor bridge sees keepalive
    // comments and tool_calls deltas exactly as produced.
    assert.ok(text.includes(": keepalive"), "keepalive comments must pass through the chat path");
    assert.ok(text.includes("write_file"), "tool_calls must pass through the chat path");
    assert.ok(text.includes("[DONE]"));
  } finally {
    await gateway.close();
    await step.close();
  }
});
