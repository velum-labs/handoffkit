import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function productionSources(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "test" || entry.name === "__tests__") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
    }
  };
  visit(join(root, "src"));
  return files;
}

test("RouteKit gateway and accounts have no FusionKit dependency edge", () => {
  for (const directory of ["model-gateway", "accounts"]) {
    const root = join(packageRoot, directory);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    assert.equal(
      Object.keys(manifest.dependencies ?? {}).some((name) => name.startsWith("@fusionkit/")),
      false,
      `${directory} manifest`
    );
    for (const path of productionSources(root)) {
      assert.doesNotMatch(readFileSync(path, "utf8"), /@fusionkit\//, path);
    }
  }
});
