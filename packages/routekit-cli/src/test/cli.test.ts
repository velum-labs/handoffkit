import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildProgram } from "../cli.js";
import { completionCandidates } from "../completion.js";

function command(program: ReturnType<typeof buildProgram>, name: string) {
  const found = program.commands.find((entry) => entry.name() === name);
  assert.ok(found, `missing command ${name}`);
  return found;
}

function productionSources(directory: string): string[] {
  const sources: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (name !== "test") sources.push(...productionSources(path));
    } else if (name.endsWith(".ts")) {
      sources.push(readFileSync(path, "utf8"));
    }
  }
  return sources;
}

test("independent command surface is complete and has no compatibility aliases", () => {
  const program = buildProgram();
  const expected = [
    "gateway",
    "codex",
    "claude",
    "cursor",
    "opencode",
    "status",
    "usage",
    "accounts",
    "providers",
    "models",
    "config",
    "doctor",
    "install",
    "uninstall",
    "telemetry",
    "completion",
    "__complete",
    "version"
  ];
  assert.deepEqual(
    program.commands.map((entry) => entry.name()).sort(),
    expected.sort()
  );
  assert.deepEqual(
    command(program, "gateway").commands.map((entry) => entry.name()).sort(),
    ["serve", "stop"]
  );
  assert.deepEqual(
    command(program, "accounts").commands.map((entry) => entry.name()).sort(),
    ["add", "cliproxy", "list", "login", "remove", "serve", "status", "stop"]
  );
  assert.deepEqual(
    command(program, "accounts")
      .commands.find((entry) => entry.name() === "cliproxy")
      ?.commands.map((entry) => entry.name())
      .sort(),
    ["install", "login", "serve", "status"]
  );
  assert.deepEqual(
    command(program, "providers").commands.map((entry) => entry.name()).sort(),
    ["add", "remove", "status"]
  );
  assert.deepEqual(
    command(program, "models").commands.map((entry) => entry.name()).sort(),
    ["info", "list"]
  );
  assert.deepEqual(
    command(program, "config").commands.map((entry) => entry.name()).sort(),
    ["edit", "init", "migrate", "path", "show"]
  );
  assert.equal(program.commands.some((entry) => entry.aliases().length > 0), false);
});

test("dynamic completion follows the command tree", () => {
  const program = buildProgram();
  assert.ok(completionCandidates(program, ["co"]).includes("config"));
  assert.deepEqual(completionCandidates(program, ["gateway", "s"]), [
    "serve",
    "stop"
  ]);
  assert.deepEqual(completionCandidates(program, ["accounts", "s"]), [
    "serve",
    "status",
    "stop"
  ]);
  assert.ok(
    completionCandidates(program, ["gateway", "serve", "--p"]).includes("--port")
  );
  assert.deepEqual(completionCandidates(program, ["accounts", "remove", ""]), [
    "claude-code",
    "codex"
  ]);
});

test("serve CLI rejects an unauthenticated non-loopback bind", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-serve-auth-"));
  const config = join(root, "router.yaml");
  writeFileSync(
    config,
    [
      "providers:",
      "  openai: {}",
      ""
    ].join("\n")
  );
  try {
    const program = buildProgram();
    const gateway = command(program, "gateway");
    const serve = gateway.commands.find((entry) => entry.name() === "serve");
    assert.ok(serve);
    assert.match(
      serve.helpInformation(),
      /authentication token \(required for non-loopback hosts\)/
    );
    await assert.rejects(
      program.parseAsync([
        "node",
        "routekit",
        "--config",
        config,
        "gateway",
        "serve",
        "--host",
        "0.0.0.0",
        "--port",
        "0",
        "--no-portless"
      ]),
      /binding to non-loopback host "0\.0\.0\.0" requires an auth token/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("account removal completion only suggests managed labels for its provider", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-account-completion-"));
  const previousHome = process.env.ROUTEKIT_HOME;
  mkdirSync(join(root, "subscriptions", "codex"), { recursive: true });
  writeFileSync(join(root, "subscriptions", "codex", "work.json"), "{}\n");
  process.env.ROUTEKIT_HOME = root;
  try {
    assert.deepEqual(
      completionCandidates(buildProgram(), ["accounts", "remove", "codex", "w"]),
      ["work"]
    );
    assert.deepEqual(
      completionCandidates(buildProgram(), ["accounts", "remove", "claude", "w"]),
      []
    );
  } finally {
    if (previousHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("production graph and sources contain no other-product dependency or vocabulary", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = join(here, "..", "..");
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(
    Object.keys(manifest.dependencies ?? {}).some((name) => name.startsWith("@fusionkit/")),
    false
  );
  const sourceRoot = join(packageRoot, "src");
  const production = productionSources(sourceRoot).join("\n");
  assert.equal(/@fusionkit\/|fusionkit|FUSIONKIT/i.test(production), false);
});
