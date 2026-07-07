/**
 * Acceptance tests for the cleanup registry (WS7.1).
 *
 * Contract: `registerCleanup(fn)` returns an unregister function; on SIGINT /
 * SIGTERM / normal exit the registered callbacks run once, LIFO, under a hard
 * timeout, and the process re-raises the conventional exit code. The signal
 * behavior is observed from a child fixture process, since installing signal
 * handlers in the test runner's own process would be invasive.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { registerCleanup, runCleanups } from "../cleanup.js";

const CLEANUP_MODULE = fileURLToPath(new URL("../cleanup.js", import.meta.url));

function fixture(dir: string, body: string): string {
  const script = join(dir, "fixture.mjs");
  writeFileSync(
    script,
    `import { registerCleanup } from ${JSON.stringify(CLEANUP_MODULE)};\n${body}`
  );
  return script;
}

async function runFixture(
  script: string,
  input: { killWith?: NodeJS.Signals } = {}
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
    let ready = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (!ready && chunk.toString().includes("ready") && input.killWith !== undefined) {
        ready = true;
        child.kill(input.killWith);
      }
    });
    child.on("error", reject);
    child.on("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

test("runs cleanups LIFO and unregister removes a callback", async () => {
  const order: string[] = [];
  const unregisterB = registerCleanup(() => {
    order.push("b");
  });
  registerCleanup(() => {
    order.push("a");
  });
  registerCleanup(() => {
    order.push("c");
  });
  unregisterB();
  await runCleanups();
  assert.deepEqual(order, ["c", "a"]);
  // A second run is a no-op: cleanups fire once.
  await runCleanups();
  assert.deepEqual(order, ["c", "a"]);
});

test("SIGINT runs registered cleanups and exits 130", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fusionkit-cleanup-"));
  try {
    const marker = join(dir, "cleaned.txt");
    const script = fixture(
      dir,
      `
      import { writeFileSync } from "node:fs";
      registerCleanup(() => {
        writeFileSync(${JSON.stringify(marker)}, "cleaned");
      });
      console.log("ready");
      setInterval(() => {}, 1000);
      `
    );
    const result = await runFixture(script, { killWith: "SIGINT" });
    assert.equal(readFileSync(marker, "utf8"), "cleaned");
    assert.equal(result.exitCode, 130);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGTERM runs registered cleanups and exits 143", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fusionkit-cleanup-"));
  try {
    const marker = join(dir, "cleaned.txt");
    const script = fixture(
      dir,
      `
      import { writeFileSync } from "node:fs";
      registerCleanup(() => {
        writeFileSync(${JSON.stringify(marker)}, "cleaned");
      });
      console.log("ready");
      setInterval(() => {}, 1000);
      `
    );
    const result = await runFixture(script, { killWith: "SIGTERM" });
    assert.equal(readFileSync(marker, "utf8"), "cleaned");
    assert.equal(result.exitCode, 143);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normal exit still runs synchronous cleanups", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fusionkit-cleanup-"));
  try {
    const marker = join(dir, "cleaned.txt");
    const script = fixture(
      dir,
      `
      import { writeFileSync } from "node:fs";
      registerCleanup(() => {
        writeFileSync(${JSON.stringify(marker)}, "cleaned");
      });
      `
    );
    const result = await runFixture(script);
    assert.equal(result.exitCode, 0);
    assert.equal(readFileSync(marker, "utf8"), "cleaned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hung async cleanup cannot stall shutdown past the hard timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fusionkit-cleanup-"));
  try {
    const marker = join(dir, "cleaned.txt");
    const script = fixture(
      dir,
      `
      import { writeFileSync } from "node:fs";
      registerCleanup(() => new Promise(() => {})); // never settles
      registerCleanup(() => {
        writeFileSync(${JSON.stringify(marker)}, "cleaned");
      });
      console.log("ready");
      setInterval(() => {}, 1000);
      `
    );
    const started = Date.now();
    await runFixture(script, { killWith: "SIGINT" });
    // LIFO: the marker cleanup ran before the hung one; the hard timeout
    // bounded the total shutdown.
    assert.equal(existsSync(marker), true);
    assert.ok(Date.now() - started < 15_000, "shutdown was bounded by the hard timeout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
