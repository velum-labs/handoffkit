import { createHash } from "node:crypto";
import { panelModeForK, type PanelMode } from "@fusionkit/protocol";
import { getWorkflow, type KernelWorkflow } from "./kernel.js";

/**
 * The serializable, content-addressed boundary between a hyperkit experiment
 * cell and FusionKit's TS kernel.
 *
 * Hyperkit treats this payload as opaque data + a hash. FusionKit interprets
 * workflowId/params, resolves the registered workflow, and runs the resulting
 * OperatorGraph. Arbitrary experiment code can generate these specs without
 * importing or understanding the runtime.
 */
export type TopologySpec = {
  version: "fusionkit.topology.v1";
  workflowId: string;
  params: Record<string, unknown>;
  /** Step boundary: 1=proposal, finite >1=lookahead, undefined=trajectory. */
  k?: number;
  /** Optional assertion; normally derived from k and checked on resolution. */
  panelMode?: PanelMode;
  metadata?: Record<string, unknown>;
};

export type ResolvedTopology = {
  spec: TopologySpec;
  hash: string;
  panelMode: PanelMode;
  workflow: KernelWorkflow;
};

export function topology(spec: Omit<TopologySpec, "version">): TopologySpec {
  if (spec.workflowId.length === 0) throw new Error("topology workflowId must be non-empty");
  if (spec.k !== undefined && (!Number.isInteger(spec.k) || spec.k < 1)) {
    throw new Error("topology k must be a positive integer when defined");
  }
  return { version: "fusionkit.topology.v1", ...spec };
}

export function topologyHash(spec: TopologySpec): string {
  const canonical = canonicalJson(spec);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function resolveTopology(spec: TopologySpec): ResolvedTopology {
  if (spec.version !== "fusionkit.topology.v1") {
    throw new Error(`unsupported topology spec version ${String(spec.version)}`);
  }
  const derivedMode = panelModeForK(spec.k);
  if (spec.panelMode !== undefined && spec.panelMode !== derivedMode) {
    throw new Error(
      `topology panelMode ${spec.panelMode} conflicts with k=${String(spec.k)} (${derivedMode})`
    );
  }
  const factory = getWorkflow<Record<string, unknown>>(spec.workflowId);
  if (factory === undefined) throw new Error(`topology workflow ${spec.workflowId} is not registered`);
  return {
    spec,
    hash: topologyHash(spec),
    panelMode: derivedMode,
    workflow: factory(spec.params)
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sortValue(child)])
    );
  }
  return value;
}

