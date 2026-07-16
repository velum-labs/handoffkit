import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { EnsembleModel, PanelTrust, UnifiedHarnessKind } from "@fusionkit/ensemble";
import type {
  OnRateLimitPolicy,
  SessionMetaInput,
  SessionStore
} from "@fusionkit/gateway";
import { fusionModelId } from "@fusionkit/registry";
import { OpenAiBackend, startGateway } from "@routekit/gateway";
import type { Gateway, RouterConfig } from "@routekit/gateway";
import { startRouter as startRouteKitRouter } from "@routekit/router";
import type { RunningRouter } from "@routekit/router";
import {
  buildChildEnv,
  normalizeApiBaseUrl,
  reservePort,
  spawnLogged,
  terminate,
  trimTrailingSlashes,
  waitForHttp
} from "@routekit/runtime";
import { stringify } from "yaml";

import { startFusionStepGateway } from "../gateway.js";
import type { GatewayEnsembleConfig, GatewayRunnerConfig } from "../gateway.js";
import { fusionkitPyCommand } from "./env.js";
import type { EnsembleRunSpec, StackReporter } from "./env.js";
import type { PortlessSession } from "../shared/portless.js";
import { createPortlessSession } from "../shared/portless.js";

export type RouteKitConnection =
  | { kind: "embedded"; config: RouterConfig }
  | { kind: "external"; url: string; authToken?: string };

export type FusionStack = {
  fusionUrl: string;
  gatewayPort: number;
  endpoints: Record<string, string>;
  embeddedRouter: boolean;
  reusedRouter: false;
  close: () => Promise<void>;
};

export type StartFusionStackOptions = {
  repo: string;
  outputRoot: string;
  ensembles: EnsembleRunSpec[];
  router: RouteKitConnection;
  harness?: UnifiedHarnessKind;
  fusionkitDir?: string;
  host?: string;
  port?: number;
  authToken?: string;
  timeoutMs?: number;
  panelTimeoutMs?: number;
  stragglerGraceMs?: number;
  onRateLimit?: OnRateLimitPolicy;
  budgetUsd?: number;
  sessionStore?: SessionStore;
  resumeId?: string;
  sessionMeta?: SessionMetaInput;
  panelTrust?: PanelTrust;
  subagents?: boolean;
  reasoning?: boolean;
  logsDir?: string;
  report?: StackReporter;
  portless?: PortlessSession;
  log: (line: string) => void;
};

/** Turn a managed child exit into an actionable lifecycle notice. */
export function describeServerCrash(input: {
  label: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  consequence?: string;
  logPath?: string;
}): string {
  const oomLikely = input.signal === "SIGKILL" || input.exitCode === null;
  const cause =
    input.signal !== null
      ? `killed by ${input.signal}`
      : `exited with code ${input.exitCode ?? "unknown"}`;
  const consequence = input.consequence ?? "it restarts on the next turn";
  const logHint =
    input.logPath !== undefined ? ` Details: ${input.logPath}.` : "";
  if (oomLikely) {
    return (
      `${input.label} was ${cause} mid-run — likely out of memory; ${consequence}. ` +
      `Try a smaller model or quant (see \`fusionkit models\`).${logHint}`
    );
  }
  return `${input.label} crashed mid-run (${cause}); ${consequence}.${logHint}`;
}

function uniqueEndpointIds(ensembles: readonly EnsembleRunSpec[]): string[] {
  return [
    ...new Set(
      ensembles.flatMap((ensemble) => [
        ...ensemble.members,
        ensemble.judge,
        ensemble.synthesizer ?? ensemble.judge
      ])
    )
  ];
}

export function gatewayEnsembleConfigs(
  ensembles: readonly EnsembleRunSpec[]
): GatewayEnsembleConfig[] {
  return ensembles.map((ensemble) => ({
    name: ensemble.name,
    modelId: fusionModelId(ensemble.name),
    models: ensemble.members.map((id) => ({ id, model: id, endpointId: id })),
    judgeEndpointId: ensemble.judge,
    judgeModelName: ensemble.judge,
    ...(ensemble.synthesizer !== undefined
      ? { synthesizerEndpointId: ensemble.synthesizer }
      : {}),
    ...(ensemble.k !== undefined ? { k: ensemble.k } : {}),
    ...(ensemble.prompts !== undefined ? { prompts: ensemble.prompts } : {})
  }));
}

