import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createMockHarness, ensemble } from "@fusionkit/ensemble";
import type { EnsembleDescriptor } from "@fusionkit/ensemble";
import { addTraceListener, removeTraceListener } from "@fusionkit/protocol";
import type { FusionTraceEvent } from "@fusionkit/protocol";

import {
  codexConfigToml,
  codexHarness,
  codexLaunchConfigToml,
  codexModelCatalogJson,
  defaultCodexRunner
} from "../index.js";
import type { CodexExecRunner } from "../index.js";

function tempOutputRoot(): { outputRoot: string; cleanup: () => void } {
  const outputRoot = mkdtempSync(join(tmpdir(), "ensemble-codex-out-"));
  return {
    outputRoot,
    cleanup: () => rmSync(outputRoot, { recursive: true, force: true })
  };
}

function descriptor(outputRoot: string, overrides: Partial<EnsembleDescriptor> = {}): EnsembleDescriptor {
  return {
    id: "codex_ensemble_test",
    harness: createMockHarness(),
    models: [{ id: "codex", model: "gpt-5.1-codex-max" }],
    runtime: { id: "local" },
    judge: { id: "judge", model: "fake-judge" },
    policy: {
      id: "policy",
      allowedTools: ["read_file", "apply_patch"],
      sideEffects: "writes_workspace",
      timeoutMs: 1_000
    },
    prompt: "Summarize Codex harness evidence.",
    sourceRepo: "handoffkit",
    baseGitSha: "b".repeat(40),
    outputRoot,
    ...overrides
  };
}

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

async function startOpenAiCompatibleServer(): Promise<{
  url: string;
  requests: Record<string, unknown>[];
  close: () => Promise<void>;
}> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "GET" && path === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "local-model" }] }));
        return;
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        const body = JSON.parse((await readBody(req)).toString("utf8")) as Record<string, unknown>;
        requests.push(body);
        const model = typeof body.model === "string" ? body.model : "local-model";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl_test",
            model,
            choices: [{ message: { role: "assistant", content: "gateway-ok" } }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
          })
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    })().catch((error: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(error) } }));
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
    requests,
    close: () => closeServer(server)
  };
}

test("codexConfigToml declares a Responses provider without requiring auth", () => {
  const toml = codexConfigToml({
    model: "local-model",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    provider: {
      baseUrl: "http://127.0.0.1:9000",
      requiresOpenAiAuth: false
    }
  });

  assert.ok(toml.includes('model = "local-model"'));
  assert.ok(toml.includes('model_provider = "fusionkit-codex"'));
  assert.ok(toml.includes("[model_providers.fusionkit-codex]"));
  assert.ok(toml.includes('base_url = "http://127.0.0.1:9000/v1"'));
  assert.ok(toml.includes('wire_api = "responses"'));
  assert.ok(toml.includes("requires_openai_auth = false"));
});

test("codexLaunchConfigToml pins fusion as default and adds a profile per native model", () => {
  const toml = codexLaunchConfigToml("http://127.0.0.1:9999", "fusion-panel", [
    "gpt-5.5",
    "mlx-community/Qwen3-1.7B-4bit"
  ]);
  // Default model + provider is fusion.
  assert.ok(toml.includes('model = "fusion-panel"'));
  assert.ok(toml.includes("[model_providers.fusionkit-local]"));
  // Each model is a profile; fusion first (bare key), then the natives.
  assert.ok(toml.includes("[profiles.fusion-panel]"));
  // Model ids with non-bare-key characters (a dot or a slash) are quoted keys.
  assert.ok(toml.includes('[profiles."gpt-5.5"]'));
  assert.ok(toml.includes('[profiles."mlx-community/Qwen3-1.7B-4bit"]'));
  // No catalog is wired unless a path is passed.
  assert.ok(!toml.includes("model_catalog_json"));
});

test("codexLaunchConfigToml wires model_catalog_json when a catalog path is given", () => {
  const toml = codexLaunchConfigToml("http://127.0.0.1:9999", "fusion-panel", ["gpt-5.5"], "/tmp/cat.json");
  assert.ok(toml.includes('model_catalog_json = "/tmp/cat.json"'));
});

