#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  durableEvidence,
  loadEvidenceMap,
  promoteMatrixResults,
  renderEvidenceMarkdown
} from "./lib/routekit-l06-evidence.mjs";
import { applyReviewedManualRecords } from "./lib/routekit-manual-evidence.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = join(ROOT, "spec", "routekit", "l06-evidence.json");
const JSON_PATH = join(ROOT, "docs", "routekit-l06-evidence.json");
const MARKDOWN_PATH = join(ROOT, "docs", "routekit-l06-evidence.md");

function parseArgs(argv) {
  const options = {
    check: false,
    matrixReport: undefined,
    manualRecords: undefined,
    revision: undefined
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === "--check") options.check = true;
    else if (arg === "--matrix-report") options.matrixReport = resolve(value());
    else if (arg === "--manual-records") options.manualRecords = resolve(value());
    else if (arg === "--revision") options.revision = value();
    else throw new Error(`unknown option: ${arg}`);
  }
  if (options.check && (options.matrixReport !== undefined || options.manualRecords !== undefined)) {
    throw new Error("--check cannot promote evidence");
  }
  if (options.matrixReport !== undefined && options.revision === undefined) {
    throw new Error("--matrix-report requires --revision <full-sha>");
  }
  if (options.manualRecords !== undefined && options.matrixReport === undefined) {
    throw new Error("--manual-records requires the bound --matrix-report");
  }
  return options;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const options = parseArgs(process.argv.slice(2));
const mapping = loadEvidenceMap(ROOT);
let source = readJson(SOURCE_PATH);
let matrixReport;
if (options.matrixReport !== undefined) {
  matrixReport = readJson(options.matrixReport);
  source = promoteMatrixResults(
    mapping,
    source,
    matrixReport,
    options.revision
  );
}
if (options.manualRecords !== undefined) {
  source = applyReviewedManualRecords(
    mapping,
    source,
    matrixReport,
    readJson(options.manualRecords)
  );
}
if (options.matrixReport !== undefined || options.manualRecords !== undefined) {
  writeFileSync(SOURCE_PATH, `${JSON.stringify(source, null, 2)}\n`);
}

const json = `${JSON.stringify(durableEvidence(mapping, source), null, 2)}\n`;
const markdown = renderEvidenceMarkdown(mapping, source);
if (options.check) {
  for (const [path, expected] of [
    [JSON_PATH, json],
    [MARKDOWN_PATH, markdown]
  ]) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== expected) {
      console.error(
        `${path.slice(ROOT.length + 1)} is stale; run node scripts/generate-routekit-l06-evidence.mjs`
      );
      process.exitCode = 1;
    }
  }
} else {
  writeFileSync(JSON_PATH, json);
  writeFileSync(MARKDOWN_PATH, markdown);
}
