/**
 * WS7.2 acceptance: the command harness honors the per-candidate straggler
 * signal. A stuck command candidate must be *killed* (its whole process group)
 * when the straggler grace timer fires — not merely abandoned as a promise while
 * the real subprocess keeps running orphaned.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createCommandHarness } from "../command.js";
import { runEnsemble } from "../run.js";
import type { EnsembleDescriptor } from "../harness.js";

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a stuck command candidate is killed when the straggler timer fires", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fusionkit-command-straggler-"));
  const pidFile = join(dir, "stuck.pid");
  try {
    // The fast candidate exits immediately; the stuck one records its process
    // group leader's pid and then sleeps far longer than the test. Only the
    // straggler abort (plumbed through to the supervisor) can end it.
    const command =
      `if [ "$HARNESS_MODEL_ID" = "fast" ]; then exit 0; fi; ` +
      `echo $$ > ${JSON.stringify(pidFile)}; exec sleep 600`;
    const descriptor: EnsembleDescriptor = {
      id: "cmd_straggler",
      harness: createCommandHarness({ command, cwd: dir }),
      models: [
        { id: "fast", model: "fake-fast" },
        { id: "stuck", model: "fake-stuck" }
      ],
      runtime: { id: "local" },
      judge: { id: "judge", model: "fake-judge" },
      policy: {
        id: "policy",
        allowedTools: [],
        sideEffects: "read_only",
        timeoutMs: 60_000,
        stragglerGraceMs: 300
      },
      prompt: "run the command",
      sourceRepo: "handoffkit",
      baseGitSha: "a".repeat(40)
    };

    const result = await runEnsemble(descriptor);
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.status),
      ["succeeded", "failed"]
    );

    // The stuck candidate's group leader must be dead once the run resolves —
    // the abort actually killed it rather than leaving an orphan.
    assert.equal(existsSync(pidFile), true, "stuck candidate should have started");
    const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    assert.ok(Number.isInteger(pid) && pid > 0, "recorded a real pid");
    const deadline = Date.now() + 5_000;
    while (processAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(processAlive(pid), false, "the stuck command's process group was killed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
