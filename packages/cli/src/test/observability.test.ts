import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

import {
  bundledScopeServer,
  expectedScopeIdentity,
  SCOPE_BUNDLED_IDENTITY,
  scopeSourceIdentity
} from "../fusion/observability.js";

const tmpRoots: string[] = [];

function makeScopeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "scope-identity-"));
  tmpRoots.push(root);
  mkdirSync(join(root, "app"), { recursive: true });
  mkdirSync(join(root, "components"), { recursive: true });
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "scope" }) + "\n");
  writeFileSync(join(root, "next.config.mjs"), "export default {};\n");
  writeFileSync(join(root, "app", "page.tsx"), "export default function Page() { return 'one'; }\n");
  writeFileSync(join(root, "components", "card.tsx"), "export function Card() { return null; }\n");
  writeFileSync(join(root, "lib", "format.ts"), "export const label = 'one';\n");
  return root;
}

after(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

test("scope source identity changes when companion app source changes", () => {
  const root = makeScopeFixture();
  const before = scopeSourceIdentity(root);

  writeFileSync(join(root, "app", "page.tsx"), "export default function Page() { return 'two'; }\n");

  assert.match(before, /^scope-dashboard:[a-f0-9]{16}$/);
  assert.notEqual(scopeSourceIdentity(root), before);
});

test("scope source identity ignores generated Next build output", () => {
  const root = makeScopeFixture();
  const before = scopeSourceIdentity(root);
  mkdirSync(join(root, ".next"), { recursive: true });
  writeFileSync(join(root, ".next", "BUILD_ID"), "generated\n");

  assert.equal(scopeSourceIdentity(root), before);
});

test("bundled scope server resolves beside the compiled CLI dist directory", () => {
  const cliPackage = mkdtempSync(join(tmpdir(), "scope-bundle-"));
  tmpRoots.push(cliPackage);
  const modulePath = join(cliPackage, "dist", "fusion", "observability.js");
  const serverPath = join(cliPackage, "scope", "server.js");
  mkdirSync(join(cliPackage, "dist", "fusion"), { recursive: true });
  mkdirSync(join(cliPackage, "scope"), { recursive: true });
  writeFileSync(modulePath, "");
  writeFileSync(serverPath, "export {};\n");
  const moduleUrl = pathToFileURL(modulePath).href;

  assert.equal(bundledScopeServer(moduleUrl, {}), serverPath);
  assert.equal(expectedScopeIdentity({ moduleUrl, env: {} }), SCOPE_BUNDLED_IDENTITY);
});

test("missing staged bundle falls back to source identity", () => {
  const cliPackage = mkdtempSync(join(tmpdir(), "scope-no-bundle-"));
  tmpRoots.push(cliPackage);
  const moduleUrl = pathToFileURL(
    join(cliPackage, "dist", "fusion", "observability.js")
  ).href;
  const scopeDir = makeScopeFixture();

  assert.equal(bundledScopeServer(moduleUrl, {}), undefined);
  assert.equal(
    expectedScopeIdentity({ moduleUrl, env: {}, scopeDir }),
    scopeSourceIdentity(scopeDir)
  );
});

test("dev mode ignores a staged bundle and uses source identity", () => {
  const cliPackage = mkdtempSync(join(tmpdir(), "scope-dev-bundle-"));
  tmpRoots.push(cliPackage);
  const modulePath = join(cliPackage, "dist", "fusion", "observability.js");
  mkdirSync(join(cliPackage, "dist", "fusion"), { recursive: true });
  mkdirSync(join(cliPackage, "scope"), { recursive: true });
  writeFileSync(join(cliPackage, "scope", "server.js"), "export {};\n");
  const scopeDir = makeScopeFixture();
  const moduleUrl = pathToFileURL(modulePath).href;
  const env = { FUSIONKIT_DEV: "1" };

  assert.equal(bundledScopeServer(moduleUrl, env), undefined);
  assert.equal(
    expectedScopeIdentity({ moduleUrl, env, scopeDir }),
    scopeSourceIdentity(scopeDir)
  );
});
