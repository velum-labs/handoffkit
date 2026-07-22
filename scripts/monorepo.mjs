#!/usr/bin/env node
// Day-to-day monorepo tooling for handoffkit (distinct from releasing).
//
//   node scripts/monorepo.mjs graph                 # internal @fusionkit/* dep graph + manifest-order check
//   node scripts/monorepo.mjs affected [base]       # Turbo build + test for changed projects and dependents
//   node scripts/monorepo.mjs clean [--all]         # purge stale release-artifacts tarballs
//
// Version-sync / drift is handled by `node scripts/release.mjs plan`; this file
// is purely local developer iteration. Dependency-free Node ESM.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const WORKSPACE_PACKAGE_DIRS = ["packages"];

const log = (msg) => process.stdout.write(`${msg}\n`);
const die = (msg) => {
  process.stderr.write(`monorepo: ${msg}\n`);
  process.exit(1);
};

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { status: res.status, stdout: (res.stdout ?? "").trim(), stderr: (res.stderr ?? "").trim(), ok: res.status === 0 };
}

// Build the internal @fusionkit/* workspace graph: name -> { dir, deps[] }.
function loadGraph() {
  const byName = new Map();
  const dirOf = new Map();
  for (const base of WORKSPACE_PACKAGE_DIRS) {
    const absBase = join(REPO_ROOT, base);
    if (!existsSync(absBase)) continue;
    for (const entry of readdirSync(absBase)) {
      const pkgPath = join(absBase, entry, "package.json");
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (!pkg.name?.startsWith("@fusionkit/")) continue;
      const dir = join(base, entry);
      byName.set(pkg.name, { name: pkg.name, dir, deps: [] });
      dirOf.set(pkg.name, dir);
    }
  }
  for (const node of byName.values()) {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, node.dir, "package.json"), "utf8"));
    for (const section of ["dependencies", "devDependencies"]) {
      for (const dep of Object.keys(pkg[section] ?? {})) {
        if (byName.has(dep)) node.deps.push(dep);
      }
    }
  }
  return byName;
}

function topoSort(byName) {
  const indeg = new Map([...byName.keys()].map((k) => [k, 0]));
  const adj = new Map([...byName.keys()].map((k) => [k, []]));
  for (const node of byName.values()) {
    for (const dep of node.deps) {
      adj.get(dep).push(node.name);
      indeg.set(node.name, indeg.get(node.name) + 1);
    }
  }
  const queue = [...byName.keys()].filter((k) => indeg.get(k) === 0).sort();
  const order = [];
  while (queue.length) {
    queue.sort();
    const name = queue.shift();
    order.push(name);
    for (const next of adj.get(name)) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== byName.size) die("dependency cycle detected among @fusionkit/* packages");
  return order;
}

function cmdGraph() {
  const byName = loadGraph();
  const order = topoSort(byName);
  log("Internal @fusionkit/* dependency graph (topological order):");
  for (const name of order) {
    const node = byName.get(name);
    log(`  ${name.padEnd(34)} <- ${node.deps.join(", ") || "(no internal deps)"}`);
  }

  // The release manifest must publish in an order consistent with the graph:
  // every dependency must be published before the packages that depend on it.
  const manifestPath = join(REPO_ROOT, "release", "npm-packages.json");
  if (!existsSync(manifestPath)) return;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const manifestOrder = (manifest.packages ?? []).map((e) => e.name);
  const pos = new Map(manifestOrder.map((name, i) => [name, i]));
  let violations = 0;
  for (const node of byName.values()) {
    if (!pos.has(node.name)) continue;
    for (const dep of node.deps) {
      if (pos.has(dep) && pos.get(dep) > pos.get(node.name)) {
        violations++;
        log(`  manifest order violation: ${dep} must publish before ${node.name}`);
      }
    }
  }
  log(violations ? `\nFAIL: ${violations} manifest ordering violation(s).` : "\nOK: release manifest order is consistent with the dependency graph.");
  if (violations) process.exit(1);
}

function cmdAffected(args) {
  const base = args.find((a) => !a.startsWith("--")) ?? "origin/main";
  const noBuild = args.includes("--no-build");
  const noTest = args.includes("--no-test");
  const tasks = [];
  if (!noBuild) tasks.push("build");
  if (!noTest) tasks.push("test");
  if (tasks.length === 0) {
    log("Nothing to run: both --no-build and --no-test were supplied.");
    return;
  }

  const filter = `--filter=...[${base}]`;
  const turboArgs = ["pnpm", "exec", "turbo", "run", ...tasks, filter];
  // `--no-build` retains the old helper's meaning: use already-built outputs
  // instead of following the test task's normal build dependency.
  if (noBuild && !noTest) turboArgs.push("--only");

  log(`Running affected ${tasks.join(" + ")} tasks vs ${base} with Turborepo.`);
  const result = run("corepack", turboArgs, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, PORTLESS: "0" }
  });
  if (!result.ok) die("affected Turborepo tasks failed");
  log("\nAffected Turborepo tasks complete.");
}

function cmdClean(args) {
  const all = args.includes("--all");
  const artifactsDir = join(REPO_ROOT, "release-artifacts", "npm");
  if (!existsSync(artifactsDir)) {
    log("Nothing to clean: release-artifacts/npm does not exist.");
    return;
  }
  const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  let removed = 0;
  for (const file of readdirSync(artifactsDir)) {
    if (!file.endsWith(".tgz")) continue;
    const isCurrent = file.includes(`-${root.version}.tgz`);
    if (all || !isCurrent) {
      rmSync(join(artifactsDir, file));
      log(`  removed ${file}`);
      removed++;
    }
  }
  log(removed ? `Removed ${removed} tarball(s).` : `No stale tarballs (root version ${root.version}).`);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "graph":
    cmdGraph();
    break;
  case "affected":
    cmdAffected(rest);
    break;
  case "clean":
    cmdClean(rest);
    break;
  default:
    log("handoffkit monorepo tooling");
    log("");
    log("  node scripts/monorepo.mjs graph             # dep graph + manifest order check");
    log("  node scripts/monorepo.mjs affected [base]   # Turbo build + test for changed projects");
    log("  node scripts/monorepo.mjs clean [--all]     # purge stale release-artifacts tarballs");
}
