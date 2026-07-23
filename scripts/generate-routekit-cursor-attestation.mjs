#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEvidenceMap } from "./lib/routekit-l06-evidence.mjs";
import {
  GATEWAY_TOKEN_ENV,
  runActiveCursorIdeAttestation
} from "./lib/routekit-cursor-attestation-runner.mjs";

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
    else if (arg === "--gateway-url") options.gatewayUrl = value();
    else if (arg === "--revision") options.revision = value();
    else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(value());
      if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
        throw new Error("--timeout-ms must be a positive integer");
      }
    }
    else if (arg === "--output") options.output = resolve(value());
    else throw new Error(`unknown option: ${arg}`);
  }
  options.timeoutMs ??= 180_000;
  for (const field of ["matrixReport", "gatewayUrl", "revision", "output"]) {
    if (options[field] === undefined) throw new Error(`--${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  return options;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const options = parseArgs(process.argv.slice(2));
const mapping = loadEvidenceMap(ROOT);
const authToken = process.env[GATEWAY_TOKEN_ENV];
if (authToken === undefined || authToken.length === 0) {
  throw new Error(`${GATEWAY_TOKEN_ENV} must be set`);
}
const attestation = await runActiveCursorIdeAttestation({
  root: ROOT,
  mapping,
  report: readJson(options.matrixReport),
  revision: options.revision,
  gatewayUrl: options.gatewayUrl,
  authToken,
  timeoutMs: options.timeoutMs
});
writeFileSync(options.output, `${JSON.stringify(attestation, null, 2)}\n`, {
  flag: "wx"
});
process.stdout.write(
  `WROTE ${options.output} suite=desktop-ui-experimental revision=${attestation.testedRevision}\n`
);
