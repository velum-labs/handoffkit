/**
 * The fusion model stack: the single `fusionkit serve` router that fronts every
 * panel model plus synthesis, and the in-process gateway that turns it into the
 * judge-streamed-trajectory front door.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stringify } from "yaml";

import { KernelBackend } from "@fusionkit/ensemble";
import type { EnsembleModel, PanelTrust, UnifiedHarnessKind } from "@fusionkit/ensemble";
import { fusionModelId, providerForAuthMode } from "@fusionkit/registry";
import { createChatNarrationWriter, MlxBackend, OpenAiBackend, startGateway } from "@fusionkit/model-gateway";
import type {
  Gateway,
  LocalComputePricing,
  ModelPricing,
  NarrationWriter,
  OnRateLimitPolicy,
  SessionMetaInput,
  SessionStore
} from "@fusionkit/model-gateway";

import { startFusionStepGateway } from "../gateway.js";
import type { GatewayEnsembleConfig, GatewayRunnerConfig } from "../gateway.js";
import { CliError } from "../shared/errors.js";
import { createPortlessSession } from "../shared/portless.js";
import type { PortlessSession } from "../shared/portless.js";
import { reservePort, spawnLogged, terminate, waitForHttp } from "../shared/proc.js";

import { PROMPT_CONFIG_KEY, PROMPT_IDS } from "../fusion-config.js";
import type { PromptOverrides } from "../fusion-config.js";

import {
  defaultKeyEnv,
  fusionkitPyCommand,
  loadEnvFileInto,
  PANEL_AUTH_MODES,
  PANEL_PROVIDERS,
  panelProviderForAuthMode,
  providerDefaultBaseUrl
} from "./env.js";
import type { EnsembleRunSpec, PanelAuthMode, PanelModelSpec, PanelProvider, StackReporter } from "./env.js";
import { detectHost } from "./local-catalog.js";

/**
 * The single `fusionkit serve` router: one process that fronts every panel
 * model (passthrough, routed by the endpoint id in the request `model` field)
 * and also performs trajectory synthesis. `endpoints` maps each panel id to the
 * router URL so the harness reaches its model through the one base URL.
 */
export type Router = {
  url: string;
  port: number;
  /** The router process pid (owns its portless route across runs). */
  pid?: number;
  endpoints: Record<string, string>;
  models: EnsembleModel[];
  /** The endpoint id used as the judge/synthesizer. */
  judgeModel: string;
  /** Config-hash discover-or-spawn identity token (see computeRouterIdentity). */
  identity: string;
  close: () => Promise<void>;
};

// TODO(@000alen): looks very brittle; replace with classify_provider_error/ProviderCallError-style startup classification.
/**
 * Heuristic: does the captured output indicate a permanent failure (bad key,
 * inaccessible model) that a retry cannot fix? Used to fail fast with a clear
 * message instead of burning the retry budget on a hopeless start.
 */
function looksPermanentFailure(log: string): boolean {
  return /401|403|invalid[ _-]?api[ _-]?key|unauthorized|forbidden|authentication|permission|model[^\n]*(not found|does not exist)|no such model|model_not_found/i.test(
    log
  );
}

/**
 * A run-time incident notice sink. While a coding agent owns the terminal
 * the launcher queues these (and flashes the terminal title); before handover
 * they go straight to the log line sink.
 */
export type StackNotify = (line: string) => void;

/**
 * Classify a crashed local server process into a one-line, actionable notice.
 * A SIGKILL (or a signal-death with no exit code) on macOS almost always means
 * the OS killed the process under memory pressure — the dominant failure mode
 * for local MLX panels — so say "out of memory" and how to fix it instead of
 * leaving the user with a bare stream-disconnect error in their tool.
 */
export function describeServerCrash(input: {
  label: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** What happens next (defaults to the managed-server restart behavior). */
  consequence?: string;
  logPath?: string;
}): string {
  const oomLikely = input.signal === "SIGKILL" || input.exitCode === null;
  const cause =
    input.signal !== null ? `killed by ${input.signal}` : `exited with code ${input.exitCode ?? "unknown"}`;
  const consequence = input.consequence ?? "it restarts on the next turn";
  const logHint = input.logPath !== undefined ? ` Details: ${input.logPath}.` : "";
  if (oomLikely) {
    return (
      `${input.label} was ${cause} mid-run — likely out of memory; ${consequence}. ` +
      `Try a smaller model or quant (see \`fusionkit models\`).${logHint}`
    );
  }
  return `${input.label} crashed mid-run (${cause}); ${consequence}.${logHint}`;
}

/** Pick the panel spec that backs the judge (by member id or model name), else the first. */
function judgeSpecFor(specs: readonly PanelModelSpec[], judgeModel: string | undefined): PanelModelSpec {
  const first = specs[0];
  if (first === undefined) throw new Error("at least one panel model is required");
  if (judgeModel === undefined) return first;
  return specs.find((spec) => spec.id === judgeModel || spec.model === judgeModel) ?? first;
}

/**
 * Lower a resolved ensemble list into the gateway's per-ensemble routing config:
 * each ensemble's advertised model id, its members, its judge/synthesizer
 * endpoint ids (router routing is by endpoint id), the judge's model name (WS7
 * cost attribution), and its prompt overrides.
 */
