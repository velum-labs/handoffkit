import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// A deliberately curated manifest of files that must exist for the repo to
// be considered intact (specs, entry points, test suites, deploy assets).
// It is maintained by hand on purpose: adding a load-bearing file to this
// list is part of reviewing the change that introduces it.
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
  // uv workspace (the Python monorepo side)
  "pyproject.toml",
  "uv.lock",
  "python/uniroute/pyproject.toml",
  "python/uniroute/src/uniroute/__init__.py",
  "python/uniroute/tests/test_end_to_end.py",
  "python/uniroute-mlx/pyproject.toml",
  "python/uniroute-mlx/src/uniroute_mlx/card.py",
  "python/uniroute-mlx/tests/test_cli_end_to_end.py",
  "packages/adapter-ai-sdk/src/routed-model.ts",
  "packages/adapter-ai-sdk/src/test/routed-model.test.ts",
  // package entry points
  "packages/protocol/src/index.ts",
  "packages/protocol/src/types.ts",
  "packages/protocol/src/api.ts",
  "packages/protocol/src/model-fusion.ts",
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
  "packages/adapter-ai-sdk/src/swarm-tools.ts",
  "packages/adapter-ai-sdk/src/model.ts",
  "packages/adapter-ai-sdk/src/mlx-env.ts",
  "packages/adapter-ai-sdk/src/managed-server.ts",
  "packages/adapter-compute/src/sandbox.ts",
  "packages/runner/src/backend.ts",
  "packages/session-hermetic/src/index.ts",
  "packages/session-vercel-sandbox/src/index.ts",
  "packages/session-harness/src/index.ts",
  "packages/session-harness/src/auth.ts",
  "packages/ensemble/src/index.ts",
  "packages/ensemble/src/harness.ts",
  "packages/ensemble/src/run.ts",
  "packages/ensemble/src/artifacts.ts",
  "packages/ensemble/src/worktree.ts",
  "packages/ensemble/src/mock.ts",
  "packages/ensemble/src/command.ts",
  "packages/testkit/src/index.ts",
  "packages/cli/src/index.ts",
  "packages/example-utils/src/index.ts",
  "packages/example-utils/src/narrate.ts",
  "packages/example-utils/src/models.ts",
  "scripts/demo.mjs",
  "examples/manifest.json",
  "packages/example-utils/src/manifest.ts",
  "examples/seed/src/index.ts",
  // test suites
  "packages/protocol/src/test/protocol.test.ts",
  "packages/protocol/src/test/model-fusion.test.ts",
  "packages/protocol/src/fixtures/model-fusion-contract/artifact-ref.v1/minimal.json",
  "packages/protocol/src/fixtures/model-fusion-contract/artifact-ref.v1/realistic.json",
  "packages/protocol/src/fixtures/model-fusion-contract/benchmark-task-record.v1/minimal.json",
  "packages/protocol/src/fixtures/model-fusion-contract/benchmark-task-record.v1/realistic.json",
  "packages/protocol/src/fixtures/model-fusion-contract/ensemble-receipt.v1/minimal.json",
  "packages/protocol/src/fixtures/model-fusion-contract/ensemble-receipt.v1/realistic.json",
  "packages/protocol/src/fixtures/model-fusion-contract/harness-candidate-record.v1/minimal.json",
  "packages/protocol/src/fixtures/model-fusion-contract/harness-candidate-record.v1/realistic.json",
  "packages/protocol/src/fixtures/model-fusion-contract/harness-run-request.v1/minimal.json",
  "packages/protocol/src/fixtures/model-fusion-contract/harness-run-request.v1/realistic.json",
  "packages/protocol/src/fixtures/model-fusion-contract/harness-run-result.v1/minimal.json",
  "packages/protocol/src/fixtures/model-fusion-contract/harness-run-result.v1/realistic.json",
  "packages/protocol/src/fixtures/model-fusion-contract/judge-synthesis-record.v1/minimal.json",
  "packages/protocol/src/fixtures/model-fusion-contract/judge-synthesis-record.v1/realistic.json",
  "packages/protocol/src/fixtures/model-fusion-contract/model-call-record.v1/minimal.json",
  "packages/protocol/src/fixtures/model-fusion-contract/model-call-record.v1/realistic.json",
  "packages/protocol/src/fixtures/model-fusion-contract/tool-call-plan.v1/minimal.json",
  "packages/protocol/src/fixtures/model-fusion-contract/tool-call-plan.v1/realistic.json",
  "packages/protocol/src/fixtures/model-fusion-contract/tool-execution-record.v1/minimal.json",
  "packages/protocol/src/fixtures/model-fusion-contract/tool-execution-record.v1/realistic.json",
  "packages/workspace/src/test/workspace.test.ts",
  "packages/plane/src/test/policy.test.ts",
  "packages/plane/src/test/api.test.ts",
  "packages/plane/src/test/hardening.test.ts",
  "packages/plane/src/test/server-hardening.test.ts",
  "packages/plane/src/sqlite-store.ts",
  "packages/plane/src/keys.ts",
  "packages/plane/src/auth.ts",
  "packages/plane/src/validation.ts",
  "packages/plane/src/ratelimit.ts",
  "packages/plane/src/retention.ts",
  "packages/handoff/src/test/plan.test.ts",
  "packages/adapter-ai-sdk/src/test/remote-tools.test.ts",
  "packages/adapter-ai-sdk/src/test/swarm-tools.test.ts",
  "packages/session-harness/src/pi.ts",
  "packages/session-harness/src/test/pi.test.ts",
  "packages/adapter-ai-sdk/src/test/mlx-env.test.ts",
  "packages/adapter-ai-sdk/src/test/managed-server.test.ts",
  "packages/adapter-compute/src/test/sandbox.test.ts",
  "packages/session-hermetic/src/test/hermetic.test.ts",
  "packages/session-harness/src/test/harness.test.ts",
  "packages/ensemble/src/test/ensemble.test.ts",
  "packages/cli/src/test/e2e.test.ts",
  "packages/cli/src/test/handoff.test.ts",
  "packages/cli/src/test/cli.test.ts",
  "test/demos.test.js",
  "examples/mlx/src/test/run.test.ts"
];

