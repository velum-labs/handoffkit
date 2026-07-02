import assert from "node:assert/strict";
import { test } from "node:test";

import type { PanelModelSpec } from "../fusion/env.js";
import type { HostInfo } from "../fusion/local-catalog.js";
import { clearSizingCacheForTests } from "../fusion/model-sizing.js";
import { localPanelMemoryWarning } from "../fusion/preflight.js";
import { describeServerCrash } from "../fusion/stack.js";

/**
 * OOM/crash handling for local panels: the crash classifier that turns a dead
 * `mlx_lm.server` into an actionable notice, and the boot-time memory check
 * that foreshadows the kill before slow model loads start.
 */

const GIB = 1024 ** 3;

// ---- describeServerCrash ----

test("a SIGKILL death is classified as likely out of memory with a fix hint", () => {
  const notice = describeServerCrash({
    label: "panel member local-1 (mlx-community/Qwen3-8B-4bit)",
    exitCode: null,
    signal: "SIGKILL"
  });
  assert.match(notice, /panel member local-1/);
  assert.match(notice, /killed by SIGKILL/);
  assert.match(notice, /out of memory/i);
  assert.match(notice, /fusionkit models/);
  assert.match(notice, /restarts on the next turn/);
});

test("a plain non-zero exit is a generic crash, not an OOM claim", () => {
  const notice = describeServerCrash({
    label: "panel member local-2 (mlx-community/gemma-3-1b-it-4bit)",
    exitCode: 1,
    signal: null
  });
  assert.match(notice, /exited with code 1/);
  assert.doesNotMatch(notice, /out of memory/i);
});

test("consequence and log path flow into the notice", () => {
  const notice = describeServerCrash({
    label: "the fusion router (fusionkit serve)",
    exitCode: null,
    signal: "SIGKILL",
    consequence: "fused turns will fail until you restart fusionkit",
    logPath: "/tmp/logs/router.log"
  });
  assert.match(notice, /fused turns will fail until you restart fusionkit/);
  assert.match(notice, /\/tmp\/logs\/router\.log/);
});

// ---- localPanelMemoryWarning ----

const host16: HostInfo = { platform: "darwin", arch: "arm64", totalRamGB: 16, appleSilicon: true };

function mlxSpec(id: string, model: string): PanelModelSpec {
  return { id, model, provider: "mlx" };
}

/** A Hub mock that sizes every repo at `weightGiB` of safetensors. */
function hubFetch(weightGiB: number): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/tree/")) {
      return new Response(
        JSON.stringify([{ type: "file", path: "model.safetensors", lfs: { size: weightGiB * GIB } }]),
        { status: 200 }
      );
    }
    if (url.includes("config.json")) {
      return new Response(
        JSON.stringify({ num_hidden_layers: 1, num_attention_heads: 1, head_dim: 1 }),
        { status: 200 }
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

test("warns when the combined local panel exceeds the usable budget", async () => {
  clearSizingCacheForTests();
  const warning = await localPanelMemoryWarning(
    [mlxSpec("local-1", "test/big-model-a"), mlxSpec("local-2", "test/big-model-b")],
    { host: host16, sizing: { fetchImpl: hubFetch(10) } }
  );
  // Two members at ~11.5GB each (10 weights + 1.5 overhead) against a
  // 16GB * 0.8 = 12.8GB budget.
  assert.ok(warning !== undefined, "an oversized panel warns");
  assert.match(warning, /memory pressure/);
  assert.match(warning, /test\/big-model-a/);
  assert.match(warning, /fusionkit models/);
});

test("stays silent when the panel fits", async () => {
  clearSizingCacheForTests();
  const warning = await localPanelMemoryWarning([mlxSpec("local-1", "test/small-model")], {
    host: host16,
    sizing: { fetchImpl: hubFetch(1) }
  });
  assert.equal(warning, undefined);
});

test("stays silent for cloud-only panels", async () => {
  clearSizingCacheForTests();
  const warning = await localPanelMemoryWarning(
    [{ id: "cloud-1", model: "gpt-5.5", provider: "openai" }],
    { host: host16 }
  );
  assert.equal(warning, undefined);
});

test("stays silent when sizing cannot be verified (offline, unknown repo)", async () => {
  clearSizingCacheForTests();
  const offline = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  const warning = await localPanelMemoryWarning([mlxSpec("local-1", "someone/mystery-model")], {
    host: host16,
    sizing: { fetchImpl: offline }
  });
  assert.equal(warning, undefined);
});

test("counts an extra local model (e.g. --reasoning-model) toward the budget", async () => {
  clearSizingCacheForTests();
  const warning = await localPanelMemoryWarning([mlxSpec("local-1", "test/medium-a")], {
    host: host16,
    extraModels: ["test/medium-b"],
    sizing: { fetchImpl: hubFetch(6) }
  });
  // Two models at ~7.5GB each exceed the 12.8GB budget only together.
  assert.ok(warning !== undefined);
  assert.match(warning, /test\/medium-b/);
});
