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
  "packages/testkit/src/index.ts",
  "packages/cli/src/index.ts",
  "examples/demos/src/run.ts",
  // test suites
  "packages/protocol/src/test/protocol.test.ts",
  "packages/workspace/src/test/workspace.test.ts",
  "packages/plane/src/test/policy.test.ts",
  "packages/plane/src/test/api.test.ts",
  "packages/handoff/src/test/plan.test.ts",
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

// The kernel has zero third-party runtime dependencies by design: the
// protocol must remain verifiable with nothing but Node built-ins. Every
// workspace package may depend only on sibling workspace packages.
if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
  fail("root runtime dependencies are not allowed; the kernel uses Node built-ins only");
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
      if (!name.startsWith("@warrant/") || version !== "workspace:*") {
        fail(
          `${manifestPath} ${section} entry "${name}": only @warrant/* workspace:* dependencies are allowed`
        );
      }
    }
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log("repo check passed");