const fail = (message) => {
  console.error(`check failed: ${message}`);
  process.exitCode = 1;
};

// Every example the manifest declares (demos and infra projects alike) must
// have its entry point; the manifest is the single source the demo
// dispatcher, the acceptance suite, and this check all read.
const manifest = JSON.parse(readFileSync("examples/manifest.json", "utf8"));
for (const entry of [...manifest.demos, ...manifest.infra]) {
  requiredFiles.push(`examples/${entry.directory}/src/run.ts`);
}

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

// The positioning sentences are part of each spec's identity; an exact
// substring assertion is the intended check (any rewording should be a
// conscious decision that also updates this guard).
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

// Dependency policy: third-party dependencies are allowed in any workspace
// package, but only trusted, exact-pinned versions reviewed onto this
// allowlist. There is no "kernel must be zero-dependency" rule: trust comes
// from pinning known-good versions and from the supply-chain controls in
// .npmrc (frozen lockfile, ignore-scripts, verify-store-integrity, a minimum
// release age), not from the absence of dependencies. The protocol/sdk
// packages still happen to use only Node built-ins, which keeps the offline
// verifier maximally auditable, but that is now a property, not a gate.
//
// Every third-party version must be pinned exactly (no ranges) and listed
// here. Bumping a dependency means updating this allowlist, which is the
// review checkpoint.
const TRUSTED_THIRD_PARTY = new Map([
  // The @ai-sdk/harness* packages are experimental canary releases (the AI
  // SDK 7 harness abstraction); they are pinned exactly like every other
  // dependency and bumped only as reviewed allowlist changes.
  ["@ai-sdk/harness", "1.0.0-canary.6"],
  ["@ai-sdk/harness-claude-code", "1.0.0-canary.2"],
  ["@ai-sdk/harness-pi", "1.0.0-canary.2"],
  ["@ai-sdk/openai-compatible", "2.0.48"],
  ["@ai-sdk/provider", "3.0.10"],
  ["@ai-sdk/sandbox-just-bash", "1.0.0-canary.6"],
  ["@ai-sdk/sandbox-vercel", "1.0.0-canary.6"],
  ["@ai-sdk/tui", "1.0.0-canary.6"],
  ["@types/node", "22.19.20"],
  ["@vercel/sandbox", "2.2.0"],
  ["ai", "6.0.200"],
  ["jose", "6.2.3"],
  ["just-bash", "3.0.1"],
  ["minimatch", "10.2.5"],
  ["ms", "2.1.3"],
  ["pino", "10.3.1"],
  ["typescript", "5.9.3"],
  ["ws", "8.21.0"],
  ["zod", "4.4.3"]
]);

function checkDeps(manifestPath, manifest) {
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

// Root manifest may carry only allowlisted, exact-pinned dev tooling.
checkDeps("package.json", pkg);

const workspaceDirs = [
  ...readdirSync("packages").map((dir) => join("packages", dir)),
  ...readdirSync("examples").map((dir) => join("examples", dir))
];
for (const dir of workspaceDirs) {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.private !== true) fail(`${manifestPath} must remain private`);
  checkDeps(manifestPath, manifest);
}

// No deferred-work markers in tracked sources: anything worth flagging is
// either fixed or documented as a deliberate decision. The pattern is
// assembled from parts so this guard does not match itself.
const todoMarker = new RegExp(`TODO${"\\("}(hardcoded|brittle|lib)${"\\)"}`);
const sourceListing = spawnSync(
  "git",
  ["ls-files", "*.ts", "*.mjs", "*.js", "*.yml", "*.yaml", "Dockerfile", "*.md"],
  { encoding: "utf8" }
);
if (sourceListing.status === 0) {
  for (const file of sourceListing.stdout.split("\n").filter((l) => l.length > 0)) {
    if (file === "scripts/check-repo.mjs") continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (todoMarker.test(lines[i])) {
        fail(`deferred-work marker in ${file}:${i + 1} — fix it or document the decision`);
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
