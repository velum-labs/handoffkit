import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packagesRoot = fileURLToPath(new URL("../../../", import.meta.url));
const PACKAGE_DIRS = [
  "harness-core",
  "tools",
  ...readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("tool-"))
    .map((entry) => entry.name)
];

function productionSources(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : productionSources(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("neutral harness and tool packages cannot reach product packages", () => {
  for (const packageDir of PACKAGE_DIRS) {
    const root = resolve(packagesRoot, packageDir);
    const manifest = readFileSync(resolve(root, "package.json"), "utf8");
    assert.doesNotMatch(manifest, /"@fusionkit\//, `${packageDir} manifest reaches product scope`);
    const tsconfig = readFileSync(resolve(root, "tsconfig.json"), "utf8");
    assert.doesNotMatch(tsconfig, /(?:ensemble|fusion-gateway|protocol|tracing|workspace)/, `${packageDir} build graph reaches product scope`);
    for (const source of productionSources(resolve(root, "src"))) {
      const content = readFileSync(source, "utf8");
      assert.doesNotMatch(
        content,
        /(?:from\s+|import\s*\()["']@fusionkit\//,
        `${source} reaches product scope`
      );
      assert.doesNotMatch(
        content,
        /\b(?:fusionkit|fusion|fused)\b/i,
        `${source} contains product-specific vocabulary`
      );
    }
  }
});
