import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FusionTool } from "@fusionkit/config";
import type { UnifiedHarnessKind } from "@fusionkit/ensemble";
import {
  defaultSessionsDir,
  FileSystemSessionStore
} from "@fusionkit/gateway";
import { fusionModelId } from "@fusionkit/registry";
import { shutdownFusionTracing } from "@fusionkit/tracing";
import type { HarnessKind } from "@routekit/harness-core";
import {
  assertModelsAvailable,
  loadRouterConfig
} from "@routekit/config";
import { resolveReasoningEffort } from "@routekit/contracts";
import type { ModelReasoningCapabilities } from "@routekit/contracts";
import { registerCleanup, trimTrailingSlashes } from "@routekit/runtime";
import { createToolLaunchContext } from "@routekit/tools";
import type { AgentProfile, ToolLaunchSpec } from "@routekit/tools";

import { resolveSessionId } from "./commands/sessions.js";
import { gatewaySetupSnippets } from "./gateway.js";
import { toolRegistry } from "./tools.js";
import { createPortlessSession } from "./shared/portless.js";
import { gitToplevel } from "./fusion/env.js";
import { openUrl, startObservability } from "./fusion/observability.js";
import type { Observability } from "./fusion/observability.js";
import type {
  EnsembleRunSpec,
  RunFusionOptions
} from "./fusion/env.js";
import {
  resolveRouterConfigPath,
  startFusionStack
} from "./fusion/stack.js";
import type { RouteKitConnection } from "./fusion/stack.js";

export * from "./fusion/env.js";
export * from "./fusion/stack.js";

export const FUSION_TOOLS: readonly FusionTool[] = [
  "codex",
  "claude",
  "cursor",
  "opencode",
  "serve"
];

function unifiedHarnessKind(kind: HarnessKind): UnifiedHarnessKind {
  switch (kind) {
    case "codex":
      return "codex";
    case "claude_code":
      return "claude-code";
    case "cursor":
      return "cursor-acp";
    case "opencode":
      return "opencode";
    case "generic":
      return "agent";
    default: {
      const exhaustive: never = kind;
      throw new Error(`unsupported tool driver kind: ${String(exhaustive)}`);
    }
  }
}

export function fusionAgentProfiles(
  ensembles: readonly EnsembleRunSpec[]
): AgentProfile[] {
  return ensembles.map((ensemble) => {
    const model = fusionModelId(ensemble.name);
    return {
      id: model,
      model,
      description: `Delegate a task to the "${ensemble.name}" compound (${ensemble.members.join(", ")}).`,
      instructions: `Answer the delegated task directly using the "${ensemble.name}" compound.`
    };
  });
}

export function fusionToolLaunchSpec(input: {
  gatewayUrl: string;
  defaultEnsemble: string;
  ensembles: readonly EnsembleRunSpec[];
  args: readonly string[];
  cwd: string;
  authToken?: string;
  effort?: string;
  reasoningByEnsemble?: Readonly<
    Record<string, ModelReasoningCapabilities | undefined>
  >;
  subagents?: boolean;
  ide?: boolean;
  logsDir?: string;
}): ToolLaunchSpec {
  const defaultModel = fusionModelId(input.defaultEnsemble);
  const models = input.ensembles.map((ensemble) => ({
    id: fusionModelId(ensemble.name),
    label: `${ensemble.name} (fusion)`,
    ...(input.reasoningByEnsemble?.[ensemble.name] !== undefined
      ? { reasoning: input.reasoningByEnsemble[ensemble.name] }
      : {})
  }));
  const selectedReasoning = models.find(
    (model) => model.id === defaultModel
  )?.reasoning;
  const effort =
    input.effort === undefined
      ? undefined
      : selectedReasoning?.status !== "supported"
        ? (() => {
            throw new Error(
              `model "${defaultModel}" has no discovered reasoning effort controls`
            );
          })()
        : resolveReasoningEffort(selectedReasoning, input.effort);
  if (input.effort !== undefined && effort === undefined) {
    throw new Error(
      `reasoning effort "${input.effort}" is not supported by model "${defaultModel}"`
    );
  }
  return {
    gatewayUrl: input.gatewayUrl,
    defaultModel,
    models,
    ...(input.subagents === false
      ? {}
      : { agentProfiles: fusionAgentProfiles(input.ensembles) }),
    args: input.args,
    ...(effort !== undefined
      ? { reasoning: { mode: "effort", effort } }
      : {}),
    cwd: input.cwd,
    ...(input.authToken !== undefined
      ? { auth: { token: input.authToken } }
      : {}),
    ...(input.ide !== undefined ? { ide: input.ide } : {}),
    ...(input.logsDir !== undefined ? { logsDir: input.logsDir } : {})
  };
}

