import { existsSync, readFileSync } from "node:fs";

const requiredFiles = [
  "README.md",
  "SECURITY.md",
  ".npmrc",
  "pnpm-lock.yaml",
  ".github/workflows/ci.yml",
  ".github/dependabot.yml",
  ".github/CODEOWNERS",
  "spec/2026-06-11-local-first-handoff-platform-spec.md",
  "spec/2026-06-11-governed-agent-execution-plane-spec.md"
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
if (existsSync("src")) {
  fail("implementation is intentionally blocked; src/ should not exist yet");
}

if (process.exitCode) process.exit(process.exitCode);
console.log("repo check passed");
