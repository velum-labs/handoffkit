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
import { claudeInstallTarget } from "../commands/install.js";

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
  assert.deepEqual(
    command(program, "claude").commands.map((entry) => entry.name()).sort(),
    ["install", "uninstall"]
  );
  assert.deepEqual(command(program, "cursor").commands, []);
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

test("config help describes import-only singleton policy", () => {
  const program = buildProgram();
  const globalConfig = program.options.find((option) => option.long === "--config");
  assert.ok(globalConfig);
  assert.match(
    globalConfig.description,
    /doctor and migration recovery only/
  );

  const config = command(program, "config");
  const init = config.commands.find((entry) => entry.name() === "init");
  const edit = config.commands.find((entry) => entry.name() === "edit");
  const importCommand = config.commands.find((entry) => entry.name() === "import");
  assert.ok(init);
  assert.ok(edit);
  assert.ok(importCommand);
  assert.equal(
    init.options.find((option) => option.long === "--global")?.hidden,
    true
  );
  assert.equal(
    edit.options.find((option) => option.long === "--global")?.hidden,
    true
  );
  assert.match(importCommand.description(), /replace the canonical singleton config/);
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
  assert.ok(completionCandidates(program, ["claude", "in"]).includes("install"));
  assert.ok(
    completionCandidates(program, ["start", "--p"]).includes("--port")
  );
  assert.deepEqual(completionCandidates(program, ["accounts", "remove", ""]), [
    "claude",
    "claude-code",
    "codex"
  ]);
  assert.deepEqual(completionCandidates(program, ["accounts", "login", "a"]), []);
  assert.deepEqual(completionCandidates(program, ["accounts", "add", ""]), [
    "claude",
    "claude-code",
    "codex"
  ]);
});

test("Claude gateway overrides never reuse the local daemon token", () => {
  const prepared = {
    preparedGatewayUrl: "http://127.0.0.1:8080/",
    preparedAuthToken: "local-daemon-secret"
  };
  assert.deepEqual(claudeInstallTarget(prepared), {
    gatewayUrl: "http://127.0.0.1:8080",
    authToken: "local-daemon-secret"
  });
  assert.throws(
    () =>
      claudeInstallTarget({
        ...prepared,
        gatewayUrl: "https://external.example"
      }),
    /requires --auth-token-env/
  );
  assert.throws(
    () =>
      claudeInstallTarget({
        ...prepared,
        gatewayUrl: "http://external.example",
        authTokenEnv: "EXTERNAL_TOKEN",
        env: { EXTERNAL_TOKEN: "external-secret" }
      }),
    /require HTTPS/
  );
  assert.deepEqual(
    claudeInstallTarget({
      ...prepared,
      gatewayUrl: "https://external.example/",
      authTokenEnv: "EXTERNAL_TOKEN",
      env: { EXTERNAL_TOKEN: "external-secret" }
    }),
    {
      gatewayUrl: "https://external.example",
      authToken: "external-secret"
    }
  );
  assert.throws(
    () =>
      claudeInstallTarget({
        ...prepared,
        gatewayUrl: "http://127.0.0.1:9090",
        authTokenEnv: "MISSING_TOKEN",
        env: {}
      }),
    /credential environment variable is not set/
  );
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
    // Retained internal connector state never leaks into public completion.
    assert.deepEqual(
      completionCandidates(buildProgram(), [
        "accounts",
        "remove",
        "antigravity",
        "a"
      ]),
      []
    );
    assert.deepEqual(
      completionCandidates(buildProgram(), ["accounts", "remove", "gemini", "a"]),
      []
    );
    assert.deepEqual(
      completionCandidates(buildProgram(), ["accounts", "remove", "mystery", "m"]),
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