function sharedEffortCapability(
  members: readonly ModelReasoningCapabilities[]
): ModelReasoningCapabilities | undefined {
  if (
    members.length === 0 ||
    members.some((capability) => capability.status !== "supported")
  ) {
    return undefined;
  }
  const efforts = (members[0]?.efforts ?? []).flatMap((effort) => {
    if (
      !members
        .slice(1)
        .every((capability) =>
          (capability.efforts ?? []).some(
            (candidate) => candidate.id === effort.id
          )
        )
    ) {
      return [];
    }
    const aliases = (effort.aliases ?? []).filter((alias) =>
      members
        .slice(1)
        .every(
          (capability) =>
            resolveReasoningEffort(capability, alias) === effort.id
        )
    );
    return [
      {
        ...effort,
        ...(aliases.length > 0 ? { aliases } : { aliases: undefined })
      }
    ];
  });
  if (efforts.length === 0) return undefined;
  const defaultEffort = members[0]?.defaultEffort;
  const provenance = members.some(
    (capability) => capability.provenance === "config"
  )
    ? "config"
    : members.every((capability) => capability.provenance === "provider")
      ? "provider"
      : "unknown";
  return {
    status: "supported",
    efforts,
    ...(defaultEffort !== undefined &&
    efforts.some((effort) => effort.id === defaultEffort) &&
    members.every(
      (capability) => capability.defaultEffort === defaultEffort
    )
      ? { defaultEffort }
      : {}),
    provenance
  };
}

