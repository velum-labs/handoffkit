import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function benchEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WARRANT_MICROVM_BENCH_FILES: "5",
    WARRANT_MICROVM_BENCH_ITERS: "1",
    ...overrides
  };
  delete env.VERCEL_TOKEN;
  delete env.VERCEL_OIDC_TOKEN;
  delete env.VERCEL_TEAM_ID;
  delete env.VERCEL_PROJECT_ID;
  return env;
}

function runBench(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["legacy/examples/microvm-isolation-bench/dist/run.js"], {
    cwd: new URL("../../../../..", import.meta.url),
    encoding: "utf8",
    env,
    timeout: 120_000
  });
}

test("microvm isolation bench runs without live credentials and skips live section", () => {
  const result = runBench(benchEnv({ WARRANT_MICROVM_LIVE: "0" }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /microvm isolation bench: 5 files, 1 iterations/);
  assert.match(result.stdout, /local path:/);
  assert.match(result.stdout, /governed compute path:/);
  assert.match(result.stdout, /direct live substrate path:/);
  assert.match(result.stdout, /warm snapshot path:/);
  assert.match(result.stdout, /compute sandbox command/);
  assert.match(result.stdout, /process isolation command/);
  assert.match(result.stdout, /fake container command/);
  assert.match(result.stdout, /\[SKIP\] governed vercel-sandbox command\s+set WARRANT_MICROVM_LIVE=1/);
  assert.match(result.stdout, /\[SKIP\] direct vercel sandbox cold\s+set WARRANT_MICROVM_LIVE=1/);
  assert.match(result.stdout, /\[SKIP\] direct vercel sandbox warm snapshot\s+set WARRANT_MICROVM_LIVE=1/);
  assert.match(result.stdout, /session="vercel-sandbox"/);
});

test("live mode without credentials still reports skipped governed and warm paths", () => {
  const result = runBench(benchEnv({
    WARRANT_MICROVM_LIVE: "1",
    WARRANT_MICROVM_SNAPSHOT_ID: "snap_test"
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /governed vercel-sandbox warm snapshot/);
  assert.match(result.stdout, /missing VERCEL_TOKEN for governed backend/);
  assert.match(result.stdout, /direct vercel sandbox cold/);
  assert.match(result.stdout, /missing VERCEL_TOKEN or VERCEL_OIDC_TOKEN/);
  assert.match(result.stdout, /direct vercel sandbox warm snapshot/);
  assert.match(result.stdout, /snapshot: snap_test/);
});
