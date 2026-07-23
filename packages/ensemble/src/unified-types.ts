import type { ModelFusionStatus } from "@fusionkit/protocol";
import type { JsonValue } from "@velum-labs/routekit-contracts";
import type { ResumeCursor } from "@velum-labs/routekit-harness-core";
import type { ReasoningSelection } from "@velum-labs/routekit-contracts";
import type { ToolRegistry } from "@velum-labs/routekit-tools";
import type { FusionTraceCarrier } from "@fusionkit/tracing";
import type { EnsembleModel, EnsembleRunResult } from "./harness.js";

export type UnifiedHarnessKind =
  | "mock"
  | "command"
  | "agent"
  | "codex"
  | "claude-code"
  | "cursor-acp"
  | "cursor-desktop"
  | "opencode";

/**
 * Trust level for unattended panel candidates. `full` (the default) gives each
 * member the highest autonomy its harness offers (e.g. Codex
 * `danger-full-access`); `guarded` keeps the harness's side-effects-derived
 * confinement (e.g. Codex `workspace-write`, fenced to the worktree).
 */
export type PanelTrust = "full" | "guarded";

/** One fused ensemble as panel members see it (for sub-agent provisioning). */
export type FusedSubagentEnsemble = {
  name: string;
  /** Advertised front-door model id (`fusion-panel` / `fusion-<name>`). */
  modelId: string;
  /** Panel member ids (for human/model-facing descriptions). */
  memberIds: readonly string[];
  judgeModel?: string;
};

/**
 * Fused sub-agent access for panel members: everything a member harness needs
 * to let its model spawn sub-agents on the fused ensembles (`fusion-*`): the
 * front-door gateway URL those turns route to, the registered ensembles, and
 * the panel depth the member's fused calls must carry (so the front door does
 * not re-provision fused access one level further down). Only provided to
 * depth-0 panels; deeper members get same-model sub-agents only.
 */
export type FusedSubagentAccess = {
  /** Front-door fusion gateway base URL (no `/v1` suffix). */
  gatewayUrl: string;
  /** Registered ensembles, session default first. */
  ensembles: readonly FusedSubagentEnsemble[];
  /** The session-default fused model id. */
  defaultModelId: string;
  /** Gateway bearer token, when the front door requires auth. */
  authToken?: string;
  /** The depth stamped on the member's fused requests (parent depth + 1). */
  depth: number;
};

/**
 * Options the unified runner passes to a tool's harness factory. The per-tool
 * packages map these onto their own harness options (provider base URL, etc.).
 */
export type ToolHarnessResolveOptions = {
  fusionBackendUrl: string;
  fusionApiKey?: string;
  timeoutMs?: number;
  /**
   * Per-model router endpoints keyed by `EnsembleModel.id`. When a candidate's
   * model id is present, its harness is pointed at that endpoint (and requests
   * the namespaced model id as its model) instead of the shared `fusionBackendUrl`, so
   * each panel model backs its own routed candidate through the one launched
   * harness.
   */
  modelEndpoints?: Record<string, string>;
  /**
   * Trace carrier of the enclosing run/turn, passed to the tool harness so it
   * can wrap each candidate in a `fusion.candidate` span with live step
   * markers, mirroring the agent harness. Unset outside a traced run.
   */
  trace?: FusionTraceCarrier;
  turn?: number;
  reasoning?: ReasoningSelection;
  /** When true, the tool harness tells its model which panel member it is. */
  panelIdentity?: boolean;
  /** Panel candidate trust level; unset means `full` (maximum autonomy). */
  panelTrust?: PanelTrust;
  /**
   * Enable the harness's native sub-agents for panel members (a member may
   * parallelize its own work on its own model, and — when `fusedSubagents` is
   * provided — delegate to the fused ensembles). Default true; the repo
   * `subagents: false` / `--no-subagents` switch turns it off.
   */
  subagents?: boolean;
  /**
   * Fused sub-agent access for this panel's members (see
   * {@link FusedSubagentAccess}). Absent for depth >= 1 panels and when
   * sub-agents are disabled.
   */
  fusedSubagents?: FusedSubagentAccess;
  /**
   * Native-session resume cursors keyed by ensemble model id, owned by the
   * caller across turns of one conversation. Driver-backed harnesses resume
   * each member's native session from these; legacy harnesses ignore them.
   */
  resumeCursors?: Map<string, ResumeCursor>;
};

