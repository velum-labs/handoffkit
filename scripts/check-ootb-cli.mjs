// OOTB shape smoke for the published `fusionkit` CLI. Guards the bits a global
// install depends on — the bin name, the top-level command surface, the
// packaged files, and that preflight fails loudly with actionable guidance —
// without needing a real npm publish. Run after `pnpm build`.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CLI = "packages/cli/dist/index.js";

const fail = (message) => {
  console.error(`ootb cli check failed: ${message}`);
  process.exitCode = 1;
};

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

// 1) Help surface: the bin self-identifies and lists the launch commands.
const help = runCli(["--help"]);
if (help.status !== 0) fail(`\`fusionkit --help\` exited ${help.status}`);
for (const token of ["fusionkit", "codex", "claude", "cursor", "serve", "fusion"]) {
  if (!help.stdout.includes(token)) fail(`help output is missing "${token}"`);
}

// 2) Preflight fails loudly when prerequisites are absent. PATH is reduced so
// uvx/codex resolve as "missing"; node still runs via its absolute path. The
// repo root is a git repository, so we exercise the preflight path (not the
// "not a git repo" path).
const preflight = runCli(["codex"], {
  PATH: "/usr/bin:/bin",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: ""
});
if (preflight.status === 0) fail("`fusionkit codex` unexpectedly succeeded with no prerequisites");
const preflightOutput = `${preflight.stdout}${preflight.stderr}`;
if (!preflightOutput.includes("preflight failed")) {
  fail(`expected a preflight failure, got:\n${preflightOutput}`);
}

// 3) Packaged shape: the published name, bin, and files a global install needs.
const pkg = JSON.parse(readFileSync("packages/cli/package.json", "utf8"));
if (pkg.name !== "@fusionkit/cli") fail(`cli package name must be "@fusionkit/cli", got "${pkg.name}"`);
if (pkg.bin?.fusionkit !== "./dist/index.js") fail("cli bin must expose `fusionkit -> ./dist/index.js`");
if (!Array.isArray(pkg.files) || !pkg.files.includes("dist")) fail("cli must publish its dist directory");
if (pkg.private !== false) fail("cli must be publishable (private:false)");

if (process.exitCode) process.exit(process.exitCode);
console.log("ootb cli check passed");