async function fusionReasoningCatalog(
  url: string,
  ensembles: readonly EnsembleRunSpec[],
  token?: string
): Promise<Record<string, ModelReasoningCapabilities | undefined>> {
  const root = trimTrailingSlashes(url.replace(/\/v1\/?$/, ""));
  const response = await fetch(`${root}/v1/models`, {
    headers:
      token !== undefined ? { authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) {
    throw new Error(
      `RouteKit gateway returned HTTP ${response.status} from /v1/models`
    );
  }
  const body = (await response.json()) as {
    data?: Array<{
      id?: unknown;
      reasoning?: ModelReasoningCapabilities;
    }>;
  };
  const byModel = new Map(
    (body.data ?? []).flatMap((entry) =>
      typeof entry.id === "string" && entry.reasoning !== undefined
        ? [[entry.id, entry.reasoning] as const]
        : []
    )
  );
  return Object.fromEntries(
    ensembles.map((ensemble) => {
      const capabilities = ensemble.members.flatMap((model) => {
        const capability = byModel.get(model);
        return capability === undefined ? [] : [capability];
      });
      return [
        ensemble.name,
        capabilities.length === ensemble.members.length
          ? sharedEffortCapability(capabilities)
          : undefined
      ];
    })
  );
}

async function externalModelIds(
  url: string,
  token?: string
): Promise<Set<string>> {
  const root = trimTrailingSlashes(url.replace(/\/v1\/?$/, ""));
  const response = await fetch(`${root}/v1/models`, {
    headers:
      token !== undefined ? { authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) {
    throw new Error(`external RouteKit gateway returned HTTP ${response.status} from /v1/models`);
  }
  const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
  return new Set(
    (body.data ?? []).flatMap((entry) =>
      typeof entry.id === "string" ? [entry.id] : []
    )
  );
}

async function resolveRouter(
  repo: string,
  options: RunFusionOptions,
  required: readonly string[]
): Promise<RouteKitConnection> {
  const router = options.router;
  if (router === undefined) {
    throw new Error(
      "FusionKit v4 requires a router reference; run `fusionkit init` or add router.config / router.url to .fusionkit/fusion.json"
    );
  }
  if (typeof router.config === "string") {
    const path = resolveRouterConfigPath(repo, router.config);
    const loaded = loadRouterConfig({ configPath: path });
    return { kind: "embedded", config: loaded.config };
  }
  const authToken =
    router.authEnv !== undefined ? process.env[router.authEnv] : undefined;
  if (router.authEnv !== undefined && authToken === undefined) {
    throw new Error(
      `external RouteKit authentication environment variable is not set: ${router.authEnv}`
    );
  }
  const available = await externalModelIds(router.url, authToken);
  assertModelsAvailable(
    required,
    available,
    "Fusion ensemble references models not advertised by external RouteKit"
  );
  return {
    kind: "external",
    url: trimTrailingSlashes(router.url.replace(/\/v1\/?$/, "")),
    ...(authToken !== undefined ? { authToken } : {})
  };
}

export async function runFusion(
  tool: FusionTool,
  toolArgs: string[],
  options: RunFusionOptions = {}
): Promise<number> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const repo = options.repo ?? gitToplevel(process.cwd());
  if (repo === undefined) {
    throw new Error(
      "FusionKit must run inside a git repository (or pass --repo <dir>)"
    );
  }
  if (options.ensembles === undefined || options.ensembles.length === 0) {
    throw new Error(
      "no fusion ensembles configured; run `fusionkit init` and select namespaced RouteKit model ids"
    );
  }
  const selectedName = options.ensemble ?? options.ensembles[0]!.name;
  const selectedIndex = options.ensembles.findIndex(
    (ensemble) => ensemble.name === selectedName
  );
  if (selectedIndex < 0) {
    throw new Error(
      `unknown ensemble "${selectedName}" (have: ${options.ensembles.map((ensemble) => ensemble.name).join(", ")})`
    );
  }
  const ensembles = options.ensembles.map((ensemble) => ({
    ...ensemble,
    members: [...ensemble.members]
  }));
  if (selectedIndex > 0) ensembles.unshift(...ensembles.splice(selectedIndex, 1));
  if (options.k !== undefined) ensembles[0]!.k = options.k;

  const routekitModelIds = [
    ...new Set(
      ensembles.flatMap((ensemble) => [
        ...ensemble.members,
        ensemble.judge,
        ensemble.synthesizer ?? ensemble.judge
      ])
    )
  ];
  const router = await resolveRouter(repo, options, routekitModelIds);
  const integration = tool === "serve" ? undefined : toolRegistry.get(tool);
  if (tool !== "serve" && integration === undefined) {
    throw new Error(`unknown fusion tool: ${tool}`);
  }

  const root = mkdtempSync(join(tmpdir(), "fusionkit-fusion-"));
  const logsDir = join(root, "logs");
  mkdirSync(logsDir, { recursive: true });
  const sessionStore = new FileSystemSessionStore(defaultSessionsDir());
  const resumeId =
    options.resume !== undefined
      ? resolveSessionId(sessionStore, options.resume)
      : options.continueLatest === true
        ? sessionStore.list()[0]?.id
        : undefined;
  const portless = await createPortlessSession({
    enabled:
      options.portless !== undefined
        ? options.portless
        : process.env.PORTLESS !== "0",
    log
  });
  const previousOtelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  let observability: Observability | undefined;
  if (options.observe === true) {
    try {
      observability = await startObservability({
        log,
        logFile: join(logsDir, "dashboard.log"),
        portless
      });
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= observability.otlpUrl;
      openUrl(observability.url);
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0];
      log(`fusion: observability dashboard unavailable; continuing without it (${detail})`);
    }
  }
  const harness =
    integration === undefined
      ? "agent"
      : unifiedHarnessKind(integration.driver.kind);
  let stack: Awaited<ReturnType<typeof startFusionStack>>;
  try {
    stack = await startFusionStack({
      repo,
      outputRoot: join(root, "runs"),
      ensembles,
      router,
      harness,
      logsDir,
      portless,
      ...(options.fusionkitDir !== undefined
        ? { fusionkitDir: options.fusionkitDir }
        : {}),
      ...(options.authToken !== undefined
        ? { authToken: options.authToken }
        : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.onRateLimit !== undefined
        ? { onRateLimit: options.onRateLimit }
        : {}),
      ...(options.budgetUsd !== undefined
        ? { budgetUsd: options.budgetUsd }
        : {}),
      ...(options.panelTrust !== undefined
        ? { panelTrust: options.panelTrust }
        : {}),
      ...(options.subagents !== undefined
        ? { subagents: options.subagents }
        : {}),
      ...(options.reasoning !== undefined
        ? { reasoning: options.reasoning }
        : {}),
      sessionStore,
      ...(resumeId !== undefined ? { resumeId } : {}),
      sessionMeta: {
        tool,
        repo,
        models: ensembles[0]!.members.map((id) => ({ id, model: id })),
        judgeModel: ensembles[0]!.judge
      },
      log
    });
  } catch (error) {
    try {
      await observability?.close();
    } catch {
      // Preserve the stack startup failure; dashboard cleanup is best effort.
    }
    if (previousOtelEndpoint === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousOtelEndpoint;
    }
    throw error;
  }
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    const errors: unknown[] = [];
    for (const close of [
      () => stack.close(),
      () => observability?.close() ?? Promise.resolve(),
      () => shutdownFusionTracing()
    ]) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (previousOtelEndpoint === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousOtelEndpoint;
    }
    if (errors.length > 0) throw new AggregateError(errors, "Fusion cleanup failed");
  };
  const unregister = registerCleanup(cleanup);
  try {
    log(
      `fusion: ready at ${stack.fusionUrl} (${stack.embeddedRouter ? "embedded RouteKit" : "external RouteKit"})`
    );
    if (tool === "serve") {
      if (options.json === true) {
        process.stdout.write(
          `${JSON.stringify({
            ready: true,
            url: stack.fusionUrl,
            model: fusionModelId(ensembles[0]!.name),
            router: stack.embeddedRouter ? "embedded" : "external"
          })}\n`
        );
      } else {
        process.stdout.write(
          `${gatewaySetupSnippets(stack.fusionUrl, "", fusionModelId(ensembles[0]!.name))}\n`
        );
      }
      await new Promise<void>(() => undefined);
      return 0;
    }
    const reasoningByEnsemble = await fusionReasoningCatalog(
      stack.routekitUrl,
      ensembles,
      router.kind === "external" ? router.authToken : undefined
    );
    const launch = createToolLaunchContext({
      spec: fusionToolLaunchSpec({
        gatewayUrl: stack.fusionUrl,
        defaultEnsemble: ensembles[0]!.name,
        ensembles,
        args: toolArgs,
        ...(options.effort !== undefined ? { effort: options.effort } : {}),
        reasoningByEnsemble,
        cwd: repo,
        ...(options.authToken !== undefined
          ? { authToken: options.authToken }
          : {}),
        ...(options.subagents !== undefined
          ? { subagents: options.subagents }
          : {}),
        ...(options.ide !== undefined ? { ide: options.ide } : {}),
        logsDir
      }),
      log,
      prepareForPassthrough: () => {},
      registerPort: (name, port) => portless.register(name, port),
      unregisterPort: (name) => portless.unregister(name)
    });
    try {
      return await integration!.launch(launch.context);
    } finally {
      await launch.dispose();
    }
  } finally {
    unregister();
    await cleanup();
  }
}

export function toolSelectOptions(): Array<{
  value: FusionTool;
  label: string;
  hint: string;
}> {
  return [
    ...toolRegistry.list().map((tool) => ({
      value: tool.id as FusionTool,
      label: tool.id,
      hint: tool.pickerHint
    })),
    {
      value: "serve",
      label: "serve",
      hint: "run only the FusionKit gateway"
    }
  ];
}
