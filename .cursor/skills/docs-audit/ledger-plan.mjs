#!/usr/bin/env node
/**
 * ledger-plan: compute the docs-audit work queue from the freshness ledger.
 *
 * Reads ledger.json (next to this script) and compares, for every page, the
 * recorded git object hashes of the page and its dependsOn paths against the
 * same paths at HEAD. Git trees are Merkle trees, so one hash comparison per
 * path answers "did anything under this path change" exactly. Hashes are
 * stored raw (not as a commit reference) so stamps survive squash merges when
 * the same content remains reachable. When an old object is unavailable
 * (for example after history rewriting or in a shallow clone), the plan
 * requires a full re-verification instead of emitting a broken diff anchor.
 *
 * Output (stdout) is a JSON work queue: changed pages with structured
 * diff-anchor arguments, rotation picks (the K pages with the oldest
 * verifiedAt), warnings
 * (dead deps, missing pages), unledgered doc files, and the skipped-unchanged
 * count. This output is evidence: paste it verbatim into the audit report.
 *
 * Boundary rule: this helper touches ledger state and git plumbing only. It
 * never reads documentation content and encodes nothing about what any doc
 * should say. Content judgment belongs to the agent following SKILL.md.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ledgerPath = join(here, "ledger.json");
const repoRoot = join(here, "..", "..", "..");
const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function fail(message) {
  console.error(`ledger-plan: ${message}`);
  process.exit(1);
}

function git(args) {
  // cwd is pinned to the repo root: `ls-files` pathspecs are cwd-relative,
  // so running from a subdirectory would silently produce wrong results.
  const result = spawnSync("git", args, { encoding: "utf8", cwd: repoRoot });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim()
  };
}

/** Hash of a path (blob or tree) at HEAD; null when the path does not exist. */
function headHash(path) {
  const result = git(["rev-parse", `HEAD:${path}`]);
  return result.ok ? result.stdout : null;
}

const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
if (ledger.version !== 1 || typeof ledger.pages !== "object" || ledger.pages === null) {
  fail("ledger.json must have version: 1 and a pages object");
}

function validRepoPath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\0") &&
    !path.split("/").includes("..")
  );
}

function validateEntry(page, entry) {
  if (!validRepoPath(page)) fail(`invalid page path ${JSON.stringify(page)}`);
  if (!entry || !Array.isArray(entry.dependsOn) || !entry.verified) {
    fail(`${page}: entry must have dependsOn[] and verified{}`);
  }
  const deps = entry.dependsOn;
  if (new Set(deps).size !== deps.length) fail(`${page}: duplicate dependsOn path`);
  for (const dep of deps) {
    if (!validRepoPath(dep)) fail(`${page}: invalid dependsOn path ${JSON.stringify(dep)}`);
    if (dep === page || page.startsWith(`${dep}/`)) {
      fail(`${page}: dependsOn ${dep} contains the page itself; use narrower source paths`);
    }
  }
  const expected = new Set([page, ...deps]);
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

let pageLimit = Number.POSITIVE_INFINITY;
let rotationK = ledger.config?.rotationK ?? 5;
let checkStaged = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--limit") pageLimit = Number(args[++i]);
  else if (args[i] === "--rotation") rotationK = Number(args[++i]);
  else if (args[i] === "--check-staged") checkStaged = true;
  else fail(`unknown option ${args[i]}`);
}
if (!Number.isInteger(pageLimit) && pageLimit !== Number.POSITIVE_INFINITY) {
  fail("--limit must be a non-negative integer");
}
if (pageLimit < 0 || !Number.isInteger(rotationK) || rotationK < 0) {
  fail("--limit/--rotation must be non-negative integers");
}

const headResult = git(["rev-parse", "HEAD"]);
if (!headResult.ok) {
  console.error("ledger-plan: not a git repository or no HEAD");
  process.exit(1);
}
const head = headResult.stdout;

if (checkStaged) {
  const previousLedger = git(["show", "HEAD:.cursor/skills/docs-audit/ledger.json"]);
  const stagedTree = git(["write-tree"]);
  if (!previousLedger.ok || !stagedTree.ok) fail("cannot inspect staged ledger state");
  const previousPages = JSON.parse(previousLedger.stdout).pages ?? {};
  for (const [page, entry] of Object.entries(ledger.pages)) {
    if (JSON.stringify(entry) === JSON.stringify(previousPages[page])) continue;
    for (const [path, expected] of Object.entries(entry.verified)) {
      const actual = git(["rev-parse", `${stagedTree.stdout}:${path}`]);
      if (!actual.ok || actual.stdout !== expected) {
        fail(
          `${page}: staged stamp for ${path} is ${expected}, ` +
          `but the intended final tree is ${actual.ok ? actual.stdout : "missing"}`
        );
      }
    }
  }
}

const changed = [];
const unchanged = [];
const warnings = [];

