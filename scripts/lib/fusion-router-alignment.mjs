import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*\/[^\s/]+(?:\/[^\s/]+)*$/;

export function collectFusionModelIds(config) {
  const ids = new Set();
  for (const ensemble of Object.values(config?.ensembles ?? {})) {
    for (const member of ensemble?.members ?? []) ids.add(member);
    if (typeof ensemble?.judge === "string") ids.add(ensemble.judge);
    if (typeof ensemble?.synthesizer === "string") ids.add(ensemble.synthesizer);
  }
  return [...ids].sort();
}

export function providerFromModelId(modelId) {
  if (typeof modelId !== "string" || !MODEL_ID_PATTERN.test(modelId)) {
    throw new Error(`Fusion model id must be namespaced as provider/model: ${String(modelId)}`);
  }
  return modelId.slice(0, modelId.indexOf("/"));
}

export function configuredProvidersFromRouterYaml(source) {
  const providers = new Set();
  const lines = source.split(/\r?\n/);
  const providersIndex = lines.findIndex((line) => /^providers:\s*(?:#.*)?$/.test(line));
  if (providersIndex === -1) return providers;

  for (const line of lines.slice(providersIndex + 1)) {
    if (/^\S/.test(line) && line.trim() !== "") break;
    const match = line.match(/^ {2}(["']?)([a-z0-9][a-z0-9-]*)\1:\s*/);
    if (match?.[2] !== undefined) providers.add(match[2]);
  }
  return providers;
}

export function findMissingRouterProviders(fusionConfig, routerYaml) {
  const configured = configuredProvidersFromRouterYaml(routerYaml);
  const referenced = new Set(collectFusionModelIds(fusionConfig).map(providerFromModelId));
  return [...referenced].filter((provider) => !configured.has(provider)).sort();
}

export function assertCommittedFusionRouterAlignment({
  repoRoot = process.cwd(),
  fusionPath = ".fusionkit/fusion.json"
} = {}) {
  const absoluteFusionPath = resolve(repoRoot, fusionPath);
  const fusionConfig = JSON.parse(readFileSync(absoluteFusionPath, "utf8"));
  const routerConfig = fusionConfig?.router?.config;
  if (typeof routerConfig !== "string" || routerConfig.length === 0) return;

  const absoluteRouterPath = resolve(dirname(absoluteFusionPath), "..", routerConfig);
  if (!existsSync(absoluteRouterPath)) {
    throw new Error(`Fusion router config does not exist: ${routerConfig}`);
  }
  const missing = findMissingRouterProviders(
    fusionConfig,
    readFileSync(absoluteRouterPath, "utf8")
  );
  if (missing.length > 0) {
    throw new Error(
      `Fusion models reference providers absent from ${routerConfig}: ${missing.join(", ")}`
    );
  }
}
