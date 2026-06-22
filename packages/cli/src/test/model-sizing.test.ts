import assert from "node:assert/strict";
import { test } from "node:test";

import {
  KV_CONTEXT_TOKENS,
  clearSizingCacheForTests,
  estimateModelSizing,
  kvCacheBytes,
  requiredGBFrom,
  sumSafetensorBytes
} from "../fusion/model-sizing.js";

const GIB = 1024 ** 3;

test("sumSafetensorBytes prefers lfs.size and ignores non-weight files", () => {
  const tree = [
    { type: "file", path: "model-00001-of-00002.safetensors", size: 134, lfs: { size: 2_000_000_000 } },
    { type: "file", path: "model-00002-of-00002.safetensors", size: 134, lfs: { size: 1_000_000_000 } },
    { type: "file", path: "config.json", size: 900 },
    { type: "file", path: "tokenizer.json", size: 5000 },
    { type: "file", path: "model.safetensors", size: 500_000_000 } // non-LFS: use plain size
  ];
  assert.equal(sumSafetensorBytes(tree), 2_000_000_000 + 1_000_000_000 + 500_000_000);
});

test("sumSafetensorBytes tolerates malformed input", () => {
  assert.equal(sumSafetensorBytes(null), 0);
  assert.equal(sumSafetensorBytes([{ nope: true }, 7, "x"]), 0);
});

test("kvCacheBytes uses real config dims (with GQA + head_dim fallback)", () => {
  // hidden 4096, 32 heads -> head_dim 128; 8 kv heads; 32 layers; fp16; 8192 ctx.
  const config = {
    num_hidden_layers: 32,
    num_attention_heads: 32,
    num_key_value_heads: 8,
    hidden_size: 4096
  };
  const headDim = 4096 / 32;
  const expected = 2 * 32 * 8 * headDim * 2 * 8192;
  assert.equal(kvCacheBytes(config, 8192), expected);

  // Explicit head_dim wins over hidden_size/heads.
  assert.equal(
    kvCacheBytes({ num_hidden_layers: 1, num_attention_heads: 4, head_dim: 64 }, 100),
    2 * 1 * 4 * 64 * 2 * 100
  );
});

test("kvCacheBytes returns 0 when dimensions are missing", () => {
  assert.equal(kvCacheBytes({ num_hidden_layers: 32 }, 8192), 0);
  assert.equal(kvCacheBytes("nope", 8192), 0);
});

test("requiredGBFrom = weights + KV + overhead", () => {
  const weightBytes = 2 * GIB;
  const config = { num_hidden_layers: 1, num_attention_heads: 1, head_dim: 1 };
  const kv = kvCacheBytes(config, KV_CONTEXT_TOKENS);
  const expected = (weightBytes + kv + 1.5 * GIB) / GIB;
  assert.equal(requiredGBFrom(weightBytes, config), expected);
});

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 404 });
}

test("estimateModelSizing measures real sizing from the Hub", async () => {
  clearSizingCacheForTests();
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/tree/")) {
      return jsonResponse([
        { type: "file", path: "model.safetensors", lfs: { size: 4 * GIB } },
        { type: "file", path: "config.json", size: 800 }
      ]);
    }
    if (url.includes("config.json")) {
      return jsonResponse({ num_hidden_layers: 1, num_attention_heads: 1, head_dim: 1 });
    }
    return jsonResponse({}, false);
  }) as typeof fetch;

  const sizing = await estimateModelSizing("mlx-community/Real-Test-1", { fetchImpl });
  assert.equal(sizing.source, "hub");
  assert.equal(sizing.weightGB, 4);
  assert.ok(sizing.requiredGB > 4 && sizing.requiredGB < 6, `weights + tiny KV + 1.5 overhead, got ${sizing.requiredGB}`);
});

test("estimateModelSizing falls back to the catalog floor when offline", async () => {
  clearSizingCacheForTests();
  const fetchImpl = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  const sizing = await estimateModelSizing("mlx-community/Offline-Test", {
    catalogFallbackGB: 9,
    fetchImpl
  });
  assert.equal(sizing.source, "catalog");
  assert.equal(sizing.requiredGB, 9);
});

test("estimateModelSizing reports unknown for an unsizable repo with no fallback", async () => {
  clearSizingCacheForTests();
  const fetchImpl = (async () => jsonResponse([], true)) as typeof fetch; // empty tree
  const sizing = await estimateModelSizing("someone/mystery", { fetchImpl });
  assert.equal(sizing.source, "unknown");
  assert.equal(sizing.requiredGB, 0);
});
