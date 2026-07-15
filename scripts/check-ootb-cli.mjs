// OOTB shape smoke for the published RouteKit and FusionKit CLIs. Guards bin
// names, ownership boundaries, top-level command surfaces, packaged files, and
// actionable Fusion preflight behavior without needing a real npm publish.
// Run after `pnpm build`.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FUSION_CLI = "packages/cli/dist/index.js";
const ROUTE_CLI = "packages/routekit-cli/dist/index.js";

const fail = (message) => {
  console.error(`ootb cli check failed: ${message}`);
  process.exitCode = 1;
};

function runCli(cli, args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

function helpHasCommand(output, command) {
  return new RegExp(`^  ${command}(?:[ <\\[]|$)`, "m").test(output);
}

// 1) FusionKit owns ensemble launch and Fusion lifecycle commands only.
const fusionHelp = runCli(FUSION_CLI, ["--help"]);
if (fusionHelp.status !== 0) fail(`\`fusionkit --help\` exited ${fusionHelp.status}`);
if (!fusionHelp.stdout.startsWith("Usage: fusionkit ")) {
  fail("FusionKit help does not identify the fusionkit executable");
}
for (const command of [
  "codex",
  "claude",
  "cursor",
  "opencode",
  "serve",
  "init",
  "setup",
  "doctor",
  "config",
  "prompts",
  "sessions",
  "models",
  "ensemble",
  "telemetry",
  "version",
  "stop",
  "completion"
]) {
  if (!helpHasCommand(fusionHelp.stdout, command)) {
    fail(`FusionKit help is missing command "${command}"`);
  }
}
for (const retired of ["proxy", "install", "uninstall"]) {
  if (helpHasCommand(fusionHelp.stdout, retired)) {
    fail(`FusionKit help unexpectedly includes RouteKit-owned surface "${retired}"`);
  }
}
for (const tool of ["codex", "claude", "cursor", "opencode"]) {
  const launchHelp = runCli(FUSION_CLI, [tool, "--help"]);
  if (launchHelp.status !== 0) fail(`\`fusionkit ${tool} --help\` exited ${launchHelp.status}`);
  for (const retiredFlag of [
    "--direct",
    "--model",
    "--provider",
    "--api-key",
    "--judge-model",
    "--reasoning-model"
  ]) {
    if (new RegExp(`^\\s+${retiredFlag}(?:[ <]|$)`, "m").test(launchHelp.stdout)) {
      fail(`FusionKit ${tool} help unexpectedly includes retired flag "${retiredFlag}"`);
    }
  }
}

// 2) RouteKit independently owns router, endpoint, account, and direct tool
// launch surfaces without exposing Fusion lifecycle commands.
const routeHelp = runCli(ROUTE_CLI, ["--help"]);
if (routeHelp.status !== 0) fail(`\`routekit --help\` exited ${routeHelp.status}`);
if (!routeHelp.stdout.startsWith("Usage: routekit ")) {
  fail("RouteKit help does not identify the routekit executable");
}
for (const command of [
  "serve",
  "codex",
  "claude",
  "cursor",
  "opencode",
  "accounts",
  "endpoints",
  "models",
  "config",
  "doctor",
  "install",
  "uninstall",
  "telemetry",
  "version",
  "stop",
  "completion"
]) {
  if (!helpHasCommand(routeHelp.stdout, command)) {
    fail(`RouteKit help is missing command "${command}"`);
  }
}
for (const fusionOnly of ["setup", "prompts", "sessions", "ensemble"]) {
  if (helpHasCommand(routeHelp.stdout, fusionOnly)) {
    fail(`RouteKit help unexpectedly includes Fusion-owned surface "${fusionOnly}"`);
  }
}

// 3) Fusion preflight fails loudly when prerequisites are absent. PATH is reduced so
// uvx/codex resolve as "missing"; node still runs via its absolute path. The
// repo root is a git repository, so we exercise the preflight path (not the
// "not a git repo" path).
const preflight = runCli(FUSION_CLI, ["codex"], {
  PATH: "/usr/bin:/bin"
});
if (preflight.status === 0) fail("`fusionkit codex` unexpectedly succeeded with no prerequisites");
const preflightOutput = `${preflight.stdout}${preflight.stderr}`;
if (
  !preflightOutput.includes("preflight failed") &&
  !preflightOutput.includes("local MLX models need Apple Silicon") &&
  !preflightOutput.includes("synthesis sidecar failed to start")
) {
  fail(`expected a preflight failure, got:\n${preflightOutput}`);
}

// 4) Packaged shape: both published names, bins, and global-install files.
for (const expected of [
  {
    path: "packages/cli/package.json",
    name: "@fusionkit/cli",
    binary: "fusionkit"
  },
  {
    path: "packages/routekit-cli/package.json",
    name: "@routekit/cli",
    binary: "routekit"
  }
]) {
  const pkg = JSON.parse(readFileSync(expected.path, "utf8"));
  if (pkg.name !== expected.name) {
    fail(`${expected.path} name must be "${expected.name}", got "${pkg.name}"`);
  }
  if (pkg.bin?.[expected.binary] !== "./dist/index.js") {
    fail(`${expected.name} must expose \`${expected.binary} -> ./dist/index.js\``);
  }
  if (!Array.isArray(pkg.files) || !pkg.files.includes("dist")) {
    fail(`${expected.name} must publish its dist directory`);
  }
  if (!pkg.files.includes("LICENSE")) fail(`${expected.name} must publish LICENSE`);
  if (pkg.private !== false) fail(`${expected.name} must be publishable (private:false)`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log("ootb cli check passed");
