/**
 * Managed agent-harness depth against the RouteKit gateway + provider
 * simulator: finite-k receding-horizon rollouts and unbounded worktree
 * rollouts. This is the production `runPanelRound -> runFusionPanels ->
 * runWorktreeAgent` path (real git worktrees, real AI SDK tool execution),
 * not a mocked driver or the k=1 raw-completion path.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { runPanelRound } from "@fusionkit/ensemble";
import type { WireTrajectory } from "@fusionkit/protocol";
import {
  stackToolingSkip,
  startProviderSim
} from "@fusionkit/testkit";
import type { ProviderSimHandle } from "@fusionkit/testkit";
import { OpenAiBackend, parseRouterConfig } from "@routekit/gateway";
import type { ProviderSource } from "@routekit/gateway";
import { startRouter } from "@routekit/router";
import type { RunningRouter } from "@routekit/router";

const SKIP = stackToolingSkip();

const MODELS = [
  { id: "openai/managed-alpha", model: "managed-alpha" },
  { id: "openai/managed-beta", model: "managed-beta" }
] as const;

let sim: ProviderSimHandle;
let router: RunningRouter;
let root: string;
let repo: string;

before(async function () {
  if (SKIP !== false) return;
  sim = await startProviderSim();
  const backend = new OpenAiBackend({
    baseUrl: `${sim.url}/v1`,
    apiKey: "test-provider-key"
  });
  const source: ProviderSource = {
    sourceId: "openai",
    discoverModels: async () => MODELS.map(({ model }) => ({ id: model })),
    chat: async (body, signal, options) =>
      await backend.chat(body, signal, options),
    embeddings: async (body, signal) => await backend.embeddings(body, signal)
  };
  router = await startRouter({
    config: parseRouterConfig({
      providers: { openai: {} },
      defaultModel: MODELS[0].id
    }),
    host: "127.0.0.1",
    port: 0,
    sources: { openai: source }
  });
  root = mkdtempSync(join(tmpdir(), "fusionkit-managed-k-"));
  repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=e2e@fusionkit.local",
      "-c",
      "user.name=fusionkit-e2e",
      "commit",
      "-q",
      "-m",
      "fixture"
    ],
    { cwd: repo }
  );
});

after(async () => {
  if (SKIP !== false) return;
  await router.close();
  await sim.close();
  rmSync(root, { recursive: true, force: true });
});

function writeCall(id: string, path: string, contents: string): {
  id: string;
  name: string;
  arguments: string;
} {
  return {
    id,
    name: "write_file",
    arguments: JSON.stringify({ path, contents })
  };
}

function callsOf(wire: WireTrajectory): Array<Record<string, unknown>> {
  return (wire.items ?? []).filter((item) => item.type === "function_call");
}

function outputsOf(wire: WireTrajectory): Array<Record<string, unknown>> {
  return (wire.items ?? []).filter((item) => item.type === "function_call_output");
}

test(
  "k=2 managed worktree rollouts execute boundary 1 and capture boundary 2 unexecuted",
  { skip: SKIP },
  async () => {
    await sim.reset();
    for (const [model, prefix] of [
      ["managed-alpha", "a"],
      ["managed-beta", "b"]
    ] as const) {
      await sim.queue(model, [
        {
          tool_calls: [
            writeCall(`${prefix}1`, `${prefix}-executed.txt`, "executed in isolated worktree")
          ]
        },
        {
          tool_calls: [
            writeCall(`${prefix}2`, `${prefix}-proposed.txt`, "must remain unexecuted")
          ]
        },
        { reply: "generation three must never run" }
      ]);
    }

    const wires = await runPanelRound({
      id: "managed_k2",
      repo,
      outputRoot: join(root, "k2-output"),
      prompt: "make one edit, then propose the next edit",
      models: [...MODELS],
      harness: "agent",
      fusionBackendUrl: router.url,
      modelEndpoints: {
        "openai/managed-alpha": router.url,
        "openai/managed-beta": router.url
      },
      k: 2
    });

    assert.equal(wires.length, 2);
    for (const wire of wires) {
      assert.equal(wire.status, "succeeded");
      assert.match(wire.final_output, /Proposed next step: write_file/);
      const calls = callsOf(wire);
      const outputs = outputsOf(wire);
      assert.equal(calls.length, 2, "both generation boundaries are captured");
      assert.equal(outputs.length, 1, "only the first boundary executes");
      assert.equal(
        outputs[0]?.call_id,
        calls[0]?.call_id,
        "the first tool call has real execution evidence"
      );
      assert.notEqual(
        calls[1]?.call_id,
        outputs[0]?.call_id,
        "the k-th proposal has no execution output"
      );
      const proposalIndex = (wire.items ?? []).indexOf(calls[1] ?? {});
      assert.equal(
        (wire.items ?? [])
          .slice(proposalIndex + 1)
          .some((item) => item.type === "function_call_output"),
        false,
        "no observation may follow the captured k-th proposal"
      );
    }
    assert.deepEqual(
      (await sim.calls({ dialect: "openai-chat" }))
        .filter((entry) => entry.model.startsWith("managed-"))
        .map((entry) => entry.model)
        .sort(),
      ["managed-alpha", "managed-alpha", "managed-beta", "managed-beta"],
      "k=2 makes exactly two generations per member"
    );
    // Worktree registrations are cleaned after the panel, even though tools
    // executed inside them.
    const worktreeList = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repo,
      encoding: "utf8"
    });
    assert.equal((worktreeList.match(/^worktree /gm) ?? []).length, 1);
  }
);

test(
  "unbounded managed rollouts execute tools, observe results, and stop on the model's final answer",
  { skip: SKIP },
  async () => {
    await sim.reset();
    for (const [model, prefix] of [
      ["managed-alpha", "a"],
      ["managed-beta", "b"]
    ] as const) {
      await sim.queue(model, [
        {
          tool_calls: [
            writeCall(`${prefix}-write`, `${prefix}-completed.txt`, "completed rollout edit")
          ]
        },
        { reply: `${model} completed after verifying the edit` }
      ]);
    }

    const wires = await runPanelRound({
      id: "managed_unbounded",
      repo,
      outputRoot: join(root, "unbounded-output"),
      prompt: "make and verify the requested edit",
      models: [...MODELS],
      harness: "agent",
      fusionBackendUrl: router.url,
      modelEndpoints: {
        "openai/managed-alpha": router.url,
        "openai/managed-beta": router.url
      }
      // k intentionally omitted: the managed agent rolls out until completion.
    });

    assert.equal(wires.length, 2);
    for (const wire of wires) {
      assert.equal(wire.status, "succeeded");
      assert.match(wire.final_output, /completed after verifying the edit/);
      assert.equal(callsOf(wire).length, 1);
      assert.equal(outputsOf(wire).length, 1, "the tool call executed in the worktree");
      assert.equal((wire.items ?? []).at(-1)?.type, "message");
    }
    assert.deepEqual(
      (await sim.calls({ dialect: "openai-chat" }))
        .filter((entry) => entry.model.startsWith("managed-"))
        .map((entry) => entry.model)
        .sort(),
      ["managed-alpha", "managed-alpha", "managed-beta", "managed-beta"]
    );
  }
);

test(
  "managed worktree tools reject path traversal and capture the failed observation as evidence",
  { skip: SKIP },
  async () => {
    await sim.reset();
    for (const model of ["managed-alpha", "managed-beta"]) {
      await sim.queue(model, [
        {
          tool_calls: [
            writeCall(`${model}-escape`, "../escape.txt", "must never leave the worktree")
          ]
        },
        { reply: `${model} observed the rejected unsafe path` }
      ]);
    }

    const wires = await runPanelRound({
      id: "managed_path_security",
      repo,
      outputRoot: join(root, "path-security-output"),
      prompt: "try the supplied edit and report the result",
      models: [...MODELS],
      harness: "agent",
      fusionBackendUrl: router.url,
      modelEndpoints: {
        "openai/managed-alpha": router.url,
        "openai/managed-beta": router.url
      },
      k: 2
    });

    assert.equal(existsSync(join(root, "escape.txt")), false);
    assert.equal(existsSync(join(repo, "escape.txt")), false);
    for (const wire of wires) {
      const rejected = (wire.items ?? []).find(
        (item) =>
          item.type === "function_call_output" &&
          (item.is_error === true ||
            /outside|path|root/i.test(typeof item.text === "string" ? item.text : ""))
      );
      assert.ok(rejected, `unsafe tool result must be captured as error evidence: ${JSON.stringify(wire)}`);
      assert.match(wire.final_output, /rejected unsafe path/);
    }
  }
);
