/**
 * `fusionkit <tool>` — one command, everything real.
 *
 * Spawns a real model panel (a cloud trio by default, or the local MLX trio
 * with `--local`), starts the Fusion Harness Gateway over a real model-backed
 * coding harness (each panel model produces a real candidate patch in its own
 * git worktree on a real repo) with real judge synthesis (FusionKit, run via
 * `uvx`), then launches the chosen coding agent (Codex / Claude Code / Cursor)
 * pre-wired to the gateway. One Ctrl+C tears the whole stack down.
 *
 * No mocks: the panel is real models, candidates are real patches verified by
 * really running the repo's tests, and the judge is a real model.
 *
 * This module is the run orchestrator; the supporting pieces live in `./fusion/`
 * (env + defaults, the observability dashboard, the model stack, and preflight)
 * and are re-exported here so existing import paths keep working.
 */

import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_ENSEMBLE_NAME, formatDurationMs, FUSION_PANEL_MODEL, fusionModelId } from "@fusionkit/tools";
import type { ToolLaunchContext } from "@fusionkit/tools";
import { defaultSessionsDir, FileSystemSessionStore, formatUsd } from "@fusionkit/model-gateway";
import type { SessionMetaInput, SessionSummary } from "@fusionkit/model-gateway";

import {
  bold,
  box,
  brandBanner,
  canPromptInteractively,
  confirm,
  cyan,
  dim,
  glyph,
  gray,
  green,
  isInteractive,
  select,
  uiStream,
  yellow
} from "@fusionkit/cli-ui";

import { resolveSessionId } from "./commands/sessions.js";
import { gatewaySetupSnippets, setGatewayChatter, setGatewayStatusSink } from "./gateway.js";
import { toolRegistry } from "./tools.js";
import { createPortlessSession } from "./shared/portless.js";
import { PreflightError, runPreflight } from "./shared/preflight.js";
import { createBootView } from "./fusion/boot-view.js";

import { hasCloudConsent, recordCloudConsent } from "./fusion/consent.js";
import {
  DEFAULT_CLOUD_PANEL,
  DEFAULT_TRIO,
  defaultKeyEnv,
  gitToplevel,
  loadEnvFileInto
} from "./fusion/env.js";
import type { EnsembleRunSpec, FusionTool, PanelModelSpec, RunFusionOptions, StackReporter } from "./fusion/env.js";
import { openUrl, startObservability } from "./fusion/observability.js";
import type { Observability } from "./fusion/observability.js";
import { ensureLocalPanelSupported } from "./fusion/platform.js";
import { provisionFusionEngine } from "./fusion/provision.js";
import { resolveNarratorModel, startFusionStack, unionPanelSpecs } from "./fusion/stack.js";
import type { FusionStack } from "./fusion/stack.js";
import { localPanelMemoryWarning, preflightRequirements, validateProviderKeys } from "./fusion/preflight.js";

export * from "./fusion/consent.js";
export * from "./fusion/env.js";
export * from "./fusion/observability.js";
export * from "./fusion/platform.js";
export * from "./fusion/stack.js";
export * from "./fusion/preflight.js";

/** Launchable fusion tools (registry-derived) plus the `serve` pseudo-tool. */
export const FUSION_TOOLS: readonly FusionTool[] = [
  ...toolRegistry.launchableFusion().map((tool) => tool.id),
  "serve"
];

/** The default fused model label (the `default` ensemble's advertised id). */
const FUSION_MODEL_LABEL = FUSION_PANEL_MODEL;

/** Whether portless is enabled: explicit flag/config wins, else on unless PORTLESS=0. */
export function portlessEnabled(options: RunFusionOptions): boolean {
  if (options.portless !== undefined) return options.portless;
  return process.env.PORTLESS !== "0";
}

function panelProviderLabel(spec: PanelModelSpec): string {
  if (spec.auth === "codex" && spec.provider === undefined) return "codex";
  return spec.provider ?? "mlx";
}

/** Human-readable panel member setup, with auth sources but never secret values. */
export function panelMemberSummary(
  spec: PanelModelSpec,
  endpoints: Record<string, string> | undefined = undefined
): string {
  const provider = spec.provider ?? "mlx";
  const providerLabel = panelProviderLabel(spec);
  const endpointUrl = endpoints?.[spec.id];
  let auth: string;
  if (endpointUrl !== undefined) {
    auth = "pre-running endpoint";
  } else if (spec.auth !== undefined) {
    auth = `${spec.auth} login`;
  } else if (provider === "mlx") {
    auth = "local MLX";
  } else {
    const keyEnv = spec.keyEnv ?? defaultKeyEnv(provider);
    auth = keyEnv !== undefined ? `api key env ${keyEnv}` : "provider config";
  }
  return `${spec.id}=${providerLabel}:${spec.model} [${auth}]`;
}

