import type {
  EnsembleModel,
  HarnessAdapter,
  HarnessCapabilities,
  ToolHarnessResolveOptions,
  UnifiedHarnessKind
} from "@fusionkit/ensemble";
import type { ModelFusionHarnessKind, ModelFusionSideEffects } from "@fusionkit/protocol";

type ToolEnv = Record<string, string | undefined>;

/**
 * How a tool is being launched: behind the real fusion panel (`fusion`) or
 * backed by a single local model (`local`). The same `ToolIntegration.launch`
 * handles both; the context's `mode` lets a tool branch where the two differ
 * (e.g. Cursor spawns a bridge in fusion mode but prints tunnel setup locally).
 */
export type ToolLaunchMode = "fusion" | "local";

/**
 * Everything a tool needs from the host to launch its real binary, injected so
 * tool packages never import the CLI (which would be a dependency cycle). The
 * host wires these to its process/portless/teardown machinery.
 */
export type ToolLaunchContext = {
  mode: ToolLaunchMode;
  /** Gateway base URL the tool should point its model provider at. */
  gatewayUrl: string;
  /** The model name/label the launched tool advertises in its own UI. */
  modelLabel: string;
  /** Arguments forwarded verbatim to the tool binary. */
  toolArgs: string[];
  /** The repository the tool runs in (defaults to the process cwd). */
  repo?: string;
  /** Bearer token the gateway requires, when set. */
  authToken?: string;
  /** Portless CA path so spawned children trust the proxy's HTTPS routes. */
  caCertPath?: string;
  /** Directory for per-tool log files (e.g. the Cursor bridge log). */
  logsDir?: string;
  /** Public tunnel URL for tools that cannot reach loopback (local Cursor). */
  publicUrl?: string;
  /** Line logger. */
  log: (line: string) => void;
  /**
   * Quiesce host UI (live checklist, cursor) before the tool inherits the
   * terminal. A no-op in non-interactive/local flows.
   */
  prepareForPassthrough: () => void;
  /** Register a named port with the host (e.g. portless) and return its URL. */
  registerPort: (name: string, port: number) => string;
  /** Release a previously registered named port. */
  unregisterPort: (name: string) => void;
  /** Register a teardown callback run on shutdown (reverse order). */
  registerDisposer: (dispose: () => void | Promise<void>) => void;
};

/**
 * Harness-level metadata for a tool, used by the ensemble harness gateway/e2e
 * matrix so it never has to `switch` over tool names. Applies to every
 * `harnessKind` the tool answers for.
 */
export type ToolHarnessMetadata = {
  /** Protocol harness kind stamped on records. */
  harnessKind: ModelFusionHarnessKind;
  /** Policy side-effects the harness needs. */
  sideEffects: ModelFusionSideEffects;
  /** Judge response-shape hint for synthesis. */
  responseShape: string;
};

/** The credential-skip-style smoke run for the dashboard's `credential-skip` task. */
export type ToolDashboardSmoke = {
  taskId: string;
  model: EnsembleModel;
  sideEffects: ModelFusionSideEffects;
  allowedTools: string[];
  /** Build the harness used for the (empty-env) credential-skip smoke. */
  makeHarness: () => HarnessAdapter;
};

/** The optional env-gated live smoke for the dashboard's `live` task. */
export type ToolDashboardLiveSmoke = {
  taskId: string;
  /** Per-tool env flag that enables this live smoke. */
  envName: string;
  prompt: string;
  /** Env var holding a model override, and the default when unset. */
  modelEnvName: string;
  defaultModel: string;
  /** Build the live harness (real credentials) for the given env. */
  makeHarness: (env: ToolEnv) => HarnessAdapter;
};

/**
 * Dashboard metadata for a tool, used by `fusionkit ensemble dashboard` to build
 * the capability matrix, smoke records, and readiness rows from the registry
 * instead of a hardcoded per-tool table.
 */
export type ToolDashboardMetadata = {
  /** Dashboard target id (e.g. "claude-code"), may differ from the tool id. */
  id: string;
  harnessKind: ModelFusionHarnessKind;
  displayName: string;
  availability: "available" | "credential_gated" | "missing";
  /** Capability overlay merged onto the adapter's own capabilities. */
  capabilities: HarnessCapabilities;
  notes: string[];
  /** Build the harness whose capabilities seed the matrix row. */
  makeMatrixHarness: (env: ToolEnv) => HarnessAdapter;
  /** Why the tool would skip for lack of credentials (undefined = ready). */
  credentialSkipReason: (env: ToolEnv) => string | undefined;
  smoke: ToolDashboardSmoke;
  liveSmoke?: ToolDashboardLiveSmoke;
};

/**
 * A single tool integration: its launcher (used by `fusionkit <tool>` and
 * `fusionkit local <tool>`) plus, optionally, its ensemble harness factory (used
 * by the harness gateway / e2e matrix). One package implements one of these and
 * the CLI registers it.
 */
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
  /** Launch modes this tool supports. */
  modes: readonly ToolLaunchMode[];
  /** The unified harness kinds this tool's adapter answers for. */
  harnessKinds: readonly UnifiedHarnessKind[];
  /** Boot the tool against the host context; resolves with its exit code. */
  launch(ctx: ToolLaunchContext): Promise<number>;
  /** Build the ensemble harness adapter for one of this tool's kinds. */
  createHarness?(kind: UnifiedHarnessKind, options: ToolHarnessResolveOptions): HarnessAdapter;
  /** Harness metadata for the gateway/e2e matrix (set when `createHarness` is). */
  harness?: ToolHarnessMetadata;
  /** Dashboard metadata for `ensemble dashboard` (set when the tool has a harness). */
  dashboard?: ToolDashboardMetadata;
};
