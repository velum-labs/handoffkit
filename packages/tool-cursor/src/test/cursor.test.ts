import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createMockHarness, ensemble } from "@fusionkit/ensemble";
import type { EnsembleDescriptor } from "@fusionkit/ensemble";

import { cursorHarness, defaultCursorRunner } from "../index.js";
import type { CursorExecRunner } from "../index.js";

function tempOutputRoot(): { outputRoot: string; cleanup: () => void } {
  const outputRoot = mkdtempSync(join(tmpdir(), "ensemble-cursor-out-"));
  return {
    outputRoot,
    cleanup: () => rmSync(outputRoot, { recursive: true, force: true })
  };
}

function descriptor(
  outputRoot: string,
  overrides: Partial<EnsembleDescriptor> = {}
): EnsembleDescriptor {
  return {
    id: "cursor_ensemble_test",
    harness: createMockHarness(),
    models: [{ id: "cursor", model: "fusion-panel" }],
    runtime: { id: "local" },
    judge: { id: "judge", model: "fake-judge" },
    policy: {
      id: "policy",
      allowedTools: ["read_file", "apply_patch", "run_shell"],
      sideEffects: "writes_workspace",
      timeoutMs: 1_000
    },
    prompt: "Fix the failing test in the repo.",
    sourceRepo: "handoffkit",
    baseGitSha: "b".repeat(40),
    outputRoot,
    ...overrides
  };
}

test("cursor adapter skips clearly when the Cursor CLI is unavailable", async () => {
  const { outputRoot, cleanup } = tempOutputRoot();
  try {
    const result = await ensemble.run(
      descriptor(outputRoot, {
        harness: cursorHarness({ env: { PATH: "" } })
      })
    );

    assert.equal(result.harnessRunResult.status, "skipped");
    assert.equal(result.candidates[0]?.status, "skipped");
    assert.equal(result.candidates[0]?.error?.kind, "capability_missing");
    assert.match(
      result.candidates[0]?.error?.message ?? "",
      /Cursor CLI .* was not found on PATH/
    );
  } finally {
    cleanup();
  }
});

test("cursor adapter produces a real candidate with a diff via the injected runner", async () => {
  const { outputRoot, cleanup } = tempOutputRoot();
  let observedMode: string | undefined;
  let observedBackend: string | undefined;
  const runner: CursorExecRunner = (input) => {
    observedMode = input.mode;
    observedBackend = input.fusionBackendUrl;
    return {
      status: "succeeded",
      transcript: "Applied the fix and verified the tests pass.",
      diff: "--- a/calc.ts\n+++ b/calc.ts\n@@ -1,1 +1,1 @@\n-return a - b;\n+return a + b;",
      toolEvents: 3
    };
  };

  try {
    const result = await ensemble.run(
      descriptor(outputRoot, {
        harness: cursorHarness({
          fusionBackendUrl: "http://127.0.0.1:9999",
          runner
        })
      })
    );

    assert.equal(observedMode, "agent");
    assert.equal(observedBackend, "http://127.0.0.1:9999");
    assert.equal(result.harnessRunResult.status, "succeeded");
    const candidate = result.candidates[0];
    assert.equal(candidate?.status, "succeeded");
    assert.equal(candidate?.metadata?.adapter, "cursor");
    assert.equal(candidate?.metadata?.tool_events, 3);
    assert.equal(candidate?.metadata?.has_diff, true);
    assert.ok(
      result.artifacts.some((artifact) => artifact.kind === "patch"),
      "a patch artifact should be captured"
    );
  } finally {
    cleanup();
  }
});

test("defaultCursorRunner spawns the bridge, drives the agent, and tears it down", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cursor-runner-"));
  // Stub `cursorkit serve`: announce readiness, then idle until terminated.
  const stubServe = join(workdir, "serve.cjs");
  writeFileSync(
    stubServe,
    [
      'process.stdout.write("bridge listening on 127.0.0.1\\n");',
      "const timer = setInterval(() => {}, 1000);",
      'process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });'
    ].join("\n")
  );
  // Stub `cursor-agent`: print a deterministic transcript and exit 0.
  const stubAgent = join(workdir, "cursor-agent");
  writeFileSync(stubAgent, '#!/bin/sh\necho "CURSOR_STUB_OK"\nexit 0\n');
  chmodSync(stubAgent, 0o755);

  const previousOverride = process.env.FUSIONKIT_CURSORKIT_SERVE_CLI;
  process.env.FUSIONKIT_CURSORKIT_SERVE_CLI = stubServe;
  try {
    const result = await defaultCursorRunner({
      prompt: "say hello",
      cwd: workdir,
      fusionBackendUrl: "http://127.0.0.1:9999",
      model: { id: "cursor", model: "fusion-panel" },
      command: stubAgent,
      modelName: "cursor-bridge",
      providerModel: "fusion-panel",
      mode: "agent",
      timeoutMs: 10_000,
      env: { PATH: process.env.PATH ?? "" }
    });

    assert.equal(result.status, "succeeded");
    assert.match(result.transcript, /CURSOR_STUB_OK/);
    assert.equal(result.exitCode, 0);
  } finally {
    if (previousOverride === undefined) {
      delete process.env.FUSIONKIT_CURSORKIT_SERVE_CLI;
    } else {
      process.env.FUSIONKIT_CURSORKIT_SERVE_CLI = previousOverride;
    }
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("defaultCursorRunner reports a clear failure when the bridge never starts", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cursor-runner-fail-"));
  // Stub serve that exits immediately without announcing readiness.
  const stubServe = join(workdir, "serve.cjs");
  writeFileSync(stubServe, 'process.exit(1);\n');
  const stubAgent = join(workdir, "cursor-agent");
  writeFileSync(stubAgent, '#!/bin/sh\necho "unused"\n');
  chmodSync(stubAgent, 0o755);

  const previousOverride = process.env.FUSIONKIT_CURSORKIT_SERVE_CLI;
  process.env.FUSIONKIT_CURSORKIT_SERVE_CLI = stubServe;
  try {
    const result = await defaultCursorRunner({
      prompt: "say hello",
      cwd: workdir,
      fusionBackendUrl: "http://127.0.0.1:9999",
      model: { id: "cursor", model: "fusion-panel" },
      command: stubAgent,
      modelName: "cursor-bridge",
      providerModel: "fusion-panel",
      mode: "agent",
      timeoutMs: 10_000,
      env: { PATH: process.env.PATH ?? "" }
    });

    assert.equal(result.status, "failed");
    assert.equal(result.toolEvents, 0);
    assert.ok((result.reason ?? "").length > 0);
  } finally {
    if (previousOverride === undefined) {
      delete process.env.FUSIONKIT_CURSORKIT_SERVE_CLI;
    } else {
      process.env.FUSIONKIT_CURSORKIT_SERVE_CLI = previousOverride;
    }
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("cursor adapter capabilities report supported when available", () => {
  const runner: CursorExecRunner = () => ({
    status: "succeeded",
    transcript: "ok",
    toolEvents: 0
  });
  const harness = cursorHarness({ runner, fusionBackendUrl: "http://x/v1" });
  const capabilities = harness.capabilities({} as EnsembleDescriptor);
  assert.equal(capabilities.apply_patch, "supported");
  assert.equal(capabilities.tool_call_loop, "supported");
  assert.equal(capabilities.adapter_available, "supported");
});
