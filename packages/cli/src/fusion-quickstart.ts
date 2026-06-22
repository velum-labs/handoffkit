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

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FUSION_PANEL_MODEL } from "@fusionkit/tools";
import type { ToolLaunchContext } from "@fusionkit/tools";

import { gatewaySetupSnippets, setGatewayChatter } from "./gateway.js";
import { toolRegistry } from "./tools.js";
import { createPortlessSession } from "./shared/portless.js";
import { runPreflight } from "./shared/preflight.js";
import { createBootView } from "./ui/boot.js";
import { confirm, select } from "./ui/prompt.js";
import { canPromptInteractively, isInteractive, uiStream } from "./ui/runtime.js";
import { bold, brandBanner, dim, glyph, gray, green } from "./ui/theme.js";

import {
  DEFAULT_CLOUD_PANEL,
  DEFAULT_TRIO,
  gitToplevel,
  loadEnvFileInto
} from "./fusion/env.js";
import type { FusionTool, RunFusionOptions, StackReporter } from "./fusion/env.js";
import { openUrl, startObservability } from "./fusion/observability.js";
import type { Observability } from "./fusion/observability.js";
import { startFusionStack } from "./fusion/stack.js";
import type { FusionStack } from "./fusion/stack.js";
import { preflightRequirements } from "./fusion/preflight.js";

export * from "./fusion/env.js";
export * from "./fusion/observability.js";
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
  const models = options.models ?? (options.local === true ? [...DEFAULT_TRIO] : [...DEFAULT_CLOUD_PANEL]);

  // Fail fast on missing prerequisites before we start spawning a stack.
  runPreflight(preflightRequirements(tool, models, options));

  // Bring up the portless session (programmatic RouteStore). Portless is a
  // polish layer, never a hard requirement: when it is off, unavailable (Node <
  // 24), or its proxy isn't running, the session degrades to loopback URLs and
  // logs a one-line hint, so a fresh install always runs out of the box.
  const portless = await createPortlessSession({ enabled: portlessEnabled(options), log });

  const judgeLabel = options.judgeModel ?? models[0]?.model ?? "(first panel model)";
  // The live boot checklist only renders on an interactive TTY when the caller
  // did not supply its own log sink (tests/programmatic callers stay on the
  // plain line-log path so their output is deterministic).
  const useBootView = options.log === undefined && isInteractive();
  if (useBootView) {
    uiStream().write(`\n${brandBanner()}\n`);
    uiStream().write(
      `${dim("panel:")} ${models.map((model) => model.id).join(", ")}   ` +
        `${dim("judge:")} ${judgeLabel}   ${dim("repo:")} ${repo}\n\n`
    );
  } else {
    log(`fusion: panel = ${models.map((model) => model.id).join(", ")}`);
    log(`fusion: repo = ${repo}`);
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

  // Cost/scope confirmation: the default cloud panel fans every prompt out
  // across multiple frontier models plus a judge. Make that explicit before we
  // spend, unless --yes was passed or we are not on an interactive TTY.
  const spawningCloud =
    options.endpoints === undefined && models.some((model) => (model.provider ?? "mlx") !== "mlx");
  if (useBootView && spawningCloud && options.yes !== true && canPromptInteractively()) {
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
  }

  // The live boot checklist, driven by structured stack events. The panel now
  // runs behind a single `fusionkit serve` router (models + synthesis), so the
  // checklist shows one router row instead of one per model; the override path
  // (pre-running endpoints + synthesis) spawns nothing.
  const spawnsRouter = !(options.endpoints !== undefined && options.synthesisUrl !== undefined);
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

    stack = await startFusionStack({
      repo,
      outputRoot: join(root, "runs"),
      models,
      logsDir,
      portless,
      ...(report !== undefined ? { report } : {}),
      ...(options.endpoints !== undefined ? { endpoints: options.endpoints } : {}),
      ...(options.fusionkitDir !== undefined ? { fusionkitDir: options.fusionkitDir } : {}),
      ...(options.prompts !== undefined ? { prompts: options.prompts } : {}),
      ...(options.judgeModel !== undefined ? { judgeModel: options.judgeModel } : {}),
      ...(options.synthesisUrl !== undefined ? { synthesisUrl: options.synthesisUrl } : {}),
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      log
    });
    disposers.push(() => stack.close());
  } catch (error) {
    if (boot !== undefined) boot.stop();
    await cleanup();
    throw error;
  }
  if (boot !== undefined) {
    // Settle the checklist BEFORE the agent inherits the terminal: the launched
    // coding tool owns the screen from here on, so no live UI may remain.
    boot.stop();
    uiStream().write(
      `${green(glyph.tick())} ${bold("fusion ready")}  ${dim(stack.fusionUrl)} ${dim(`(model: ${FUSION_MODEL_LABEL})`)}\n`
    );
    uiStream().write(`${dim(`logs: ${logsDir}`)}\n`);
    if (observability !== undefined) {
      uiStream().write(`${dim(`dashboard: ${observability.url}`)}\n`);
    }
  } else {
    log(`fusion: gateway on ${stack.fusionUrl} (model: ${FUSION_MODEL_LABEL})`);
    log(`fusion: logs in ${logsDir}`);
  }

  // Hand the terminal to the coding agent cleanly: silence the per-turn gateway
  // chatter (it would corrupt a full-screen agent TUI; trace events still flow
  // to --observe) and make sure the cursor is restored.
  const prepareForPassthrough = (): void => {
    setGatewayChatter(false);
    const stream = uiStream();
    if (stream.isTTY) stream.write("\u001b[?25h");
  };

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
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
      ...(portless.caCertPath !== undefined ? { caCertPath: portless.caCertPath } : {}),
      logsDir,
      log,
      prepareForPassthrough,
      registerPort: (name, port) => portless.register(name, port),
      unregisterPort: (name) => portless.unregister(name),
      registerDisposer: (dispose) => disposers.push(dispose)
    };
    return await integration.launch(ctx);
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
