/**
 * Shared v4 full-stack fixture:
 *
 * provider simulator -> embedded RouteKit router -> Python synthesis sidecar
 * -> RouteKit public gateway with FusionBackend.
 *
 * Fusion receives only namespaced model ids. Provider dialect/model details
 * exist solely in test-owned RouteKit provider sources.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UnifiedHarnessKind } from "@fusionkit/ensemble";
import type {
  OnRateLimitPolicy,
  SessionStore
} from "@fusionkit/gateway";
import { fusionModelId } from "@fusionkit/registry";
import {
  repoRoot,
  scriptFusedTurn,
  startProviderSim
} from "@fusionkit/testkit";
import type {
  FusedTurnScript,
  ProviderSimHandle,
  SimModelSpec
} from "@fusionkit/testkit";
import {
  AnthropicBackend,
  CodexResponsesBackend,
  GoogleGenAiBackend,
  OpenAiBackend,
  parseRouterConfig
} from "@routekit/gateway";
import type {
  Backend,
  BackendRequestOptions,
  ProviderId,
  ProviderSource,
  RouterConfig
} from "@routekit/gateway";

import type { PromptOverrides } from "../fusion-config.js";
import { startFusionStack } from "../fusion/stack.js";

export type SimStackMember = SimModelSpec;

export type SimStackEnsemble = {
  name: string;
  memberIds: readonly string[];
  judgeId?: string;
  synthesizerId?: string;
  k?: number;
  prompts?: PromptOverrides;
};

export type GatewayDoors = {
  chat: (body: Record<string, unknown>) => Promise<Response>;
  messages: (body: Record<string, unknown>) => Promise<Response>;
  countTokens: (body: Record<string, unknown>) => Promise<Response>;
  responses: (body: Record<string, unknown>) => Promise<Response>;
  cursorChat: (body: Record<string, unknown>) => Promise<Response>;
  embeddings: (body: Record<string, unknown>) => Promise<Response>;
  models: (options?: { anthropicShape?: boolean }) => Promise<Response>;
  model: (id: string) => Promise<Response>;
  cursorModels: () => Promise<Response>;
};

export type SimFusionStack = {
  sim: ProviderSimHandle;
  gatewayUrl: string;
  door: GatewayDoors;
  scriptFusedTurn: (
    script: Omit<FusedTurnScript, "judgeModel"> & { judgeModel?: string }
  ) => Promise<void>;
  close: () => Promise<void>;
};

function buildDoors(gatewayUrl: string): GatewayDoors {
  const post = (
    path: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): Promise<Response> =>
    fetch(`${gatewayUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body)
    });
  return {
    chat: (body) => post("/v1/chat/completions", body),
    messages: (body) =>
      post("/v1/messages", body, { "anthropic-version": "2023-06-01" }),
    countTokens: (body) =>
      post("/v1/messages/count_tokens", body, {
        "anthropic-version": "2023-06-01"
      }),
    responses: (body) => post("/v1/responses", body),
    cursorChat: (body) => post("/v1/cursor/chat/completions", body),
    embeddings: (body) => post("/v1/embeddings", body),
    models: (options = {}) =>
      fetch(`${gatewayUrl}/v1/models`, {
        headers:
          options.anthropicShape === true
            ? { "anthropic-version": "2023-06-01" }
            : {}
      }),
    model: (id) =>
      fetch(`${gatewayUrl}/v1/models/${encodeURIComponent(id)}`),
    cursorModels: () => fetch(`${gatewayUrl}/v1/cursor/models`)
  };
}

function providerIdFor(member: SimStackMember): ProviderId {
  const provider = member.provider ?? "openai";
  switch (provider) {
    case "anthropic":
    case "google":
    case "codex":
    case "openai":
    case "openrouter":
      return provider;
    case "openai-compatible":
      return "openai";
    default: {
      const exhaustive: never = provider;
      throw new Error(`unsupported simulator provider: ${String(exhaustive)}`);
    }
  }
}

function publicModelId(member: SimStackMember): string {
  return `${providerIdFor(member)}/${member.model}`;
}

function simulatorBackend(
  simUrl: string,
  provider: ProviderId,
  model: string
): Backend {
  const options = {
    baseUrl:
      provider === "google" ? `${simUrl}/v1beta` : `${simUrl}/v1`,
    apiKey: "test-provider-key",
    defaultModel: model
  };
  switch (provider) {
    case "anthropic":
    case "claude-code":
      return new AnthropicBackend(options);
    case "google":
      return new GoogleGenAiBackend(options);
    case "codex":
      return new CodexResponsesBackend(options);
    case "cliproxy":
    case "openai":
    case "openrouter":
      return new OpenAiBackend(options);
    default: {
      const exhaustive: never = provider;
      throw new Error(`unsupported simulator provider: ${String(exhaustive)}`);
    }
  }
}

function simulatorProviderSource(
  simUrl: string,
  provider: ProviderId,
  members: readonly SimStackMember[]
): ProviderSource {
  const models = members.map((member) => member.model);
  const backend = simulatorBackend(simUrl, provider, models[0]!);
  return {
    sourceId: provider,
    discoverModels: async () => models.map((id) => ({ id })),
    chat: async (
      body: unknown,
      signal?: AbortSignal,
      options?: BackendRequestOptions
    ) => await backend.chat(body, signal, options),
    embeddings: async (body: unknown, signal?: AbortSignal) =>
      await backend.embeddings(body, signal),
    close: async () => await backend.close?.()
  };
}

function simulatorRouter(
  simUrl: string,
  members: readonly SimStackMember[]
): {
  config: RouterConfig;
  sources: Partial<Record<ProviderId, ProviderSource>>;
} {
  const grouped = new Map<ProviderId, SimStackMember[]>();
  for (const member of members) {
    const provider = providerIdFor(member);
    grouped.set(provider, [...(grouped.get(provider) ?? []), member]);
  }
  const providers = Object.fromEntries(
    [...grouped].map(([provider]) => [provider, {}])
  );
  return {
    config: parseRouterConfig({
      providers,
      defaultModel: publicModelId(members[0]!)
    }),
    sources: Object.fromEntries(
      [...grouped].map(([provider, providerMembers]) => [
        provider,
        simulatorProviderSource(simUrl, provider, providerMembers)
      ])
    )
  };
}

export async function startSimFusionStack(options: {
  members: readonly SimStackMember[];
  judgeId?: string;
  k?: number;
  ensembles?: readonly SimStackEnsemble[];
  sessionStore?: SessionStore;
  resumeId?: string;
  onRateLimit?: OnRateLimitPolicy;
  budgetUsd?: number;
  authToken?: string;
  panelTimeoutMs?: number;
  stragglerGraceMs?: number;
  harness?: UnifiedHarnessKind;
  unbounded?: boolean;
}): Promise<SimFusionStack> {
  const first = options.members[0];
  if (first === undefined) throw new Error("at least one member is required");
  const judgeAlias =
    options.judgeId ??
    options.members[options.members.length - 1]?.id ??
    first.id;
  const modelIds = new Map(
    options.members.map((member) => [member.id, publicModelId(member)])
  );
  const resolveModel = (id: string): string => modelIds.get(id) ?? id;
  const judgeId = resolveModel(judgeAlias);
  const judgeModel =
    options.members.find((member) => member.id === judgeAlias)?.model ??
    first.model;
  const panelMembers = options.members.filter((member) => member.id !== judgeAlias);
  const panel = panelMembers.length > 0 ? panelMembers : [first];
  const ensembles =
    options.ensembles !== undefined && options.ensembles.length > 0
      ? options.ensembles.map((ensemble) => ({
          name: ensemble.name,
          members: ensemble.memberIds.map(resolveModel),
          judge: resolveModel(ensemble.judgeId ?? judgeAlias),
          ...(ensemble.synthesizerId !== undefined
            ? { synthesizer: resolveModel(ensemble.synthesizerId) }
            : {}),
          ...(ensemble.k !== undefined
            ? { k: ensemble.k }
            : options.unbounded === true
              ? {}
              : { k: options.k ?? 1 }),
          ...(ensemble.prompts !== undefined
            ? { prompts: ensemble.prompts }
            : {})
        }))
      : [
          {
            name: "default",
            members: panel.map(publicModelId),
            judge: judgeId,
            ...(options.unbounded === true ? {} : { k: options.k ?? 1 })
          }
        ];

  const sim = await startProviderSim();
  const router = simulatorRouter(sim.url, options.members);
  const outputRoot = mkdtempSync(join(tmpdir(), "fusionkit-v4-sim-stack-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: outputRoot });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=e2e@fusionkit.local",
      "-c",
      "user.name=fusionkit-e2e",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "sim stack fixture"
    ],
    { cwd: outputRoot }
  );
  let stack: Awaited<ReturnType<typeof startFusionStack>> | undefined;
  const close = async (): Promise<void> => {
    try {
      await stack?.close();
    } finally {
      await sim.close();
      rmSync(outputRoot, { recursive: true, force: true });
    }
  };
  try {
    stack = await startFusionStack({
      repo: outputRoot,
      outputRoot,
      ensembles,
      router: {
        kind: "embedded",
        config: router.config,
        sources: router.sources
      },
      harness: options.harness ?? "agent",
      reasoning: true,
      fusionkitDir: repoRoot(),
      ...(options.sessionStore !== undefined
        ? { sessionStore: options.sessionStore }
        : {}),
      ...(options.resumeId !== undefined ? { resumeId: options.resumeId } : {}),
      ...(options.onRateLimit !== undefined
        ? { onRateLimit: options.onRateLimit }
        : {}),
      ...(options.budgetUsd !== undefined
        ? { budgetUsd: options.budgetUsd }
        : {}),
      ...(options.authToken !== undefined
        ? { authToken: options.authToken }
        : {}),
      ...(options.panelTimeoutMs !== undefined
        ? { panelTimeoutMs: options.panelTimeoutMs }
        : {}),
      ...(options.stragglerGraceMs !== undefined
        ? { stragglerGraceMs: options.stragglerGraceMs }
        : {}),
      log: () => {}
    });
    return {
      sim,
      gatewayUrl: stack.fusionUrl,
      door: buildDoors(stack.fusionUrl),
      scriptFusedTurn: async (script) => {
        await sim.reset();
        await scriptFusedTurn(sim, {
          judgeModel: script.judgeModel ?? judgeModel,
          ...script
        });
      },
      close
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export function fusedModelIds(
  ensembles: readonly SimStackEnsemble[]
): string[] {
  return ensembles.map((ensemble) => fusionModelId(ensemble.name));
}
