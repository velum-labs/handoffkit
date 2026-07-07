#!/usr/bin/env node
// Regenerate the docs-site changelog page from the root CHANGELOG.md.
//
//   node scripts/sync-docs-changelog.mjs           # write apps/docs/content/docs/changelog.mdx
//   node scripts/sync-docs-changelog.mjs --check   # exit 1 if the page is stale
//
// The generated MDX is committed (like the OpenAPI reference), and the docs
// build also runs this script so a deploy can never ship a stale page. The
// release coordinator runs it as part of the `changelog` action so the docs
// page lands in the same release commit as the CHANGELOG.md update.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { changelogToDocsMdx } from "./lib/changelog.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHANGELOG_PATH = join(REPO_ROOT, "CHANGELOG.md");
const OUTPUT_PATH = join(REPO_ROOT, "apps", "docs", "content", "docs", "changelog.mdx");

const check = process.argv.includes("--check");

const changelog = readFileSync(CHANGELOG_PATH, "utf8");
const mdx = changelogToDocsMdx(changelog);

if (check) {
  const current = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, "utf8") : null;
  if (current !== mdx) {
    console.error(
      "apps/docs/content/docs/changelog.mdx is out of sync with CHANGELOG.md; run `node scripts/sync-docs-changelog.mjs`"
    );
    process.exit(1);
  }
  process.exit(0);
}

writeFileSync(OUTPUT_PATH, mdx);
console.log("wrote apps/docs/content/docs/changelog.mdx from CHANGELOG.md");
