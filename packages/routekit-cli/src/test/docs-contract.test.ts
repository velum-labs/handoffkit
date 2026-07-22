import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const routekitCli = join(root, "packages", "routekit-cli", "dist", "index.js");
const cliEnv = { ...process.env, FUSIONKIT_NO_TUI: "1", ROUTEKIT_NO_TUI: "1" };

function help(args: readonly string[]): string {
  return execFileSync(process.execPath, [routekitCli, ...args], {
    encoding: "utf8",
    env: cliEnv
  });
}

test("documented safe CLI commands remain executable", () => {
  for (const [cli, args] of [
    [routekitCli, ["accounts", "add", "--help"]],
    [routekitCli, ["providers", "add", "--help"]],
    [routekitCli, ["accounts", "login", "--help"]],
    [routekitCli, ["accounts", "remove", "--help"]]
  ] as const) {
    const output = execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env: cliEnv
    });
    assert.match(output, /Usage:/);
  }
  // The cliproxy subtree is gone from the public accounts surface.
  const accountsHelp = help(["accounts", "--help"]);
  assert.match(accountsHelp, /\blogin\b/);
  assert.doesNotMatch(accountsHelp, /\bcliproxy\b/);
});

test("first-launch help exposes only supported RouteKit routes", () => {
  const rootHelp = help(["--help"]);
  for (const command of ["codex", "claude", "cursor", "accounts", "providers"]) {
    assert.match(rootHelp, new RegExp(`^  ${command}(?:[ <\\[]|$)`, "m"));
  }
  assert.doesNotMatch(rootHelp, /\bopencode\b/i);

  const loginHelp = help(["accounts", "login", "--help"]);
  assert.match(loginHelp, /claude-code, codex/);
  assert.doesNotMatch(loginHelp, /\b(?:gemini|grok|kimi|cliproxy)\b/i);
});

test("public RouteKit docs contain no not-offered onboarding commands", () => {
  for (const path of [
    "README.md",
    "packages/routekit-cli/README.md",
    "docs/configuration.md",
    "docs/subscription-pooling.md",
    "apps/docs/content/docs/guides/subscription-pooling.mdx",
    "apps/docs/content/docs/getting-started/installation.mdx",
    "configs/models.example.yaml"
  ]) {
    const source = readFileSync(join(root, path), "utf8");
    assert.doesNotMatch(
      source,
      /\broutekit\s+(?:opencode\b|accounts\s+login\s+(?:gemini|grok|kimi)\b|providers\s+add\s+(?:google|cliproxy)\b)/i,
      `${path} advertises a route that is not offered at first launch`
    );
  }
});

test("retained implementation references are explicitly non-contractual", () => {
  for (const path of [
    "packages/accounts/README.md",
    "apps/docs/content/docs/reference/packages.mdx",
    "docs/packages.md",
    "configs/benchmark-router.example.yaml",
    "docs/routekit-account-activation-evidence.md"
  ]) {
    const source = readFileSync(join(root, path), "utf8");
    assert.match(
      source,
      /non-contractual|not first-launch qualification|does not add them to RouteKit's launch support/i,
      `${path} does not label retained implementation details as non-contractual`
    );
  }

  const installation = readFileSync(
    join(root, "apps/docs/content/docs/getting-started/installation.mdx"),
    "utf8"
  );
  assert.match(installation, /accounts login claude-code/);
  assert.match(installation, /accounts login codex/);
  assert.doesNotMatch(installation, /accounts add <kind>/);

  for (const path of ["CHANGELOG.md", "apps/docs/content/docs/changelog.mdx"]) {
    const source = readFileSync(join(root, path), "utf8");
    assert.match(
      source,
      /retained internal Google[\s\S]{0,120}outside RouteKit's public\s+support contract/i,
      `${path} does not distinguish the retained Google backend from public support`
    );
  }
});
