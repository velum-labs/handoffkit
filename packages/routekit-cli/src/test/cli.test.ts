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
    "daemon",
    "start",
    "stop",
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
    "telemetry",
    "completion",
    "__complete",
    "version"
  ];
  assert.deepEqual(
    program.commands.map((entry) => entry.name()).sort(),
    expected.sort()
  );
  assert.equal(
    program.commands.some((entry) => entry.name() === "gateway"),
    false
  );
  assert.deepEqual(
    command(program, "daemon").commands.map((entry) => entry.name()).sort(),
    ["auth", "logs", "reload", "restart", "run", "service", "start", "status", "stop", "upgrade"]
  );
  assert.deepEqual(
    command(program, "daemon")
      .commands.find((entry) => entry.name() === "service")
      ?.commands.map((entry) => entry.name())
      .sort(),
    ["install", "status", "uninstall"]
  );
  assert.deepEqual(
    command(program, "codex").commands.map((entry) => entry.name()).sort(),
    ["install", "uninstall"]
  );
  for (const launcher of ["claude", "cursor", "opencode"]) {
    assert.deepEqual(command(program, launcher).commands, []);
  }
  // One connector-neutral account surface: no cliproxy (or other
  // implementation-detail) subtree is exposed.
  assert.deepEqual(
    command(program, "accounts").commands.map((entry) => entry.name()).sort(),
    ["add", "list", "login", "remove", "status"]
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
    ["edit", "import", "init", "migrate", "path", "show"]
  );
  assert.equal(program.commands.some((entry) => entry.aliases().length > 0), false);
});

test("top-level help presents one public RouteKit lifecycle", () => {
  const help = buildProgram().helpInformation();
  assert.match(help, /^\s+start\b/m);
  assert.match(help, /^\s+status\b/m);
  assert.match(help, /^\s+stop\b/m);
  assert.doesNotMatch(help, /^\s+daemon\b/m);
  assert.doesNotMatch(help, /^\s+gateway\b/m);
});

test("dynamic completion follows the command tree", () => {
  const program = buildProgram();
  const topLevel = completionCandidates(program, [""]);
  assert.ok(topLevel.includes("start"));
  assert.ok(topLevel.includes("status"));
  assert.ok(topLevel.includes("stop"));
  assert.equal(topLevel.includes("daemon"), false);
  assert.equal(topLevel.includes("gateway"), false);
  assert.ok(completionCandidates(program, ["co"]).includes("config"));
  assert.deepEqual(completionCandidates(program, ["accounts", "s"]), [
    "status"
  ]);
  assert.ok(completionCandidates(program, ["codex", "in"]).includes("install"));
  assert.ok(
    completionCandidates(program, ["start", "--p"]).includes("--port")
  );
  assert.deepEqual(completionCandidates(program, ["accounts", "remove", ""]), [
    "antigravity",
    "claude",
    "claude-code",
    "codex",
    "gemini",
    "grok",
    "kimi",
    "xai"
  ]);
  assert.deepEqual(completionCandidates(program, ["accounts", "login", "a"]), [
    "antigravity"
  ]);
  assert.deepEqual(completionCandidates(program, ["accounts", "add", ""]), [
    "claude",
    "claude-code",
    "codex"
  ]);
});

test("start CLI documents explicit data-plane authentication", () => {
  const program = buildProgram();
  const start = program.commands.find((entry) => entry.name() === "start");
  assert.ok(start);
  assert.match(start.helpInformation(), /authentication token/);
});

test("account removal completion only suggests managed labels for its provider", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-account-completion-"));
  const previousHome = process.env.ROUTEKIT_HOME;
  mkdirSync(join(root, "subscriptions", "codex"), { recursive: true });
  mkdirSync(join(root, "cliproxy", "auth"), { recursive: true });
  writeFileSync(join(root, "subscriptions", "codex", "work.json"), "{}\n");
  writeFileSync(
    join(root, "cliproxy", "auth", "antigravity-user@example.com.json"),
    JSON.stringify({ type: "antigravity" })
  );
  writeFileSync(
    join(root, "cliproxy", "auth", "mystery-blob.json"),
    "{not-json"
  );
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
    // Aliases resolve to the canonical kind's labels.
    assert.deepEqual(
      completionCandidates(buildProgram(), [
        "accounts",
        "remove",
        "antigravity",
        "a"
      ]),
      ["antigravity-user@example.com"]
    );
    assert.deepEqual(
      completionCandidates(buildProgram(), ["accounts", "remove", "gemini", "a"]),
      ["antigravity-user@example.com"]
    );
    assert.ok(
      completionCandidates(buildProgram(), ["accounts", "remove", "m"]).includes(
        "mystery"
      )
    );
    assert.deepEqual(
      completionCandidates(buildProgram(), ["accounts", "remove", "mystery", "m"]),
      ["mystery-blob"]
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
