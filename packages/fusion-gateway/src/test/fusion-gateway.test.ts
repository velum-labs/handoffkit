import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FUSION_EVIDENCE_HEADER,
  FUSION_RUN_ID_HEADER,
  FUSION_STATUS_HEADER,
  promptFromAnthropic,
  promptFromChat,
  promptFromResponses,
  startFusionGateway
} from "../fusion-gateway.js";
import type { FrontDoorRunner, FrontDoorRunnerInput } from "../fusion-gateway.js";

function recordingRunner(): { runner: FrontDoorRunner; calls: FrontDoorRunnerInput[] } {
  const calls: FrontDoorRunnerInput[] = [];
  const runner: FrontDoorRunner = async (input) => {
    calls.push(input);
    return {
      finalOutput: `FUSION_OK:${input.dialect}:${input.prompt}`,
      runId: `run_${calls.length}`,
      status: "succeeded",
      evidence: ["patch_artifact", "tool_execution", "judge_synthesis"]
    };
  };
  return { runner, calls };
}

test("prompt extractors pull user text from each dialect", () => {
  assert.equal(
    promptFromResponses({
      instructions: "sys",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
    }),
    "sys\n\nhello"
  );
  assert.equal(
    promptFromAnthropic({
      system: "sys",
      messages: [{ role: "user", content: "hi there" }]
    }),
    "sys\n\nhi there"
  );
  assert.equal(
    promptFromChat({ messages: [{ role: "user", content: "do the thing" }] }),
    "do the thing"
  );
});

test("gateway translates Responses, Anthropic, and Chat front doors", async () => {
  const { runner, calls } = recordingRunner();
  const gateway = await startFusionGateway({ runner, defaultModel: "fusion-panel" });
  try {
    const health = await fetch(`${gateway.url()}/health`);
    assert.equal(health.status, 200);

    const responses = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fusion-panel",
        input: [{ role: "user", content: [{ type: "input_text", text: "codex prompt" }] }]
      })
    });
    assert.equal(responses.status, 200);
    assert.equal(responses.headers.get(FUSION_STATUS_HEADER), "succeeded");
    assert.equal(responses.headers.get(FUSION_RUN_ID_HEADER), "run_1");
    assert.deepEqual(JSON.parse(responses.headers.get(FUSION_EVIDENCE_HEADER) ?? "[]"), [
      "patch_artifact",
      "tool_execution",
      "judge_synthesis"
    ]);
    const responsesBody = (await responses.json()) as {
      object: string;
      output: Array<{ content: Array<{ text: string }> }>;
    };
    assert.equal(responsesBody.object, "response");
    assert.match(responsesBody.output[0]?.content[0]?.text ?? "", /FUSION_OK:openai-responses:codex prompt/);

    const messages = await fetch(`${gateway.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "fusion-panel",
        max_tokens: 256,
        messages: [{ role: "user", content: "claude prompt" }]
      })
    });
    const messagesBody = (await messages.json()) as {
      type: string;
      content: Array<{ text?: string }>;
    };
    assert.equal(messagesBody.type, "message");
    assert.match(messagesBody.content[0]?.text ?? "", /FUSION_OK:anthropic-messages:claude prompt/);

    const chat = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fusion-panel",
        messages: [{ role: "user", content: "cursor prompt" }]
      })
    });
    const chatBody = (await chat.json()) as {
      object: string;
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(chatBody.object, "chat.completion");
    assert.match(chatBody.choices[0]?.message.content ?? "", /FUSION_OK:openai-chat:cursor prompt/);

    assert.deepEqual(
      calls.map((call) => call.dialect),
      ["openai-responses", "anthropic-messages", "openai-chat"]
    );
  } finally {
    await gateway.close();
  }
});

test("gateway serves OpenAI and Anthropic model lists and enforces auth", async () => {
  const { runner } = recordingRunner();
  const gateway = await startFusionGateway({
    runner,
    defaultModel: "fusion-panel",
    authToken: "secret"
  });
  try {
    const unauthorized = await fetch(`${gateway.url()}/v1/models`);
    assert.equal(unauthorized.status, 401);

    const openai = await fetch(`${gateway.url()}/v1/models`, {
      headers: { authorization: "Bearer secret" }
    });
    const openaiBody = (await openai.json()) as { data: Array<{ id: string }> };
    assert.equal(openaiBody.data[0]?.id, "fusion-panel");

    const anthropic = await fetch(`${gateway.url()}/v1/models`, {
      headers: { authorization: "Bearer secret", "anthropic-version": "2023-06-01" }
    });
    const anthropicBody = (await anthropic.json()) as { data: Array<{ type: string; id: string }> };
    assert.equal(anthropicBody.data[0]?.type, "model");
    assert.equal(anthropicBody.data[0]?.id, "fusion-panel");
  } finally {
    await gateway.close();
  }
});
