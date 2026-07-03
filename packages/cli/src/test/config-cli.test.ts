import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { FUSION_CONFIG_VERSION } from "../fusion-config.js";
import type { FusionConfig } from "../fusion-config.js";
import { exportRouterYaml, routerConfigYaml } from "../fusion/stack.js";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/** A repo dir with a committed `.fusionkit/fusion.json` (no git needed; --repo). */
function makeConfigRepo(config: FusionConfig): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fusion-config-cli-"));
  mkdirSync(join(dir, ".fusionkit"), { recursive: true });
  writeFileSync(join(dir, ".fusionkit", "fusion.json"), JSON.stringify(config, null, 2) + "\n");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const CLOUD_CONFIG: FusionConfig = {
  version: FUSION_CONFIG_VERSION,
  tool: "claude",
  panel: [
    { id: "gpt", model: "gpt-5.5", provider: "openai", keyEnv: "OPENAI_API_KEY" },
    { id: "sonnet", model: "claude-sonnet-4-6", provider: "anthropic", keyEnv: "ANTHROPIC_API_KEY" }
  ],
  judgeModel: "claude-sonnet-4-6"
};

test("config help lists its subcommands", () => {
  const result = runCli(["config", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  for (const sub of ["show", "path", "export-yaml"]) {
    assert.match(result.stdout, new RegExp(`\\b${sub}\\b`));
  }
});

test("config path prints the .fusionkit/fusion.json location", () => {
  const fixture = makeConfigRepo(CLOUD_CONFIG);
  try {
    const result = runCli(["config", "path", "--repo", fixture.dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), join(fixture.dir, ".fusionkit", "fusion.json"));
  } finally {
    fixture.cleanup();
  }
});

test("config show renders the effective panel and provenance tags", () => {
  const fixture = makeConfigRepo(CLOUD_CONFIG);
  try {
    const result = runCli(["config", "show", "--repo", fixture.dir]);
    assert.equal(result.status, 0, result.stderr);
    // Panel members and their config-sourced provenance.
    assert.match(result.stdout, /gpt = openai:gpt-5\.5/);
    assert.match(result.stdout, /sonnet = anthropic:claude-sonnet-4-6/);
    assert.match(result.stdout, /\.fusionkit/);
    // A field left unset falls through to the built-in default tag.
    assert.match(result.stdout, /default/);
    assert.match(result.stdout, /precedence:/);
  } finally {
    fixture.cleanup();
  }
});

test("config show falls back to the default cloud trio with no config", () => {
  const dir = mkdtempSync(join(tmpdir(), "fusion-config-cli-empty-"));
  try {
    const result = runCli(["config", "show", "--repo", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /gemini = google:gemini-2\.5-pro/);
    assert.match(result.stdout, /3 model\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config export-yaml stdout is exactly the derived router YAML (no drift)", () => {
  const fixture = makeConfigRepo(CLOUD_CONFIG);
  try {
    const result = runCli(["config", "export-yaml", "--repo", fixture.dir]);
    assert.equal(result.status, 0, result.stderr);

    const specs = CLOUD_CONFIG.panel ?? [];
    const expected = exportRouterYaml({ specs, judgeModel: CLOUD_CONFIG.judgeModel });
    // The command output must equal the reused generator (no duplicated logic).
    assert.equal(result.stdout, expected);
    // ...which is itself exactly routerConfigYaml with the judge endpoint id.
    assert.equal(
      expected,
      routerConfigYaml({ specs, mlxUrls: {}, judgeId: "sonnet" })
    );
    // Sanity: it is valid-looking router YAML.
    assert.match(result.stdout, /^endpoints:/);
    assert.match(result.stdout, /judge_model: "sonnet"/);
  } finally {
    fixture.cleanup();
  }
});

test("routerConfigYaml emits endpoint pricing when configured", () => {
  const yaml = routerConfigYaml({
    specs: [
      {
        id: "gpt",
        model: "gpt-5.5",
        provider: "openai",
        pricing: { inputPer1mTokens: 1.25, outputPer1mTokens: 10, currency: "USD" }
      }
    ],
    mlxUrls: {},
    judgeId: "gpt"
  });
  assert.match(yaml, /pricing:/);
  assert.match(yaml, /input_per_1m_tokens: 1\.25/);
  assert.match(yaml, /output_per_1m_tokens: 10/);
  assert.match(yaml, /currency: "USD"/);
});

test("config export-yaml -o writes the YAML to a file and reports it on stderr", () => {
  const fixture = makeConfigRepo(CLOUD_CONFIG);
  const outPath = join(fixture.dir, "router.yaml");
  try {
    const result = runCli(["config", "export-yaml", "--repo", fixture.dir, "-o", outPath]);
    assert.equal(result.status, 0, result.stderr);
    // stdout stays clean (nothing piped) when writing to a file.
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /wrote/);
    const written = readFileSync(outPath, "utf8");
    const expected = exportRouterYaml({ specs: CLOUD_CONFIG.panel ?? [], judgeModel: CLOUD_CONFIG.judgeModel });
    assert.equal(written, expected);
  } finally {
    fixture.cleanup();
  }
});
