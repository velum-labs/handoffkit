import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { FUSION_CONFIG_VERSION } from "../fusion-config.js";
import { runClaudeRoute } from "../fusion/claude-route.js";
import { mergeRoutingProviders, panelSpecToRoutingProvider } from "../fusion/providers/index.js";
import { printRoutingPreview, sampleRoutingBody } from "../fusion/routing.js";
import { parseScenarioRoutes } from "@fusionkit/model-gateway";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));
const tmpRoots: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusion-routing-"));
  tmpRoots.push(dir);
  return dir;
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir });
}

function writeRoutingConfig(
  dir: string,
  routing: {
    routes: Record<string, unknown>;
    providers: Array<{ id: string; provider: string; keyEnv: string }>;
  }
): void {
  mkdirSync(join(dir, ".fusionkit"), { recursive: true });
  writeFileSync(
    join(dir, ".fusionkit", "fusion.json"),
    JSON.stringify({
      version: FUSION_CONFIG_VERSION,
      routing
    })
  );
}

after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

test("panelSpecToRoutingProvider maps cloud panel entries", () => {
  const spec = panelSpecToRoutingProvider({
    id: "sonnet",
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    keyEnv: "ANTHROPIC_API_KEY"
  });
  assert.deepEqual(spec, {
    id: "sonnet",
    provider: "anthropic",
    keyEnv: "ANTHROPIC_API_KEY"
  });
});

test("panelSpecToRoutingProvider maps mlx panel entries with model field", () => {
  const spec = panelSpecToRoutingProvider({
    id: "local",
    model: "mlx-community/Qwen3-1.7B-4bit",
    provider: "mlx"
  });
  assert.deepEqual(spec, {
    id: "local",
    provider: "mlx",
    model: "mlx-community/Qwen3-1.7B-4bit"
  });
});

test("mergeRoutingProviders prefers explicit entries and keeps mlx panel providers", () => {
  const merged = mergeRoutingProviders(
    [{ id: "sonnet", provider: "anthropic", keyEnv: "KEY" }],
    [
      { id: "sonnet", model: "other", provider: "anthropic", keyEnv: "OTHER" },
      { id: "local", model: "mlx-community/Qwen3-1.7B-4bit", provider: "mlx" }
    ]
  );
  assert.equal(merged.length, 2);
  assert.equal(merged.find((entry) => entry.id === "sonnet")?.keyEnv, "KEY");
  assert.deepEqual(merged.find((entry) => entry.id === "local"), {
    id: "local",
    provider: "mlx",
    model: "mlx-community/Qwen3-1.7B-4bit"
  });
});

test("printRoutingPreview emits scenario decision", () => {
  const routes = parseScenarioRoutes({ default: "p,m1", webSearch: "p,m2" }, "test");
  const lines: string[] = [];
  const decision = printRoutingPreview(
    routes,
    { ...sampleRoutingBody("search the web"), tools: [{ name: "web_search" }] },
    (line) => lines.push(line)
  );
  assert.equal(decision.scenario, "webSearch");
  assert.match(lines[0] ?? "", /webSearch/);
});

test("runClaudeRoute dry-run prints routing decision without network", async () => {
  const dir = freshDir();
  initGitRepo(dir);
  writeRoutingConfig(dir, {
    routes: { default: "claude-sub,claude-sonnet-4-5" },
    providers: [{ id: "claude-sub", provider: "anthropic", keyEnv: "ANTHROPIC_API_KEY" }]
  });

  const lines: string[] = [];
  const code = await runClaudeRoute([], {
    repo: dir,
    dryRun: true,
    previewText: "explain this codebase",
    log: (line) => lines.push(line)
  });

  assert.equal(code, 0);
  assert.match(lines[0] ?? "", /scenario=default/);
  assert.match(lines[0] ?? "", /claude-sub,claude-sonnet-4-5/);
  assert.match(lines[0] ?? "", /standard request/);
});

test("fusion claude --route-dry-run prints routing decision via CLI", () => {
  const dir = freshDir();
  initGitRepo(dir);
  writeRoutingConfig(dir, {
    routes: { default: "claude-sub,claude-sonnet-4-5" },
    providers: [{ id: "claude-sub", provider: "anthropic", keyEnv: "ANTHROPIC_API_KEY" }]
  });

  const result = spawnSync(
    process.execPath,
    [
      CLI,
      "fusion",
      "claude",
      "--route",
      "--route-dry-run",
      "--route-preview",
      "explain this codebase",
      "--repo",
      dir
    ],
    { encoding: "utf8", env: { ...process.env, PORTLESS: "0" } }
  );

  assert.equal(result.status, 0, result.stderr);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /scenario=default/);
  assert.match(output, /claude-sub,claude-sonnet-4-5/);
});

test("claude --help documents route flags", () => {
  const result = spawnSync(process.execPath, [CLI, "claude", "--help"], {
    encoding: "utf8",
    env: { ...process.env, PORTLESS: "0" }
  });
  assert.equal(result.status, 0);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /--route/);
  assert.match(output, /--route-dry-run/);
  assert.match(output, /--route-preview/);
});
