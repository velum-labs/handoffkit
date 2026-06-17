/**
 * ACP Registry integration. Resolves curated ACP-compatible agents (for
 * example the registry-backed `Codex CLI` and `Claude Agent` adapters) from the
 * ACP Registry so they can drive the generic ACP front door. The fetcher and
 * install directory are injectable for deterministic testing.
 *
 * Registry source: https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ACP_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

export type AcpRegistryAgent = {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  distribution?: Record<string, unknown>;
};

export type AcpRegistry = {
  agents: AcpRegistryAgent[];
};

export type AcpRegistryFetcher = (url: string) => Promise<unknown>;

export type InstalledAcpAdapter = {
  id: string;
  name: string;
  version: string;
  distribution: Record<string, unknown>;
  installedAt: string;
  metadataPath: string;
};

function normalizeRegistry(raw: unknown): AcpRegistry {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("ACP registry payload must be an object");
  }
  const agentsValue = (raw as { agents?: unknown }).agents;
  if (!Array.isArray(agentsValue)) {
    throw new Error("ACP registry payload is missing an agents array");
  }
  const agents: AcpRegistryAgent[] = [];
  for (const entry of agentsValue) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) continue;
    const agent: AcpRegistryAgent = { id };
    const name = (entry as { name?: unknown }).name;
    if (typeof name === "string") agent.name = name;
    const version = (entry as { version?: unknown }).version;
    if (typeof version === "string") agent.version = version;
    const description = (entry as { description?: unknown }).description;
    if (typeof description === "string") agent.description = description;
    const distribution = (entry as { distribution?: unknown }).distribution;
    if (typeof distribution === "object" && distribution !== null) {
      agent.distribution = distribution as Record<string, unknown>;
    }
    agents.push(agent);
  }
  return { agents };
}

const defaultFetcher: AcpRegistryFetcher = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`ACP registry fetch failed: ${response.status}`);
  }
  return (await response.json()) as unknown;
};

export async function fetchAcpRegistry(
  fetcher: AcpRegistryFetcher = defaultFetcher,
  url: string = ACP_REGISTRY_URL
): Promise<AcpRegistry> {
  return normalizeRegistry(await fetcher(url));
}

export type InstallAcpAdaptersOptions = {
  agentIds: string[];
  installDir: string;
  fetcher?: AcpRegistryFetcher;
  url?: string;
};

export async function installAcpAdapters(
  options: InstallAcpAdaptersOptions
): Promise<InstalledAcpAdapter[]> {
  if (options.agentIds.length === 0) {
    throw new Error("at least one ACP agent id is required");
  }
  const registry = await fetchAcpRegistry(
    options.fetcher ?? defaultFetcher,
    options.url ?? ACP_REGISTRY_URL
  );
  const byId = new Map(registry.agents.map((agent) => [agent.id, agent]));
  const dir = resolve(options.installDir);
  mkdirSync(dir, { recursive: true });

  const installed: InstalledAcpAdapter[] = [];
  for (const agentId of options.agentIds) {
    const agent = byId.get(agentId);
    if (agent === undefined) {
      throw new Error(`ACP registry has no agent with id "${agentId}"`);
    }
    if (agent.distribution === undefined) {
      throw new Error(`ACP agent "${agentId}" has no distribution metadata`);
    }
    const metadataPath = join(dir, `${agentId}.json`);
    const record: InstalledAcpAdapter = {
      id: agent.id,
      name: agent.name ?? agent.id,
      version: agent.version ?? "unknown",
      distribution: agent.distribution,
      installedAt: new Date().toISOString(),
      metadataPath
    };
    writeFileSync(metadataPath, JSON.stringify(record, null, 2) + "\n");
    installed.push(record);
  }
  return installed;
}
