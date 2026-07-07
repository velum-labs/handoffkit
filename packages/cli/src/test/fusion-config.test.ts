import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  DEFAULT_ENSEMBLE_NAME,
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

/** The default ensemble a flat/legacy `panel`/`judgeModel` upgrades into. */
function defaultEnsemble(config: FusionConfig | undefined) {
  return config?.ensembles?.[DEFAULT_ENSEMBLE_NAME];
}

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
  assert.equal(defaultEnsemble(config)?.panel?.length, 1);
  assert.equal(defaultEnsemble(config)?.panel?.[0]?.provider, "openai");
  assert.equal(defaultEnsemble(config)?.judgeModel, "gpt-5.5");
  assert.equal(config.observe, true);
  assert.equal(config.port, 1234);
});

test("parseFusionConfig accepts a v3 ensembles map", () => {
  const config = parseFusionConfig(
    {
      version: FUSION_CONFIG_VERSION,
      defaultEnsemble: "deep",
      ensembles: {
        default: { panel: [{ id: "gpt", model: "gpt-5.5", provider: "openai" }] },
        deep: {
          panel: [{ id: "opus", model: "claude-opus-4-8", provider: "anthropic" }],
          judgeModel: "claude-opus-4-8",
          synthesizerModel: "claude-opus-4-8"
        }
      }
    },
    "test"
  );
  assert.deepEqual(Object.keys(config.ensembles ?? {}), ["default", "deep"]);
  assert.equal(config.defaultEnsemble, "deep");
  assert.equal(config.ensembles?.deep?.judgeModel, "claude-opus-4-8");
  assert.equal(config.ensembles?.deep?.synthesizerModel, "claude-opus-4-8");
});

test("parseFusionConfig validates ensemble names", () => {
  const panel = [{ id: "gpt", model: "gpt-5.5", provider: "openai" }];
  assert.throws(
    () =>
      parseFusionConfig(
        { version: FUSION_CONFIG_VERSION, ensembles: { "Bad Name": { panel } } },
        "test"
      ),
    /ensemble name/
  );
  // "panel" is reserved: it would collide with the default's `fusion-panel` id.
  assert.throws(
    () =>
      parseFusionConfig(
        { version: FUSION_CONFIG_VERSION, ensembles: { panel: { panel } } },
        "test"
      ),
    /reserved/
  );
});

test("parseFusionConfig requires a non-empty panel on non-default ensembles", () => {
  assert.throws(
    () =>
      parseFusionConfig(
        { version: FUSION_CONFIG_VERSION, ensembles: { deep: { judgeModel: "gpt-5.5" } } },
        "test"
      ),
    /ensembles\.deep\.panel/
  );
  // The default ensemble may omit the panel (built-in trio applies).
  const config = parseFusionConfig(
    { version: FUSION_CONFIG_VERSION, ensembles: { default: { judgeModel: "gpt-5.5" } } },
    "test"
  );
  assert.equal(defaultEnsemble(config)?.judgeModel, "gpt-5.5");
});

test("parseFusionConfig validates defaultEnsemble names a defined ensemble", () => {
  assert.throws(
    () =>
      parseFusionConfig(
        {
          version: FUSION_CONFIG_VERSION,
          defaultEnsemble: "nope",
          ensembles: { default: { panel: [{ id: "gpt", model: "gpt-5.5" }] } }
        },
        "test"
      ),
    /defaultEnsemble/
  );
});

test("parseFusionConfig rejects flat panel combined with ensembles", () => {
  assert.throws(
    () =>
      parseFusionConfig(
        {
          version: FUSION_CONFIG_VERSION,
          panel: [{ id: "gpt", model: "gpt-5.5" }],
          ensembles: { default: { panel: [{ id: "gpt", model: "gpt-5.5" }] } }
        },
        "test"
      ),
    /cannot be combined/
  );
});

