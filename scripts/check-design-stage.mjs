import { existsSync, readFileSync } from "node:fs";

const requiredFiles = [
  "README.md",
  "package.json",
  "pnpm-lock.yaml",
  "spec/2026-06-11-local-first-handoff-platform-spec.md",
];

const forbiddenImplementationPaths = ["src", "lib", "packages", "apps"];
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const fail = (message) => {
  console.error(message);
  process.exitCode = 1;
};

for (const path of requiredFiles) {
  if (!existsSync(path)) {
    fail(`Missing required repository artifact: ${path}`);
  }
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

if (packageJson.private !== true) {
  fail("package.json must remain private for the design-stage package.");
}

if (packageJson.packageManager !== "pnpm@10.33.3") {
  fail("package.json must pin packageManager to pnpm@10.33.3.");
}

if (packageJson.scripts?.check !== "node scripts/check-design-stage.mjs") {
  fail("package.json scripts.check must run the design-stage verification.");
}

for (const field of dependencyFields) {
  const entries = Object.keys(packageJson[field] ?? {});

  if (entries.length > 0) {
    fail(`Design-stage repo should not declare ${field}: ${entries.join(", ")}`);
  }
}

for (const path of forbiddenImplementationPaths) {
  if (existsSync(path)) {
    fail(`Implementation remains blocked; remove unexpected ${path}/ directory.`);
  }
}

const spec = readFileSync(
  "spec/2026-06-11-local-first-handoff-platform-spec.md",
  "utf8",
);

if (!spec.includes("Status: Draft")) {
  fail("Spec must preserve its Draft status marker.");
}

if (!spec.includes("Treat implementation as blocked")) {
  fail("Spec must preserve the implementation-blocked design note.");
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log("Design-stage repository checks passed.");
