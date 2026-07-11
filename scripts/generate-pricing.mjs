/**
 * Refresh and validate spec/registry/pricing.json.
 *
 * The generated registry embeds a small curated pricing table, not the full
 * LiteLLM database. This script keeps that curated table deterministic for CI
 * and lets maintainers refresh the known keys from LiteLLM explicitly.
 *
 * Modes:
 *   node scripts/generate-pricing.mjs
 *     Canonicalize the checked-in pricing table.
 *
 *   node scripts/generate-pricing.mjs --check
 *     Verify canonical order and pricing shape.
 *
 *   node scripts/generate-pricing.mjs --fetch
 *     Refresh known model keys from LiteLLM's public price database.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const TARGET = "spec/registry/pricing.json";
const LITELLM_PRICE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const TOKENS_PER_MILLION = 1_000_000;

const checkMode = process.argv.includes("--check");
const fetchMode = process.argv.includes("--fetch");

function fail(message) {
  console.error(`pricing generation failed: ${message}`);
  process.exitCode = 1;
}

function readPricingFile() {
  const parsed = JSON.parse(readFileSync(TARGET, "utf8"));
  const pricing = parsed.pricing;
  if (pricing === undefined || typeof pricing !== "object" || Array.isArray(pricing)) {
    throw new Error(`${TARGET} must carry an object under "pricing"`);
  }
  return parsed;
}

function dollarsPerMillion(value) {
  return Math.round(value * TOKENS_PER_MILLION * 1_000_000) / 1_000_000;
}

function normalizePrice(entry) {
  if (
    typeof entry !== "object" ||
    entry === null ||
    typeof entry.inputPer1mTokens !== "number" ||
    typeof entry.outputPer1mTokens !== "number"
  ) {
    throw new Error("pricing entries must define inputPer1mTokens and outputPer1mTokens");
  }
  return {
    inputPer1mTokens: entry.inputPer1mTokens,
    outputPer1mTokens: entry.outputPer1mTokens
  };
}

function litellmPrice(entry) {
  if (typeof entry !== "object" || entry === null) return undefined;
  const input = entry.input_cost_per_token;
  const output = entry.output_cost_per_token;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  return {
    inputPer1mTokens: dollarsPerMillion(input),
    outputPer1mTokens: dollarsPerMillion(output)
  };
}

async function fetchLiteLlmPrices() {
  const response = await fetch(LITELLM_PRICE_URL);
  if (!response.ok) {
    throw new Error(`LiteLLM pricing fetch returned ${response.status}`);
  }
  return response.json();
}

function sortedRecord(record) {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
  );
}

function validate(pricing) {
  const models = pricing.models;
  const aliases = pricing.aliases;
  const overrides = pricing.manualOverrides;
  if (models === undefined || typeof models !== "object" || Array.isArray(models)) {
    fail("pricing.models must be an object");
    return;
  }
  if (aliases === undefined || typeof aliases !== "object" || Array.isArray(aliases)) {
    fail("pricing.aliases must be an object");
    return;
  }
  if (overrides === undefined || typeof overrides !== "object" || Array.isArray(overrides)) {
    fail("pricing.manualOverrides must be an object");
    return;
  }
  const priced = { ...models, ...overrides };
  for (const [model, entry] of Object.entries(priced)) {
    try {
      const normalized = normalizePrice(entry);
      if (normalized.inputPer1mTokens < 0 || normalized.outputPer1mTokens < 0) {
        fail(`${model} pricing must be non-negative`);
      }
    } catch (error) {
      fail(`${model}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (typeof canonical !== "string" || canonical.length === 0) {
      fail(`pricing.aliases.${alias} must be a non-empty canonical model id`);
      continue;
    }
    if (!(canonical in priced)) {
      fail(`pricing.aliases.${alias} → ${canonical} must reference a priced model`);
    }
  }
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main() {
  if (!existsSync(TARGET)) {
    throw new Error(`missing ${TARGET}`);
  }
  const current = readPricingFile();
  const liteLlm = fetchMode ? await fetchLiteLlmPrices() : undefined;
  const manualOverrides = sortedRecord(current.pricing.manualOverrides ?? {});
  const aliases = sortedRecord(current.pricing.aliases ?? {});
  const models = {};

  for (const [model, entry] of Object.entries(current.pricing.models ?? {})) {
    const refreshed =
      liteLlm !== undefined && typeof liteLlm === "object" && liteLlm !== null
        ? litellmPrice(liteLlm[model])
        : undefined;
    models[model] = refreshed ?? normalizePrice(entry);
  }

  const next = {
    $comment: current.$comment,
    pricing: {
      models: sortedRecord(models),
      aliases,
      manualOverrides
    }
  };
  validate(next.pricing);
  const rendered = stableStringify(next);
  const existing = readFileSync(TARGET, "utf8");
  if (checkMode) {
    if (existing !== rendered) {
      fail(`pricing table is stale; run \`node scripts/generate-pricing.mjs${fetchMode ? " --fetch" : ""}\``);
    } else {
      console.log("pricing check passed");
    }
    return;
  }
  writeFileSync(TARGET, rendered);
  console.log(`wrote ${TARGET}`);
  if (fetchMode) {
    console.log("refreshed curated pricing from LiteLLM");
  }
}

await main();