/**
 * Provides everything ensemble needs about a tool-backed harness kind (codex,
 * claude-code, cursor-*) without ensemble depending on any per-tool package. The
 * host registers one (built from its neutral tool registry) via
 * `setToolDriverRegistry`; without it, requesting a tool harness kind
 * throws a clear error.
 */
export type ToolDriverRegistry = Pick<ToolRegistry, "driverForKind">;

export type UnifiedHarnessMatrixResult = {
  harness: UnifiedHarnessKind;
  modelIds: string[];
  status: ModelFusionStatus;
  message: string;
  ensemble?: EnsembleRunResult;
  artifacts: Record<string, string>;
  details: Record<string, JsonValue>;
};

export type UnifiedHarnessE2EResult = {
  id: string;
  generatedAt: string;
  fusionBackendUrl: string;
  repo: string;
  results: UnifiedHarnessMatrixResult[];
  reportPath?: string;
};

export type CursorHarnessRunnerInput = {
  kind: Extract<UnifiedHarnessKind, "cursor-acp" | "cursor-desktop">;
  model: EnsembleModel;
  fusionBackendUrl: string;
  repo: string;
  outDir: string;
  timeoutMs?: number;
};

export type CursorHarnessRunnerResult = {
  status: ModelFusionStatus;
  message: string;
  artifacts?: Record<string, string>;
  details?: Record<string, JsonValue>;
};

export type UnifiedHarnessE2EOptions = {
  id?: string;
  fusionBackendUrl: string;
  fusionApiKey?: string;
  repo: string;
  outputRoot: string;
  prompt: string;
  reasoning?: ReasoningSelection;
  harnesses: UnifiedHarnessKind[];
  models: EnsembleModel[];
  command?: string;
  timeoutMs?: number;
  /** Aborts the whole run (all candidates); see EnsembleDescriptor.signal. */
  signal?: AbortSignal;
  /** Straggler grace window after the first success; see EnsemblePolicy.stragglerGraceMs. */
  stragglerGraceMs?: number;
  judgeModel?: string;
  cursorRunner?: (input: CursorHarnessRunnerInput) => Promise<CursorHarnessRunnerResult>;
  /**
   * Per-candidate model backend URLs keyed by `EnsembleModel.id`. When a
   * candidate's model id is present, its command harness is pointed at that
   * endpoint instead of the shared `fusionBackendUrl`, so each panel model can
   * back its own real candidate (e.g. a local MLX trio).
   */
  modelEndpoints?: Record<string, string>;
  /**
   * Trace carrier of the enclosing run/turn. When set, the harnesses,
   * panel-model calls, and the FusionKit trajectory synthesis all parent
   * their spans onto it so any OTLP consumer can reconstruct one session.
   */
  trace?: FusionTraceCarrier;
  /** User-turn index this panel run belongs to (stamped on candidate spans). */
  turn?: number;
  /** When true, each harness tells its model which panel member it is (see FusionPanelOptions). */
  panelIdentity?: boolean;
  /** Panel candidate trust level; unset means `full` (maximum autonomy). */
  panelTrust?: PanelTrust;
  /** Enable native sub-agents inside panel members (see ToolHarnessResolveOptions). */
  subagents?: boolean;
  /** Fused sub-agent access for panel members (see FusedSubagentAccess). */
  fusedSubagents?: FusedSubagentAccess;
  /**
   * Finite step-boundary budget per member (receding-horizon lookahead): the
   * member's harness executes tool-call batches 1..k-1 in its worktree and
   * captures the k-th unexecuted as its terminal proposal. Only the generic
   * `agent` harness supports it (fusionkit owns that loop); configuring it
   * with a CLI harness is a validation error. Unset = unbounded (today).
   */
  k?: number;
  /**
   * Native-session resume cursors keyed by ensemble model id, owned by the
   * caller across turns of one conversation. Only the harness-core driver
   * harnesses honor it; legacy harnesses ignore it.
   */
  resumeCursors?: Map<string, ResumeCursor>;
};
