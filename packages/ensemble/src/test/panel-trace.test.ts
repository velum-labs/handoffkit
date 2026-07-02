import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The trace emitter is a lazy singleton that reads FUSION_TRACE_DIR at first
// construction, so enable it before importing anything that emits.
const TRACE_DIR = mkdtempSync(join(tmpdir(), "panel-trace-"));
process.env.FUSION_TRACE_DIR = TRACE_DIR;
delete process.env.FUSION_TRACE_URL;

const { traceCandidate } = await import("../candidate-trace.js");

function readEvents(traceId: string): Record<string, unknown>[] {
  return readFileSync(join(TRACE_DIR, `${traceId}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("traceCandidate emits started, per-step, and finished events under the session trace", () => {
  // The tool harnesses (codex/claude/cursor) call traceCandidate so the
  // companion app renders their candidate trajectories the same way the agent
  // harness's do.
  const traceId = "trace_candidate_emit";
  const tracer = traceCandidate(
    { traceId, parentSpanId: "span_session", turn: 1 },
    { candidateId: "cand_a", modelId: "a", model: "mlx/alpha", branchName: "b", worktreePath: "/w" }
  );
  tracer.finished({
    status: "succeeded",
    steps: [
      { index: 0, type: "tool_call", tool_name: "read_file" },
      { index: 1, type: "output", text: "the answer" }
    ],
    finalOutput: "the answer",
    toolCallCount: 1,
    finishReason: "stop"
  });

  const events = readEvents(traceId);
  const started = events.find((e) => e.event_type === "harness.candidate.started");
  const steps = events.filter((e) => e.event_type === "trajectory.step");
  const finished = events.find((e) => e.event_type === "harness.candidate.finished");

  assert.ok(started, "started emitted");
  assert.equal(started?.trace_id, traceId);
  assert.equal(started?.component, "panel-model");
  assert.equal(started?.candidate_id, "cand_a");
  assert.equal(started?.model_id, "a");
  assert.equal((started?.payload as Record<string, unknown>).model, "mlx/alpha");

  assert.equal(steps.length, 2, "one trajectory.step per reconstructed step");
  assert.equal((steps[0]?.payload as { step?: { type?: string } }).step?.type, "tool_call");

  assert.ok(finished, "finished emitted");
  const fp = finished?.payload as Record<string, unknown>;
  assert.equal(fp.status, "succeeded");
  assert.equal(fp.step_count, 2);
  assert.equal(fp.final_output_preview, "the answer");
});

test("traceCandidate emits live steps and does not replay them at finish", async () => {
  const traceId = "trace_candidate_live_steps";
  const tracer = traceCandidate(
    { traceId, parentSpanId: "span_session", turn: 1 },
    { candidateId: "cand_live", modelId: "live" }
  );
  tracer.step({ index: 0, type: "tool_call", tool_name: "read_file" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  tracer.finished({
    status: "succeeded",
    steps: [
      { index: 0, type: "tool_call", tool_name: "read_file" },
      { index: 1, type: "output", text: "done" }
    ],
    finalOutput: "done"
  });

  const events = readEvents(traceId);
  const steps = events.filter((e) => e.event_type === "trajectory.step");
  assert.equal(steps.length, 2, "finish only emits the not-yet-streamed step");
  assert.equal((steps[0]?.payload as { step?: { index?: number } }).step?.index, 0);
  assert.equal((steps[1]?.payload as { step?: { index?: number } }).step?.index, 1);
  assert.ok((steps[0]?.ts as number) < (steps[1]?.ts as number), "live step timestamp precedes finish replay");
});

test("traceCandidate is a no-op when no traceId is set", () => {
  // No traceId -> nothing emitted, no throw (harnesses call it unconditionally).
  const tracer = traceCandidate({}, { candidateId: "cand_x", modelId: "x" });
  assert.doesNotThrow(() => tracer.step({ index: 0, type: "output", text: "ignored" }));
  assert.doesNotThrow(() => tracer.finished({ status: "succeeded", steps: [] }));
});

test.after(() => rmSync(TRACE_DIR, { recursive: true, force: true }));
