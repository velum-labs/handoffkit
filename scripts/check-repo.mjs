import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const requiredFiles = [
  "README.md",
  "SECURITY.md",
  ".npmrc",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".github/workflows/ci.yml",
  ".github/dependabot.yml",
  ".github/CODEOWNERS",
  "spec/2026-06-11-local-first-handoff-platform-spec.md",
  "spec/2026-06-11-governed-agent-execution-plane-spec.md",
  "tsconfig.json",
  "tsconfig.base.json",
  "Dockerfile",
  "docker-compose.yml",
  // package entry points
  "packages/protocol/src/index.ts",
  "packages/protocol/src/types.ts",
  "packages/protocol/src/api.ts",
  "packages/protocol/src/receipt.ts",
  "packages/workspace/src/index.ts",
  "packages/sdk/src/index.ts",
  "packages/plane/src/plane.ts",
  "packages/plane/ui/index.html",
  "packages/plane/ui/app.css",
  "packages/plane/ui/app.js",
  "packages/runner/src/runner.ts",
  "packages/handoff/src/handoff.ts",
  "packages/handoff/src/triggers.ts",
  "packages/adapter-ai-sdk/src/remote-tools.ts",
  "packages/adapter-ai-sdk/src/model.ts",
  "packages/adapter-compute/src/sandbox.ts",
  "packages/testkit/src/index.ts",
  "packages/cli/src/index.ts",
  "examples/demos/src/run.ts",
  // test suites
  "packages/protocol/src/test/protocol.test.ts",
  "packages/workspace/src/test/workspace.test.ts",
  "packages/plane/src/test/policy.test.ts",
  "packages/plane/src/test/api.test.ts",
  "packages/handoff/src/test/plan.test.ts",
  "packages/adapter-ai-sdk/src/test/remote-tools.test.ts",
  "packages/adapter-compute/src/test/sandbox.test.ts",
  "packages/cli/src/test/e2e.test.ts",
  "packages/cli/src/test/handoff.test.ts",
  "packages/cli/src/test/cli.test.ts",
  "examples/demos/src/test/demos.test.ts"
];

const fail = (message) => {
  console.error(`check failed: ${message}`);
  process.exitCode = 1;
};

for (const file of requiredFiles) {
  if (!existsSync(file)) fail(`missing ${file}`);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.private !== true) fail("package.json must remain private");
if (!/^pnpm@\d+\.\d+\.\d+$/.test(pkg.packageManager ?? "")) {
  fail("packageManager must pin a concrete pnpm version");
}
if (pkg.scripts?.check !== "node scripts/check-repo.mjs") {
  fail("check script must run scripts/check-repo.mjs");
}

const npmrc = readFileSync(".npmrc", "utf8");
for (const setting of [
  "engine-strict=true",
  "package-manager-strict=true",
  "strict-peer-dependencies=true",
  "ignore-scripts=true",
  "verify-store-integrity=true"
]) {
  if (!npmrc.includes(setting)) fail(`.npmrc missing ${setting}`);
}

const supersededSpec = readFileSync(
  "spec/2026-06-11-local-first-handoff-platform-spec.md",
  "utf8"
);
if (!supersededSpec.includes("The coordination layer for hybrid distributed AI compute.")) {
  fail("superseded spec does not contain its original positioning");
}

const currentSpec = readFileSync(
  "spec/2026-06-11-governed-agent-execution-plane-spec.md",
  "utf8"
);
if (!currentSpec.includes("The governed execution and provenance plane for AI agents.")) {
  fail("current spec does not contain current positioning");
}
if (!currentSpec.includes("Supersedes:")) {
  fail("current spec must declare what it supersedes");
}

// Dependency policy: third-party dependencies are allowed, but only trusted,
// exact-pinned versions reviewed onto this allowlist, and only in adapter and
// example packages. The trust-critical kernel — protocol, workspace, sdk,
// plane, runner, handoff, cli — stays on Node built-ins so receipts remain
// verifiable without trusting anyone's dependency tree. The lockfile is
// installed frozen in CI with scripts ignored, store integrity verified, and
// a minimum release age enforced (see .npmrc).
const TRUSTED_THIRD_PARTY = new Map([
  ["@ai-sdk/provider", "3.0.10"],
  ["ai", "6.0.200"],
  ["zod", "4.4.3"]
]);
const THIRD_PARTY_ALLOWED_IN = new Set([
  "packages/adapter-ai-sdk",
  "examples/demos"
]);

if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
  fail("root runtime dependencies are not allowed");
}
const workspaceDirs = [
  ...readdirSync("packages").map((dir) => join("packages", dir)),
  ...readdirSync("examples").map((dir) => join("examples", dir))
];
for (const dir of workspaceDirs) {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.private !== true) fail(`${manifestPath} must remain private`);
  for (const [section, deps] of [
    ["dependencies", manifest.dependencies ?? {}],
    ["devDependencies", manifest.devDependencies ?? {}]
  ]) {
    for (const [name, version] of Object.entries(deps)) {
      if (name.startsWith("@warrant/")) {
        if (version !== "workspace:*") {
          fail(`${manifestPath} ${section} "${name}": internal packages must use workspace:*`);
        }
        continue;
      }
      if (!THIRD_PARTY_ALLOWED_IN.has(dir.replaceAll("\\", "/"))) {
        fail(
          `${manifestPath} ${section} "${name}": third-party dependencies are not allowed in this package (kernel packages use Node built-ins only)`
        );
      }
      const trusted = TRUSTED_THIRD_PARTY.get(name);
      if (trusted === undefined) {
        fail(
          `${manifestPath} ${section} "${name}": not on the trusted dependency allowlist in scripts/check-repo.mjs`
        );
      } else if (version !== trusted) {
        fail(
          `${manifestPath} ${section} "${name}": version "${version}" must be the exact trusted pin "${trusted}"`
        );
      }
    }
  }
}

// Build artifacts must never be tracked: a committed .tsbuildinfo makes
// `tsc -b` skip emit on fresh clones, which breaks `pnpm build` from scratch.
const tracked = spawnSync(
  "git",
  ["ls-files", "*.tsbuildinfo", "**/dist/**"],
  { encoding: "utf8" }
);
if (tracked.status === 0) {
  for (const file of tracked.stdout.split("\n").filter((line) => line.length > 0)) {
    fail(`build artifact is tracked in git: ${file}`);
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log("repo check passed");
