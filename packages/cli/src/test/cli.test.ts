import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { MODEL_FUSION_SCHEMA_BUNDLE_HASH } from "@warrant/protocol";
import {
  makeRepo as makeStackRepo,
  mockRunRequest,
  startStack,
  uploadWorkspace
} from "@warrant/testkit";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));
const SMOKE_ENV_KEYS = [
  "WARRANT_CLAUDE_SMOKE",
  "WARRANT_CODEX_SMOKE",
  "WARRANT_ENSEMBLE_LIVE_SMOKE"
] as const;

let home: string;

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

async function startFusionBackend(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse((await readBody(req)).toString("utf8")) as { model?: string };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: `CLI_FUSION:${body.model}` } }]
        })
      );
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
    close: () => closeServer(server)
  };
}

async function startSentinelBackend(
  sentinel: string
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      await readBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: `${sentinel} fusion synthesis` } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      );
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
    close: () => closeServer(server)
  };
}

function warrant(
  args: string[],
  options: { input?: string; env?: Record<string, string | undefined>; dir?: string } = {}
): { status: number; stdout: string; stderr: string } {
  const env = { ...process.env };
  for (const key of SMOKE_ENV_KEYS) delete env[key];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync(process.execPath, [CLI, "--dir", options.dir ?? home, ...args], {
    encoding: "utf8",
    env,
    input: options.input
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

async function warrantAsync(
  args: string[],
  options: { input?: string; env?: Record<string, string | undefined>; dir?: string } = {}
): Promise<{ status: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  for (const key of SMOKE_ENV_KEYS) delete env[key];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "--dir", options.dir ?? home, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      resolve({ status: code ?? 1, stdout, stderr });
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

before(() => {
  home = mkdtempSync(join(tmpdir(), "warrant-cli-test-"));
  rmSync(home, { recursive: true, force: true });
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

test("help prints usage and lists the top-level commands", () => {
  const result = warrant(["help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /governed execution and provenance plane/);
  for (const command of ["run", "continue", "ensemble", "local", "fusion", "ui"]) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
});

test("ensemble help lists its subcommands", () => {
  const result = warrant(["ensemble", "--help"]);
  assert.equal(result.status, 0);
  for (const sub of ["run", "handoff", "dashboard", "e2e", "gateway"]) {
    assert.match(result.stdout, new RegExp(`\\b${sub}\\b`));
  }
});

test("ensemble dashboard help documents the live-smoke flag", () => {
  const result = warrant(["ensemble", "dashboard", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--live-smoke/);
});

test("gateway help lists the front-door subcommands", () => {
  const result = warrant(["ensemble", "gateway", "--help"]);
  assert.equal(result.status, 0);
  for (const sub of ["serve", "acp", "acp-registry", "test", "codex-config"]) {
    assert.match(result.stdout, new RegExp(`\\b${sub}\\b`));
  }
});

test("gateway acp-registry rejects an unknown action", () => {
  const result = warrant(["ensemble", "gateway", "acp-registry", "bogus"]);
  assert.notEqual(result.status, 0);
});

test("local without a tool prints usage and fails", () => {
  const result = warrant(["local"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: warrant local </);
});

test("local rejects an unknown tool", () => {
  const result = warrant(["local", "frobnicate"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: warrant local </);
});

test("local help documents the flags-before-tool contract", () => {
  const result = warrant(["local", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /must precede the tool name/);
});

test("fusion help documents the flags-before-tool contract", () => {
  const result = warrant(["fusion", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /must precede the tool name/);
});

test("init creates keys, config, and policy; refuses to re-init", () => {
  const result = warrant(["init"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /initialized warrant home/);
  assert.match(result.stdout, /admin token \(for the control panel\)/);
  assert.ok(existsSync(join(home, "config.json")));
  assert.ok(existsSync(join(home, "policy.json")));
  // The org private key is sealed at rest; a master key file is generated.
  assert.ok(existsSync(join(home, "keys", "plane.key.enc")));
  assert.ok(existsSync(join(home, "keys", "plane.pub.pem")));
  assert.ok(existsSync(join(home, "master.key")));

  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
    version: string;
    host: string;
    secretsKeyHex?: string;
  };
  assert.equal(config.version, "warrant.config.v2");
  assert.equal(config.host, "127.0.0.1");
  // No key material lives in config.json anymore.
  assert.equal(config.secretsKeyHex, undefined);

  const again = warrant(["init"]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already initialized/);
});

test("secrets are stored encrypted and listed by name only", () => {
  const set = warrant(["secrets", "set", "NPM_TOKEN", "super-secret-value"]);
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /encrypted at rest/);

  const list = warrant(["secrets", "list"]);
  assert.equal(list.status, 0);
  assert.equal(list.stdout.trim(), "NPM_TOKEN");

  const stored = readFileSync(join(home, "secrets.enc"), "utf8");
  assert.ok(!stored.includes("super-secret-value"), "value must be encrypted");
});

test("ui prints the control panel address and login token", () => {
  const result = warrant(["ui"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /control panel: http:\/\/127\.0\.0\.1:7172\/ui\//);
  assert.match(result.stdout, /login token: {3}\S+/);
});

test("unknown commands and missing arguments fail with guidance", () => {
  const unknown = warrant(["frobnicate"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown command/);

  const missingAgent = warrant(["run", "do things"]);
  assert.equal(missingAgent.status, 1);
  assert.match(missingAgent.stderr, /--agent is required/);

  const missingTask = warrant(["continue", "--agent", "mock"]);
  assert.equal(missingTask.status, 1);
  assert.match(missingTask.stderr, /task prompt is required/);

  const badAgent = warrant(["continue", "--agent", "nonsense", "task"]);
  assert.equal(badAgent.status, 1);
  assert.match(badAgent.stderr, /unknown agent kind/);
});

test("verify fails closed on a tampered bundle file", () => {
  const path = join(home, "garbage.bundle.json");
  const fake = {
    version: "warrant.bundle.v1",
    contract: { signatures: [], workspace: { baseRef: "x" } },
    receipt: {
      contractHash: "0".repeat(64),
      signatures: [],
      status: "completed",
      workspaceIn: { baseRef: "y", manifestHash: "z" },
      workspaceOut: { diffHash: "", artifactHashes: [] },
      secretsReleased: [],
      eventsHead: "",
      eventCount: 0
    },
    events: [],
    keys: { planePublicKeyPem: "", runnerPublicKeyPem: "" }
  };
  writeFileSync(path, JSON.stringify(fake));
  const result = warrant(["verify", path]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /VERIFICATION FAILED/);
});

function makeRepo(): { repo: string; cleanup: () => void; output: string } {
  const root = mkdtempSync(join(tmpdir(), "warrant-ensemble-cli-"));
  const repo = join(root, "repo");
  const output = join(root, "out");
  mkdirSync(repo);
  spawnSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "cli@warrant.local"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "warrant-cli"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# cli ensemble\n");
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "--quiet", "-m", "init"], { cwd: repo });
  return { repo, output, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeCodingRepo(): { repo: string; cleanup: () => void; output: string } {
  const fixture = makeRepo();
  writeFileSync(
    join(fixture.repo, "calculator.js"),
    "exports.add = (left, right) => left - right;\n"
  );
  writeFileSync(
    join(fixture.repo, "calculator.test.js"),
    [
      "const assert = require('node:assert/strict');",
      "const { add } = require('./calculator.js');",
      "assert.equal(add(2, 3), 5);",
      "console.log('TEST_OK');",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(fixture.repo, "fix-and-test.js"),
    [
      "const fs = require('node:fs');",
      "fs.writeFileSync('calculator.js', 'exports.add = (left, right) => left + right;\\n');",
      "require('./calculator.test.js');",
      "console.log('PATCH_TEST_OK');",
      ""
    ].join("\n")
  );
  spawnSync("git", ["add", "-A"], { cwd: fixture.repo });
  spawnSync("git", ["commit", "--quiet", "-m", "add failing coding fixture"], { cwd: fixture.repo });
  return fixture;
}

function addFusionCommandProbe(repo: string): void {
  writeFileSync(
    join(repo, "fusion-probe.js"),
    [
      "const fs = require('node:fs');",
      "(async () => {",
      "  const response = await fetch(process.env.FUSIONKIT_CHAT_COMPLETIONS_URL, {",
      "    method: 'POST',",
      "    headers: { 'content-type': 'application/json' },",
      "    body: JSON.stringify({",
      "      model: process.env.FUSIONKIT_MODEL,",
      "      messages: [{ role: 'user', content: 'probe' }]",
      "    })",
      "  });",
      "  const body = await response.json();",
      "  fs.writeFileSync('fusion-result.txt', body.choices[0].message.content);",
      "  console.log('FUSION_PROBE_OK');",
      "})().catch((error) => { console.error(error); process.exit(1); });",
      ""
    ].join("\n")
  );
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "--quiet", "-m", "add fusion probe"], { cwd: repo });
}

test("ensemble mock smoke writes records and concise summary", () => {
  const fixture = makeRepo();
  try {
    const result = warrant([
      "ensemble",
      "run",
      "--harness",
      "mock",
      "--repo",
      fixture.repo,
      "--out",
      fixture.output,
      "--id",
      "cli_mock",
      "this prompt should not be printed in full"
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ensemble cli_mock \[succeeded\]/);
    assert.match(result.stdout, /candidates: 2/);
    assert.ok(!result.stdout.includes("this prompt should not be printed in full"));
    assert.ok(existsSync(join(fixture.output, "summary.json")));
    assert.ok(existsSync(join(fixture.output, "harness-run-request.json")));
    assert.ok(existsSync(join(fixture.output, "harness-run-result.json")));
    assert.ok(existsSync(join(fixture.output, "candidates", "cli_mock_fast_0.json")));
    const summary = JSON.parse(readFileSync(join(fixture.output, "summary.json"), "utf8")) as {
      candidates: unknown[];
      finalPatchPath: string | null;
    };
    assert.equal(summary.candidates.length, 2);
    assert.equal(typeof summary.finalPatchPath === "string" || summary.finalPatchPath === null, true);
  } finally {
    fixture.cleanup();
  }
});

test("ensemble command smoke records command output", () => {
  const fixture = makeRepo();
  try {
    const result = warrant([
      "ensemble",
      "run",
      "--harness",
      "command",
      "--command",
      "printf command-ok",
      "--repo",
      fixture.repo,
      "--out",
      fixture.output,
      "--id",
      "cli_command",
      "command prompt"
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ensemble cli_command \[succeeded\]/);
    const summary = readFileSync(join(fixture.output, "summary.json"), "utf8");
    assert.ok(summary.includes("cli_command_command_0"));
    const candidate = readFileSync(
      join(fixture.output, "candidates", "cli_command_command_0.json"),
      "utf8"
    );
    assert.ok(candidate.includes("succeeded"));
  } finally {
    fixture.cleanup();
  }
});

test("ensemble command failure exits nonzero but writes summary", () => {
  const fixture = makeRepo();
  try {
    const result = warrant([
      "ensemble",
      "run",
      "--harness",
      "command",
      "--command",
      "exit 7",
      "--repo",
      fixture.repo,
      "--out",
      fixture.output,
      "--id",
      "cli_fail",
      "command prompt"
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /ensemble cli_fail \[failed\]/);
    assert.ok(existsSync(join(fixture.output, "summary.json")));
  } finally {
    fixture.cleanup();
  }
});


function benchmarkTask(taskId: string, prompt: string) {
  const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  return {
    schema: "benchmark-task-record.v1",
    schema_version: "v1",
    schema_bundle_hash: MODEL_FUSION_SCHEMA_BUNDLE_HASH,
    producer: "fusionkit-evals",
    producer_version: "0.1.0",
    producer_git_sha: "a".repeat(40),
    created_at: "2026-01-01T00:00:00.000Z",
    task_id: taskId,
    task_kind: "harness_coding",
    source_repo: "fusionkit",
    source_sha: "b".repeat(40),
    prompt,
    prompt_hash: hash(prompt),
    setup_hash: hash(`${taskId}:setup`),
    expected_evidence: ["harness records join"],
    scorer: { kind: "record_join" },
    holdout: false,
    contamination_notes: "synthetic cli handoff test",
    allowed_tools: ["read_file"]
  };
}

test("ensemble handoff rejects positional prompts", () => {
  const payload = {
    category: "coding",
    manifest_path: "/tmp/handoff-positional-task.json",
    task: benchmarkTask("handoff_positional", "should come from stdin")
  };
  const result = warrant(["ensemble", "handoff", "unexpected prompt"], {
    input: JSON.stringify(payload)
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not accept positional arguments/);
  assert.equal(result.stdout, "");
});

test("ensemble handoff emits FusionKit-compatible contract records on stdout", () => {
  const fixture = makeRepo();
  try {
    const payload = {
      category: "coding",
      manifest_path: "/tmp/handoff-cli-task.json",
      task: benchmarkTask("handoff_cli_task", "summarize the repo for handoff")
    };
    const result = warrant(
      [
        "ensemble",
        "handoff",
        "--harness",
        "mock",
        "--repo",
        fixture.repo,
        "--out",
        fixture.output,
        "--id",
        "cli_handoff"
      ],
      { input: JSON.stringify(payload) }
    );
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as { records: Array<{ schema: string }> };
    const schemas = parsed.records.map((record) => record.schema);
    assert.deepEqual(schemas.slice(0, 3), [
      "benchmark-task-record.v1",
      "harness-run-request.v1",
      "harness-run-result.v1"
    ]);
    assert.ok(schemas.includes("harness-candidate-record.v1"));
    assert.ok(schemas.includes("judge-synthesis-record.v1"));
    assert.ok(existsSync(join(fixture.output, "harness-run-result.json")));
    assert.ok(!result.stdout.includes("ensemble cli_handoff"));
  } finally {
    fixture.cleanup();
  }
});

test("ensemble handoff exits zero with failed command harness records for FusionKit ingestion", () => {
  const fixture = makeRepo();
  try {
    const payload = {
      category: "coding",
      manifest_path: "/tmp/handoff-command-fail-task.json",
      task: benchmarkTask("handoff_command_fail", "run a failing command harness")
    };
    const result = warrant(
      [
        "ensemble",
        "handoff",
        "--harness",
        "command",
        "--command",
        "exit 7",
        "--repo",
        fixture.repo,
        "--out",
        fixture.output,
        "--id",
        "cli_command_fail"
      ],
      { input: JSON.stringify(payload) }
    );
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as {
      records: Array<{ schema: string; status?: string; harness_kind?: string }>;
    };
    const runResult = parsed.records.find(
      (record) => record.schema === "harness-run-result.v1"
    );
    assert.equal(runResult?.status, "failed");
    assert.equal(runResult?.harness_kind, "generic");
    assert.ok(parsed.records.some((record) => record.schema === "harness-candidate-record.v1"));
  } finally {
    fixture.cleanup();
  }
});

test("ensemble handoff command harness records real patch and test evidence", () => {
  const fixture = makeCodingRepo();
  try {
    const payload = {
      category: "coding",
      manifest_path: "/tmp/handoff-command-patch-task.json",
      task: {
        ...benchmarkTask(
          "handoff_command_patch",
          "Fix calculator.js so calculator.test.js passes, then run the test."
        ),
        allowed_tools: ["read_file", "write_file", "run_tests"]
      }
    };
    const result = warrant(
      [
        "ensemble",
        "handoff",
        "--harness",
        "command",
        "--command",
        "node fix-and-test.js",
        "--repo",
        fixture.repo,
        "--out",
        fixture.output,
        "--id",
        "cli_command_patch"
      ],
      { input: JSON.stringify(payload) }
    );

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as {
      records: Array<{
        schema: string;
        status?: string;
        artifacts?: Array<{ kind?: string; uri?: string }>;
      }>;
    };
    const runResult = parsed.records.find(
      (record) => record.schema === "harness-run-result.v1"
    );
    const candidate = parsed.records.find(
      (record) => record.schema === "harness-candidate-record.v1"
    );
    const toolExecution = parsed.records.find(
      (record) => record.schema === "tool-execution-record.v1"
    );
    assert.equal(runResult?.status, "succeeded");
    assert.equal(candidate?.status, "succeeded");
    assert.equal(toolExecution?.status, "succeeded");

    const patch = candidate?.artifacts?.find((artifact) => artifact.kind === "patch");
    const transcript = candidate?.artifacts?.find((artifact) => artifact.kind === "transcript");
    assert.ok(patch?.uri, "candidate must include a patch artifact");
    assert.ok(transcript?.uri, "candidate must include a transcript artifact");
    assert.match(
      readFileSync(fileURLToPath(transcript.uri), "utf8"),
      /PATCH_TEST_OK/
    );
  } finally {
    fixture.cleanup();
  }
});

test("ensemble handoff returns structured skip records when codex credentials are absent", () => {
  const fixture = makeRepo();
  const emptyCodexHome = mkdtempSync(join(tmpdir(), "warrant-codex-empty-home-"));
  try {
    const payload = {
      category: "coding",
      manifest_path: "/tmp/handoff-codex-task.json",
      task: benchmarkTask("handoff_codex_skip", "try the codex coding harness")
    };
    const result = warrant(
      [
        "ensemble",
        "handoff",
        "--harness",
        "codex",
        "--repo",
        fixture.repo,
        "--out",
        fixture.output,
        "--id",
        "cli_codex_skip"
      ],
      {
        input: JSON.stringify(payload),
        env: {
          CODEX_API_KEY: "",
          OPENAI_API_KEY: "",
          CODEX_HOME: emptyCodexHome,
          WARRANT_CODEX_RESPONSES_BASE_URL: "",
          CODEX_RESPONSES_BASE_URL: "",
          WARRANT_CODEX_OPENAI_BASE_URL: "",
          OPENAI_BASE_URL: ""
        }
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as {
      records: Array<{ schema: string; status?: string; harness_kind?: string; errors?: unknown[] }>;
    };
    const runResult = parsed.records.find(
      (record) => record.schema === "harness-run-result.v1"
    );
    assert.equal(runResult?.status, "skipped");
    assert.equal(runResult?.harness_kind, "codex");
    assert.ok(JSON.stringify(runResult?.errors).includes("Codex credentials are absent"));
  } finally {
    fixture.cleanup();
    rmSync(emptyCodexHome, { recursive: true, force: true });
  }
});

test("ensemble dashboard writes markdown and run-result records", () => {
  const fixture = makeRepo();
  try {
    const result = warrant([
      "ensemble",
      "dashboard",
      "--repo",
      fixture.repo,
      "--out",
      fixture.output,
      "--timeout-ms",
      "1000"
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /harness dashboard/);
    assert.match(result.stdout, /records: 6/);
    assert.ok(existsSync(join(fixture.output, "dashboard.md")));
    assert.ok(existsSync(join(fixture.output, "harness-run-results", "mock-success.json")));
    assert.ok(existsSync(join(fixture.output, "harness-run-results", "cursor-missing.json")));
    const dashboard = readFileSync(join(fixture.output, "dashboard.md"), "utf8");
    assert.match(dashboard, /Capability Matrix/);
    assert.match(dashboard, /command-failure/);
  } finally {
    fixture.cleanup();
  }
});

test("ensemble dashboard live-smoke flag remains env-gated by default", () => {
  const fixture = makeRepo();
  try {
    const result = warrant([
      "ensemble",
      "dashboard",
      "--repo",
      fixture.repo,
      "--out",
      fixture.output,
      "--timeout-ms",
      "1000",
      "--live-smoke",
      "claude-code",
      "--live-smoke",
      "codex"
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /records: 6/);
    const dashboard = readFileSync(join(fixture.output, "dashboard.md"), "utf8");
    assert.match(dashboard, /live smoke not requested/);
    assert.equal(dashboard.includes("claude-code-live"), false);
    assert.equal(dashboard.includes("codex-live"), false);
  } finally {
    fixture.cleanup();
  }
});

test("ensemble dashboard rejects unknown live-smoke targets", () => {
  const fixture = makeRepo();
  try {
    const result = warrant([
      "ensemble",
      "dashboard",
      "--repo",
      fixture.repo,
      "--out",
      fixture.output,
      "--live-smoke",
      "cursor"
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--live-smoke must be/);
  } finally {
    fixture.cleanup();
  }
});

test("ensemble task-file input works without printing prompt contents", () => {
  const fixture = makeRepo();
  try {
    const taskFile = join(fixture.repo, "task.txt");
    writeFileSync(taskFile, "secret-ish task text that should not print");
    const result = warrant([
      "ensemble",
      "run",
      "--harness",
      "mock",
      "--task-file",
      taskFile,
      "--repo",
      fixture.repo,
      "--out",
      fixture.output,
      "--id",
      "cli_file"
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ensemble cli_file \[succeeded\]/);
    assert.ok(!result.stdout.includes("secret-ish task text"));
    assert.ok(existsSync(join(fixture.output, "summary.json")));
  } finally {
    fixture.cleanup();
  }
});

test("ensemble e2e runs a FusionKit-backed command matrix and writes a report", async () => {
  const fixture = makeRepo();
  const backend = await startFusionBackend();
  try {
    addFusionCommandProbe(fixture.repo);
    const result = await warrantAsync([
      "ensemble",
      "e2e",
      "--fusion-backend",
      backend.url,
      "--harness",
      "command",
      "--command",
      "node fusion-probe.js",
      "--model",
      "alpha=fusion-alpha",
      "--judge-model",
      "fusion-judge",
      "--repo",
      fixture.repo,
      "--out",
      fixture.output,
      "Run the FusionKit-backed command harness."
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /unified e2e \[succeeded:1\]/);
    assert.ok(existsSync(join(fixture.output, "unified-e2e-report.json")));
    const report = readFileSync(join(fixture.output, "unified-e2e-report.json"), "utf8");
    assert.match(report, /"harness": "command"/);
    assert.match(report, /"judgeSynthesis": true/);
  } finally {
    await backend.close();
    fixture.cleanup();
  }
});

test("ensemble gateway codex-config prints a Responses provider snippet", () => {
  const result = warrant([
    "ensemble",
    "gateway",
    "codex-config",
    "--fusion-backend",
    "http://127.0.0.1:8787"
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /model_provider = "fusion-gateway"/);
  assert.match(result.stdout, /wire_api = "responses"/);
  assert.match(result.stdout, /base_url = "http:\/\/127\.0\.0\.1:8787\/v1"/);
});

test("ensemble gateway test runs the unified front-door acceptance suite", async () => {
  const fixture = makeRepo();
  const backend = await startSentinelBackend("FUSION_OK");
  try {
    addFusionCommandProbe(fixture.repo);
    const reportPath = join(fixture.output, "front-door-report.json");
    const result = await warrantAsync([
      "ensemble",
      "gateway",
      "test",
      "--fusion-backend",
      backend.url,
      "--harness",
      "command",
      "--command",
      "node fusion-probe.js",
      "--model",
      "alpha=fusion-alpha",
      "--judge-model",
      "fusion-judge",
      "--repo",
      fixture.repo,
      "--out",
      reportPath,
      "--sentinel",
      "FUSION_OK"
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /front-door acceptance report/);
    assert.ok(existsSync(reportPath));
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      front_doors: Array<{ id: string; status: string; reason?: string }>;
    };
    const statusOf = (id: string): string | undefined =>
      report.front_doors.find((door) => door.id === id)?.status;
    assert.equal(statusOf("codex-responses"), "passed");
    assert.equal(statusOf("claude-messages"), "passed");
    assert.equal(statusOf("openai-chat"), "passed");
    assert.equal(statusOf("generic-acp"), "passed");
    assert.equal(statusOf("codex-acp"), "blocked");
    assert.equal(statusOf("cursor-acp"), "blocked");
  } finally {
    await backend.close();
    fixture.cleanup();
  }
});

test("lifecycle commands read a real run from a live plane", async () => {
  const stack = await startStack({
    policy: (policy) => {
      policy.agents.allow = ["mock"];
    }
  });
  const repo = makeStackRepo({ files: { "README.md": "# cli lifecycle\n" } });
  const liveHome = mkdtempSync(join(tmpdir(), "warrant-cli-live-"));
  rmSync(liveHome, { recursive: true, force: true });
  try {
    // The plane runs in this test process, so every CLI call must use the async
    // spawner: a synchronous spawn would block the event loop and deadlock the
    // in-process plane.
    const init = await warrantAsync(["init"], { dir: liveHome });
    assert.equal(init.status, 0, init.stderr);

    // Point the freshly initialized home at the in-process test stack.
    const configPath = join(liveHome, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      planeUrl: string;
      adminToken: string;
    };
    config.planeUrl = stack.planeUrl;
    config.adminToken = stack.adminToken;
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Create one completed run through the SDK so the CLI has something to read.
    const captured = await uploadWorkspace(stack.client, repo);
    const created = await stack.client.requestRun(
      mockRunRequest({ prompt: "lifecycle probe", pool: stack.pool, workspace: captured.manifest })
    );
    if (created.status === "awaiting_approval") {
      await stack.client.approve(created.runId, { kind: "human", id: "cli-tester" });
    }
    assert.ok(await stack.runOnce());

    const runs = await warrantAsync(["runs"], { dir: liveHome });
    assert.equal(runs.status, 0, runs.stderr);
    assert.match(runs.stdout, new RegExp(created.runId));

    const receipt = await warrantAsync(["receipt", created.runId], { dir: liveHome });
    assert.equal(receipt.status, 0, receipt.stderr);

    const bundlePath = join(liveHome, "out.bundle.json");
    const bundle = await warrantAsync(["bundle", created.runId, "--out", bundlePath], {
      dir: liveHome
    });
    assert.equal(bundle.status, 0, bundle.stderr);
    assert.match(bundle.stdout, /bundle written to/);
    assert.ok(existsSync(bundlePath));

    // The CLI round-trips its own bundle through offline verification.
    const verify = await warrantAsync(["verify", bundlePath], { dir: liveHome });
    assert.equal(verify.status, 0, verify.stderr);
    assert.match(verify.stdout, /VERIFIED/);

    const exported = await warrantAsync(["export"], { dir: liveHome });
    assert.equal(exported.status, 0, exported.stderr);
    assert.match(exported.stdout, new RegExp(created.runId));

    const pull = await warrantAsync(["pull", created.runId, "--repo", repo], { dir: liveHome });
    assert.equal(pull.status, 0, pull.stderr);
    assert.match(pull.stdout, /applied|nothing to pull|branch/);
  } finally {
    await stack.stop();
    rmSync(repo, { recursive: true, force: true });
    rmSync(liveHome, { recursive: true, force: true });
  }
});
