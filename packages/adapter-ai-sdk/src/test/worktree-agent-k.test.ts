/**
 * Finite-k semantics in the worktree agent loop: tool-call batches of
 * generations 1..k-1 execute in the worktree; the k-th generation's batch is
 * captured unexecuted as the terminal proposal (trailing `tool_call` steps
 * with no observation), and sentinel observations never reach the trajectory.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runWorktreeAgent } from "../worktree-agent.js";

type ScriptedTurn = {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** A scripted OpenAI-compatible chat endpoint: one canned reply per generation. */
async function startScriptedModel(turns: ScriptedTurn[]): Promise<{
  baseUrl: string;
  generations: () => number;
  close: () => Promise<void>;
}> {
  let generation = 0;
  const server = createServer((req, res) => {
    void (async () => {
      await readBody(req);
      const turn = turns[generation] ?? { content: "(script exhausted)" };
      generation += 1;
      const message: Record<string, unknown> = {
        role: "assistant",
        content: turn.content ?? null,
        ...(turn.toolCalls !== undefined
          ? {
              tool_calls: turn.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments }
              }))
            }
          : {})
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `cmpl_${generation}`,
          object: "chat.completion",
          created: 0,
          model: "scripted",
          choices: [
            {
              index: 0,
              message,
              finish_reason: turn.toolCalls !== undefined ? "tool_calls" : "stop"
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      );
    })().catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    generations: () => generation,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

function writeCall(id: string, path: string, contents: string): { id: string; name: string; arguments: string } {
  return { id, name: "write_file", arguments: JSON.stringify({ path, contents }) };
}

test("k=2 executes the first batch, captures the second unexecuted as the proposal", async () => {
  const worktree = mkdtempSync(join(tmpdir(), "wk-agent-k-"));
  const model = await startScriptedModel([
    { toolCalls: [writeCall("c1", "first.txt", "executed")] },
    { toolCalls: [writeCall("c2", "second.txt", "proposed")] },
    { content: "should never be reached" }
  ]);
  try {
    const result = await runWorktreeAgent({
      worktree,
      prompt: "do the task",
      baseUrl: model.baseUrl,
      model: "scripted",
      k: 2
    });

    // Boundary 1 executed for real; boundary 2 (the k-th) proposed, not executed.
    assert.equal(readFileSync(join(worktree, "first.txt"), "utf8"), "executed");
    assert.equal(existsSync(join(worktree, "second.txt")), false, "the k-th batch must not execute");
    assert.equal(model.generations(), 2, "k bounds the loop: no generation after the k-th boundary");
    assert.equal(result.status, "succeeded");

    // The trajectory ends at the proposal: a tool_call for second.txt with no
    // observation after it (sentinel observations are stripped).
    const types = result.steps.map((step) => step.type);
    const lastToolCall = result.steps.filter((step) => step.type === "tool_call").at(-1);
    assert.match(lastToolCall?.tool_input ?? "", /second\.txt/);
    const proposalIndex = result.steps.indexOf(lastToolCall!);
    assert.deepEqual(
      types.slice(proposalIndex + 1).filter((type) => type === "observation"),
      [],
      "no observation may follow the proposed batch"
    );
    // The executed boundary's observation is real evidence and stays.
    const firstCallIndex = result.steps.findIndex((step) => step.type === "tool_call");
    assert.equal(result.steps[firstCallIndex + 1]?.type, "observation");
  } finally {
    await model.close();
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("k=2 with a parallel batch at the boundary captures the whole batch atomically", async () => {
  const worktree = mkdtempSync(join(tmpdir(), "wk-agent-k-"));
  const model = await startScriptedModel([
    { toolCalls: [writeCall("c1", "lookahead.txt", "executed")] },
    {
      toolCalls: [
        writeCall("c2a", "batch-a.txt", "proposed"),
        writeCall("c2b", "batch-b.txt", "proposed")
      ]
    }
  ]);
  try {
    const result = await runWorktreeAgent({
      worktree,
      prompt: "do the task",
      baseUrl: model.baseUrl,
      model: "scripted",
      k: 2
    });

    assert.equal(existsSync(join(worktree, "batch-a.txt")), false);
    assert.equal(existsSync(join(worktree, "batch-b.txt")), false);
    const proposed = result.steps.filter(
      (step) => step.type === "tool_call" && /batch-[ab]\.txt/.test(step.tool_input ?? "")
    );
    assert.equal(proposed.length, 2, "the whole k-th batch is proposed together");
  } finally {
    await model.close();
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("a final answer before the k-th boundary ends the rollout normally", async () => {
  const worktree = mkdtempSync(join(tmpdir(), "wk-agent-k-"));
  const model = await startScriptedModel([
    { toolCalls: [writeCall("c1", "work.txt", "executed")] },
    { content: "done: the answer" }
  ]);
  try {
    const result = await runWorktreeAgent({
      worktree,
      prompt: "do the task",
      baseUrl: model.baseUrl,
      model: "scripted",
      k: 5
    });
    assert.equal(result.finalOutput, "done: the answer");
    assert.equal(readFileSync(join(worktree, "work.txt"), "utf8"), "executed");
  } finally {
    await model.close();
    rmSync(worktree, { recursive: true, force: true });
  }
});
