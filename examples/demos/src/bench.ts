/**
 * Performance benchmark asserting the spec's section 8.4 budgets:
 *
 *   - contract creation incl. workspace capture: p50 < 5s, p95 < 20s
 *   - dryRun disclosure report:                   < 10s
 *   - receipt verification (offline):             < 1s
 *   - contract size excluding artifacts:          < 10 MB
 *
 * The headline budget targets a 100k-file repository. Creating 100k files is
 * heavy for CI, so the corpus size defaults to 2000 and is configurable via
 * WARRANT_BENCH_FILES; the corpus size is printed so results are honest, and
 * the budgets below are the spec's absolute ceilings (a 2000-file repo
 * should sit far under them, and the harness still fails if it does not).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { verifyReceiptBundle } from "@warrant/protocol";
import { captureWorkspace } from "@warrant/workspace";
import { git, makeRepo, startStack } from "@warrant/testkit";

const FILE_COUNT = Number(process.env.WARRANT_BENCH_FILES ?? "2000");
const ITERATIONS = Number(process.env.WARRANT_BENCH_ITERS ?? "10");

const BUDGETS = {
  contractCreateP50Ms: 5000,
  contractCreateP95Ms: 20000,
  dryRunMs: 10000,
  verifyMs: 1000,
  contractBytes: 10 * 1024 * 1024
};

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

function seedCorpus(repo: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const path = join(repo, `src/mod${i % 100}/file${i}.ts`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `export const v${i} = ${i};\n`);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", `corpus of ${count} files`]);
}

type Result = { name: string; value: number; budget: number; unit: string };

async function main(): Promise<void> {
  const results: Result[] = [];
  const repo = makeRepo({ files: { "README.md": "# bench\n" } });
  const stack = await startStack({ pool: "default" });

  try {
    console.log(`corpus: ${FILE_COUNT} files, ${ITERATIONS} iterations`);
    seedCorpus(repo, FILE_COUNT);

    // Contract creation incl. workspace capture.
    const captureTimes: number[] = [];
    let lastManifest = captureWorkspace(repo).manifest;
    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();
      const captured = captureWorkspace(repo);
      await stack.client.putBlob(captured.bundle);
      if (captured.dirtyDiff) await stack.client.putBlob(captured.dirtyDiff);
      const created = await stack.client.requestRun({
        requestedBy: { kind: "human", id: "bench" },
        agentKind: "mock",
        prompt: "bench",
        pool: "default",
        secretNames: [],
        workspace: captured.manifest,
        network: { defaultDeny: true, allowHosts: [] },
        budget: {},
        disclosure: "minimal-context"
      });
      captureTimes.push(performance.now() - start);
      lastManifest = captured.manifest;
      void created;
    }
    results.push({
      name: "contract create p50",
      value: percentile(captureTimes, 50),
      budget: BUDGETS.contractCreateP50Ms,
      unit: "ms"
    });
    results.push({
      name: "contract create p95",
      value: percentile(captureTimes, 95),
      budget: BUDGETS.contractCreateP95Ms,
      unit: "ms"
    });

    // dryRun disclosure report.
    const dryStart = performance.now();
    await stack.client.dryRun({
      requestedBy: { kind: "human", id: "bench" },
      agentKind: "mock",
      prompt: "bench",
      pool: "default",
      secretNames: [],
      workspace: lastManifest,
      network: { defaultDeny: true, allowHosts: [] },
      budget: {},
      disclosure: "minimal-context"
    });
    results.push({
      name: "dry run",
      value: performance.now() - dryStart,
      budget: BUDGETS.dryRunMs,
      unit: "ms"
    });

    // A full governed run to produce a receipt, then measure offline verify.
    const captured = captureWorkspace(repo);
    await stack.client.putBlob(captured.bundle);
    if (captured.dirtyDiff) await stack.client.putBlob(captured.dirtyDiff);
    const run = await stack.client.requestRun({
      requestedBy: { kind: "human", id: "bench" },
      agentKind: "mock",
      prompt: "bench receipt",
      pool: "default",
      secretNames: [],
      workspace: captured.manifest,
      network: { defaultDeny: true, allowHosts: [] },
      budget: {},
      disclosure: "minimal-context"
    });
    // Drain the queue (the capture loop above left created runs unclaimed)
    // until our receipt run reaches a terminal state.
    let drained = 0;
    for (let i = 0; i < FILE_COUNT + ITERATIONS + 20; i++) {
      const processed = await stack.runOnce();
      if (processed) drained++;
      const view = await stack.client.getRun(run.runId);
      if (["completed", "failed", "cancelled"].includes(view.status)) break;
      if (!processed) break;
    }
    const finalStatus = (await stack.client.getRun(run.runId)).status;
    if (finalStatus !== "completed" && finalStatus !== "failed") {
      throw new Error(
        `receipt run did not finish (status ${finalStatus}, drained ${drained})`
      );
    }
    const bundle = await stack.client.getBundle(run.runId);

    const verifyStart = performance.now();
    const verification = verifyReceiptBundle(bundle);
    const verifyMs = performance.now() - verifyStart;
    if (!verification.ok) throw new Error("benchmark receipt failed to verify");
    results.push({
      name: "offline verify",
      value: verifyMs,
      budget: BUDGETS.verifyMs,
      unit: "ms"
    });

    const contractBytes = Buffer.byteLength(JSON.stringify(bundle.contract), "utf8");
    results.push({
      name: "contract size",
      value: contractBytes,
      budget: BUDGETS.contractBytes,
      unit: "bytes"
    });

    let failed = false;
    console.log("");
    for (const r of results) {
      const ok = r.value <= r.budget;
      if (!ok) failed = true;
      const status = ok ? "OK " : "FAIL";
      console.log(
        `  [${status}] ${r.name.padEnd(22)} ${r.value.toFixed(1).padStart(12)} ${r.unit} (budget ${r.budget} ${r.unit})`
      );
    }
    console.log("");
    if (failed) {
      console.error("BENCHMARK FAILED: a section 8.4 budget was exceeded");
      process.exitCode = 1;
    } else {
      console.log("all section 8.4 budgets met");
    }
  } finally {
    await stack.stop();
    rmSync(repo, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
