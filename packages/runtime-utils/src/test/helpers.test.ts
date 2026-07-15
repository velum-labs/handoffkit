import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  estimateTokens,
  randomId,
  spawnTool,
  trimSurroundingSlashes,
  trimTrailingSlashes
} from "../index.js";

test("randomId returns hex ids with optional prefix and default length", () => {
  const bare = randomId();
  assert.match(bare, /^[0-9a-f]{10}$/);
  const prefixed = randomId(12, "req_");
  assert.match(prefixed, /^req_[0-9a-f]{12}$/);
});

test("ids minted in the same millisecond stay distinct (panel-root collision guard)", () => {
  // Panel run ids are `panels_${Date.now()}_${randomId(6)}`; the random suffix
  // is the only thing separating two panels started in the same tick, so it
  // must actually be random per call (not seeded by the clock).
  const first = randomId(6);
  const second = randomId(6);
  assert.notEqual(first, second, "back-to-back ids in one tick differ");
});

test("estimateTokens uses ceil(chars/4) with a minimum of 1", () => {
  assert.equal(estimateTokens(""), 1);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("user", '{"tool":"payload"}'), 6);
});

test("slash trimming is linear and preserves interior separators", () => {
  assert.equal(trimTrailingSlashes("https://route.test////"), "https://route.test");
  assert.equal(trimSurroundingSlashes("////route/path////"), "route/path");
  assert.equal(trimSurroundingSlashes("////"), "");
});

test("spawnTool forwards explicit tool env without leaking unrelated secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fusionkit-spawn-tool-env-"));
  const output = join(dir, "env.json");
  process.env.FUSIONKIT_UNRELATED_SECRET = "must-not-leak";
  try {
    const script = [
      'const { writeFileSync } = require("node:fs");',
      `writeFileSync(${JSON.stringify(output)}, JSON.stringify({`,
      "  secret: process.env.FUSIONKIT_UNRELATED_SECRET ?? null,",
      "  explicit: process.env.FUSIONKIT_EXPLICIT_TOOL_ENV ?? null,",
      "  hasPath: process.env.PATH !== undefined",
      "}));"
    ].join("\n");
    const code = await spawnTool(
      process.execPath,
      ["-e", script],
      { FUSIONKIT_EXPLICIT_TOOL_ENV: "gateway-only" },
      dir
    );
    assert.equal(code, 0);
    const observed = JSON.parse(readFileSync(output, "utf8")) as {
      secret: string | null;
      explicit: string | null;
      hasPath: boolean;
    };
    assert.equal(observed.secret, null);
    assert.equal(observed.explicit, "gateway-only");
    assert.equal(observed.hasPath, true);
  } finally {
    delete process.env.FUSIONKIT_UNRELATED_SECRET;
    rmSync(dir, { recursive: true, force: true });
  }
});
