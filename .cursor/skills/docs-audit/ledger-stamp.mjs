#!/usr/bin/env node
/**
 * ledger-stamp: record that pages were verified against the current state.
 *
 * Usage:
 *   node ledger-stamp.mjs <page...> [--commit <sha>] [--date <ISO-8601>]
 *   node ledger-stamp.mjs <page> --dep <path> [--dep <path>...]  # rewrite deps
 *   node ledger-stamp.mjs --add <page> [--dep <path>...]
 *   node ledger-stamp.mjs --remove <page>
 *
 * For each page, records the git object hash of the page itself (from the
 * intended final tree, so it is safe — and intended — to stamp before
 * committing your doc edits. Dependencies changed in the working tree are
 * hashed there too; unchanged dependencies come from HEAD (or --commit).
 * --dep
 * with a single existing page replaces its dependsOn (the dead-dep repair
 * path); --remove drops a page whose file was deleted. Always writes the
 * ledger with sorted page keys and stable formatting so diffs stay
 * reviewable.
 *
 * Stamping a page asserts a human-meaningful fact: the page was verified
 * against the recorded source state. Never stamp a page that was not actually
 * verified — a mis-stamped page silently escapes future audits until the
 * rotation catches it.
 *
 * Boundary rule: this helper touches ledger state and git plumbing only. It
 * never reads documentation content (hashing bytes is not reading) and
 * encodes nothing about what any doc should say.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ledgerPath = join(here, "ledger.json");
const repoRoot = join(here, "..", "..", "..");

function fail(message) {
  console.error(`ledger-stamp: ${message}`);
  process.exit(1);
}

function git(args, env = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    cwd: repoRoot,
    env: { ...process.env, ...env }
  });
  return {
    status: result.status,
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim()
  };
}

const args = process.argv.slice(2);
const pages = [];
let commit = "HEAD";
let date = new Date().toISOString();
let addPage = null;
let removePage = null;
let deps = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--commit") commit = args[++i] ?? fail("--commit needs a value");
  else if (arg === "--date") date = args[++i] ?? fail("--date needs a value");
  else if (arg === "--add") addPage = args[++i] ?? fail("--add needs a page path");
  else if (arg === "--remove") removePage = args[++i] ?? fail("--remove needs a page path");
  else if (arg === "--dep") {
    deps ??= [];
    deps.push(args[++i] ?? fail("--dep needs a path"));
  }
  else if (arg.startsWith("--")) fail(`unknown option ${arg}`);
  else pages.push(arg);
}

if (Number.isNaN(Date.parse(date))) fail(`--date must be an ISO date/time, got ${date}`);
date = new Date(date).toISOString();
if (pages.length === 0 && addPage === null && removePage === null) {
  fail("nothing to do: pass page paths, --add, or --remove");
}
if (addPage !== null && removePage !== null) fail("--add and --remove are mutually exclusive");
if (removePage !== null && (pages.length > 0 || deps !== null)) {
  fail("--remove cannot be combined with page stamping or --dep");
}
if (deps !== null && addPage === null && pages.length !== 1) {
  fail("--dep rewrites one page's dependsOn: pass exactly one page (or use --add)");
}
if (!git(["rev-parse", "--verify", `${commit}^{commit}`]).ok) fail(`cannot resolve commit ${commit}`);

function finalTreeHashes(page, dependsOn) {
  const tempDirectory = mkdtempSync(join(tmpdir(), "docs-ledger-"));
  const indexPath = join(tempDirectory, "index");
  const indexEnv = { GIT_INDEX_FILE: indexPath };
  try {
    const readTree = git(["read-tree", "HEAD"], indexEnv);
    if (!readTree.ok) fail(`cannot initialize temporary index: ${readTree.stderr}`);
    const add = git(["add", "-A", "--", page, ...dependsOn], indexEnv);
    if (!add.ok) fail(`${page}: cannot stage intended final paths: ${add.stderr}`);
    const tree = git(["write-tree"], indexEnv);
    if (!tree.ok) fail(`${page}: cannot write intended final tree: ${tree.stderr}`);

    const hashes = {};
    for (const path of [page, ...dependsOn]) {
      const workingDiff = git(["diff", "--quiet", "HEAD", "--", path]);
      const untracked = git(["ls-files", "--others", "--exclude-standard", "--", path]);
      if (![0, 1].includes(workingDiff.status) || !untracked.ok) {
        fail(`${page}: cannot inspect working-tree state for ${path}`);
      }
      const useFinalTree = path === page || workingDiff.status === 1 || untracked.stdout !== "";
      const source = useFinalTree ? tree.stdout : commit;
      const result = git(["rev-parse", `${source}:${path}`]);
      if (!result.ok) {
        fail(`${page}: ${path} does not exist in the intended final tree; fix dependsOn first`);
      }
      hashes[path] = result.stdout;
    }
    return hashes;
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
if (ledger.version !== 1 || typeof ledger.pages !== "object" || ledger.pages === null) {
  fail("ledger.json must have version: 1 and a pages object");
}
const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function validRepoPath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\0") &&
    !path.split("/").includes("..")
  );
}

function validatePaths(page, dependsOn) {
  if (!validRepoPath(page)) fail(`invalid page path ${JSON.stringify(page)}`);
  if (new Set(dependsOn).size !== dependsOn.length) fail(`${page}: duplicate --dep`);
  for (const dep of dependsOn) {
    if (!validRepoPath(dep)) fail(`${page}: invalid dependency path ${JSON.stringify(dep)}`);
    if (dep === page || page.startsWith(`${dep}/`)) {
      fail(`${page}: dependency ${dep} contains the page itself; use narrower source paths`);
    }
  }
}

function validateEntry(page, entry) {
  if (!entry || !Array.isArray(entry.dependsOn) || !entry.verified) {
    fail(`${page}: entry must have dependsOn[] and verified{}`);
  }
  validatePaths(page, entry.dependsOn);
  const expected = new Set([page, ...entry.dependsOn]);
  const actual = Object.keys(entry.verified);
  if (actual.length !== expected.size || actual.some((path) => !expected.has(path))) {
    fail(`${page}: verified keys must equal the page plus dependsOn paths`);
  }
  for (const [path, hash] of Object.entries(entry.verified)) {
    if (!objectIdPattern.test(hash)) fail(`${page}: invalid object id for ${path}`);
  }
  if (Number.isNaN(Date.parse(entry.verifiedAt))) fail(`${page}: invalid verifiedAt`);
}

for (const [page, entry] of Object.entries(ledger.pages)) validateEntry(page, entry);

function stamp(page, dependsOn) {
  validatePaths(page, dependsOn);
  const verified = finalTreeHashes(page, dependsOn);
  ledger.pages[page] = { dependsOn, verified, verifiedAt: date };
}

if (removePage !== null) {
  if (!ledger.pages[removePage]) fail(`${removePage} has no ledger entry to remove`);
  delete ledger.pages[removePage];
}

if (addPage !== null) {
  // No --dep means a self-only page.
  if (ledger.pages[addPage]) fail(`${addPage} already has a ledger entry; stamp it instead`);
  stamp(addPage, deps ?? []);
}

for (const page of pages) {
  const entry = ledger.pages[page];
  if (!entry) fail(`${page} has no ledger entry; use --add with --dep to create one`);
  stamp(page, addPage === null && deps !== null ? deps : entry.dependsOn);
}

ledger.pages = Object.fromEntries(
  Object.entries(ledger.pages).sort(([a], [b]) => a.localeCompare(b))
);

writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
const touched = [...pages, ...(addPage === null ? [] : [addPage]), ...(removePage === null ? [] : [removePage])];
console.log(`updated ${touched.length} page(s) (${date})`);