export function gatewayEnsembleConfigs(ensembles: readonly EnsembleRunSpec[]): GatewayEnsembleConfig[] {
  return ensembles.map((ensemble) => {
    const judgeSpec = judgeSpecFor(ensemble.models, ensemble.judgeModel);
    const synthSpec =
      ensemble.synthesizerModel !== undefined
        ? judgeSpecFor(ensemble.models, ensemble.synthesizerModel)
        : undefined;
    return {
      name: ensemble.name,
      modelId: fusionModelId(ensemble.name),
      models: ensemble.models.map((spec) => ({ id: spec.id, model: spec.model })),
      judgeEndpointId: judgeSpec.id,
      judgeModelName: judgeSpec.model,
      ...(synthSpec !== undefined ? { synthesizerEndpointId: synthSpec.id } : {}),
      ...(ensemble.k !== undefined ? { k: ensemble.k } : {}),
      ...(ensemble.prompts !== undefined && Object.keys(ensemble.prompts).length > 0
        ? { prompts: ensemble.prompts }
        : {})
    };
  });
}

/**
 * The union of panel members across ensembles, deduped by member id. A member
 * id shared by two ensembles must be the identical spec (one router endpoint
 * per id), otherwise this throws with the conflicting id named.
 */
export function unionPanelSpecs(ensembles: readonly EnsembleRunSpec[]): PanelModelSpec[] {
  const byId = new Map<string, PanelModelSpec>();
  const union: PanelModelSpec[] = [];
  for (const ensemble of ensembles) {
    for (const spec of ensemble.models) {
      const existing = byId.get(spec.id);
      if (existing === undefined) {
        byId.set(spec.id, spec);
        union.push(spec);
        continue;
      }
      if (!samePanelSpec(existing, spec)) {
        throw new Error(
          `panel member id "${spec.id}" is defined differently across ensembles; ` +
            `give the variants distinct ids (each id becomes one router endpoint)`
        );
      }
    }
  }
  return union;
}

function samePanelSpec(a: PanelModelSpec, b: PanelModelSpec): boolean {
  return (
    a.model === b.model &&
    (a.provider ?? "mlx") === (b.provider ?? "mlx") &&
    a.baseUrl === b.baseUrl &&
    a.keyEnv === b.keyEnv &&
    a.auth === b.auth
  );
}

/** The router endpoint id reserved for a dedicated narration-writer model. */
export const NARRATOR_ENDPOINT_ID = "narrator";

/**
 * Cloud providers a `provider/model` narrator token can name: every provider
 * with an API key env in the provider registry (openai/anthropic/google/
 * openrouter — local and openai-compatible endpoints have no ambient key).
 */
const NARRATOR_CLOUD_PROVIDERS = new Set<PanelProvider>(
  (PANEL_PROVIDERS as readonly PanelProvider[]).filter(
    (provider) => defaultKeyEnv(provider) !== undefined
  )
);

/**
 * How a `--reasoning-model` value is served:
 * - `endpoint`: it names a panel member (by id or model), so the writer reuses
 *   that member's existing router endpoint.
 * - `extra-endpoint`: a `provider/model` token (`openai/gpt-5.5-mini`,
 *   `claude-code/claude-haiku-4-5`, ...) served by a dedicated `narrator`
 *   endpoint added to the router config (cloud endpoints are config-only, so
 *   router startup cost is unchanged).
 * - `mlx`: anything else is a local MLX model path (the historical behavior),
 *   booted directly on Apple Silicon.
 */
export type NarratorResolution =
  | { kind: "endpoint"; endpointId: string }
  | { kind: "extra-endpoint"; spec: PanelModelSpec }
  | { kind: "mlx"; model: string };

/** Resolve a `--reasoning-model` value against the panel (see {@link NarratorResolution}). */
export function resolveNarratorModel(
  reasoningModel: string,
  specs: readonly PanelModelSpec[]
): NarratorResolution {
  const member = specs.find((spec) => spec.id === reasoningModel || spec.model === reasoningModel);
  if (member !== undefined) return { kind: "endpoint", endpointId: member.id };
  const slash = reasoningModel.indexOf("/");
  if (slash > 0 && slash < reasoningModel.length - 1) {
    const prefix = reasoningModel.slice(0, slash);
    const model = reasoningModel.slice(slash + 1);
    if (NARRATOR_CLOUD_PROVIDERS.has(prefix as PanelProvider)) {
      const provider = prefix as PanelProvider;
      const keyEnv = defaultKeyEnv(provider);
      return {
        kind: "extra-endpoint",
        spec: {
          id: NARRATOR_ENDPOINT_ID,
          model,
          provider,
          ...(keyEnv !== undefined ? { keyEnv } : {})
        }
      };
    }
    // Subscription prefixes reuse the local CLI login, like panel members do;
    // the auth-mode -> provider mapping comes from the subscription registry.
    if ((PANEL_AUTH_MODES as readonly string[]).includes(prefix)) {
      const auth = prefix as PanelAuthMode;
      const authProvider = panelProviderForAuthMode(auth);
      return {
        kind: "extra-endpoint",
        spec: {
          id: NARRATOR_ENDPOINT_ID,
          model,
          ...(authProvider !== undefined ? { provider: authProvider } : {}),
          auth
        }
      };
    }
  }
  // A bare HF-style path (e.g. mlx-community/Qwen3-1.7B-4bit): local MLX.
  return { kind: "mlx", model: reasoningModel };
}

