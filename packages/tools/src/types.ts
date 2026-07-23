import type { AnyHarnessDriver, HarnessKind } from "@velum-labs/routekit-harness-core";
import type {
  ModelReasoningCapabilities,
  ReasoningSelection
} from "@velum-labs/routekit-contracts";

export type ToolModelFeature = "streaming" | "tools" | "images" | "reasoning_controls";
export type ToolCapabilityGrade = "full" | "degraded" | "unsupported";
export type ToolModelFeatureStatus = ToolCapabilityGrade | "unknown";

/** An opaque gateway model entry. Launchers never interpret the id. */
export type ToolModel = {
  id: string;
  label?: string;
  aliases?: readonly string[];
  features?: Partial<Record<ToolModelFeature, ToolModelFeatureStatus>>;
  reasoning?: ModelReasoningCapabilities;
};

/** A host-authored generic agent definition serialized by each launcher. */
export type AgentProfile = {
  id: string;
  model: string;
  description: string;
  instructions: string;
};

/** Portable launch data shared by RouteKit launch commands and product hosts. */
export type ToolLaunchSpec = {
  gatewayUrl: string;
  defaultModel: string;
  models: readonly ToolModel[];
  reasoning?: ReasoningSelection;
  agentProfiles?: readonly AgentProfile[];
  args: readonly string[];
  cwd?: string;
  auth?: { token?: string };
  tls?: { caCertPath?: string };
  logsDir?: string;
  publicUrl?: string;
  ide?: boolean;
};

/** Host lifecycle services paired with one neutral launch specification. */
export type ToolLaunchContext = {
  spec: ToolLaunchSpec;
  log: (line: string) => void;
  prepareForPassthrough: () => void;
  registerPort: (name: string, port: number) => string;
  unregisterPort: (name: string) => void;
  registerDisposer: (dispose: () => void | Promise<void>) => void;
};

export type ToolDriverRoute = {
  gatewayUrl: string;
  model: string;
  authToken?: string;
};

export type ToolDriverMetadata = {
  kind: HarnessKind;
  driver: AnyHarnessDriver;
  configForRoute(route: ToolDriverRoute): unknown;
};

export type ToolCapabilityMetadata = {
  streaming: ToolCapabilityGrade;
  tools: ToolCapabilityGrade;
  images: ToolCapabilityGrade;
  reasoning_controls: ToolCapabilityGrade;
};

/** One neutral launcher plus the canonical driver and static metadata. */
export type ToolIntegration = {
  /** Stable id (e.g. "codex"). */
  id: string;
  /** Alternate selectors that resolve to this tool. */
  aliases?: readonly string[];
  /** Human-facing name for pickers and dashboards. */
  displayName: string;
  /** One-line hint shown in the interactive picker. */
  pickerHint: string;
  /** The PATH binary launched, when the tool spawns one. */
  binary?: string;
  /** The npm package implementing this integration. */
  packageName: string;
  /** How to install the tool binary (doctor/preflight guidance). */
  installHint?: string;
  /** One-line authentication summary. */
  authSummary?: string;
  /**
   * Front-door setup block for pointing this tool at a running gateway
   * (rendered by `gatewaySetupSnippets`). `note` carries tool-specific extra
   * context (e.g. the Cursorkit endpoint placeholder).
   */
  setupSnippet?: (input: {
    gatewayUrl: string;
    model?: string;
    note?: string;
  }) => string;
  /** Boot the tool against the host context; resolves with its exit code. */
  launch(ctx: ToolLaunchContext): Promise<number>;
  driver: ToolDriverMetadata;
  capabilities: ToolCapabilityMetadata;
};
