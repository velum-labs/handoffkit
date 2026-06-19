import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  FUSION_CONFIG_VERSION,
  FusionConfigError,
  fusionConfigPath,
  loadFusionConfig,
  parseFusionConfig,
  writeFusionConfig
} from "../fusion-config.js";
import type { FusionConfig } from "../fusion-config.js";

const tmpRoots: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusion-config-"));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

test("parseFusionConfig accepts a valid config", () => {
  const raw = {
    version: FUSION_CONFIG_VERSION,
    tool: "codex",
    panel: [{ id: "gpt", model: "gpt-5.5", provider: "openai", keyEnv: "OPENAI_API_KEY" }],
    judgeModel: "gpt-5.5",
    local: false,
    observe: true,
    port: 1234
  };
  const config = parseFusionConfig(raw, "test");
  assert.equal(config.tool, "codex");
  assert.equal(config.panel?.length, 1);
  assert.equal(config.panel?.[0]?.provider, "openai");
  assert.equal(config.observe, true);
  assert.equal(config.port, 1234);
});

test("parseFusionConfig rejects an unsupported version", () => {
  assert.throws(() => parseFusionConfig({ version: "nope" }, "test"), FusionConfigError);
});

test("parseFusionConfig rejects an unknown panel provider", () => {
  assert.throws(
    () =>
      parseFusionConfig(
        { version: FUSION_CONFIG_VERSION, panel: [{ id: "x", model: "m", provider: "bogus" }] },
        "test"
      ),
    /panel\[0\]\.provider/
  );
});

test("parseFusionConfig rejects a panel entry missing model", () => {
  assert.throws(
    () => parseFusionConfig({ version: FUSION_CONFIG_VERSION, panel: [{ id: "x" }] }, "test"),
    /panel\[0\]\.model/
  );
});

test("parseFusionConfig rejects a non-object", () => {
  assert.throws(() => parseFusionConfig(["not", "an", "object"], "test"), FusionConfigError);
});

test("loadFusionConfig returns undefined when the file is absent", () => {
  assert.equal(loadFusionConfig(freshDir()), undefined);
});

test("write then load round-trips the config", () => {
  const dir = freshDir();
  const config: FusionConfig = {
    version: FUSION_CONFIG_VERSION,
    tool: "claude",
    panel: [
      { id: "gpt", model: "gpt-5.5", provider: "openai", keyEnv: "OPENAI_API_KEY" },
      { id: "sonnet", model: "claude-sonnet-4-6", provider: "anthropic", keyEnv: "ANTHROPIC_API_KEY" }
    ],
    judgeModel: "gpt-5.5",
    local: false,
    observe: false
  };
  const path = writeFusionConfig(dir, config);
  assert.equal(path, fusionConfigPath(dir));
  const loaded = loadFusionConfig(dir);
  assert.deepEqual(loaded, config);
});

test("writeFusionConfig refuses to clobber without force, overwrites with it", () => {
  const dir = freshDir();
  const base: FusionConfig = { version: FUSION_CONFIG_VERSION, tool: "codex" };
  writeFusionConfig(dir, base);
  assert.throws(() => writeFusionConfig(dir, { version: FUSION_CONFIG_VERSION, tool: "claude" }), FusionConfigError);
  writeFusionConfig(dir, { version: FUSION_CONFIG_VERSION, tool: "claude" }, { force: true });
  const reloaded = loadFusionConfig(dir);
  assert.equal(reloaded?.tool, "claude");
});

test("loadFusionConfig surfaces invalid JSON as a FusionConfigError", () => {
  const dir = freshDir();
  writeFileSync(fusionConfigPath(dir), "{ this is not json");
  assert.throws(() => loadFusionConfig(dir), FusionConfigError);
});