/** Auth summary for the launched coding tool, not the panel members behind it. */
export function toolAuthSummary(tool: FusionTool): string | undefined {
  if (tool === "serve") return undefined;
  return toolRegistry.get(tool)?.authSummary ?? `${tool} auth: FusionKit gateway provider`;
}

export function fusionPreambleLines(input: {
  tool: FusionTool;
  repo: string;
  models: readonly PanelModelSpec[];
  judgeLabel: string;
  /** The session-default fused model id (default: `fusion-panel`). */
  modelLabel?: string;
  /** Every registered ensemble (session default first) for multi-ensemble repos. */
  ensembles?: readonly EnsembleRunSpec[];
  endpoints?: Record<string, string>;
  observe?: boolean;
  budgetUsd?: number;
  onRateLimit?: RunFusionOptions["onRateLimit"];
  resumeId?: string;
}): string[] {
  const lines = [
    `tool: ${input.tool} -> FusionKit gateway`,
    `model: ${input.modelLabel ?? FUSION_MODEL_LABEL}`,
    `repo: ${input.repo}`,
    `judge: ${input.judgeLabel}`,
    `panel: ${input.models.map((model) => panelMemberSummary(model, input.endpoints)).join(", ")}`
  ];
  const auth = toolAuthSummary(input.tool);
  if (auth !== undefined) lines.splice(1, 0, auth);
  // Other registered ensembles: each is selectable in the tool's own picker.
  for (const ensemble of input.ensembles ?? []) {
    if (fusionModelId(ensemble.name) === (input.modelLabel ?? FUSION_MODEL_LABEL)) continue;
    lines.push(
      `ensemble ${ensemble.name} (${fusionModelId(ensemble.name)}): ${ensemble.models.map((spec) => spec.id).join(", ")}`
    );
  }
  if (input.resumeId !== undefined) lines.push(`resume: ${input.resumeId}`);
  if (input.observe === true) lines.push("observe: on");
  if (input.budgetUsd !== undefined) lines.push(`budget: $${input.budgetUsd}`);
  if (input.onRateLimit !== undefined) lines.push(`rate limits: ${input.onRateLimit}`);
  return lines;
}

/**
 * The end-of-run receipt: what the fusion engine actually did while the coding
  * agent owned the terminal (fused turns, provider spend/estimates, how to resume).
 * Empty when no turns were recorded (nothing to report). Exported for tests.
 */
export function sessionReceiptLines(
  sessions: readonly SessionSummary[],
  input: { elapsedMs: number; tool: FusionTool }
): string[] {
  const turns = sessions.reduce((sum, session) => sum + session.turnCount, 0);
  if (turns === 0) return [];
  const providerUsd = sessions.reduce(
    (sum, session) => sum + (session.cost?.providerUsd ?? session.cost?.totalUsd ?? 0),
    0
  );
  const localComputeUsd = sessions.reduce((sum, session) => sum + (session.cost?.localComputeUsd ?? 0), 0);
  const localActiveMs = sessions.reduce((sum, session) => sum + (session.cost?.localActiveMs ?? 0), 0);
  const totalTokens = sessions.reduce((sum, session) => sum + (session.cost?.totalTokens ?? 0), 0);
  const metered = sessions.reduce(
    (sum, session) => sum + (session.cost?.meteredEntries ?? session.cost?.meteredTurns ?? 0),
    0
  );
  const unknown = sessions.reduce(
    (sum, session) => sum + (session.cost?.unknownCostEntries ?? session.cost?.unknownCostTurns ?? 0),
    0
  );
  const lines = [
    `fusion session complete — ${turns} fused turn(s) in ${formatDurationMs(input.elapsedMs)}`
  ];
  const providerSpend =
    metered > 0 || providerUsd > 0
      ? formatUsd(providerUsd)
      : "unknown";
  const localSpend =
    localActiveMs > 0
      ? `${formatDurationMs(localActiveMs)} active${localComputeUsd > 0 ? ` (${formatUsd(localComputeUsd)} est)` : " (estimate unknown)"}`
      : "none";
  const tokens = totalTokens > 0 ? ` · ${totalTokens.toLocaleString("en-US")} tokens` : "";
  const unknownText = unknown > 0 ? ` (+${unknown} unknown-cost entr${unknown === 1 ? "y" : "ies"})` : "";
  lines.push(
    `spend: provider spend/est ${providerSpend}${unknownText} · local compute: ${localSpend}${tokens}`
  );
  const latest = sessions[0];
  if (latest !== undefined) {
    lines.push(`resume this session: fusionkit ${input.tool} --resume ${latest.id.slice(0, 8)}`);
  }
  return lines;
}

/**
 * Style the plain `key: value` preamble lines for the framed launch card: dim
 * aligned labels, and one bullet line per panel member so long model ids never
 * run into each other.
 */