for (const [page, entry] of Object.entries(ledger.pages)) {
  const verified = entry.verified ?? {};
  const deps = [page, ...(entry.dependsOn ?? [])];

  if (headHash(page) === null) {
    warnings.push({
      type: "missing-page",
      page,
      detail: `${page} is in the ledger but does not exist at HEAD; remove its entry or restore the page`
    });
    continue;
  }

  const changedDeps = [];
  for (const dep of deps) {
    const before = verified[dep] ?? null;
    const after = headHash(dep);
    if (after === null) {
      warnings.push({
        type: "dead-dep",
        page,
        detail: `${dep} no longer exists at HEAD (renamed or deleted); fix the page's dependsOn`
      });
      changedDeps.push({ path: dep, diffArgs: null, reason: "dependency is missing at HEAD" });
    } else if (before === null) {
      changedDeps.push({ path: dep, diffArgs: null, reason: "never verified" });
    } else if (before !== after) {
      const oldObject = git(["cat-file", "-e", `${before}^{object}`]);
      changedDeps.push(
        oldObject.ok
          ? { path: dep, diffArgs: ["diff", before, after], reason: null }
          : {
              path: dep,
              diffArgs: null,
              reason: "old object is unavailable; fully re-verify this dependency"
            }
      );
    }
  }

  if (changedDeps.length > 0) {
    changed.push({ page, verifiedAt: entry.verifiedAt ?? null, changedDeps });
  } else {
    unchanged.push({ page, verifiedAt: entry.verifiedAt ?? "0000-00-00" });
  }
}

// Rotation: the K unchanged pages with the oldest verification stamps get a
// full re-verification anyway. This bounds worst-case staleness for pages
// whose dependsOn lists are incomplete or whose claims were never true.
unchanged.sort((a, b) => a.verifiedAt.localeCompare(b.verifiedAt) || a.page.localeCompare(b.page));
const rotationCandidates = unchanged
  .slice(0, rotationK)
  .map(({ page, verifiedAt }) => ({ page, verifiedAt }));

// Unledgered scan: doc files on the configured surfaces with no ledger entry.
// This is file-tree bookkeeping (paths only, never content).
const unledgered = [];
const surfaces = ledger.config?.surfaces ?? [];
const excludes = ledger.config?.exclude ?? [];
if (surfaces.length > 0) {
  // :(glob) pathspecs keep `*` from crossing directory boundaries (`**` still does).
  const listing = git(["ls-files", "--", ...surfaces.map((glob) => `:(glob)${glob}`)]);
  if (listing.ok) {
    for (const file of listing.stdout.split("\n").filter((line) => line.length > 0)) {
      if (ledger.pages[file]) continue;
      if (excludes.some((prefix) => file === prefix || file.startsWith(prefix))) continue;
      unledgered.push(file);
    }
  } else {
    warnings.push({
      type: "scan-failed",
      page: null,
      detail: `unledgered scan failed (${listing.stderr}); treat the empty unledgered list as unknown`
    });
  }
}

const plan = {
  generatedAt: new Date().toISOString(),
  head,
  rotationK,
  ...buildBoundedQueue()
};

console.log(JSON.stringify(plan, null, 2));

function buildBoundedQueue() {
  const selected = new Set();
  const hasCapacity = () => pageLimit === Number.POSITIVE_INFINITY || selected.size < pageLimit;
  const select = (page) => {
    if (selected.has(page)) return true;
    if (!hasCapacity()) return false;
    selected.add(page);
    return true;
  };

  // Broken ledger entries are highest priority, followed by source changes,
  // newly discovered docs, then healthy-page rotation. One page consumes one
  // unit even if it appears in both warnings and changed.
  const warningPages = [...new Set(warnings.map(({ page }) => page).filter((page) => page !== null))];
  for (const page of warningPages) select(page);
  for (const { page } of changed) select(page);
  for (const page of unledgered) select(page);
  for (const { page } of rotationCandidates) select(page);

  const selectedChanged = changed.filter(({ page }) => selected.has(page));
  const selectedUnledgered = unledgered.filter((page) => selected.has(page));
  const selectedRotation = rotationCandidates.filter(({ page }) => selected.has(page));
  const selectedWarnings = warnings.filter(({ page }) => page === null || selected.has(page));

  return {
    changed: selectedChanged,
    deferredChangedCount: changed.length - selectedChanged.length,
    rotation: selectedRotation,
    deferredRotationCount: rotationCandidates.length - selectedRotation.length,
    unledgered: selectedUnledgered,
    deferredUnledgeredCount: unledgered.length - selectedUnledgered.length,
    warnings: selectedWarnings,
    deferredWarningCount:
      warningPages.length - warningPages.filter((page) => selected.has(page)).length,
    unchangedCount: unchanged.length - selectedRotation.length
  };
}