/**
 * Build the Python synthesis sidecar config. Every endpoint points only at the
 * RouteKit gateway and is addressed by its opaque endpoint id. Provider names,
 * provider URLs, key env names, pricing, and account state never cross this
 * boundary.
 */
export function sidecarConfigYaml(input: {
  endpointIds: readonly string[];
  routekitUrl: string;
  judge: string;
  synthesizer?: string;
  prompts?: Record<string, string>;
}): string {
  const routekitUrl = trimTrailingSlashes(input.routekitUrl);
  return (
    stringify({
      routekit_url: routekitUrl,
      endpoint_ids: input.endpointIds,
      default_model: input.judge,
      judge_model: input.judge,
      synthesizer_model: input.synthesizer ?? input.judge,
      sampling: { temperature: 0.2, top_p: 0.9, max_tokens: 8192 },
      ...(input.prompts !== undefined ? { prompts: input.prompts } : {})
    }) + "\n"
  );
}

/** Build the Python child's environment without inheriting credentials. */
export function sidecarEnvironment(
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return buildChildEnv({ base: env });
}

async function startSynthesisSidecar(input: {
  endpointIds: readonly string[];
  routekitUrl: string;
  judge: string;
  synthesizer?: string;
  prompts?: Record<string, string>;
  fusionkitDir?: string;
  logsDir?: string;
}): Promise<{ url: string; close(): Promise<void> }> {
  const directory = mkdtempSync(join(tmpdir(), "fusionkit-sidecar-"));
  const configPath = join(directory, "fusion.yaml");
  writeFileSync(
    configPath,
    sidecarConfigYaml({
      endpointIds: input.endpointIds,
      routekitUrl: input.routekitUrl,
      judge: input.judge,
      ...(input.synthesizer !== undefined ? { synthesizer: input.synthesizer } : {}),
      ...(input.prompts !== undefined ? { prompts: input.prompts } : {})
    }),
    { mode: 0o600 }
  );
  const runner = fusionkitPyCommand(input.fusionkitDir);
  const reservation = await reservePort();
  const port = reservation.port;
  await reservation.release();
  const processHandle = spawnLogged(
    runner.command,
    [
      ...runner.prefix,
      "serve",
      "--config",
      configPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(port)
    ],
    {
      ...(runner.cwd !== undefined ? { cwd: runner.cwd } : {}),
      env: sidecarEnvironment(),
      ...(input.logsDir !== undefined
        ? { logFile: join(input.logsDir, "synthesis-sidecar.log") }
        : {})
    }
  );
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${url}/health`, processHandle, {
      timeoutMs: 60_000,
      label: "FusionKit synthesis sidecar",
      requireOk: true
    });
  } catch (error) {
    terminate(processHandle.child);
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    url,
    close: async () => {
      terminate(processHandle.child);
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

async function closeOwned(
  resources: ReadonlyArray<{ close(): Promise<void> } | undefined>
): Promise<void> {
  const errors: unknown[] = [];
  for (const resource of resources) {
    try {
      await resource?.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to close Fusion-owned resources");
  }
}

export async function startFusionStack(
  options: StartFusionStackOptions
): Promise<FusionStack> {
  const portless =
    options.portless ?? (await createPortlessSession({ enabled: false }));
  let embedded: RunningRouter | undefined;
  let authBridge: Gateway | undefined;
  let sidecar: { url: string; close(): Promise<void> } | undefined;
  try {
    if (options.report !== undefined) {
      options.report({ kind: "server.start", id: "router", label: "RouteKit router" });
    }
    embedded =
      options.router.kind === "embedded"
        ? await startRouteKitRouter({
            config: options.router.config,
            host: "127.0.0.1",
            port: 0
          })
        : undefined;
    const upstreamRouteKitUrl =
      options.router.kind === "external" ? options.router.url : embedded!.url;
    const ingressToken =
      options.router.kind === "external" ? options.router.authToken : undefined;
    authBridge =
      ingressToken === undefined
        ? undefined
        : await startGateway({
            backend: new OpenAiBackend({
              baseUrl: normalizeApiBaseUrl(upstreamRouteKitUrl),
              apiKey: ingressToken
            }),
            host: "127.0.0.1",
            port: 0
          });
    const routekitUrl = authBridge?.url() ?? upstreamRouteKitUrl;
    if (options.report !== undefined) {
      options.report({
        kind: "server.ready",
        id: "router",
        detail: `${upstreamRouteKitUrl}${embedded === undefined ? " (external)" : " (embedded)"}`
      });
    }

    const selected = options.ensembles[0];
    if (selected === undefined) throw new Error("at least one ensemble is required");
    const endpointIds = uniqueEndpointIds(options.ensembles);
    sidecar = await startSynthesisSidecar({
      endpointIds,
      routekitUrl,
      judge: selected.judge,
      ...(selected.synthesizer !== undefined
        ? { synthesizer: selected.synthesizer }
        : {}),
      ...(selected.prompts !== undefined
        ? {
            prompts: {
              ...(selected.prompts.judge !== undefined
                ? { judge_system: selected.prompts.judge }
                : {}),
              ...(selected.prompts.synthesizer !== undefined
                ? { synthesizer_system: selected.prompts.synthesizer }
                : {})
            }
          }
        : {}),
      ...(options.fusionkitDir !== undefined
        ? { fusionkitDir: options.fusionkitDir }
        : {}),
      ...(options.logsDir !== undefined ? { logsDir: options.logsDir } : {})
    });

    const models: EnsembleModel[] = endpointIds.map((id) => ({
      id,
      model: id,
      endpointId: id
    }));
    const modelEndpoints = Object.fromEntries(
      endpointIds.map((id) => [id, routekitUrl])
    );
    const gatewayConfig: GatewayRunnerConfig = {
      fusionBackendUrl: sidecar.url,
      repo: options.repo,
      outputRoot: options.outputRoot,
      harnesses: [options.harness ?? "agent"],
      models,
      ensembles: gatewayEnsembleConfigs(options.ensembles),
      judgeModel: selected.judge,
      modelEndpoints,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.panelTimeoutMs !== undefined
        ? { panelTimeoutMs: options.panelTimeoutMs }
        : {}),
      ...(options.stragglerGraceMs !== undefined
        ? { stragglerGraceMs: options.stragglerGraceMs }
        : {}),
      ...(options.onRateLimit !== undefined
        ? { onRateLimit: options.onRateLimit }
        : {}),
      ...(options.budgetUsd !== undefined ? { budgetUsd: options.budgetUsd } : {}),
      ...(options.sessionStore !== undefined
        ? { sessionStore: options.sessionStore }
        : {}),
      ...(options.resumeId !== undefined ? { resumeId: options.resumeId } : {}),
      ...(options.sessionMeta !== undefined
        ? { sessionMeta: options.sessionMeta }
        : {}),
      ...(options.panelTrust !== undefined
        ? { panelTrust: options.panelTrust }
        : {}),
      ...(options.subagents !== undefined ? { subagents: options.subagents } : {}),
      ...(options.reasoning !== undefined
        ? { reasoningTraces: options.reasoning }
        : {})
    };
    const gateway = await startFusionStepGateway({
      config: gatewayConfig,
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      ...(options.authToken !== undefined
        ? { authToken: options.authToken }
        : {})
    });
    const fusionUrl = portless.register("gateway", gateway.port());
    return {
      fusionUrl,
      gatewayPort: gateway.port(),
      endpoints: modelEndpoints,
      embeddedRouter: embedded !== undefined,
      reusedRouter: false,
      close: async () => {
        try {
          await closeOwned([gateway, sidecar, authBridge, embedded]);
        } finally {
          portless.unregister("gateway");
        }
      }
    };
  } catch (error) {
    try {
      await closeOwned([sidecar, authBridge, embedded]);
    } catch {
      // Preserve the startup failure; owned-resource cleanup is best effort.
    }
    throw error;
  }
}

export function resolveRouterConfigPath(repoRoot: string, configPath: string): string {
  return resolve(repoRoot, configPath);
}
