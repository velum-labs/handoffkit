#!/usr/bin/env node
/**
 * ledger-plan: compute the docs-audit work queue from the freshness ledger.
 *
 * Reads ledger.json (next to this script) and compares, for every page, the
 * recorded git object hashes of the page and its dependsOn paths against the
 * same paths at HEAD. Git trees are Merkle trees, so one hash comparison per
 * path answers "did anything under this path change" exactly. Hashes are
 * stored raw (not as a commit reference) so stamps survive squash merges and
 * shallow clones; `git diff <oldHash> <newHash>` still yields the exact
 * reconciliation diff for both trees and single files.
 *
 * Output (stdout) is a JSON work queue: changed pages with their diff-anchor
 * commands, rotation picks (the K pages with the oldest verifiedAt), warnings
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

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
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
const rotationK = ledger.config?.rotationK ?? 5;

const headResult = git(["rev-parse", "HEAD"]);
if (!headResult.ok) {
  console.error("ledger-plan: not a git repository or no HEAD");
  process.exit(1);
}
const head = headResult.stdout;

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
      changedDeps.push({ path: dep, diffCommand: null });
    } else if (before === null) {
      changedDeps.push({ path: dep, diffCommand: null, reason: "never verified" });
    } else if (before !== after) {
      changedDeps.push({ path: dep, diffCommand: `git diff ${before} ${after}` });
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
const rotation = unchanged.slice(0, rotationK).map(({ page, verifiedAt }) => ({ page, verifiedAt }));

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
  }
}

const plan = {
  generatedAt: new Date().toISOString(),
  head,
  rotationK,
  changed,
  rotation,
  unledgered,
  warnings,
  unchangedCount: unchanged.length - rotation.length
};

console.log(JSON.stringify(plan, null, 2));