test("parseFusionConfig accepts panelTrust levels and rejects unknown ones", () => {
  const full = parseFusionConfig({ version: FUSION_CONFIG_VERSION, panelTrust: "full" }, "test");
  assert.equal(full.panelTrust, "full");
  const guarded = parseFusionConfig({ version: FUSION_CONFIG_VERSION, panelTrust: "guarded" }, "test");
  assert.equal(guarded.panelTrust, "guarded");
  // Unset stays undefined (defaults to full downstream).
  const unset = parseFusionConfig({ version: FUSION_CONFIG_VERSION }, "test");
  assert.equal(unset.panelTrust, undefined);
  assert.throws(
    () => parseFusionConfig({ version: FUSION_CONFIG_VERSION, panelTrust: "yolo" }, "test"),
    FusionConfigError
  );
});

test("parseFusionConfig accepts the subagents opt-out and rejects bad values", () => {
  const off = parseFusionConfig({ version: FUSION_CONFIG_VERSION, subagents: false }, "test");
  assert.equal(off.subagents, false);
  // Unset stays undefined (defaults to on downstream).
  const unset = parseFusionConfig({ version: FUSION_CONFIG_VERSION }, "test");
  assert.equal(unset.subagents, undefined);
  assert.throws(
    () => parseFusionConfig({ version: FUSION_CONFIG_VERSION, subagents: "yes" }, "test"),
    FusionConfigError
  );
});

test("parseFusionConfig accepts reasoning + reasoningModel and rejects bad values", () => {
  const config = parseFusionConfig(
    {
      version: FUSION_CONFIG_VERSION,
      reasoning: true,
      reasoningModel: "mlx-community/Qwen3-1.7B-4bit"
    },
    "test"
  );
  assert.equal(config.reasoning, true);
  assert.equal(config.reasoningModel, "mlx-community/Qwen3-1.7B-4bit");
  assert.throws(
    () => parseFusionConfig({ version: FUSION_CONFIG_VERSION, reasoningModel: 7 }, "test"),
    FusionConfigError
  );
  assert.throws(
    () => parseFusionConfig({ version: FUSION_CONFIG_VERSION, reasoningModel: "" }, "test"),
    FusionConfigError
  );
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
  assert.equal(defaultEnsemble(config)?.panel?.[0]?.auth, "claude-code");
  assert.equal(defaultEnsemble(config)?.panel?.[1]?.auth, "codex");
});

