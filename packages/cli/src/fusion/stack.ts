/**
 * The fusion model stack: the single `fusionkit serve` router that fronts every
 * panel model plus synthesis, and the in-process gateway that turns it into the
 * judge-streamed-trajectory front door.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EnsembleModel } from "@fusionkit/ensemble";
import { MlxBackend, startGateway } from "@fusionkit/model-gateway";
import type { Gateway } from "@fusionkit/model-gateway";

import { startFusionStepGateway } from "../gateway.js";
import type { GatewayRunnerConfig } from "../gateway.js";
import { createPortlessSession } from "../shared/portless.js";
import type { PortlessSession } from "../shared/portless.js";
import { freePort, spawnLogged, terminate, waitForHttp } from "../shared/proc.js";

import { PROMPT_CONFIG_KEY, PROMPT_IDS } from "../fusion-config.js";
import type { PromptOverrides } from "../fusion-config.js";

import { defaultKeyEnv, fusionkitPyCommand, loadEnvFileInto } from "./env.js";
import type { PanelModelSpec, PanelProvider, StackReporter } from "./env.js";

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
  /** Sorted endpoint ids — the router's discover-or-spawn identity token. */
  identity: string;
  close: () => Promise<void>;
};

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
 * Default provider base URL when a cloud spec carries no explicit `baseUrl`.
 * fusionkit's `ModelEndpoint` requires `base_url`, so the router config must
 * always set it (the `serve-endpoint` shim filled this in for us before). Mirrors
 * `PROVIDER_DEFAULT_BASE_URL` in fusionkit's openai_endpoint.py.
 */
function providerDefaultBaseUrl(provider: Exclude<PanelProvider, "mlx">): string {
  switch (provider) {
    case "openai":
      return "https://api.openai.com";
    case "anthropic":
      return "https://api.anthropic.com";
    case "google":
      return "https://generativelanguage.googleapis.com";
    case "openai-compatible":
      return "http://127.0.0.1";
    default: {
      const exhaustive: never = provider;
      throw new Error(`unknown provider ${String(exhaustive)}`);
    }
  }
}

/** Pick the panel spec that backs the judge (by model name), else the first. */
function judgeSpecFor(specs: PanelModelSpec[], judgeModel: string | undefined): PanelModelSpec {
  const first = specs[0];
  if (first === undefined) throw new Error("at least one panel model is required");
  if (judgeModel === undefined) return first;
  return specs.find((spec) => spec.model === judgeModel) ?? first;
}

/**
 * Build the `fusionkit serve` config (YAML) for the consolidated router: one
 * endpoint per panel model. Cloud models call their provider directly (keyed by
 * `api_key_env`); MLX models are fronted as `openai-compatible` endpoints
 * pointing at their in-process gateway loopback URL. The judge endpoint doubles
 * as the synthesizer. Values are JSON-quoted (valid YAML flow scalars).
 */
