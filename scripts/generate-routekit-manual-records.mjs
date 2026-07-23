#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEvidenceMap } from "./lib/routekit-l06-evidence.mjs";
import { deriveReviewedManualRecords } from "./lib/routekit-manual-evidence.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === "--matrix-report") options.matrixReport = resolve(value());
    else if (arg === "--cursor-attestation") options.cursorAttestation = resolve(value());
    else if (arg === "--revision") options.revision = value();
    else if (arg === "--output") options.output = resolve(value());
    else throw new Error(`unknown option: ${arg}`);
  }
  for (const field of ["matrixReport", "revision", "output"]) {
    if (options[field] === undefined) throw new Error(`--${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  return options;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const options = parseArgs(process.argv.slice(2));
const mapping = loadEvidenceMap(ROOT);
const report = readJson(options.matrixReport);
const records = deriveReviewedManualRecords(mapping, report, {
  revision: options.revision,
  ...(options.cursorAttestation === undefined
    ? {}
    : { cursorIdeAttestation: readJson(options.cursorAttestation) })
});
writeFileSync(options.output, `${JSON.stringify(records, null, 2)}\n`, {
  flag: "wx"
});
process.stdout.write(
  `WROTE ${options.output} routes=${Object.keys(records.routes).length} revision=${records.testedRevision}\n`
);
