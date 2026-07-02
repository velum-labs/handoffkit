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

import { FUSION_PANEL_MODEL } from "@fusionkit/tools";
import type { ToolLaunchContext } from "@fusionkit/tools";
import { defaultSessionsDir, FileSystemSessionStore, formatUsd } from "@fusionkit/model-gateway";
import type { SessionMetaInput, SessionSummary } from "@fusionkit/model-gateway";

import { resolveSessionId } from "./commands/sessions.js";
import { gatewaySetupSnippets, setGatewayChatter, setGatewayStatusSink } from "./gateway.js";
import { toolRegistry } from "./tools.js";
import { createPortlessSession } from "./shared/portless.js";
import { PreflightError, runPreflight } from "./shared/preflight.js";
import { createBootView } from "./ui/boot.js";
import { confirm, select } from "./ui/prompt.js";
import { canPromptInteractively, isInteractive, uiStream } from "./ui/runtime.js";
import { bold, brandBanner, dim, glyph, gray, green, yellow } from "./ui/theme.js";

import { hasCloudConsent, recordCloudConsent } from "./fusion/consent.js";
import {
  DEFAULT_CLOUD_PANEL,
  DEFAULT_TRIO,
  defaultKeyEnv,
  gitToplevel,
  loadEnvFileInto
} from "./fusion/env.js";
import type { FusionTool, PanelModelSpec, RunFusionOptions, StackReporter } from "./fusion/env.js";
import { openUrl, startObservability } from "./fusion/observability.js";
import type { Observability } from "./fusion/observability.js";
import { ensureLocalPanelSupported } from "./fusion/platform.js";
import { provisionFusionEngine } from "./fusion/provision.js";
import { resolveNarratorModel, startFusionStack } from "./fusion/stack.js";
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

/** The model label the launched tool uses; the gateway ignores it for routing. */
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
  switch (tool) {
    case "codex":
      return "codex auth: ephemeral CODEX_HOME -> FusionKit local provider (Responses; requires_openai_auth=false)";
    case "serve":
      return undefined;
    default:
      return `${tool} auth: FusionKit gateway provider`;
  }
}

export function fusionPreambleLines(input: {
  tool: FusionTool;
  repo: string;
  models: readonly PanelModelSpec[];
  judgeLabel: string;
  endpoints?: Record<string, string>;
  observe?: boolean;
  budgetUsd?: number;
  onRateLimit?: RunFusionOptions["onRateLimit"];
  resumeId?: string;
}): string[] {
  const lines = [
    `tool: ${input.tool} -> FusionKit gateway`,
    `model: ${FUSION_MODEL_LABEL}`,
    `repo: ${input.repo}`,
    `judge: ${input.judgeLabel}`,
    `panel: ${input.models.map((model) => panelMemberSummary(model, input.endpoints)).join(", ")}`
  ];
  const auth = toolAuthSummary(input.tool);
  if (auth !== undefined) lines.splice(1, 0, auth);
  if (input.resumeId !== undefined) lines.push(`resume: ${input.resumeId}`);
  if (input.observe === true) lines.push("observe: on");
  if (input.budgetUsd !== undefined) lines.push(`budget: $${input.budgetUsd}`);
  if (input.onRateLimit !== undefined) lines.push(`rate limits: ${input.onRateLimit}`);
  return lines;
}

/** Compact human elapsed time, e.g. `42s` or `4m07s`. */
function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * The end-of-run receipt: what the fusion engine actually did while the coding
 * agent owned the terminal (fused turns, gateway-observed spend, how to resume).
 * Empty when no turns were recorded (nothing to report). Exported for tests.
 */
export function sessionReceiptLines(
  sessions: readonly SessionSummary[],
  input: { elapsedMs: number; tool: FusionTool }
): string[] {
  const turns = sessions.reduce((sum, session) => sum + session.turnCount, 0);
  if (turns === 0) return [];
  const totalUsd = sessions.reduce((sum, session) => sum + (session.cost?.totalUsd ?? 0), 0);
  const totalTokens = sessions.reduce((sum, session) => sum + (session.cost?.totalTokens ?? 0), 0);
  const metered = sessions.reduce((sum, session) => sum + (session.cost?.meteredTurns ?? 0), 0);
  const unknown = sessions.reduce((sum, session) => sum + (session.cost?.unknownCostTurns ?? 0), 0);
  const lines = [
    `fusion session complete — ${turns} fused turn(s) in ${formatElapsed(input.elapsedMs)}`
  ];
  const spend =
    metered > 0
      ? `${formatUsd(totalUsd)}${unknown > 0 ? ` (+${unknown} unmetered turn(s))` : ""}`
      : "unknown (no usage metered)";
  const tokens = totalTokens > 0 ? ` · ${totalTokens.toLocaleString("en-US")} tokens` : "";
  lines.push(`spend (gateway-observed): ${spend}${tokens}`);
  const latest = sessions[0];
  if (latest !== undefined) {
    lines.push(`resume this session: fusionkit ${input.tool} --resume ${latest.id.slice(0, 8)}`);
  }
  return lines;
}