function routerConfigYaml(input: {
  specs: PanelModelSpec[];
  mlxUrls: Record<string, string>;
  judgeId: string;
  prompts?: PromptOverrides;
}): string {
  const lines = ["endpoints:"];
  for (const spec of input.specs) {
    const provider = spec.provider ?? "mlx";
    lines.push(`  - id: ${JSON.stringify(spec.id)}`);
    lines.push(`    model: ${JSON.stringify(spec.model)}`);
    if (provider === "mlx") {
      lines.push("    provider: openai-compatible");
      lines.push(`    base_url: ${JSON.stringify(input.mlxUrls[spec.id] ?? "")}`);
      lines.push("    api_key: not-needed");
    } else {
      // `base_url` is required by fusionkit's ModelEndpoint, so always emit one
      // (the spec's, or the provider default).
      const baseUrl = spec.baseUrl ?? providerDefaultBaseUrl(provider);
      lines.push(`    provider: ${provider}`);
      lines.push(`    base_url: ${JSON.stringify(baseUrl)}`);
      const keyEnv = spec.keyEnv ?? defaultKeyEnv(provider);
      if (keyEnv !== undefined) lines.push(`    api_key_env: ${JSON.stringify(keyEnv)}`);
    }
  }
  lines.push(`default_model: ${JSON.stringify(input.judgeId)}`);
  lines.push(`judge_model: ${JSON.stringify(input.judgeId)}`);
  lines.push(`synthesizer_model: ${JSON.stringify(input.judgeId)}`);
  // Generous budget: reasoning models (gpt-5.x) spend tokens on reasoning before
  // producing content, so a small cap can yield an empty answer.
  lines.push("sampling: {temperature: 0.2, top_p: 0.9, max_tokens: 8192}");
  // Committed `.fusionkit/prompts/*.md` overrides flow into the synthesizer's
  // PromptOverrides here. JSON.stringify yields a valid YAML double-quoted
  // scalar, so multi-line prompts are escaped safely.
  const promptEntries = PROMPT_IDS.flatMap((id) => {
    const value = input.prompts?.[id];
    return value !== undefined ? [[PROMPT_CONFIG_KEY[id], value] as const] : [];
  });
  if (promptEntries.length > 0) {
    lines.push("prompts:");
    for (const [key, value] of promptEntries) {
      lines.push(`  ${key}: ${JSON.stringify(value)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
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
  judgeModel?: string;
  fusionkitDir?: string;
  prompts?: PromptOverrides;
  logsDir?: string;
  report?: StackReporter;
  log: (line: string) => void;
}): Promise<Router> {
  const { specs, report } = options;
  const judgeSpec = judgeSpecFor(specs, options.judgeModel);
  const models: EnsembleModel[] = specs.map((spec) => ({ id: spec.id, model: spec.model }));
  const identity = specs.map((spec) => spec.id).sort().join(",");

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
      const backend = new MlxBackend({ model: spec.model });
      await backend.start();
      const gateway = await startGateway({ backend });
      backends.push(backend);
      gateways.push(gateway);
      mlxUrls[spec.id] = gateway.url();
    }

    const config = routerConfigYaml({
      specs,
      mlxUrls,
      judgeId: judgeSpec.id,
      ...(options.prompts !== undefined ? { prompts: options.prompts } : {})
    });
    const configDir = mkdtempSync(join(tmpdir(), "fusion-router-"));
    const configPath = join(configDir, "router.yaml");
    writeFileSync(configPath, config);
    const runner = fusionkitPyCommand(options.fusionkitDir);
    const port = await freePort();
    const proc = spawnLogged(
      runner.command,
      [...runner.prefix, "serve", "--config", configPath, "--host", "127.0.0.1", "--port", String(port)],
      {
        ...(runner.cwd !== undefined ? { cwd: runner.cwd } : {}),
        ...(options.logsDir !== undefined ? { logFile: join(options.logsDir, "router.log") } : {}),
        env
      }
    );
    proc.child.once("exit", () => rmSync(configDir, { recursive: true, force: true }));
    const url = `http://127.0.0.1:${port}`;
    try {
      await waitForHttp(`${url}/v1/models`, proc, {
        timeoutMs: 60_000,
        label: "fusion router",
        requireOk: true
      });
    } catch (error) {
      terminate(proc.child);
      // A provider-side rejection (bad key / model) will not be fixed by a
      // retry, so surface the distilled cause with guidance.
      const hint = looksPermanentFailure(proc.log()) ? " (check model names and provider API keys)" : "";
      throw new Error(`${error instanceof Error ? error.message : String(error)}${hint}`);
    }
    announceReady(url);

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
  endpoints: Record<string, string>;
  close: () => Promise<void>;
};

export type StartFusionStackOptions = {
  repo: string;
  outputRoot: string;
  models: PanelModelSpec[];
  endpoints?: Record<string, string>;
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
  logsDir?: string;
  report?: StackReporter;
  /** Active portless session; defaults to a disabled (loopback) session. */
  portless?: PortlessSession;
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

  let modelEndpoints: Record<string, string>;
  let fusionBackendUrl: string;
  let routerClose: () => Promise<void> | void = () => {};

  if (override) {
    modelEndpoints = options.endpoints as Record<string, string>;
    fusionBackendUrl = options.synthesisUrl as string;
  } else {
    // Discover-or-spawn the single router (models + synthesis), reusing a
    // compatible running instance (same endpoint id set) across runs.
    const expectedIdentity = options.models.map((spec) => spec.id).sort().join(",");
    const resolved = await portless.discoverOrSpawn({
      name: "router",
      identity: expectedIdentity,
      healthCheck: async (loopbackUrl) => {
        try {
          const response = await fetch(`${loopbackUrl}/v1/models`, { signal: AbortSignal.timeout(2000) });
          if (!response.ok) return undefined;
          const body = (await response.json()) as { data?: Array<{ id?: string }> };
          return (body.data ?? [])
            .map((entry) => entry.id)
            .filter((id): id is string => typeof id === "string" && id !== "fusionkit/router")
            .sort()
            .join(",");
        } catch {
          return undefined;
        }
      },
      spawn: async () => {
        if (report) report({ kind: "server.start", id: "router", label: "router" });
        const router = await startRouter({
          specs: options.models,
          ...(options.judgeModel !== undefined ? { judgeModel: options.judgeModel } : {}),
          ...(options.fusionkitDir !== undefined ? { fusionkitDir: options.fusionkitDir } : {}),
          ...(options.prompts !== undefined ? { prompts: options.prompts } : {}),
          ...(options.logsDir !== undefined ? { logsDir: options.logsDir } : {}),
          ...(report !== undefined ? { report } : {}),
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
    modelEndpoints = Object.fromEntries(options.models.map((spec) => [spec.id, resolved.loopbackUrl]));
    fusionBackendUrl = resolved.loopbackUrl;
    routerClose = resolved.close;
  }

  try {
    if (report) report({ kind: "gateway.start" });
    // The judge-streamed-trajectory front door: each panel model produces a
    // trajectory and the judge emits the trajectory the user's tool executes.
    const gatewayConfig: GatewayRunnerConfig = {
      fusionBackendUrl,
      repo: options.repo,
      outputRoot: options.outputRoot,
      harnesses: ["agent"],
      models,
      judgeModel: judgeModelName,
      modelEndpoints,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
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
      endpoints: modelEndpoints,
      close: async () => {
        await gateway.close();
        portless.unregister("gateway");
        await routerClose();
      }
    };
  } catch (error) {
    await routerClose();
    throw error;
  }
}