export function styledPreambleLines(lines: readonly string[]): string[] {
  type Row = { label: string; value: string };
  const rows: Row[] = lines.map((line) => {
    const split = line.indexOf(": ");
    return split === -1 ? { label: "", value: line } : { label: line.slice(0, split), value: line.slice(split + 2) };
  });
  const width = Math.max(0, ...rows.map((row) => row.label.length));
  const out: string[] = [];
  for (const row of rows) {
    if (row.label === "panel" || row.label.startsWith("ensemble ")) {
      out.push(`${dim(row.label.padEnd(width))}`);
      for (const member of row.value.split(", ")) out.push(`  ${gray(glyph.bullet())} ${member}`);
      continue;
    }
    out.push(row.label.length === 0 ? row.value : `${dim(row.label.padEnd(width))}  ${row.value}`);
  }
  return out;
}

export async function runFusion(
  tool: FusionTool,
  toolArgs: string[],
  options: RunFusionOptions = {}
): Promise<number> {
  const log = options.log ?? ((line: string) => uiStream().write(`${line}\n`));
  const root = mkdtempSync(join(tmpdir(), "fusionkit-fusion-"));
  const logsDir = join(root, "logs");
  mkdirSync(logsDir, { recursive: true });
  // Default the fused repo to the current directory's git repo: the panel models
  // and the launched harness must operate on the SAME codebase, and the launched
  // tool runs in this repo (below). No hidden sample repo — if the user wants a
  // different repo they pass --repo.
  let repo = options.repo;
  if (repo === undefined) {
    const toplevel = gitToplevel(process.cwd());
    if (toplevel === undefined) {
      throw new Error(
        "no --repo given and the current directory is not a git repository; " +
          "cd into your project (or pass --repo <dir>) so the panel fuses over the code you're working on"
      );
    }
    repo = toplevel;
  }
  // Load API keys from a project `.env` (cwd, then the repo root) so provider
  // keys work without a manual `export`. Already-exported values always win, so
  // an explicitly set (even empty) key is never overridden.
  loadEnvFileInto(join(process.cwd(), ".env"), process.env);
  if (repo !== process.cwd()) loadEnvFileInto(join(repo, ".env"), process.env);

  // Resolve the named-ensemble list: config-provided ensembles, else one
  // implicit `default` ensemble from the flag/default panel. Every ensemble is
  // registered as its own gateway model; the selected one (--ensemble, then the
  // config's defaultEnsemble, then the first) is the session default.
  const fallbackPanel = (): PanelModelSpec[] =>
    options.local === true ? DEFAULT_TRIO.map((spec) => ({ ...spec })) : DEFAULT_CLOUD_PANEL.map((spec) => ({ ...spec }));
  // Ensemble names whose panel fell back to the built-in trio (adaptive-drop eligible).
  const defaultedPanels = new Set<string>();
  let ensembles: EnsembleRunSpec[];
  if (options.ensembles !== undefined && options.ensembles.length > 0 && options.endpoints === undefined) {
    ensembles = options.ensembles.map((ensemble) => {
      const defaulted = ensemble.models.length === 0;
      if (defaulted) defaultedPanels.add(ensemble.name);
      return {
        ...ensemble,
        models: (defaulted ? fallbackPanel() : ensemble.models).map((spec) => ({ ...spec }))
      };
    });
  } else {
    if (options.models === undefined) defaultedPanels.add(DEFAULT_ENSEMBLE_NAME);
    ensembles = [
      {
        name: DEFAULT_ENSEMBLE_NAME,
        models: (options.models ?? fallbackPanel()).map((spec) => ({ ...spec })),
        ...(options.judgeModel !== undefined ? { judgeModel: options.judgeModel } : {}),
        ...(options.prompts !== undefined ? { prompts: options.prompts } : {})
      }
    ];
  }
  const selectedName = options.ensemble ?? ensembles[0]?.name ?? DEFAULT_ENSEMBLE_NAME;
  const selectedIndex = ensembles.findIndex((ensemble) => ensemble.name === selectedName);
  if (selectedIndex === -1) {
    throw new Error(
      `unknown ensemble "${selectedName}" (have: ${ensembles.map((ensemble) => ensemble.name).join(", ")})`
    );
  }
  if (selectedIndex > 0) ensembles.unshift(...ensembles.splice(selectedIndex, 1));
  const selected = ensembles[0] as EnsembleRunSpec;
  // Explicit flags override the selected ensemble only.
  if (options.ensembles !== undefined && options.ensembles.length > 0) {
    if (options.models !== undefined) {
      selected.models = options.models.map((spec) => ({ ...spec }));
      defaultedPanels.delete(selected.name);
    }
    if (options.judgeModel !== undefined) selected.judgeModel = options.judgeModel;
  }
  const modelLabel = fusionModelId(selected.name);

  // Adaptive default panel: when an ensemble's panel is the built-in default
  // (nobody picked it), work with the keys the user has instead of failing
  // preflight for the full trio. Members whose key env is missing are dropped
  // with an explicit note; if NO key is present the full panel flows into
  // preflight, which then names every missing key with a fix hint. Non-selected
  // ensembles are additionally soft: a keyless member is dropped (it would fail
  // its slot anyway) and an ensemble left empty is skipped with a warning
  // rather than failing the launch.
  const panelNotes: string[] = [];
  const hasCredential = (spec: PanelModelSpec): boolean => {
    if (spec.auth !== undefined) return true;
    const provider = spec.provider ?? "mlx";
    if (provider === "mlx") return true;
    const keyEnv = spec.keyEnv ?? defaultKeyEnv(provider);
    if (keyEnv === undefined) return true;
    return (process.env[keyEnv] ?? "").length > 0;
  };
  const skipNote = (spec: PanelModelSpec, ensembleName: string): void => {
    const keyEnv = spec.keyEnv ?? defaultKeyEnv(spec.provider ?? "mlx");
    const where = ensembleName === selected.name ? "panel" : `ensemble ${ensembleName}`;
    panelNotes.push(
      `${where}: ${spec.id} (${spec.model}) skipped — ${keyEnv ?? "its API key"} is not set (export it to add ${spec.id} back)`
    );
  };
  if (options.endpoints === undefined) {
    if (defaultedPanels.has(selected.name) && options.local !== true) {
      const present = selected.models.filter(hasCredential);
      if (present.length > 0 && present.length < selected.models.length) {
        for (const spec of selected.models) {
          if (!hasCredential(spec)) skipNote(spec, selected.name);
        }
        selected.models = present;
      }
    }
    ensembles = ensembles.filter((ensemble) => {
      if (ensemble.name === selected.name) return true;
      const present = ensemble.models.filter(hasCredential);
      if (present.length === ensemble.models.length) return true;
      for (const spec of ensemble.models) {
        if (!hasCredential(spec)) skipNote(spec, ensemble.name);
      }
      if (present.length === 0) {
        panelNotes.push(
          `ensemble ${ensemble.name} (${fusionModelId(ensemble.name)}) skipped — no member has a usable credential`
        );
        return false;
      }
      ensemble.models = present;
      return true;
    });
  }

  // The selected ensemble's panel (preamble, session metadata) and the union of
  // members across every ensemble (one router endpoint each: preflight, key
  // probes, memory sizing, consent, and the stack itself).
  const models = selected.models;
  const unionModels = unionPanelSpecs(ensembles);

  // Cross-platform gating (WS8): a local MLX panel only runs on Apple Silicon.
  // Fail early with a pointer at the cross-platform cloud path instead of
  // crashing deep in the MLX backend on Linux/Windows.
  ensureLocalPanelSupported(unionModels);

  // Fail fast on missing prerequisites before we start spawning a stack.
  runPreflight(preflightRequirements(tool, unionModels, options));

  const spawnsRouter = !(options.endpoints !== undefined && options.synthesisUrl !== undefined);

  // Warm the pinned Python engine in the background as early as possible so a
  // cold uv cache downloads while the user reads the preamble / answers the
  // cost prompt, instead of inside the router's readiness window. Fire and
  // forget: the router's own `uvx` spawn shares the same (locked) cache.
  if (spawnsRouter) {
    void provisionFusionEngine({
      ...(options.fusionkitDir !== undefined ? { fusionkitDir: options.fusionkitDir } : {})
    })
      .then((outcome) => {
        // Name the one-time cold start when it actually happened, so a slow
        // first boot explains itself (and promises speed next time).
        if (outcome.kind === "provisioned") {
          log("fusion: fusion engine provisioned (one-time cold start — future runs boot fast)");
        }
      })
      .catch(() => {});
  }

  // Validate provider keys concurrently with the prompt/boot preamble: a bad
  // key should fail here in ~2s with the env var named, not after the router's
  // 60s readiness timeout. Awaited right before the stack boots.
  const keyValidation = spawnsRouter ? validateProviderKeys(unionModels) : Promise.resolve([]);

  // Size the local (MLX) members against this machine's usable memory,
  // concurrently with the preamble like the key probes. A panel that does not
  // fit gets a warning (not a hard block): the models would load, then be
  // OOM-killed mid-run with only a bare stream error inside the tool. The
  // narration writer only counts when it resolves to a local MLX model (a
  // panel member or provider/model token loads nothing locally).
  const narratorResolution =
    options.reasoningModel !== undefined && options.reasoning !== false
      ? resolveNarratorModel(options.reasoningModel, unionModels)
      : undefined;
  const memoryCheck = spawnsRouter
    ? localPanelMemoryWarning(unionModels, {
        ...(narratorResolution?.kind === "mlx" ? { extraModels: [narratorResolution.model] } : {})
      }).catch(() => undefined)
    : Promise.resolve(undefined);

  // WS4 — durable sessions. The store persists every gateway session under
  // ~/.fusionkit/sessions (or $FUSIONKIT_SESSIONS_DIR) so it survives this
  // CLI process; `--resume <id>`/`--continue` rehydrate one into the new run.
  const sessionStore = new FileSystemSessionStore(defaultSessionsDir());
  let resumeId: string | undefined;
  if (options.resume !== undefined) {
    resumeId = resolveSessionId(sessionStore, options.resume);
    if (resumeId === undefined) {
      log(`fusion: no stored session matches "${options.resume}"; starting fresh.`);
    } else {
      log(`fusion: resuming session ${resumeId}`);
    }
  } else if (options.continueLatest === true) {
    resumeId = sessionStore.list()[0]?.id;
    log(resumeId !== undefined ? `fusion: continuing latest session ${resumeId}` : "fusion: no prior session to continue; starting fresh.");
  }
  const sessionJudgeModel = selected.judgeModel ?? options.judgeModel;
  const sessionMeta: SessionMetaInput = {
    tool,
    repo,
    models: models.map((spec) => ({ id: spec.id, model: spec.model })),
    ...(sessionJudgeModel !== undefined ? { judgeModel: sessionJudgeModel } : {})
  };

  // Bring up the portless session (programmatic RouteStore). Portless is a
  // polish layer, never a hard requirement: when it is off, unavailable (Node <
  // 24), or its proxy isn't running, the session degrades to loopback URLs and
  // logs a one-line hint, so a fresh install always runs out of the box.
  const portless = await createPortlessSession({ enabled: portlessEnabled(options), log });

  const judgeLabel = selected.judgeModel ?? options.judgeModel ?? models[0]?.model ?? "(first panel model)";
  const preambleLines = fusionPreambleLines({
    tool,
    repo,
    models,
    judgeLabel,
    modelLabel,
    ensembles,
    ...(options.endpoints !== undefined ? { endpoints: options.endpoints } : {}),
    ...(options.observe !== undefined ? { observe: options.observe } : {}),
    ...(options.budgetUsd !== undefined ? { budgetUsd: options.budgetUsd } : {}),
    ...(options.onRateLimit !== undefined ? { onRateLimit: options.onRateLimit } : {}),
    ...(resumeId !== undefined ? { resumeId } : {})
  });
  // The live boot checklist only renders on an interactive TTY when the caller
  // did not supply its own log sink (tests/programmatic callers stay on the
  // plain line-log path so their output is deterministic).
  const useBootView = options.log === undefined && isInteractive();
  if (useBootView) {
    // The launch card: the one "you're about to spend money" screen — panel,
    // judge, budget, and session wiring in a single framed block.
    uiStream().write(`\n${brandBanner()}\n\n`);
    uiStream().write(`${box(`fusion · ${tool}`, styledPreambleLines(preambleLines))}\n`);
    for (const note of panelNotes) uiStream().write(`${yellow(glyph.warn())} ${note}\n`);
    uiStream().write("\n");
  } else {
    for (const line of preambleLines) log(`fusion: ${line}`);
    for (const note of panelNotes) log(`fusion: ${note}`);
  }

  // Teardown wiring is registered BEFORE the first spawn so a Ctrl+C during the
  // (potentially slow) boot tears down whatever has already started, instead of
  // orphaning detached child process groups. Resources push their disposer as
  // soon as they exist; cleanup runs them in reverse order, exactly once.
  const disposers: Array<() => Promise<void> | void> = [];
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    for (const dispose of disposers.reverse()) {
      try {
        await dispose();
      } catch {
        // best-effort teardown; never let one disposer block the rest
      }
    }
  };
  let signalled = false;
  const onSignal = (): void => {
    if (signalled) return;
    signalled = true;
    // Never wedge on shutdown: if cleanup stalls (a child ignoring SIGTERM),
    // force-exit after a grace period.
    const forced = setTimeout(() => process.exit(1), 10_000);
    forced.unref();
    void cleanup().then(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  // Out-of-band per-turn status: while the coding agent owns the screen, the
  // only channel that cannot corrupt its TUI is the terminal title.
  const setTerminalTitle = (text: string | undefined): void => {
    const stream = uiStream();
    if (!stream.isTTY) return;
    stream.write(`\u001b]2;${text ?? ""}\u0007`);
  };

  // Run-time incident notices (a panel model server OOM-killed mid-run, a dead
  // router, ...). Before handover they log as ordinary lines; while the coding
  // agent owns the terminal they are queued (and flashed in the terminal
  // title), then printed once the tool exits — so a bare "stream disconnected"
  // inside the tool always gets an explanation on the way out. Every notice is
  // also appended to logs/incidents.log as durable evidence.
  const noticeCounts = new Map<string, number>();
  let passthroughActive = false;
  const notify = (line: string): void => {
    try {
      appendFileSync(join(logsDir, "incidents.log"), `${new Date().toISOString()} ${line}\n`);
    } catch {
      // the notice itself must never fail the run
    }
    noticeCounts.set(line, (noticeCounts.get(line) ?? 0) + 1);
    if (passthroughActive) setTerminalTitle(`fusionkit · ${line}`);
    else log(`fusion: warning: ${line}`);
  };

  // Cost/scope confirmation: the default cloud panel fans every prompt out
  // across multiple frontier models plus a judge. Make that explicit before we
  // spend — once per repo+panel: an interactive approval is persisted, so the
  // prompt is a one-time moment, not a per-run toll. --yes still skips it.
  const spawningCloud =
    options.endpoints === undefined && unionModels.some((model) => (model.provider ?? "mlx") !== "mlx");
  if (useBootView && spawningCloud && options.yes !== true && canPromptInteractively()) {
    if (hasCloudConsent(repo, unionModels)) {
      uiStream().write(`${gray("cloud panel previously approved for this repo — starting.")}\n`);
    } else {
      // Subscription members are billed by the subscription (and subject to its
      // rate limits); API-key members incur per-token provider usage.
      const usesSubscription = unionModels.some((model) => model.auth !== undefined);
      const cost = usesSubscription ? "provider usage / subscription limits apply" : "provider usage applies";
      const proceed = await confirm({
        message: `Run the cloud panel? Each prompt fans out across ${models.length} model(s) + a judge (${cost}).`,
        defaultValue: true
      });
      if (!proceed) {
        uiStream().write(`${gray("aborted — nothing was started.")}\n`);
        return 130;
      }
      recordCloudConsent(repo, unionModels);
      uiStream().write(`${gray("approved — remembered for this repo and panel (won't ask again).")}\n`);
    }
  }

  // A rejected key is a preflight failure: surface it now (the probes ran
  // concurrently with the preamble/prompt above), before anything spawns.
  const keyProblems = await keyValidation;
  if (keyProblems.length > 0) {
    throw new PreflightError(`fusionkit preflight failed:\n${keyProblems.join("\n")}`);
  }

  // Local panel too big for this machine: warn (never block) before the slow
  // model loads start, so a later OOM kill is at least foreshadowed.
  const memoryWarning = await memoryCheck;
  if (memoryWarning !== undefined) {
    if (useBootView) uiStream().write(`${yellow(glyph.warn())} ${memoryWarning}\n`);
    else log(`fusion: warning: ${memoryWarning}`);
  }

  // The live boot checklist, driven by structured stack events. The panel now
  // runs behind a single `fusionkit serve` router (models + synthesis), so the
  // checklist shows one router row instead of one per model; the override path
  // (pre-running endpoints + synthesis) spawns nothing.
  const bootStartedAt = Date.now();
  const boot = useBootView
    ? createBootView({
        servers: spawnsRouter ? [{ id: "router", label: `router · ${unionModels.map((model) => model.id).join(", ")}` }] : [],
        includeSynth: false,
        includeDashboard: options.observe === true,
        title: dim("booting the fusion stack")
      })
    : undefined;
  if (boot !== undefined) disposers.push(() => boot.stop());
  const report: StackReporter | undefined = boot?.report;

  // When --observe is set, boot the dashboard and export the trace env BEFORE
  // anything starts, so the in-process gateway/ensemble/agent emitters and every
  // spawned child (panel servers, synthesis serve, cursor bridge) inherit it.
  // Without the flag, FUSION_TRACE_* stays unset and all emitters are no-ops.
  let observability: Observability | undefined;
  let stack: FusionStack;
  try {
    if (options.observe === true) {
      // The dashboard (apps/scope) ships prebuilt with the npm package (staged
      // by scripts/stage-scope.mjs at release) and is built from source in the
      // monorepo. Either way it is best-effort: a missing or unbuildable
      // dashboard must never block the core fusion run.
      try {
        observability = await startObservability({
          log,
          logFile: join(logsDir, "dashboard.log"),
          portless,
          ...(report !== undefined ? { report } : {})
        });
        disposers.push(() => observability?.close() ?? Promise.resolve());
        process.env.FUSION_TRACE_URL = observability.ingestUrl;
        process.env.FUSION_TRACE_DIR = observability.traceDir;
        if (boot === undefined) {
          log(`fusion: observability dashboard at ${observability.url}`);
          log(`fusion: trace events -> ${observability.ingestUrl} (jsonl fallback in ${observability.traceDir})`);
        }
        openUrl(observability.url);
      } catch (error) {
        observability = undefined;
        const first = (error instanceof Error ? error.message : String(error)).split("\n")[0];
        if (report !== undefined) report({ kind: "dashboard.fail", detail: "unavailable — skipped" });
        else log(`fusion: observability dashboard unavailable; continuing without it (${first})`);
      }
    }

    const panelHarness = toolRegistry.panelHarnessKindFor(tool);
    const stackPrompts = selected.prompts ?? options.prompts;
    const stackJudgeModel = selected.judgeModel ?? options.judgeModel;
    stack = await startFusionStack({
      repo,
      outputRoot: join(root, "runs"),
      models: unionModels,
      ensembles,
      logsDir,
      portless,
      ...(panelHarness !== undefined ? { harness: panelHarness } : {}),
      ...(report !== undefined ? { report } : {}),
      ...(options.endpoints !== undefined ? { endpoints: options.endpoints } : {}),
      ...(options.fusionkitDir !== undefined ? { fusionkitDir: options.fusionkitDir } : {}),
      ...(stackPrompts !== undefined ? { prompts: stackPrompts } : {}),
      ...(stackJudgeModel !== undefined ? { judgeModel: stackJudgeModel } : {}),
      ...(options.synthesisUrl !== undefined ? { synthesisUrl: options.synthesisUrl } : {}),
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.onRateLimit !== undefined ? { onRateLimit: options.onRateLimit } : {}),
      ...(options.budgetUsd !== undefined ? { budgetUsd: options.budgetUsd } : {}),
      ...(options.panelTrust !== undefined ? { panelTrust: options.panelTrust } : {}),
      ...(options.subagents !== undefined ? { subagents: options.subagents } : {}),
      ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
      ...(options.reasoningModel !== undefined ? { reasoningModel: options.reasoningModel } : {}),
      sessionStore,
      sessionMeta,
      ...(resumeId !== undefined ? { resumeId } : {}),
      notify,
      log
    });
    disposers.push(() => stack.close());
  } catch (error) {
    if (boot !== undefined) boot.stop();
    await cleanup();
    throw error;
  }
  // Make speed visible: warm boots (a reused running router) are near-instant,
  // and saying so is what turns caching into a felt feature.
  const bootSeconds = ((Date.now() - bootStartedAt) / 1000).toFixed(1);
  const reusedNote = stack.reusedRouter ? " — reused running engine" : "";
  if (boot !== undefined) {
    // Settle the checklist BEFORE the agent inherits the terminal: the launched
    // coding tool owns the screen from here on, so no live UI may remain.
    boot.stop();
    uiStream().write(
      `${green(glyph.tick())} ${bold("fusion ready")} ${dim(`in ${bootSeconds}s${reusedNote}`)}  ${dim(stack.fusionUrl)} ${dim(`(model: ${modelLabel})`)}\n`
    );
    uiStream().write(`${dim(`logs: ${logsDir}`)}\n`);
    if (observability !== undefined) {
      uiStream().write(`${dim(`dashboard: ${observability.url}`)}\n`);
    } else if (options.observe !== true && tool !== "serve") {
      uiStream().write(`${dim("tip: add --observe to watch every fused turn in a live dashboard")}\n`);
    }
  } else {
    log(`fusion: gateway on ${stack.fusionUrl} (model: ${modelLabel})`);
    log(`fusion: ready in ${bootSeconds}s${reusedNote}`);
    log(`fusion: logs in ${logsDir}`);
  }

  // Hand the terminal to the coding agent cleanly: silence the per-turn gateway
  // chatter (it would corrupt a full-screen agent TUI; trace events still flow
  // to --observe), move turn status to the terminal title, and make sure the
  // cursor is restored.
  // Running spend for the terminal-title ticker and the budget early warning:
  // the only live cost signal the user gets while the agent owns the screen.
  const spendSoFar = (): { usd: number; turns: number } => {
    try {
      const sessions = sessionStore
        .list()
        .filter((session) => session.updatedAt >= bootStartedAt && (session.repo === undefined || session.repo === repo));
      return {
        usd: sessions.reduce(
          (sum, session) => sum + (session.cost?.providerUsd ?? session.cost?.totalUsd ?? 0),
          0
        ),
        turns: sessions.reduce((sum, session) => sum + session.turnCount, 0)
      };
    } catch {
      return { usd: 0, turns: 0 };
    }
  };
  let budgetWarned = false;
  const maybeWarnBudget = (usd: number): void => {
    if (budgetWarned || options.budgetUsd === undefined || options.budgetUsd <= 0) return;
    if (usd >= 0.8 * options.budgetUsd) {
      budgetWarned = true;
      notify(
        `session spend ${formatUsd(usd)} has reached 80% of the $${options.budgetUsd} budget — the session stops at the cap`
      );
    }
  };

  const prepareForPassthrough = (): void => {
    passthroughActive = true;
    setGatewayChatter(false);
    setGatewayStatusSink((status) => {
      switch (status.phase) {
        case "panel":
          setTerminalTitle(`fusionkit · fusing ${status.models.join(" + ")} (turn ${status.turn})`);
          break;
        case "judging":
          setTerminalTitle(
            `fusionkit · judging ${status.candidates} candidate${status.candidates === 1 ? "" : "s"} (turn ${status.turn})`
          );
          break;
        case "idle": {
          const spend = spendSoFar();
          setTerminalTitle(
            spend.turns > 0
              ? `fusionkit · ${spend.turns} turn${spend.turns === 1 ? "" : "s"} · ${formatUsd(spend.usd)} spent`
              : undefined
          );
          maybeWarnBudget(spend.usd);
          break;
        }
        default: {
          const exhaustive: never = status;
          throw new Error(`unknown gateway status: ${String(exhaustive)}`);
        }
      }
    });
    const stream = uiStream();
    if (stream.isTTY) stream.write("\u001b[?25h");
  };
  disposers.push(() => {
    setGatewayStatusSink(undefined);
    setTerminalTitle(undefined);
  });

  try {
    if (tool === "serve") {
      log("");
      log(gatewaySetupSnippets(stack.fusionUrl, "http://127.0.0.1:<cursorkit-port>"));
      log("");
      log("Gateway is running. Point any tool at it, or Ctrl+C to stop.");
      await new Promise<void>(() => {
        /* run until interrupted */
      });
      return 0;
    }
    const integration = toolRegistry.get(tool);
    if (integration === undefined || !integration.modes.includes("fusion")) {
      throw new Error(`unknown fusion tool: ${String(tool)}`);
    }
    const ctx: ToolLaunchContext = {
      mode: "fusion",
      gatewayUrl: stack.fusionUrl,
      modelLabel,
      fusedModels: ensembles.map((ensemble) => fusionModelId(ensemble.name)),
      // The detail sub-agent auto-provisioning needs: each launcher defines one
      // native sub-agent per ensemble from this list (session default first).
      fusedEnsembles: ensembles.map((ensemble) => ({
        name: ensemble.name,
        modelId: fusionModelId(ensemble.name),
        memberIds: ensemble.models.map((spec) => spec.id),
        ...(ensemble.judgeModel !== undefined ? { judgeModel: ensemble.judgeModel } : {})
      })),
      ...(options.subagents !== undefined ? { subagents: options.subagents } : {}),
      nativeModels: [...new Set(unionModels.map((spec) => spec.model))],
      toolArgs,
      repo,
      ...(options.ide === true ? { ide: true } : {}),
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
      ...(portless.caCertPath !== undefined ? { caCertPath: portless.caCertPath } : {}),
      logsDir,
      log,
      prepareForPassthrough,
      registerPort: (name, port) => portless.register(name, port),
      unregisterPort: (name) => portless.unregister(name),
      registerDisposer: (dispose) => disposers.push(dispose)
    };
    const launchedAt = Date.now();
    const code = await integration.launch(ctx);
    passthroughActive = false;
    // Incidents that happened while the agent owned the terminal (an OOM-killed
    // panel server, a dead router): the tool could only show a bare stream
    // error, so explain what actually happened now that we have the screen back.
    // Best-effort: a notice failure must never change the exit code.
    try {
      if (noticeCounts.size > 0) {
        const noticeLines = [...noticeCounts.entries()].map(
          ([line, count]) => (count > 1 ? `${line} (x${count})` : line)
        );
        if (useBootView) {
          uiStream().write("\n");
          for (const line of noticeLines) uiStream().write(`${yellow(glyph.warn())} ${line}\n`);
          uiStream().write(`${dim(`incident log: ${join(logsDir, "incidents.log")}`)}\n`);
        } else {
          for (const line of noticeLines) log(`fusion: warning: ${line}`);
        }
      }
    } catch {
      // never let notices mask the tool's exit
    }
    // The end-of-run receipt: the engine worked invisibly while the agent owned
    // the terminal — this is the one place we say what it actually did.
    // Best-effort: a receipt failure must never change the exit code.
    try {
      const receiptSessions = sessionStore
        .list()
        .filter(
          (session) =>
            session.updatedAt >= launchedAt &&
            (session.repo === undefined || session.repo === repo) &&
            (session.tool === undefined || session.tool === tool)
        );
      const receipt = sessionReceiptLines(receiptSessions, {
        elapsedMs: Date.now() - launchedAt,
        tool
      });
      if (receipt.length > 0) {
        if (useBootView) {
          // The receipt is the screen users judge the run by: frame it, and
          // always end on the copy-pasteable resume command.
          const body = receipt.map((line, index) => {
            if (index === 0) return `${green(glyph.tick())} ${bold(line)}`;
            const resume = line.match(/^resume this session: (.+)$/);
            if (resume !== null) return `${dim("resume:")} ${cyan(resume[1] ?? "")}`;
            return dim(line);
          });
          uiStream().write(`\n${box("fusion receipt", body)}\n`);
        } else {
          for (const line of receipt) log(`fusion: ${line}`);
        }
      }
    } catch {
      // never let the receipt mask the tool's exit
    }
    return code;
  } finally {
    await cleanup();
  }
}

/**
 * Selectable fusion tools (registry-derived launchers + the `serve`
 * pseudo-tool), shared by every tool picker (`pickTool`, the init wizard).
 */
export function toolSelectOptions(): Array<{ value: FusionTool; label: string; hint: string }> {
  return [
    ...toolRegistry.launchableFusion().map((tool) => ({
      value: tool.id,
      label: tool.id,
      hint: tool.pickerHint
    })),
    { value: "serve" as FusionTool, label: "serve", hint: "just run the gateway and print setup" }
  ];
}

/** Interactive tool picker for when no `--tool` was provided on a TTY. */
export async function pickTool(): Promise<FusionTool> {
  return select<FusionTool>({
    message: "Which coding agent should model fusion back?",
    options: toolSelectOptions(),
    defaultIndex: 0
  });
}
