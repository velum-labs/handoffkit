/**
 * Refresh and validate spec/registry/local-catalog.json.
 *
 * The catalog is intentionally checked in: local MLX defaults must be available
 * offline and must not depend on live HuggingFace availability during CI.
 *
 * Modes:
 *   node scripts/generate-local-catalog.mjs
 *     Canonicalize the checked-in catalog and preserve hand-tuned fields.
 *
 *   node scripts/generate-local-catalog.mjs --check
 *     Verify the catalog is canonical and internally consistent.
 *
 *   node scripts/generate-local-catalog.mjs --fetch
 *     Query HuggingFace model metadata and refresh sizeGB from repo file sizes.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const TARGET = "spec/registry/local-catalog.json";
const HUGGINGFACE_MODEL_API = "https://huggingface.co/api/models";
const GIB = 1024 ** 3;

const checkMode = process.argv.includes("--check");
const fetchMode = process.argv.includes("--fetch");

function fail(message) {
  console.error(`local catalog generation failed: ${message}`);
  process.exitCode = 1;
}

function readCatalog() {
  const parsed = JSON.parse(readFileSync(TARGET, "utf8"));
  const catalog = parsed.localCatalog;
  if (catalog === undefined || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error(`${TARGET} must carry an object under "localCatalog"`);
  }
  return parsed;
}

function modelSlug(repo) {
  return repo.split("/").at(-1) ?? repo;
}

function inferParams(repo) {
  const match = modelSlug(repo).match(/(\d+(?:\.\d+)?)[bB](?![a-zA-Z])/);
  return match === null ? "unknown" : `${match[1]}B`;
}

function inferQuant(repo) {
  const match = modelSlug(repo).match(/(?:^|-)(\d+bit)(?:-|$)/i);
  return match === null ? "unknown" : match[1].toLowerCase();
}

function titleToken(token) {
  if (/^\d+(?:\.\d+)?[bB]$/.test(token)) return token.toUpperCase();
  if (token.toLowerCase() === "it") return "Instruct";
  if (token.toLowerCase() === "mlx") return "MLX";
  if (/^qwen/i.test(token)) return token.replace(/^qwen/i, "Qwen");
  if (/^llama/i.test(token)) return token.replace(/^llama/i, "Llama");
  if (/^gemma/i.test(token)) return token.replace(/^gemma/i, "Gemma");
  return `${token.slice(0, 1).toUpperCase()}${token.slice(1)}`;
}

function inferLabel(repo) {
  const quant = inferQuant(repo);
  const withoutQuant =
    quant === "unknown" ? modelSlug(repo) : modelSlug(repo).replace(new RegExp(`-${quant}$`, "i"), "");
  return withoutQuant.split("-").filter(Boolean).map(titleToken).join(" ");
}

function roundSizeGB(bytes) {
  return Math.max(0.1, Math.round((bytes / GIB) * 10) / 10);
}

function isWeightOrConfigFile(fileName) {
  return (
    /\.(safetensors|bin|gguf|npz|json|txt|model)$/i.test(fileName) ||
    fileName === "tokenizer.model"
  );
}

async function fetchRepoSizeGB(repo) {
  const response = await fetch(`${HUGGINGFACE_MODEL_API}/${repo}?blobs=true`);
  if (!response.ok) {
    throw new Error(`HuggingFace returned ${response.status} for ${repo}`);
  }
  const data = await response.json();
  const siblings = Array.isArray(data.siblings) ? data.siblings : [];
  const bytes = siblings.reduce((sum, sibling) => {
    if (typeof sibling !== "object" || sibling === null) return sum;
    const fileName = typeof sibling.rfilename === "string" ? sibling.rfilename : "";
    const size = typeof sibling.size === "number" ? sibling.size : 0;
    return isWeightOrConfigFile(fileName) ? sum + size : sum;
  }, 0);
  return bytes > 0 ? roundSizeGB(bytes) : undefined;
}

async function normalizeEntry(entry) {
  if (typeof entry.repo !== "string" || entry.repo.length === 0) {
    throw new Error("local catalog entry is missing repo");
  }
  const fetchedSizeGB = fetchMode ? await fetchRepoSizeGB(entry.repo) : undefined;
  return {
    repo: entry.repo,
    label: typeof entry.label === "string" && entry.label.length > 0 ? entry.label : inferLabel(entry.repo),
    params:
      typeof entry.params === "string" && entry.params.length > 0 ? entry.params : inferParams(entry.repo),
    quant: typeof entry.quant === "string" && entry.quant.length > 0 ? entry.quant : inferQuant(entry.repo),
    sizeGB: fetchedSizeGB ?? entry.sizeGB,
    minRamGB: entry.minRamGB,
    blurb: entry.blurb,
    role: entry.role
  };
}

function validate(catalog) {
  const entries = catalog.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    fail("localCatalog.entries must be a non-empty array");
    return;
  }
  const repos = new Set();
  for (const entry of entries) {
    if (repos.has(entry.repo)) fail(`duplicate local catalog repo: ${entry.repo}`);
    repos.add(entry.repo);
    if (!["general", "coder"].includes(entry.role)) {
      fail(`${entry.repo} role must be "general" or "coder"`);
    }
    for (const key of ["label", "params", "quant", "blurb"]) {
      if (typeof entry[key] !== "string" || entry[key].length === 0) {
        fail(`${entry.repo} must define non-empty ${key}`);
      }
    }
    for (const key of ["sizeGB", "minRamGB"]) {
      if (typeof entry[key] !== "number" || !Number.isFinite(entry[key]) || entry[key] <= 0) {
        fail(`${entry.repo} must define positive numeric ${key}`);
      }
    }
  }
  for (const preferred of catalog.preferred ?? []) {
    if (!repos.has(preferred.repo)) {
      fail(`preferred local model ${preferred.id} references unknown repo ${preferred.repo}`);
    }
  }
  if (!repos.has(catalog.probeModel)) {
    fail(`probeModel references unknown repo ${catalog.probeModel}`);
  }
  if (typeof catalog.gatewayDefaultModel !== "string" || catalog.gatewayDefaultModel.length === 0) {
    fail("gatewayDefaultModel must be a non-empty repo id");
  }
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main() {
  if (!existsSync(TARGET)) {
    throw new Error(`missing ${TARGET}`);
  }
  const current = readCatalog();
  const entries = [];
  for (const entry of current.localCatalog.entries) {
    entries.push(await normalizeEntry(entry));
  }
  entries.sort((a, b) => a.sizeGB - b.sizeGB || a.repo.localeCompare(b.repo));

  const next = {
    $comment: current.$comment,
    localCatalog: {
      gatewayDefaultModel: current.localCatalog.gatewayDefaultModel,
      probeModel: current.localCatalog.probeModel,
      preferred: current.localCatalog.preferred,
      entries
    }
  };
  validate(next.localCatalog);
  const rendered = stableStringify(next);
  const existing = readFileSync(TARGET, "utf8");
  if (checkMode) {
    if (existing !== rendered) {
      fail(`local catalog is stale; run \`node scripts/generate-local-catalog.mjs${fetchMode ? " --fetch" : ""}\``);
    } else {
      console.log("local catalog check passed");
    }
    return;
  }
  writeFileSync(TARGET, rendered);
  console.log(`wrote ${TARGET}`);
  if (fetchMode) {
    console.log("refreshed local catalog sizes from HuggingFace");
  }
}

await main();
