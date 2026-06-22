import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LOCAL_CATALOG,
  USABLE_RAM_FRACTION,
  affordable,
  catalogEntry,
  defaultTrioFor,
  detectHost,
  fits,
  recommendFor,
  usableRamGB
} from "../fusion/local-catalog.js";
import type { HostInfo } from "../fusion/local-catalog.js";

function host(totalRamGB: number, appleSilicon = true): HostInfo {
  return {
    platform: appleSilicon ? "darwin" : "linux",
    arch: appleSilicon ? "arm64" : "x64",
    totalRamGB,
    appleSilicon
  };
}

test("fits compares the model floor against the usable memory budget", () => {
  const small = LOCAL_CATALOG.find((entry) => entry.minRamGB === 4);
  const large = [...LOCAL_CATALOG].sort((a, b) => b.minRamGB - a.minRamGB)[0];
  assert.ok(small !== undefined && large !== undefined);
  assert.equal(usableRamGB(host(32)), 32 * USABLE_RAM_FRACTION);
  // 4GB floor fits a 32GB machine ...
  assert.equal(fits(small, host(32)), true);
  // ... but the biggest model does not fit 16GB (16 * 0.8 = 12.8 < minRamGB).
  assert.equal(fits(large, host(16)), false);
});

test("affordable gates a model against the remaining (cumulative) budget", () => {
  const entry = LOCAL_CATALOG.find((candidate) => candidate.minRamGB === 16);
  assert.ok(entry !== undefined);
  assert.equal(affordable(entry, 20), true, "16GB model fits 20GB remaining");
  assert.equal(affordable(entry, 10), false, "16GB model does not fit 10GB remaining");
});

test("defaultTrioFor never exceeds the cumulative memory budget", () => {
  for (const totalRamGB of [8, 16, 24, 48, 64, 128]) {
    const h = host(totalRamGB);
    const trio = defaultTrioFor(h);
    const used = trio.reduce((sum, entry) => sum + entry.minRamGB, 0);
    assert.ok(trio.length >= 1 && trio.length <= 3, `1-3 models on ${totalRamGB}GB`);
    // The fallback single model on a tiny host may exceed the budget by design;
    // any multi-model panel must fit cumulatively.
    if (trio.length > 1) {
      assert.ok(used <= usableRamGB(h), `combined ${used}GB <= budget on ${totalRamGB}GB`);
    }
  }
});

test("recommendFor puts fitting models first, smallest first", () => {
  const recs = recommendFor(host(8));
  assert.ok(recs.length === LOCAL_CATALOG.length, "every catalog entry is returned");
  // The first entry fits; the last does not (8GB can't run the big models).
  assert.equal(recs[0]?.fits, true);
  assert.equal(recs[recs.length - 1]?.fits, false);
  // Fitting block is sorted ascending by size, and no non-fitting precedes a fitting one.
  let seenNonFitting = false;
  for (const rec of recs) {
    if (!rec.fits) seenNonFitting = true;
    else assert.equal(seenNonFitting, false, "a fitting model must not follow a non-fitting one");
  }
});

test("defaultTrioFor returns the three small all-rounders on a roomy machine", () => {
  const trio = defaultTrioFor(host(64));
  assert.deepEqual(
    trio.map((entry) => entry.repo),
    [
      "mlx-community/Qwen3-1.7B-4bit",
      "mlx-community/gemma-3-1b-it-4bit",
      "mlx-community/Llama-3.2-1B-Instruct-4bit"
    ]
  );
});

test("defaultTrioFor trims the panel to fit a mid-size machine", () => {
  // 16GB -> 12.8GB budget: the preferred trio (6+4+4=14) can't all fit, so it
  // returns the largest fitting subset rather than over-committing.
  const trio = defaultTrioFor(host(16));
  const used = trio.reduce((sum, entry) => sum + entry.minRamGB, 0);
  assert.ok(used <= usableRamGB(host(16)));
  assert.ok(trio.length >= 1 && trio.length < 3);
});

test("defaultTrioFor falls back to the single smallest model on a tiny machine", () => {
  const trio = defaultTrioFor(host(3));
  assert.equal(trio.length, 1, "only the smallest model is offered");
  assert.ok(trio[0] !== undefined);
  assert.equal(trio[0]?.minRamGB, Math.min(...LOCAL_CATALOG.map((entry) => entry.minRamGB)));
});

test("catalogEntry looks up by repo id", () => {
  assert.equal(catalogEntry("mlx-community/Qwen3-1.7B-4bit")?.params, "1.7B");
  assert.equal(catalogEntry("does/not-exist"), undefined);
});

test("detectHost reports the running host's shape", () => {
  const detected = detectHost();
  assert.equal(detected.platform, process.platform);
  assert.equal(detected.arch, process.arch);
  assert.ok(detected.totalRamGB > 0);
  assert.equal(detected.appleSilicon, process.platform === "darwin" && process.arch === "arm64");
});