test("codexModelCatalogJson clones the installed template and overrides identity per model", () => {
  // A stand-in for an entry from ~/.codex/models_cache.json (real schema varies
  // by Codex version; we only override identity fields and keep the rest).
  const template = {
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "stock",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    context_window: 272000
  };
  const catalog = JSON.parse(codexModelCatalogJson("fusion-panel", ["gpt-5.5", "claude-opus-4-8"], template)) as {
    models: Array<Record<string, unknown>>;
  };
  assert.deepEqual(
    catalog.models.map((entry) => entry.slug),
    ["fusion-panel", "gpt-5.5", "claude-opus-4-8"]
  );
  // Fusion is first (priority 0 = default-ish); identity overridden, schema kept.
  assert.equal(catalog.models[0]?.priority, 0);
  assert.equal(catalog.models[0]?.display_name, "fusion-panel (fusion)");
  // Version-specific schema fields from the template survive untouched.
  assert.ok(catalog.models.every((entry) => entry.context_window === 272000));
  assert.ok(catalog.models.every((entry) => entry.visibility === "list"));
  assert.ok(catalog.models.every((entry) => Array.isArray(entry.supported_reasoning_levels)));
});

test("codex adapter skips clearly when credentials are absent", async () => {
  const { outputRoot, cleanup } = tempOutputRoot();
  const emptyCodexHome = mkdtempSync(join(tmpdir(), "ensemble-codex-empty-home-"));
  let invoked = false;
  const runner: CodexExecRunner = () => {
    invoked = true;
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  try {
    const result = await ensemble.run(
      descriptor(outputRoot, {
        harness: codexHarness({ env: { CODEX_HOME: emptyCodexHome }, runner })
      })
    );

    assert.equal(invoked, false);
    assert.equal(result.harnessRunResult.status, "skipped");
    assert.equal(result.candidates[0]?.status, "skipped");
    assert.equal(result.candidates[0]?.error?.kind, "capability_missing");
    assert.match(result.candidates[0]?.error?.message ?? "", /CODEX_API_KEY|OPENAI_API_KEY/);
  } finally {
    cleanup();
    rmSync(emptyCodexHome, { recursive: true, force: true });
  }
});

test("codex adapter accepts local CLI auth without exported API keys", async () => {
  const { outputRoot, cleanup } = tempOutputRoot();
  const sourceHome = mkdtempSync(join(tmpdir(), "ensemble-codex-source-home-"));
  writeFileSync(join(sourceHome, "auth.json"), "{\"auth\":\"redacted-test-token\"}\n");
  let seenAuthFile = false;
  const runner: CodexExecRunner = (input) => {
    const codexHome = input.env.CODEX_HOME;
    assert.ok(codexHome);
    assert.notEqual(codexHome, sourceHome);
    assert.equal(input.env.CODEX_API_KEY, undefined);
    assert.equal(input.env.OPENAI_API_KEY, undefined);
    seenAuthFile = existsSync(join(codexHome, "auth.json"));
    return { stdout: "codex local auth ok", stderr: "", exitCode: 0 };
  };

  try {
    const result = await ensemble.run(
      descriptor(outputRoot, {
        harness: codexHarness({ env: { CODEX_HOME: sourceHome }, runner })
      })
    );

    assert.equal(seenAuthFile, true);
    assert.equal(result.harnessRunResult.status, "succeeded");
    assert.equal(result.candidates[0]?.metadata?.provider_kind, "ambient");
  } finally {
    cleanup();
    rmSync(sourceHome, { recursive: true, force: true });
  }
});

test("generic ensemble descriptor swaps mock harness for Codex harness", async () => {
  const { outputRoot, cleanup } = tempOutputRoot();
  let seenArgs: string[] | undefined;
  let seenConfig = "";
  const runner: CodexExecRunner = (input) => {
    seenArgs = input.args;
    const codexHome = input.env.CODEX_HOME;
    assert.ok(codexHome);
    seenConfig = readFileSync(join(codexHome, "config.toml"), "utf8");
    assert.equal(input.env.CODEX_API_KEY, "test-key");
    return { stdout: '{"type":"message","message":"codex-ok"}\n', stderr: "", exitCode: 0 };
  };

  try {
    const base = descriptor(outputRoot);
    const mock = await ensemble.run(base);
    const codex = await ensemble.run({
      ...base,
      harness: codexHarness({ env: { CODEX_API_KEY: "test-key" }, runner })
    });

    assert.equal(mock.harnessRunResult.status, "succeeded");
    assert.equal(codex.harnessRunResult.status, "succeeded");
    assert.deepEqual(seenArgs?.slice(0, 3), ["exec", "--json", "--skip-git-repo-check"]);
    assert.equal(seenArgs?.at(-1), base.prompt);
    assert.ok(seenConfig.includes('model = "gpt-5.1-codex-max"'));
    assert.equal(codex.candidates[0]?.metadata?.provider_kind, "ambient");
  } finally {
    cleanup();
  }
});

test("defaultCodexRunner captures stdout/stderr and exit code from a real process", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-runner-"));
  const stubCli = join(workdir, "codex-stub");
  writeFileSync(
    stubCli,
    '#!/bin/sh\necho "codex-stdout-ok"\necho "codex-stderr-ok" 1>&2\nexit 0\n'
  );
  chmodSync(stubCli, 0o755);

  try {
    const result = await defaultCodexRunner({
      command: stubCli,
      args: ["exec", "hello"],
      cwd: workdir,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 10_000
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /codex-stdout-ok/);
    assert.match(result.stderr, /codex-stderr-ok/);
    assert.notEqual(result.timedOut, true);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("defaultCodexRunner reports a non-zero exit code from the process", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-runner-fail-"));
  const stubCli = join(workdir, "codex-stub");
  writeFileSync(stubCli, '#!/bin/sh\necho "boom" 1>&2\nexit 3\n');
  chmodSync(stubCli, 0o755);

  try {
    const result = await defaultCodexRunner({
      command: stubCli,
      args: ["exec"],
      cwd: workdir,
      env: { PATH: process.env.PATH ?? "" }
    });

    assert.equal(result.exitCode, 3);
    assert.match(result.stderr, /boom/);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("Codex OpenAI-compatible provider goes through Responses gateway records", async () => {
  const { outputRoot, cleanup } = tempOutputRoot();
  const upstream = await startOpenAiCompatibleServer();
  const traceId = "trace_codex_live_capture";
  const traceEvents: FusionTraceEvent[] = [];
  const listener = (event: FusionTraceEvent): void => {
    if (event.trace_id === traceId) traceEvents.push(event);
  };
  addTraceListener(listener);
  let gatewayBaseUrl: string | undefined;
  const runner: CodexExecRunner = async (input) => {
    const codexHome = input.env.CODEX_HOME;
    assert.ok(codexHome);
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    const match = /base_url = "([^"]+)"/.exec(config);
    assert.ok(match);
    gatewayBaseUrl = match[1];
    assert.ok(gatewayBaseUrl);
    const response = await fetch(`${gatewayBaseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "hello from fake codex",
        stream: false
      })
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.ok(
      traceEvents.some((event) => event.event_type === "trajectory.step"),
      "gateway capture emits a live trajectory step before Codex exits"
    );
    return { stdout: "codex gateway ok", stderr: "", exitCode: 0 };
  };

  try {
    const result = await ensemble.run(
      descriptor(outputRoot, {
        harness: codexHarness({
          env: {},
          provider: {
            kind: "openai-compatible",
            baseUrl: `${upstream.url}/v1`,
            defaultModel: "local-model"
          },
          traceId,
          runner
        })
      })
    );

    assert.match(gatewayBaseUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.equal(upstream.requests.length, 1);
    assert.equal(result.harnessRunResult.status, "succeeded");
    assert.equal(result.modelCallRecords.length, 1);
    assert.equal(result.modelCallRecords[0]?.metadata?.dialect, "openai-responses");
    assert.equal(result.modelCallRecords[0]?.model, "local-model");
    assert.equal(result.candidates[0]?.metadata?.model_call_count, 1);
    const stepIndex = traceEvents.findIndex((event) => event.event_type === "trajectory.step");
    const finishedIndex = traceEvents.findIndex((event) => event.event_type === "harness.candidate.finished");
    assert.ok(stepIndex >= 0 && finishedIndex >= 0 && stepIndex < finishedIndex);
  } finally {
    removeTraceListener(listener);
    await upstream.close();
    cleanup();
  }
});
