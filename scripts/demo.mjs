#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// The examples manifest is the single source of demo metadata; this script,
// test/demos.test.js, scripts/check-repo.mjs, and the banners each demo
// prints all read the same file.
const manifest = JSON.parse(
  readFileSync(new URL("../examples/manifest.json", import.meta.url), "utf8")
);
const DEMOS = manifest.demos;

// Colors come from @warrant/example-utils once it is built; before the
// first build (when only listing works anyway) fall back to plain text.
let bold = (text) => text;
let dim = (text) => text;
try {
  const narrate = await import("../packages/example-utils/dist/narrate.js");
  bold = narrate.bold;
  dim = narrate.dim;
} catch {
  // not built yet: plain text listing
}

function list() {
  console.log(bold("warrant examples"));
  console.log("");
  for (const demo of DEMOS) {
    console.log(`  ${bold(demo.id)}  ${demo.title}${demo.interactive ? dim("  (interactive)") : ""}`);
    console.log(`      ${dim(demo.summary)}`);
  }
  console.log("");
  console.log(`run one:  ${bold("pnpm demo 01")}`);
  console.log(`run all:  ${bold("pnpm demo all")} ${dim("(skips interactive examples)")}`);
}

function runDemo(demo) {
  const entry = `examples/${demo.directory}/dist/run.js`;
  if (!existsSync(entry)) {
    console.error(`missing built example: ${entry}`);
    console.error("run pnpm build before running demos");
    return 1;
  }
  const result = spawnSync(process.execPath, [entry], { stdio: "inherit" });
  return result.status ?? 1;
}

const selector = process.argv[2];
if (!selector || selector === "list") {
  list();
  process.exit(0);
}

if (selector === "all") {
  for (const demo of DEMOS) {
    if (demo.interactive) continue;
    const status = runDemo(demo);
    if (status !== 0) process.exit(status);
  }
  process.exit(0);
}

const normalized = selector.padStart(2, "0");
const demo = DEMOS.find((candidate) => candidate.id === selector || candidate.id === normalized);
if (!demo) {
  console.error(`unknown demo "${selector}"`);
  list();
  process.exit(1);
}

process.exit(runDemo(demo));
