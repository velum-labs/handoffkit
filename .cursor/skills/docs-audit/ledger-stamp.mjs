#!/usr/bin/env node
/**
 * ledger-stamp: record that pages were verified against the current state.
 *
 * Usage:
 *   node ledger-stamp.mjs <page...> [--commit <sha>] [--date <YYYY-MM-DD>]
 *   node ledger-stamp.mjs <page> --deps <path,path,...>   # also rewrite dependsOn
 *   node ledger-stamp.mjs --add <page> --deps <path,path,...>
 *   node ledger-stamp.mjs --remove <page>
 *
 * For each page, records the git object hash of the page itself (from the
 * working tree, so it is safe — and intended — to stamp before committing
 * your doc edits; blob hashes are content-addressed and will match HEAD once
 * committed) and of every dependsOn path (from HEAD, or --commit). --deps
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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ledgerPath = join(here, "ledger.json");
const repoRoot = join(here, "..", "..", "..");

function fail(message) {
  console.error(`ledger-stamp: ${message}`);
  process.exit(1);
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", cwd: repoRoot });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim()
  };
}

const args = process.argv.slice(2);
const pages = [];
let commit = "HEAD";
let date = new Date().toISOString().slice(0, 10);
let addPage = null;
let removePage = null;
let deps = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--commit") commit = args[++i] ?? fail("--commit needs a value");
  else if (arg === "--date") date = args[++i] ?? fail("--date needs a value");
  else if (arg === "--add") addPage = args[++i] ?? fail("--add needs a page path");
  else if (arg === "--remove") removePage = args[++i] ?? fail("--remove needs a page path");
  else if (arg === "--deps") deps = args[++i] ?? fail("--deps needs a comma-separated list");
  else if (arg.startsWith("--")) fail(`unknown option ${arg}`);
  else pages.push(arg);
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`--date must be YYYY-MM-DD, got ${date}`);
if (pages.length === 0 && addPage === null && removePage === null) {
  fail("nothing to do: pass page paths, --add, or --remove");
}
if (deps !== null && addPage === null && pages.length !== 1) {
  fail("--deps rewrites one page's dependsOn: pass exactly one page (or use --add)");
}
if (!git(["rev-parse", "--verify", `${commit}^{commit}`]).ok) fail(`cannot resolve commit ${commit}`);

/** Blob hash of the page as it sits in the working tree right now. */
function workingTreeHash(page) {
  if (!existsSync(join(repoRoot, page))) fail(`${page} does not exist in the working tree`);
  const result = git(["hash-object", "--", page]);
  if (!result.ok) fail(`cannot hash ${page}: ${result.stderr}`);
  return result.stdout;
}

/** Object hash (blob or tree) of a dependency path at the given commit. */
function depHash(page, dep) {
  const result = git(["rev-parse", `${commit}:${dep}`]);
  if (!result.ok) fail(`${page}: dependency ${dep} does not exist at ${commit}; fix dependsOn first`);
  return result.stdout;
}

const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));

function parseDeps(raw) {
  return raw.split(",").map((dep) => dep.trim()).filter((dep) => dep.length > 0);
}

function stamp(page, dependsOn) {
  const verified = { [page]: workingTreeHash(page) };
  for (const dep of dependsOn) verified[dep] = depHash(page, dep);
  ledger.pages[page] = { dependsOn, verified, verifiedAt: date };
}

if (removePage !== null) {
  if (!ledger.pages[removePage]) fail(`${removePage} has no ledger entry to remove`);
  delete ledger.pages[removePage];
}

if (addPage !== null) {
  if (deps === null) fail("--add requires --deps (use --deps '' for a self-only page)");
  if (ledger.pages[addPage]) fail(`${addPage} already has a ledger entry; stamp it instead`);
  stamp(addPage, parseDeps(deps));
}

for (const page of pages) {
  const entry = ledger.pages[page];
  if (!entry) fail(`${page} has no ledger entry; use --add with --deps to create one`);
  stamp(page, addPage === null && deps !== null ? parseDeps(deps) : entry.dependsOn);
}

ledger.pages = Object.fromEntries(
  Object.entries(ledger.pages).sort(([a], [b]) => a.localeCompare(b))
);

writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
const touched = [...pages, ...(addPage === null ? [] : [addPage]), ...(removePage === null ? [] : [removePage])];
console.log(`updated ${touched.length} page(s) (${date})`);