/** Hash the full effective router config so reuse only happens when nothing material changed. */
export function computeRouterIdentity(input: {
  specs: readonly PanelModelSpec[];
  extraSpecs?: readonly PanelModelSpec[];
  judgeId: string;
  prompts?: PromptOverrides;
  mlxUrls: Record<string, string>;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = input.env ?? process.env;
  const presentKeyEnvs = [
    ...new Set(
      [...input.specs, ...(input.extraSpecs ?? [])].flatMap((spec) => {
        const provider = spec.provider ?? "mlx";
        const keyEnv = spec.keyEnv ?? defaultKeyEnv(provider);
        return keyEnv !== undefined && (env[keyEnv] ?? "").length > 0 ? [keyEnv] : [];
      })
    )
  ].sort();
  const payload = {
    endpoints: [...input.specs, ...(input.extraSpecs ?? [])].map((spec) => ({
      id: spec.id,
      model: spec.model,
      provider: spec.provider ?? "mlx",
      baseUrl: spec.baseUrl,
      keyEnv: spec.keyEnv,
      auth: spec.auth,
      pricing: spec.pricing,
      mlxUrl: input.mlxUrls[spec.id]
    })),
    judgeId: input.judgeId,
    prompts: input.prompts ?? {},
    presentKeyEnvs,
    sampling: { temperature: 0.2, top_p: 0.9, max_tokens: 8192 }
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

function routerDiscoverIdentity(input: {
  specs: readonly PanelModelSpec[];
  extraSpecs?: readonly PanelModelSpec[];
  judgeId: string;
  prompts?: PromptOverrides;
  mlxUrls: Record<string, string>;
  env?: NodeJS.ProcessEnv;
}): string {
  const idPart = [...input.specs, ...(input.extraSpecs ?? [])]
    .map((spec) => spec.id)
    .sort()
    .join(",");
  return `${computeRouterIdentity(input)}:${idPart}`;
}

/**
 * Build the `fusionkit serve` config (YAML) for the consolidated router: one
 * endpoint per panel model. Cloud models call their provider directly (keyed by
 * `api_key_env`); MLX models are fronted as `openai-compatible` endpoints
 * pointing at their in-process gateway loopback URL. The judge endpoint doubles
 * as the synthesizer. Emitted with a real YAML serializer, so hostile model ids
 * (`:`, quotes, metacharacters) cannot corrupt the document.
 */
export function routerConfigYaml(input: {
  specs: PanelModelSpec[];
  mlxUrls: Record<string, string>;
  judgeId: string;
  prompts?: PromptOverrides;
}): string {
  const endpoints = input.specs.map((spec) => {
    const provider = spec.provider ?? "mlx";
    const entry: Record<string, unknown> = {
      id: spec.id,
      model: spec.model
    };
    if (spec.auth !== undefined) {
      entry.provider = providerForAuthMode(spec.auth);
      entry.auth = { mode: spec.auth };
    } else if (provider === "mlx") {
      entry.provider = "openai-compatible";
      entry.base_url = input.mlxUrls[spec.id] ?? "";
      entry.api_key = "not-needed";
    } else {
      const baseUrl = spec.baseUrl ?? providerDefaultBaseUrl(provider);
      entry.provider = provider;
      entry.base_url = baseUrl;
      const keyEnv = spec.keyEnv ?? defaultKeyEnv(provider);
      if (keyEnv !== undefined) entry.api_key_env = keyEnv;
    }
    if (spec.pricing !== undefined) {
      const pricing: Record<string, unknown> = {};
      if (spec.pricing.inputPer1mTokens !== undefined) {
        pricing.input_per_1m_tokens = spec.pricing.inputPer1mTokens;
      }
      if (spec.pricing.outputPer1mTokens !== undefined) {
        pricing.output_per_1m_tokens = spec.pricing.outputPer1mTokens;
      }
      if (spec.pricing.currency !== undefined) pricing.currency = spec.pricing.currency;
      if (Object.keys(pricing).length > 0) entry.pricing = pricing;
    }
    return entry;
  });
  const promptEntries = PROMPT_IDS.flatMap((id) => {
    const value = input.prompts?.[id];
    return value !== undefined ? [[PROMPT_CONFIG_KEY[id], value] as const] : [];
  });
  const prompts =
    promptEntries.length > 0 ? Object.fromEntries(promptEntries) : undefined;
  return (
    stringify({
      endpoints,
      default_model: input.judgeId,
      judge_model: input.judgeId,
      synthesizer_model: input.judgeId,
      sampling: { temperature: 0.2, top_p: 0.9, max_tokens: 8192 },
      ...(prompts !== undefined ? { prompts } : {})
    }) + "\n"
  );
}

function pricingOverrides(specs: readonly PanelModelSpec[]): Record<string, ModelPricing> {
  const overrides: Record<string, ModelPricing> = {};
  for (const spec of specs) {
    const pricing = spec.pricing;
    if (pricing?.inputPer1mTokens === undefined || pricing.outputPer1mTokens === undefined) continue;
    const value = {
      inputPer1mTokens: pricing.inputPer1mTokens,
      outputPer1mTokens: pricing.outputPer1mTokens,
      ...(pricing.currency !== undefined ? { currency: pricing.currency } : {})
    };
    overrides[spec.model] = value;
    overrides[spec.id] = value;
  }
  return overrides;
}

function localComputePricing(specs: readonly PanelModelSpec[]): Record<string, LocalComputePricing> {
  const localCompute: Record<string, LocalComputePricing> = {};
  for (const spec of specs) {
    if (spec.localCompute === undefined) continue;
    localCompute[spec.model] = spec.localCompute;
    localCompute[spec.id] = spec.localCompute;
  }
  return localCompute;
}

/**
 * Build the derived `fusionkit serve` router YAML for a resolved panel, for
 * `fusionkit config export-yaml` (raw `fusionkit serve` users who don't go
 * through the Node harness gateway). It reuses the exact same {@link
 * routerConfigYaml} the live stack writes, so the exported file never drifts
 * from what a real run produces. The judge endpoint is selected the same way
 * {@link startRouter} does (by model name, first member as fallback). MLX members
 * carry an empty `base_url` placeholder, since their loopback gateway only exists
 * during a live Node run — annotate it so raw users know to fill it in (or run
 * the panel through `fusionkit <tool>` / `fusionkit serve` instead).
 */
export function exportRouterYaml(input: {
  specs: PanelModelSpec[];
  judgeModel?: string;
  prompts?: PromptOverrides;
}): string {
  const judgeSpec = judgeSpecFor(input.specs, input.judgeModel);
  return routerConfigYaml({
    specs: input.specs,
    mlxUrls: {},
    judgeId: judgeSpec.id,
    ...(input.prompts !== undefined ? { prompts: input.prompts } : {})
  });
}

/**
 * Spawn the single `fusionkit serve` router fronting every panel model + the
 * synthesizer. MLX specs first get an in-process OpenAI-compatible gateway
 * (loopback) that the router proxies to; cloud specs call their provider
 * directly. Returns the router URL, an id->routerUrl endpoint map, and a close
 * that tears down the router process and any MLX gateways it fronts.
 */
export async function startRouter(options: {
  specs: PanelModelSpec[];
  /**
   * Extra non-panel endpoints (e.g. the dedicated `narrator` writer endpoint).
   * They join the router config and its identity, but never the panel: no
   * judge candidacy, no harness endpoint, no `models` entry. Cloud or
   * subscription specs only (an MLX extra would need a loopback gateway).
   */
  extraSpecs?: PanelModelSpec[];
  judgeModel?: string;
  fusionkitDir?: string;
  prompts?: PromptOverrides;
  logsDir?: string;
  report?: StackReporter;
  /** Run-time incident sink (crashed model servers, a dead router, ...). */
  notify?: StackNotify;
  log: (line: string) => void;
}): Promise<Router> {
  const { specs, report } = options;
  const allSpecs = [...specs, ...(options.extraSpecs ?? [])];
  const judgeSpec = judgeSpecFor(specs, options.judgeModel);
  const models: EnsembleModel[] = specs.map((spec) => ({ id: spec.id, model: spec.model }));
  let identity = "";

  const announceStart = (label: string): void => {
    if (report) report({ kind: "server.start", id: "router", label });
    else options.log(`fusion: starting ${label}...`);
  };
  const announceReady = (detail: string): void => {
    if (report) report({ kind: "server.ready", id: "router", detail });
    else options.log(`fusion: router ready on ${detail}`);
  };

  announceStart(`router · ${specs.map((spec) => spec.id).join(", ")}`);

  // The router inherits the parent env plus the FusionKit checkout's `.env` (so
  // provider keys load seamlessly), without overriding anything already exported.
  // It calls providers directly and MLX over loopback (never a portless HTTPS
  // URL), so it needs no portless CA — and must keep its default certifi bundle
  // intact to verify real provider certificates.
  // env-spread-allowed: the Python router is a trusted infra child that legitimately needs the user's provider keys
  const env: Record<string, string | undefined> = { ...process.env };
  if (options.fusionkitDir !== undefined) {
    loadEnvFileInto(join(options.fusionkitDir, ".env"), env);
  }

  const backends: MlxBackend[] = [];
  const gateways: Gateway[] = [];
  const mlxUrls: Record<string, string> = {};
  const closeBackends = async (): Promise<void> => {
    await Promise.allSettled(gateways.map((gateway) => gateway.close()));
    await Promise.allSettled(backends.map((backend) => backend.stop()));
  };

  try {
    // MLX backends are memory-heavy (each loads a model into RAM), so they start
    // sequentially before the router that fronts them.
    for (const spec of specs) {
      if ((spec.provider ?? "mlx") !== "mlx") continue;
      const backend = new MlxBackend({
        model: spec.model,
        onEvent: (event) => {
          // A local model server dying mid-run (usually OOM-killed by the OS)
          // must be said out loud — the tool only sees a failed/disconnected
          // turn and cannot explain itself.
          if (event.type !== "crashed") return;
          options.notify?.(
            describeServerCrash({
              label: `panel member ${spec.id} (${spec.model})`,
              exitCode: event.exitCode,
              signal: event.signal
            })
          );
        }
      });
      await backend.start();
      const gateway = await startGateway({
        backend: new KernelBackend(backend, {
          workflowIds: { chat: "direct-model-turn", models: "direct-model-models", embeddings: "direct-model-embeddings" }
        })
      });
      backends.push(backend);
      gateways.push(gateway);
      mlxUrls[spec.id] = gateway.url();
    }

    const config = routerConfigYaml({
      specs: allSpecs,
      mlxUrls,
      judgeId: judgeSpec.id,
      ...(options.prompts !== undefined ? { prompts: options.prompts } : {})
    });
    identity = routerDiscoverIdentity({
      specs,
      extraSpecs: options.extraSpecs,
      judgeId: judgeSpec.id,
      prompts: options.prompts,
      mlxUrls,
      env
    });
    // The router serves this token back on /health, so a later run's
    // discover-or-spawn probe compares real effective configs — not just
    // endpoint id sets — before reusing the process.
    env.FUSIONKIT_ROUTER_IDENTITY = identity;
    const configDir = mkdtempSync(join(tmpdir(), "fusion-router-"));
    const configPath = join(configDir, "router.yaml");
    writeFileSync(configPath, config);
    const runner = fusionkitPyCommand(options.fusionkitDir);
    // Hold the port until the instant before the router process binds it, so a
    // concurrent picker cannot slip in between choosing and spawning.
    const reservation = await reservePort();
    const port = reservation.port;
    const routerArgs = [
      ...runner.prefix,
      "serve",
      "--config",
      configPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(port)
    ];
    await reservation.release();
    const proc = spawnLogged(runner.command, routerArgs, {
      ...(runner.cwd !== undefined ? { cwd: runner.cwd } : {}),
      ...(options.logsDir !== undefined ? { logFile: join(options.logsDir, "router.log") } : {}),
      env
    });
    proc.child.once("exit", () => rmSync(configDir, { recursive: true, force: true }));
    const url = `http://127.0.0.1:${port}`;
    // Surface the engine's own boot chatter (uvx resolve/download on a cold
    // first run, model loading, ...) as live sub-detail on the checklist row, so
    // a slow cold start explains itself instead of spinning silently.
    const progress =
      report !== undefined
        ? setInterval(() => {
            const lines = proc
              .log()
              .split(/[\r\n]+/)
              .map((line) => line.trim())
              .filter((line) => line.length > 0);
            const last = lines[lines.length - 1];
            if (last === undefined) return;
            const detail = last.length > 64 ? `${last.slice(0, 63)}…` : last;
            report({ kind: "server.progress", id: "router", detail });
          }, 500)
        : undefined;
    progress?.unref();
    try {
      await waitForHttp(`${url}/v1/models`, proc, {
        timeoutMs: 60_000,
        label: "fusion router",
        requireOk: true
      });
    } catch (error) {
      terminate(proc.child);
      // A provider-side rejection (bad key / model) will not be fixed by a
      // retry, so surface the distilled cause as evidence with guidance. The
      // top-level handler renders CliError as a framed panel; programmatic
      // callers still get an Error with everything in the message.
      const raw = error instanceof Error ? error.message : String(error);
      const [first, ...rest] = raw.split("\n");
      const permanent = looksPermanentFailure(proc.log());
      throw new CliError({
        code: "router-startup",
        message: first ?? raw,
        ...(rest.filter((line) => line.trim().length > 0).length > 0
          ? { details: rest.filter((line) => line.trim().length > 0) }
          : {}),
        hint: permanent
          ? "a provider rejected the request (bad API key or model name) — a retry cannot fix this; check the panel's model names and provider API keys"
          : "the engine did not come up in time — check the log tail above (network, provider outage, or a cold uv cache)",
        tryCommand: "fusionkit doctor"
      });
    } finally {
      if (progress !== undefined) clearInterval(progress);
    }
    announceReady(url);

    // The router became ready: from here on an exit is a mid-run death (OOM,
    // crash), not a startup failure — surface it instead of failing silently
    // with 502s on every subsequent turn.
    let routerClosing = false;
    proc.child.once("exit", (code, signal) => {
      if (routerClosing) return;
      options.notify?.(
        describeServerCrash({
          label: "the fusion router (fusionkit serve)",
          exitCode: code,
          signal,
          consequence: "fused turns will fail until you restart fusionkit",
          ...(options.logsDir !== undefined ? { logPath: join(options.logsDir, "router.log") } : {})
        })
      );
    });

    const endpoints: Record<string, string> = Object.fromEntries(specs.map((spec) => [spec.id, url]));
    return {
      url,
      port,
      ...(proc.child.pid !== undefined ? { pid: proc.child.pid } : {}),
      endpoints,
      models,
      judgeModel: judgeSpec.id,
      identity,
      close: async () => {
        routerClosing = true;
        terminate(proc.child);
        await closeBackends();
      }
    };
  } catch (error) {
    await closeBackends();
    throw error;
  }
}

export type FusionStack = {
  fusionUrl: string;
  /** The gateway's raw loopback port (for tunnels that need a dialable origin). */
  gatewayPort: number;
  endpoints: Record<string, string>;
  /** True when a compatible running router was reused instead of spawned. */
  reusedRouter: boolean;
  close: () => Promise<void>;
};

export type StartFusionStackOptions = {
  repo: string;
  outputRoot: string;
  /** The union of panel members across every ensemble (one router endpoint each). */
  models: PanelModelSpec[];
  /**
   * Named ensembles, session-default first. Each is registered as its own
   * gateway model; a request to it fans out only its members and fuses with its
   * judge/synthesizer/prompts. When unset, the whole `models` list is the one
   * implicit `default` ensemble (with `judgeModel`/`prompts` below).
   */
  ensembles?: EnsembleRunSpec[];
  /**
   * The harness kind the panel runs through (the launched tool's harness). Every
   * panel model is driven by this one harness; defaults to the generic `agent`
   * when unset (e.g. `serve` with no launched tool).
   */
  harness?: UnifiedHarnessKind;
  endpoints?: Record<string, string>;
  /**
   * Extra passthrough-only endpoints (e.g. the launched tool's own stock
   * models, served via its subscription login). Each joins the router config
   * and the gateway's vendor passthrough routing, but never the panel: no
   * judge candidacy, no fused fanout. Ignored with pre-running `endpoints`
   * (there is no managed router to host them).
   */
  extraPassthroughSpecs?: PanelModelSpec[];
  fusionkitDir?: string;
  /** System-prompt overrides emitted into the router's synthesizer config. */
  prompts?: PromptOverrides;
  judgeModel?: string;
  /** Pre-running fusionkit serve URL for trajectory synthesis (skips spawn). */
  synthesisUrl?: string;
  host?: string;
  port?: number;
  authToken?: string;
  timeoutMs?: number;
  /** WS5 rate-limit / credit failover policy (default `fusion`). */
  onRateLimit?: OnRateLimitPolicy;
  /** WS7 budget cap (USD) for the session's gateway-observed cost. */
  budgetUsd?: number;
  /** WS4 durable session store; when set the gateway persists/resumes sessions. */
  sessionStore?: SessionStore;
  /** WS4 resume target id bound to the first conversation this gateway serves. */
  resumeId?: string;
  /** WS4 static session header (tool/repo/panel) persisted on session creation. */
  sessionMeta?: SessionMetaInput;
  /**
   * When true, panel members are told which member they are and are given the
   * launched tool's own system/custom instructions. Default off.
   */
  panelIdentity?: boolean;
  /** Panel candidate trust level; unset means `full` (maximum autonomy). */
  panelTrust?: PanelTrust;
  /** Same-model sub-agents inside panel members (see GatewayRunnerConfig). Default on. */
  subagents?: boolean;
  /** Reasoning traces: narrate panel/judge progress in the tool's thinking UI. Default on. */
  reasoning?: boolean;
  /**
   * Optional model that writes the narration prose: a panel member id/model, a
   * `provider/model` token (any supported provider, incl. `claude-code`/`codex`
   * subscriptions), or a local MLX model path (Apple Silicon only). See
   * {@link resolveNarratorModel}.
   */
  reasoningModel?: string;
  logsDir?: string;
  report?: StackReporter;
  /** Active portless session; defaults to a disabled (loopback) session. */
  portless?: PortlessSession;
  /** Run-time incident sink (crashed model servers, a dead router, ...). */
  notify?: StackNotify;
  log: (line: string) => void;
};

export async function startFusionStack(options: StartFusionStackOptions): Promise<FusionStack> {
  const report = options.report;
  const portless = options.portless ?? (await createPortlessSession({ enabled: false }));

  // Full override (pre-running per-model endpoints + a pre-running synthesis
  // URL, e.g. tests): use them verbatim and spawn no router.
  const override = options.endpoints !== undefined && options.synthesisUrl !== undefined;
  const judgeModelName = options.judgeModel ?? options.models[0]?.model ?? "";
  const models: EnsembleModel[] = options.models.map((spec) => ({ id: spec.id, model: spec.model }));
  const pricing = pricingOverrides(options.models);
  const localCompute = localComputePricing(options.models);

  // Resolve the narration-writer model (--reasoning-model) up front: a panel
  // member reuses its router endpoint, a provider/model token needs a dedicated
  // `narrator` endpoint folded into the router config (and its identity, so
  // reuse detection distinguishes routers with and without it), and anything
  // else is a local MLX model booted directly.
  const narratorResolution =
    options.reasoningModel !== undefined && options.reasoning !== false
      ? resolveNarratorModel(options.reasoningModel, options.models)
      : undefined;
  const narratorSpec =
    narratorResolution?.kind === "extra-endpoint" ? narratorResolution.spec : undefined;

  // Passthrough-only extras (the launched tool's preserved stock models) join
  // the managed router alongside the narrator endpoint; with pre-running
  // endpoints there is no router to host them.
  const extraPassthroughSpecs = override ? [] : (options.extraPassthroughSpecs ?? []);
  const routerExtraSpecs = [
    ...(narratorSpec !== undefined ? [narratorSpec] : []),
    ...extraPassthroughSpecs
  ];

  let modelEndpoints: Record<string, string>;
  let fusionBackendUrl: string;
  let reusedRouter = false;
  let routerClose: () => Promise<void> | void = () => {};

  if (override) {
    modelEndpoints = options.endpoints as Record<string, string>;
    fusionBackendUrl = options.synthesisUrl as string;
  } else {
    // Discover-or-spawn the single router (models + synthesis), reusing a
    // compatible running instance across runs. The identity is a hash of the
    // full effective config (models, prompts, keys-present, sampling), served
    // back by the router on /health — so changing a model, a prompt override,
    // or an API key restarts the router instead of silently reusing a stale
    // one. Mirror startRouter's env (parent env + the checkout's .env overlay)
    // so both sides hash the same keys-present set. MLX panels hash their
    // per-run gateway URLs and therefore never reuse: a previous run's
    // in-process gateways died with that run's CLI.
    const judgeSpec = judgeSpecFor(options.models, options.judgeModel);
    // env-spread-allowed: identity hashing only records which key env vars are present
    const identityEnv: Record<string, string | undefined> = { ...process.env };
    if (options.fusionkitDir !== undefined) {
      loadEnvFileInto(join(options.fusionkitDir, ".env"), identityEnv);
    }
    const expectedIdentity = routerDiscoverIdentity({
      specs: options.models,
      extraSpecs: routerExtraSpecs.length > 0 ? routerExtraSpecs : undefined,
      judgeId: judgeSpec.id,
      prompts: options.prompts,
      mlxUrls: {},
      env: identityEnv
    });
    const resolved = await portless.discoverOrSpawn({
      name: "router",
      identity: expectedIdentity,
      healthCheck: async (loopbackUrl) => {
        try {
          const response = await fetch(`${loopbackUrl}/health`, { signal: AbortSignal.timeout(2000) });
          if (!response.ok) return undefined;
          const body = (await response.json()) as { identity?: unknown };
          return typeof body.identity === "string" ? body.identity : undefined;
        } catch {
          return undefined;
        }
      },
      spawn: async () => {
        if (report) report({ kind: "server.start", id: "router", label: "router" });
        const router = await startRouter({
          specs: options.models,
          ...(routerExtraSpecs.length > 0 ? { extraSpecs: routerExtraSpecs } : {}),
          ...(options.judgeModel !== undefined ? { judgeModel: options.judgeModel } : {}),
          ...(options.fusionkitDir !== undefined ? { fusionkitDir: options.fusionkitDir } : {}),
          ...(options.prompts !== undefined ? { prompts: options.prompts } : {}),
          ...(options.logsDir !== undefined ? { logsDir: options.logsDir } : {}),
          ...(report !== undefined ? { report } : {}),
          ...(options.notify !== undefined ? { notify: options.notify } : {}),
          log: options.log
        });
        return {
          port: router.port,
          ...(router.pid !== undefined ? { pid: router.pid } : {}),
          close: router.close
        };
      }
    });
    // The harness + the in-process step call reach the router over loopback (the
    // portless name is for humans); see the CA-at-startup note in portless.ts.
    // Passthrough-only extras route through the same router, so their ids join
    // the endpoint map (which the gateway's passthrough registration reads).
    modelEndpoints = Object.fromEntries(
      [...options.models, ...extraPassthroughSpecs].map((spec) => [spec.id, resolved.loopbackUrl])
    );
    fusionBackendUrl = resolved.loopbackUrl;
    reusedRouter = !resolved.owned;
    routerClose = resolved.close;
    if (reusedRouter) {
      // A compatible router from a previous run is reused (warm boot). Say so —
      // otherwise the checklist row would sit "pending" forever and the speed
      // win would be invisible.
      if (report) {
        report({ kind: "server.start", id: "router", label: "router" });
        report({ kind: "server.ready", id: "router", detail: `${resolved.loopbackUrl} (reused running engine)` });
      } else {
        options.log(`fusion: reusing running fusion router on ${resolved.loopbackUrl}`);
      }
    }
  }

  // Optional narration writer (--reasoning-model): the model that writes the
  // narration prose. Router-served models (a panel member, or the dedicated
  // `narrator` endpoint) need no extra process; a local MLX model boots in the
  // background — until it is warm, writer calls time out into the templated
  // prose, so it never delays the stack or a turn.
  let narrationWriter: NarrationWriter | undefined;
  let narrationClose: () => Promise<void> = async () => {};
  if (narratorResolution !== undefined && options.reasoningModel !== undefined) {
    const reasoningModel = options.reasoningModel;
    if (narratorResolution.kind === "mlx") {
      // Local MLX path (the historical behavior). Off Apple Silicon it
      // degrades to templates with a note.
      if (!detectHost().appleSilicon) {
        options.log(
          `fusion: --reasoning-model ${reasoningModel} is a local MLX model and needs Apple Silicon; using templated narration`
        );
      } else {
        const reasoningBackend = new MlxBackend({
          model: narratorResolution.model,
          onEvent: (event) => {
            if (event.type !== "crashed") return;
            options.notify?.(
              describeServerCrash({
                label: `the narration writer (${reasoningModel})`,
                exitCode: event.exitCode,
                signal: event.signal,
                consequence: "narration falls back to templated prose"
              })
            );
          }
        });
        void reasoningBackend.start().catch((error: unknown) => {
          // Best-effort warm: a failed start just means templated narration, but
          // say so — a silent fallback would read as the feature not working.
          const first = (error instanceof Error ? error.message : String(error)).split("\n")[0];
          options.log(
            `fusion: narration model ${reasoningModel} failed to start; using templated prose (${first})`
          );
        });
        narrationWriter = createChatNarrationWriter({
          chat: (body, signal) => reasoningBackend.chat(body, signal),
          model: narratorResolution.model,
          // Qwen3-style hybrid thinking burns the whole one-sentence budget;
          // local servers accept the kwarg (cloud providers would reject it).
          chatTemplateKwargs: { enable_thinking: false }
        });
        narrationClose = () => reasoningBackend.close();
      }
    } else if (narratorResolution.kind === "extra-endpoint" && override) {
      // A dedicated narrator endpoint only exists on a router this stack
      // configures; with pre-running endpoints there is nowhere to add it.
      options.log(
        `fusion: --reasoning-model ${reasoningModel} needs the managed fusion router; using templated narration`
      );
    } else {
      // Router-served: the writer calls the router's OpenAI chat door with the
      // endpoint id as the model. No process to manage, any provider works.
      const endpointId =
        narratorResolution.kind === "endpoint"
          ? narratorResolution.endpointId
          : narratorResolution.spec.id;
      const routerBackend = new OpenAiBackend({
        baseUrl: `${modelEndpoints[endpointId] ?? fusionBackendUrl}/v1`
      });
      narrationWriter = createChatNarrationWriter({
        chat: (body, signal) => routerBackend.chat(body, signal),
        model: endpointId
      });
    }
  }

  try {
    if (report) report({ kind: "gateway.start" });
    // Per-ensemble routing config: which members/judge/synthesizer/prompts each
    // advertised fused model id runs. The first entry is the session default.
    const ensembleConfigs =
      options.ensembles !== undefined && options.ensembles.length > 0
        ? gatewayEnsembleConfigs(options.ensembles)
        : undefined;
    // The judge-streamed-trajectory front door: each panel model produces a
    // trajectory and the judge emits the trajectory the user's tool executes.
    const gatewayConfig: GatewayRunnerConfig = {
      fusionBackendUrl,
      repo: options.repo,
      outputRoot: options.outputRoot,
      harnesses: [options.harness ?? "agent"],
      models,
      judgeModel: judgeModelName,
      ...(ensembleConfigs !== undefined ? { ensembles: ensembleConfigs } : {}),
      ...(extraPassthroughSpecs.length > 0
        ? { extraPassthrough: extraPassthroughSpecs.map((spec) => ({ id: spec.id, model: spec.model })) }
        : {}),
      modelEndpoints,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(Object.keys(pricing).length > 0 ? { pricing } : {}),
      ...(Object.keys(localCompute).length > 0 ? { localCompute } : {}),
      // Explicitly mark the panel's local (MLX) members so the gateway's cost
      // classification never falls back to model-id string heuristics.
      localModels: options.models.flatMap((spec) =>
        (spec.provider ?? "mlx") === "mlx" ? [spec.model, spec.id] : []
      ),
      ...(options.onRateLimit !== undefined ? { onRateLimit: options.onRateLimit } : {}),
      ...(options.budgetUsd !== undefined ? { budgetUsd: options.budgetUsd } : {}),
      ...(options.sessionStore !== undefined ? { sessionStore: options.sessionStore } : {}),
      ...(options.resumeId !== undefined ? { resumeId: options.resumeId } : {}),
      ...(options.sessionMeta !== undefined ? { sessionMeta: options.sessionMeta } : {}),
      ...(options.panelIdentity !== undefined ? { panelIdentity: options.panelIdentity } : {}),
      ...(options.panelTrust !== undefined ? { panelTrust: options.panelTrust } : {}),
      ...(options.subagents !== undefined ? { subagents: options.subagents } : {}),
      ...(options.reasoning !== undefined ? { reasoningTraces: options.reasoning } : {}),
      ...(narrationWriter !== undefined ? { narrationWriter } : {})
    };
    const gateway = await startFusionStepGateway({
      config: gatewayConfig,
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {})
    });
    // The gateway runs in-process (dies with this CLI), so it gets a per-run
    // portless name rather than being a cross-run singleton.
    const fusionUrl = portless.register("gateway", gateway.port());
    if (report) report({ kind: "gateway.ready", detail: fusionUrl });
    return {
      fusionUrl,
      gatewayPort: gateway.port(),
      endpoints: modelEndpoints,
      reusedRouter,
      close: async () => {
        await gateway.close();
        portless.unregister("gateway");
        await narrationClose();
        await routerClose();
      }
    };
  } catch (error) {
    await narrationClose();
    await routerClose();
    throw error;
  }
}
