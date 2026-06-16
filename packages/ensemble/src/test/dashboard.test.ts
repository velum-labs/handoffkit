import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { assertHarnessRunResultV1 } from "@warrant/protocol";
import { gitText } from "@warrant/workspace";

import {
  createHarnessCapabilityMatrix,
  runHarnessSmokeDashboard
} from "../dashboard.js";

function makeRepo(): { repo: string; outputRoot: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "ensemble-dashboard-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  gitText(repo, ["init", "--quiet", "--initial-branch=main"]);
  gitText(repo, ["config", "user.email", "dashboard@warrant.local"]);
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

  assert.deepEqual(harnessIds, ["cursor", "claude-code", "codex", "command", "mock"]);
  assert.ok(matrix.capabilities.includes("model_override"));
  assert.ok(matrix.capabilities.includes("transcript_capture"));
  assert.ok(matrix.capabilities.includes("diff_capture"));
  assert.ok(matrix.capabilities.includes("tool_loop_capture"));
  assert.ok(matrix.capabilities.includes("patch_apply_visibility"));
  assert.ok(matrix.capabilities.includes("route_model_observation"));
  assert.ok(matrix.capabilities.includes("verification_hint"));
  assert.ok(matrix.capabilities.includes("replay_support"));
  assert.ok(matrix.capabilities.includes("workspace_read"));
  assert.ok(matrix.capabilities.includes("verification"));
  assert.equal(matrix.rows.find((row) => row.harnessId === "cursor")?.availability, "missing");
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
      createdAt: "2026-06-16T00:00:00.000Z"
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
      "succeeded",
      "succeeded",
      "unsupported"
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
      dashboard.records.find((record) => record.taskId === "cursor-missing")?.result
        .errors?.[0]?.kind,
      "capability_missing"
    );

    const markdown = readFileSync(dashboard.dashboardPath, "utf8");
    assert.match(markdown, /# HandoffKit Harness Smoke Dashboard/);
    assert.match(markdown, /## Capability Matrix/);
    assert.match(markdown, /command-failure/);
    assert.match(markdown, /cursor-missing/);
    assert.match(markdown, /harness-run-results\/mock-success\.json/);
  } finally {
    fixture.cleanup();
  }
});