test("parseFusionConfig accepts panel pricing and local compute metadata", () => {
  const config = parseFusionConfig(
    {
      version: FUSION_CONFIG_VERSION,
      panel: [
        {
          id: "qwen",
          model: "mlx-community/Qwen3-1.7B-4bit",
          provider: "mlx",
          pricing: { inputPer1mTokens: 0, outputPer1mTokens: 0, currency: "USD" },
          localCompute: { usdPerDeviceHour: 0.36 }
        }
      ]
    },
    "test"
  );
  assert.equal(defaultEnsemble(config)?.panel?.[0]?.pricing?.outputPer1mTokens, 0);
  assert.equal(defaultEnsemble(config)?.panel?.[0]?.localCompute?.usdPerDeviceHour, 0.36);
  assert.throws(
    () =>
      parseFusionConfig(
        {
          version: FUSION_CONFIG_VERSION,
          panel: [{ id: "x", model: "m", pricing: { inputPer1mTokens: -1 } }]
        },
        "test"
      ),
    FusionConfigError
  );
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

test("parseFusionConfig accepts an openrouter panel entry", () => {
  const config = parseFusionConfig(
    {
      version: FUSION_CONFIG_VERSION,
      panel: [
        {
          id: "or-sonnet",
          model: "anthropic/claude-sonnet-4.5",
          provider: "openrouter",
          keyEnv: "OPENROUTER_API_KEY"
        }
      ]
    },
    "test"
  );
  assert.equal(defaultEnsemble(config)?.panel?.[0]?.provider, "openrouter");
  assert.equal(defaultEnsemble(config)?.panel?.[0]?.model, "anthropic/claude-sonnet-4.5");
  assert.equal(defaultEnsemble(config)?.panel?.[0]?.keyEnv, "OPENROUTER_API_KEY");
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

test("loadFusionConfig returns undefined when no config exists", () => {
  assert.equal(loadFusionConfig(freshDir()), undefined);
});

test("write then load round-trips the config through .fusionkit/fusion.json", () => {
  const dir = freshDir();
  const config: FusionConfig = {
    version: FUSION_CONFIG_VERSION,
    tool: "claude",
    ensembles: {
      [DEFAULT_ENSEMBLE_NAME]: {
        panel: [
          { id: "gpt", model: "gpt-5.5", provider: "openai", keyEnv: "OPENAI_API_KEY" },
          { id: "sonnet", model: "claude-sonnet-4-6", provider: "anthropic", keyEnv: "ANTHROPIC_API_KEY" }
        ],
        judgeModel: "gpt-5.5"
      }
    },
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
  writeFusionPrompts(dir, { judge: "CUSTOM JUDGE", synthesizer: "CUSTOM SYNTH" });
  const loaded = loadFusionConfig(dir);
  assert.deepEqual(loaded?.prompts, { judge: "CUSTOM JUDGE", synthesizer: "CUSTOM SYNTH" });
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

test("per-ensemble prompts override the flat files per id, flat files are the fallback", () => {
  const dir = freshDir();
  writeFusionConfig(dir, {
    version: FUSION_CONFIG_VERSION,
    ensembles: {
      default: { panel: [{ id: "gpt", model: "gpt-5.5", provider: "openai" }] },
      deep: { panel: [{ id: "opus", model: "claude-opus-4-8", provider: "anthropic" }] }
    }
  });
  writeFusionPrompts(dir, { judge: "FLAT JUDGE", synthesizer: "FLAT SYNTH" });
  writeFusionPrompts(dir, { judge: "DEEP JUDGE" }, { ensemble: "deep" });
  const loaded = loadFusionConfig(dir);
  // The default ensemble uses the flat files verbatim.
  assert.deepEqual(loaded?.ensembles?.default?.prompts, {
    judge: "FLAT JUDGE",
    synthesizer: "FLAT SYNTH"
  });
  // A named ensemble's own file wins per id; missing ids fall back to flat.
  assert.deepEqual(loaded?.ensembles?.deep?.prompts, {
    judge: "DEEP JUDGE",
    synthesizer: "FLAT SYNTH"
  });
  // The top-level prompts stay the flat (default-ensemble) overrides.
  assert.deepEqual(loaded?.prompts, { judge: "FLAT JUDGE", synthesizer: "FLAT SYNTH" });
});

test("a legacy flat panel upgrades into ensembles.default in memory", () => {
  const config = parseFusionConfig(
    {
      version: "fusionkit.fusion.v2",
      panel: [{ id: "gpt", model: "gpt-5.5", provider: "openai" }],
      judgeModel: "gpt-5.5"
    },
    "test"
  );
  assert.equal(config.version, FUSION_CONFIG_VERSION);
  assert.equal(defaultEnsemble(config)?.panel?.[0]?.id, "gpt");
  assert.equal(defaultEnsemble(config)?.judgeModel, "gpt-5.5");
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

test("k parses per ensemble and at the top level", () => {
  const config = parseFusionConfig(
    {
      version: FUSION_CONFIG_VERSION,
      k: 4,
      ensembles: {
        step: { panel: [{ id: "gpt", model: "gpt-5.5" }], k: 1 },
        deep: { panel: [{ id: "gpt", model: "gpt-5.5" }] }
      }
    },
    "test"
  );
  assert.equal(config.k, 4);
  assert.equal(config.ensembles?.step?.k, 1);
  assert.equal(config.ensembles?.deep?.k, undefined);
});

test("k rejects non-positive and non-integer values", () => {
  for (const bad of [0, -1, 1.5, "2"]) {
    assert.throws(
      () =>
        parseFusionConfig(
          {
            version: FUSION_CONFIG_VERSION,
            ensembles: { step: { panel: [{ id: "gpt", model: "gpt-5.5" }], k: bad } }
          },
          "test"
        ),
      /k must be a positive integer/
    );
  }
});
