import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  runUnifiedHarnessE2E,
  type CursorHarnessRunnerInput
} from "../unified.js";

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startFusionBackend(): Promise<{
  url: string;
  models: string[];
  close: () => Promise<void>;
}> {
  const models: string[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse((await readBody(req)).toString("utf8")) as {
        model?: string;
        messages?: Array<{ role?: string; content?: string }>;
      };
      const model = body.model ?? "unknown";
      models.push(model);
      // The unified fusion endpoint: returns an OpenAI chat completion whose
      // terminal `fusion.trajectory.synthesis` carries the folded fusion result.
      if (req.url === "/v1/fusion/trajectories:fuse") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: `JUDGE_FINAL:${model}` } }],
            fusion: {
              trajectory: {
                trajectory_id: "synthesis_test",
                synthesis: { decision: "synthesize", rationale: "fused" }
              }
            }
          })
        );
        return;
      }
      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: `MODEL_REPLY:${model}` } }]
          })
        );
        return;
      }
      res.writeHead(404).end();
    })().catch((error: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);
  return {
    url: `http://127.0.0.1:${address.port}`,
    models,
    close: () => closeServer(server)
  };
}

function makeRepo(): { root: string; repo: string; outputRoot: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "unified-harness-e2e-"));
  const repo = join(root, "repo");
  const outputRoot = join(root, "out");
  mkdirSync(repo);
  spawnSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "unified@warrant.local"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "unified"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# unified fixture\n");
  writeFileSync(
    join(repo, "candidate.js"),
    [
      "const fs = require('node:fs');",
      "(async () => {",
      "  const response = await fetch(process.env.FUSIONKIT_CHAT_COMPLETIONS_URL, {",
      "    method: 'POST',",
      "    headers: { 'content-type': 'application/json' },",
      "    body: JSON.stringify({",
      "      model: process.env.FUSIONKIT_MODEL,",
      "      messages: [{ role: 'user', content: 'candidate probe' }]",
      "    })",
      "  });",
      "  const body = await response.json();",
      "  fs.writeFileSync(`result-${process.env.HARNESS_MODEL_ID}.txt`, body.choices[0].message.content);",
      "  console.log(`MODEL_OK:${process.env.HARNESS_MODEL_ID}`);",
      "})().catch((error) => { console.error(error); process.exit(1); });",
      ""
    ].join("\n")
  );
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "--quiet", "-m", "init"], { cwd: repo });
  return { root, repo, outputRoot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("unified runner routes each command candidate through FusionKit and synthesizes", async () => {
  const fixture = makeRepo();
  const backend = await startFusionBackend();
  try {
    const result = await runUnifiedHarnessE2E({
      id: "unified_test",
      fusionBackendUrl: backend.url,
      repo: fixture.repo,
      outputRoot: fixture.outputRoot,
      prompt: "Run the candidate script and synthesize the result.",
      harnesses: ["command"],
      models: [
        { id: "alpha", model: "fusion-alpha" },
        { id: "beta", model: "fusion-beta" }
      ],
      judgeModel: "fusion-judge",
      command: "node candidate.js",
      timeoutMs: 10_000
    });

    const row = result.results[0];
    assert.equal(row?.status, "succeeded");
    assert.equal(row?.ensemble?.candidates.length, 2);
    assert.equal(row?.ensemble?.judgeSynthesisRecord?.final_output, "JUDGE_FINAL:fusion-judge");
    assert.ok(row?.ensemble?.artifacts.some((artifact) => artifact.kind === "patch"));
    assert.deepEqual(backend.models.sort(), ["fusion-alpha", "fusion-beta", "fusion-judge"]);
    assert.ok(result.reportPath?.endsWith("unified-e2e-report.json"));
  } finally {
    await backend.close();
    fixture.cleanup();
  }
});

test("unified runner includes Cursor ACP and desktop adapter results", async () => {
  const fixture = makeRepo();
  try {
    const seen: CursorHarnessRunnerInput[] = [];
    const result = await runUnifiedHarnessE2E({
      id: "unified_cursor_test",
      fusionBackendUrl: "http://127.0.0.1:9999",
      repo: fixture.repo,
      outputRoot: fixture.outputRoot,
      prompt: "Run Cursor probes.",
      harnesses: ["cursor-acp", "cursor-desktop"],
      models: [{ id: "cursor-local", model: "local-model" }],
      cursorRunner: async (input) => {
        seen.push(input);
        return {
          status: "succeeded",
          message: `${input.kind} ok`,
          artifacts: { report: join(input.outDir, "report.json") },
          details: { model: input.model.id }
        };
      }
    });

    assert.deepEqual(result.results.map((row) => row.harness), ["cursor-acp", "cursor-desktop"]);
    assert.deepEqual(result.results.map((row) => row.status), ["succeeded", "succeeded"]);
    assert.deepEqual(seen.map((input) => input.kind), ["cursor-acp", "cursor-desktop"]);
  } finally {
    fixture.cleanup();
  }
});
