import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  FUSION_CONFIG_VERSION,
  FusionConfigError,
  fusionConfigPath,
  fusionPromptPath,
  legacyFusionConfigPath,
  loadFusionConfig,
  parseFusionConfig,
  readFusionPrompts,
  writeFusionConfig,
  writeFusionPrompts
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

test("parseFusionConfig accepts subscription panel entries with auth", () => {
  const config = parseFusionConfig(
    {
      version: FUSION_CONFIG_VERSION,
      panel: [
        { id: "claude-code", model: "claude-sonnet-4-5", provider: "anthropic", auth: "claude-code" },
        { id: "codex", model: "gpt-5.5", auth: "codex" }
      ]
    },
    "test"
  );
  assert.equal(config.panel?.[0]?.auth, "claude-code");
  assert.equal(config.panel?.[1]?.auth, "codex");
});

test("parseFusionConfig rejects an unknown auth mode", () => {
  assert.throws(
    () =>
      parseFusionConfig(
        { version: FUSION_CONFIG_VERSION, panel: [{ id: "x", model: "m", auth: "nope" }] },
        "test"
      ),
    FusionConfigError
  );
});

test("parseFusionConfig upgrades a legacy v1 version in memory", () => {
  const config = parseFusionConfig(
    { version: "fusionkit.fusion.v1", tool: "claude" },
    "test"
  );
  assert.equal(config.version, FUSION_CONFIG_VERSION);
  assert.equal(config.tool, "claude");
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

test("parseFusionConfig accepts routing config", () => {
  const config = parseFusionConfig(
    {
      version: FUSION_CONFIG_VERSION,
      routing: {
        default: "anthropic,claude-sonnet-4-5",
        longContextThreshold: 50000,
        providers: [{ id: "anthropic", provider: "anthropic", keyEnv: "ANTHROPIC_API_KEY" }]
      }
    },
    "test"
  );
  assert.equal(config.routing?.routes.default, "anthropic,claude-sonnet-4-5");
  assert.equal(config.routing?.routes.longContextThreshold, 50000);
  assert.equal(config.routing?.providers.length, 1);
});

test("parseFusionConfig rejects routing without providers", () => {
  assert.throws(
    () =>
      parseFusionConfig(
        { version: FUSION_CONFIG_VERSION, routing: { default: "a,m", providers: [] } },
        "test"
      ),
    FusionConfigError
  );
});

test("loadFusionConfig returns undefined when no config exists", () => {
  assert.equal(loadFusionConfig(freshDir()), undefined);
});

test("write then load round-trips the config through .fusionkit/fusion.json", () => {
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
  assert.ok(path.endsWith(join(".fusionkit", "fusion.json")));
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

test("writeFusionConfig omits the prompts field from fusion.json", () => {
  const dir = freshDir();
  writeFusionConfig(dir, { version: FUSION_CONFIG_VERSION, tool: "codex", prompts: { judge: "X" } });
  const onDisk = JSON.parse(readFileSync(fusionConfigPath(dir), "utf8")) as Record<string, unknown>;
  assert.equal("prompts" in onDisk, false);
});

test("loadFusionConfig surfaces invalid JSON as a FusionConfigError", () => {
  const dir = freshDir();
  writeFusionConfig(dir, { version: FUSION_CONFIG_VERSION, tool: "codex" });
  writeFileSync(fusionConfigPath(dir), "{ this is not json");
  assert.throws(() => loadFusionConfig(dir), FusionConfigError);
});

test("prompt overrides are read from .fusionkit/prompts/*.md and attached on load", () => {
  const dir = freshDir();
  writeFusionConfig(dir, { version: FUSION_CONFIG_VERSION, tool: "codex" });
  writeFusionPrompts(dir, { judge: "CUSTOM JUDGE", "trajectory-step": "CUSTOM STEP" });
  const loaded = loadFusionConfig(dir);
  assert.deepEqual(loaded?.prompts, { judge: "CUSTOM JUDGE", "trajectory-step": "CUSTOM STEP" });
});

test("empty prompt files are ignored (fall back to built-in defaults)", () => {
  const dir = freshDir();
  writeFusionConfig(dir, { version: FUSION_CONFIG_VERSION, tool: "codex" });
  writeFusionPrompts(dir, { judge: "REAL" });
  // Blank out the file: an empty override means "use the built-in default".
  writeFileSync(fusionPromptPath(dir, "judge"), "   \n");
  assert.deepEqual(readFusionPrompts(dir), {});
  assert.equal(loadFusionConfig(dir)?.prompts, undefined);
});

test("writeFusionPrompts does not clobber existing files without force", () => {
  const dir = freshDir();
  writeFusionPrompts(dir, { judge: "FIRST" });
  const second = writeFusionPrompts(dir, { judge: "SECOND" });
  assert.deepEqual(second, []);
  assert.equal(readFusionPrompts(dir).judge, "FIRST");
  writeFusionPrompts(dir, { judge: "THIRD" }, { force: true });
  assert.equal(readFusionPrompts(dir).judge, "THIRD");
});

test("loadFusionConfig auto-migrates a legacy fusionkit.json into .fusionkit/", () => {
  const dir = freshDir();
  const legacy: FusionConfig = { version: FUSION_CONFIG_VERSION, tool: "claude", local: true };
  writeFileSync(legacyFusionConfigPath(dir), JSON.stringify(legacy, null, 2) + "\n");

  const notices: string[] = [];
  const loaded = loadFusionConfig(dir, (message) => notices.push(message));
  assert.equal(loaded?.tool, "claude");
  assert.equal(loaded?.local, true);
  // The migrated copy now exists; the legacy file is left intact as a fallback.
  assert.ok(existsSync(fusionConfigPath(dir)));
  assert.ok(existsSync(legacyFusionConfigPath(dir)));
  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? "", /migrated/);
});

test("loadFusionConfig migrates a legacy v1 file and upgrades the version", () => {
  const dir = freshDir();
  writeFileSync(
    legacyFusionConfigPath(dir),
    JSON.stringify({ version: "fusionkit.fusion.v1", tool: "codex" }, null, 2) + "\n"
  );
  const loaded = loadFusionConfig(dir);
  assert.equal(loaded?.version, FUSION_CONFIG_VERSION);
  const migrated = JSON.parse(readFileSync(fusionConfigPath(dir), "utf8")) as { version: string };
  assert.equal(migrated.version, FUSION_CONFIG_VERSION);
});