export async function runFusion(
  tool: FusionTool,
  toolArgs: string[],
  options: RunFusionOptions = {}
): Promise<number> {
  const log = options.log ?? ((line: string) => console.error(line));
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
  let models = options.models ?? (options.local === true ? [...DEFAULT_TRIO] : [...DEFAULT_CLOUD_PANEL]);

  // Adaptive default panel: when the user did not pick a panel themselves,
  // work with the keys they have instead of failing preflight for the full
  // trio. Members whose key env is missing are dropped with an explicit note;
  // if NO key is present the full panel flows into preflight, which then names
  // every missing key with a fix hint.
  const panelNotes: string[] = [];
  if (options.models === undefined && options.local !== true && options.endpoints === undefined) {
    const hasCredential = (spec: PanelModelSpec): boolean => {
      if (spec.auth !== undefined) return true;
      const provider = spec.provider ?? "mlx";
      if (provider === "mlx") return true;
      const keyEnv = spec.keyEnv ?? defaultKeyEnv(provider);
      if (keyEnv === undefined) return true;
      return (process.env[keyEnv] ?? "").length > 0;
    };
    const present = models.filter(hasCredential);
    if (present.length > 0 && present.length < models.length) {
      for (const spec of models) {
        if (hasCredential(spec)) continue;
        const keyEnv = spec.keyEnv ?? defaultKeyEnv(spec.provider ?? "mlx");
        panelNotes.push(
          `panel: ${spec.id} (${spec.model}) skipped — ${keyEnv ?? "its API key"} is not set (export it to add ${spec.id} back)`
        );
      }
      models = present;
    }
  }

  // Cross-platform gating (WS8): a local MLX panel only runs on Apple Silicon.
  // Fail early with a pointer at the cross-platform cloud path instead of
  // crashing deep in the MLX backend on Linux/Windows.
  ensureLocalPanelSupported(models);

  // Fail fast on missing prerequisites before we start spawning a stack.
  runPreflight(preflightRequirements(tool, models, options));

  const spawnsRouter = !(options.endpoints !== undefined && options.synthesisUrl !== undefined);

  // Warm the pinned Python engine in the background as early as possible so a
  // cold uv cache downloads while the user reads the preamble / answers the
  // cost prompt, instead of inside the router's readiness window. Fire and
  // forget: the router's own `uvx` spawn shares the same (locked) cache.
  if (spawnsRouter) {
    void provisionFusionEngine({
      ...(options.fusionkitDir !== undefined ? { fusionkitDir: options.fusionkitDir } : {})
    }).catch(() => {});
  }

  // Validate provider keys concurrently with the prompt/boot preamble: a bad
  // key should fail here in ~2s with the env var named, not after the router's
  // 60s readiness timeout. Awaited right before the stack boots.
  const keyValidation = spawnsRouter ? validateProviderKeys(models) : Promise.resolve([]);

  // Size the local (MLX) members against this machine's usable memory,
  // concurrently with the preamble like the key probes. A panel that does not
  // fit gets a warning (not a hard block): the models would load, then be
  // OOM-killed mid-run with only a bare stream error inside the tool. The
  // narration writer only counts when it resolves to a local MLX model (a
  // panel member or provider/model token loads nothing locally).
  const narratorResolution =
    options.reasoningModel !== undefined && options.reasoning !== false
      ? resolveNarratorModel(options.reasoningModel, models)
      : undefined;
  const memoryCheck = spawnsRouter
    ? localPanelMemoryWarning(models, {
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
  const sessionMeta: SessionMetaInput = {
    tool,
    repo,
    models: models.map((spec) => ({ id: spec.id, model: spec.model })),
    ...(options.judgeModel !== undefined ? { judgeModel: options.judgeModel } : {})
  };

  // Bring up the portless session (programmatic RouteStore). Portless is a
  // polish layer, never a hard requirement: when it is off, unavailable (Node <
  // 24), or its proxy isn't running, the session degrades to loopback URLs and
  // logs a one-line hint, so a fresh install always runs out of the box.
  const portless = await createPortlessSession({ enabled: portlessEnabled(options), log });

  const judgeLabel = options.judgeModel ?? models[0]?.model ?? "(first panel model)";
  const preambleLines = fusionPreambleLines({
    tool,
    repo,
    models,
    judgeLabel,
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
    uiStream().write(`\n${brandBanner()}\n`);
    uiStream().write(`${preambleLines.join("\n")}\n`);
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
    options.endpoints === undefined && models.some((model) => (model.provider ?? "mlx") !== "mlx");
  if (useBootView && spawningCloud && options.yes !== true && canPromptInteractively()) {
    if (hasCloudConsent(repo, models)) {
      uiStream().write(`${gray("cloud panel previously approved for this repo — starting.")}\n`);
    } else {
      // Subscription members are billed by the subscription (and subject to its
      // rate limits); API-key members incur per-token provider usage.
      const usesSubscription = models.some((model) => model.auth !== undefined);
      const cost = usesSubscription ? "provider usage / subscription limits apply" : "provider usage applies";
      const proceed = await confirm({
        message: `Run the cloud panel? Each prompt fans out across ${models.length} model(s) + a judge (${cost}).`,
        defaultValue: true
      });
      if (!proceed) {
        uiStream().write(`${gray("aborted — nothing was started.")}\n`);
        return 130;
      }
      recordCloudConsent(repo, models);
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
        servers: spawnsRouter ? [{ id: "router", label: `router · ${models.map((model) => model.id).join(", ")}` }] : [],
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
      // The dashboard (apps/scope) is a dev/monorepo-only app and is NOT bundled
      // with the npm package, so it is best-effort: a missing or unbuildable
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
    stack = await startFusionStack({
      repo,
      outputRoot: join(root, "runs"),
      models,
      logsDir,
      portless,
      ...(panelHarness !== undefined ? { harness: panelHarness } : {}),
      ...(report !== undefined ? { report } : {}),
      ...(options.endpoints !== undefined ? { endpoints: options.endpoints } : {}),
      ...(options.fusionkitDir !== undefined ? { fusionkitDir: options.fusionkitDir } : {}),
      ...(options.prompts !== undefined ? { prompts: options.prompts } : {}),
      ...(options.judgeModel !== undefined ? { judgeModel: options.judgeModel } : {}),
      ...(options.synthesisUrl !== undefined ? { synthesisUrl: options.synthesisUrl } : {}),
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.onRateLimit !== undefined ? { onRateLimit: options.onRateLimit } : {}),
      ...(options.budgetUsd !== undefined ? { budgetUsd: options.budgetUsd } : {}),
      ...(options.panelTrust !== undefined ? { panelTrust: options.panelTrust } : {}),
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
      `${green(glyph.tick())} ${bold("fusion ready")} ${dim(`in ${bootSeconds}s${reusedNote}`)}  ${dim(stack.fusionUrl)} ${dim(`(model: ${FUSION_MODEL_LABEL})`)}\n`
    );
    uiStream().write(`${dim(`logs: ${logsDir}`)}\n`);
    if (observability !== undefined) {
      uiStream().write(`${dim(`dashboard: ${observability.url}`)}\n`);
    } else if (options.observe !== true && tool !== "serve") {
      uiStream().write(`${dim("tip: add --observe to watch every fused turn in a live dashboard")}\n`);
    }
  } else {
    log(`fusion: gateway on ${stack.fusionUrl} (model: ${FUSION_MODEL_LABEL})`);
    log(`fusion: ready in ${bootSeconds}s${reusedNote}`);
    log(`fusion: logs in ${logsDir}`);
  }

  // Hand the terminal to the coding agent cleanly: silence the per-turn gateway
  // chatter (it would corrupt a full-screen agent TUI; trace events still flow
  // to --observe), move turn status to the terminal title, and make sure the
  // cursor is restored.
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
        case "idle":
          setTerminalTitle(undefined);
          break;
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
      modelLabel: FUSION_MODEL_LABEL,
      nativeModels: models.map((spec) => spec.model),
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
          uiStream().write(`\n${green(glyph.tick())} ${bold(receipt[0] ?? "")}\n`);
          for (const line of receipt.slice(1)) uiStream().write(`  ${dim(line)}\n`);
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

/** Interactive tool picker for when no `--tool` was provided on a TTY. */
export async function pickTool(): Promise<FusionTool> {
  return select<FusionTool>({
    message: "Which coding agent should model fusion back?",
    options: [
      ...toolRegistry.launchableFusion().map((tool) => ({
        value: tool.id,
        label: tool.id,
        hint: tool.pickerHint
      })),
      { value: "serve", label: "serve", hint: "just run the gateway and print setup" }
    ],
    defaultIndex: 0
  });
}
