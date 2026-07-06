import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { assertHarnessRunResultV1 } from "@fusionkit/protocol";
import { gitText } from "@fusionkit/workspace";
import { createMockHarness } from "@fusionkit/ensemble";

import {
  createHarnessCapabilityMatrix,
  runHarnessSmokeDashboard
} from "../dashboard.js";

function makeRepo(): { repo: string; outputRoot: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "ensemble-dashboard-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  gitText(repo, ["init", "--quiet", "--initial-branch=main"]);
  gitText(repo, ["config", "user.email", "dashboard@fusionkit.local"]);
  gitText(repo, ["config", "user.name", "dashboard"]);
  writeFileSync(join(repo, "README.md"), "# dashboard\n");
  gitText(repo, ["add", "-A"]);
  gitText(repo, ["commit", "--quiet", "-m", "init"]);
  return {
    repo,
    outputRoot: join(root, "dashboard-out"),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

test("capability matrix covers Cursor, Claude Code, Codex, command, and mock", () => {
  const matrix = createHarnessCapabilityMatrix({ env: {} });
  const harnessIds = matrix.rows.map((row) => row.harnessId);

  assert.deepEqual(harnessIds, ["codex", "claude-code", "cursor", "command", "mock"]);
  assert.ok(matrix.capabilities.includes("model_override"));
  assert.ok(matrix.capabilities.includes("transcript_capture"));
  assert.ok(matrix.capabilities.includes("diff_capture"));
  assert.ok(matrix.capabilities.includes("tool_loop_capture"));
  assert.ok(matrix.capabilities.includes("patch_apply_visibility"));
  assert.ok(matrix.capabilities.includes("route_model_observation"));
  assert.ok(matrix.capabilities.includes("verification_hint"));
  assert.ok(matrix.capabilities.includes("replay_support"));
  assert.ok(matrix.capabilities.includes("workspace_read"));
  assert.equal(
    matrix.rows.find((row) => row.harnessId === "cursor")?.availability,
    "credential_gated"
  );
  assert.equal(
    matrix.rows.find((row) => row.harnessId === "claude-code")?.harnessKind,
    "claude_code"
  );
  assert.equal(matrix.rows.find((row) => row.harnessId === "codex")?.harnessKind, "codex");
});

test("smoke dashboard writes schema-valid success, failure, skipped, and missing records", async () => {
  const fixture = makeRepo();
  try {
    const dashboard = await runHarnessSmokeDashboard({
      repo: fixture.repo,
      outputRoot: fixture.outputRoot,
      timeoutMs: 1_000,
      createdAt: "2026-06-16T00:00:00.000Z",
      // Hermetic: never read the host's credentials or PATH — the dashboard
      // must render the same on a dev machine with every agent installed.
      env: {}
    });

    assert.equal(dashboard.records.length, 6);
    assert.equal(existsSync(dashboard.dashboardPath), true);
    for (const record of dashboard.records) {
      assertHarnessRunResultV1(record.result);
      assert.equal(existsSync(record.resultPath), true);
      const written = JSON.parse(readFileSync(record.resultPath, "utf8")) as unknown;
      assertHarnessRunResultV1(written);
    }

    const statuses = dashboard.records.map((record) => record.result.status).sort();
    assert.deepEqual(statuses, [
      "failed",
      "skipped",
      "skipped",
      "skipped",
      "succeeded",
      "succeeded"
    ]);
    assert.equal(
      dashboard.records.find((record) => record.taskId === "claude-code-skipped")?.result
        .harness_kind,
      "claude_code"
    );
    assert.equal(
      dashboard.records.find((record) => record.taskId === "codex-skipped")?.result.harness_kind,
      "codex"
    );
    assert.equal(
      dashboard.records.find((record) => record.taskId === "cursor-skipped")?.result.harness_kind,
      "cursor"
    );
    assert.equal(
      dashboard.records.find((record) => record.taskId === "cursor-skipped")?.result.status,
      "skipped"
    );

    const markdown = readFileSync(dashboard.dashboardPath, "utf8");
    assert.match(markdown, /# HandoffKit Harness Smoke Dashboard/);
    assert.match(markdown, /## Capability Matrix/);
    assert.match(markdown, /## Adapter Readiness/);
    assert.match(markdown, /contract\/mock ready/);
    assert.match(markdown, /credentials missing\/skipped/);
    assert.match(markdown, /live smoke not requested/);
    assert.match(markdown, /command-failure/);
    assert.match(markdown, /cursor-skipped/);
    assert.match(markdown, /harness-run-results\/mock-success\.json/);
    assert.equal(dashboard.readiness.length, 5);
  } finally {
    fixture.cleanup();
  }
});

test("smoke dashboard only adds live records when explicit smoke env is enabled", async () => {
  const fixture = makeRepo();
  try {
    const dashboard = await runHarnessSmokeDashboard({
      repo: fixture.repo,
      outputRoot: fixture.outputRoot,
      timeoutMs: 1_000,
      createdAt: "2026-06-16T00:00:00.000Z",
      env: {},
      liveSmoke: ["claude-code", "codex"]
    });

    assert.equal(dashboard.records.length, 6);
    assert.equal(
      dashboard.records.some((record) => record.purpose === "live"),
      false
    );
  } finally {
    fixture.cleanup();
  }
});

test("explicit live smoke without credentials records a failed preflight", async () => {
  const fixture = makeRepo();
  try {
    const dashboard = await runHarnessSmokeDashboard({
      repo: fixture.repo,
      outputRoot: fixture.outputRoot,
      timeoutMs: 1_000,
      createdAt: "2026-06-16T00:00:00.000Z",
      env: { FUSIONKIT_CLAUDE_SMOKE: "1" },
      liveSmoke: ["claude-code"]
    });
    const live = dashboard.records.find((record) => record.taskId === "claude-code-live");

    assert.equal(live?.purpose, "live");
    assert.equal(live?.result.status, "failed");
    assert.match(live?.result.output_summary ?? "", /Explicit live smoke failed before launch/);
    assert.equal(
      dashboard.readiness.find((row) => row.harnessId === "claude-code")?.liveSmoke,
      "live smoke failed"
    );
  } finally {
    fixture.cleanup();
  }
});

test("live smoke readiness reports sanitized local evidence refs", async () => {
  const fixture = makeRepo();
  const privateTranscript = "raw private transcript should not render";
  try {
    const claudeHarness = {
      ...createMockHarness({
        id: "claude-code-live-mock",
        candidates: {
          claude: {
            transcript: privateTranscript,
            artifacts: [
              {
                artifact_id: "claude_safe_log",
                kind: "log",
                hash: `sha256:${"a".repeat(64)}`,
                uri: "file:///tmp/private-claude.log",
                redaction_status: "synthetic"
              },
              {
                artifact_id: "claude_raw_transcript",
                kind: "transcript",
                hash: `sha256:${"b".repeat(64)}`,
                uri: "file:///tmp/raw-claude.txt",
                redaction_status: "raw"
              }
            ]
          }
        }
      }),
      harnessKind: "claude_code" as const
    };
    const codexHarness = {
      ...createMockHarness({
        id: "codex-live-mock",
        candidates: {
          codex: {
            transcript: "codex private transcript should not render",
            artifacts: [
              {
                artifact_id: "codex_safe_log",
                kind: "log",
                hash: `sha256:${"c".repeat(64)}`,
                uri: "file:///tmp/private-codex.log",
                redaction_status: "synthetic"
              }
            ]
          }
        }
      }),
      harnessKind: "codex" as const
    };
    const dashboard = await runHarnessSmokeDashboard({
      repo: fixture.repo,
      outputRoot: fixture.outputRoot,
      timeoutMs: 1_000,
      createdAt: "2026-06-16T00:00:00.000Z",
      env: {
        FUSIONKIT_ENSEMBLE_LIVE_SMOKE: "1",
        VERCEL_TOKEN: "vercel-test",
        ANTHROPIC_API_KEY: "anthropic-test",
        CODEX_API_KEY: "codex-test"
      },
      liveSmoke: ["claude-code", "codex"],
      liveSmokeHarnesses: {
        "claude-code": claudeHarness,
        codex: codexHarness
      }
    });

    assert.equal(dashboard.records.length, 8);
    assert.equal(
      dashboard.records.find((record) => record.taskId === "claude-code-live")?.result.status,
      "succeeded"
    );
    assert.equal(
      dashboard.records.find((record) => record.taskId === "codex-live")?.result.status,
      "succeeded"
    );
    assert.equal(
      dashboard.readiness.find((row) => row.harnessId === "claude-code")?.liveSmoke,
      "live smoke passed"
    );
    assert.equal(
      dashboard.readiness.find((row) => row.harnessId === "codex")?.liveSmoke,
      "live smoke passed"
    );

    const markdown = readFileSync(dashboard.dashboardPath, "utf8");
    assert.match(markdown, /log:claude_safe_log:sha256/);
    assert.match(markdown, /log:codex_safe_log:sha256/);
    assert.match(markdown, /raw artifact ref\(s\) withheld/);
    assert.equal(markdown.includes(privateTranscript), false);
    assert.equal(markdown.includes("file:///tmp/private-claude.log"), false);
    assert.equal(markdown.includes("file:///tmp/private-codex.log"), false);
  } finally {
    fixture.cleanup();
  }
});
