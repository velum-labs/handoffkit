/**
 * Shared v4 full-stack fixture:
 *
 * provider simulator -> embedded RouteKit router -> Python synthesis sidecar
 * -> RouteKit public gateway with FusionBackend.
 *
 * Fusion receives only opaque endpoint ids. Provider dialect/model details
 * exist solely in the test-owned RouteKit config.
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
  SimEndpointSpec
} from "@fusionkit/testkit";
import { parseRouterConfig } from "@routekit/gateway";
import type { RouterConfig } from "@routekit/gateway";

import type { PromptOverrides } from "../fusion-config.js";
import { startFusionStack } from "../fusion/stack.js";

export type SimStackMember = SimEndpointSpec;

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

function dialectFor(
  provider: SimEndpointSpec["provider"]
): "openai" | "anthropic" | "google" | "codex" {
  const resolved = provider ?? "openai";
  switch (resolved) {
    case "anthropic":
      return "anthropic";
    case "google":
      return "google";
    case "codex":
      return "codex";
    case "openai":
    case "openai-compatible":
    case "openrouter":
      return "openai";
    default: {
      const exhaustive: never = resolved;
      throw new Error(`unsupported simulator provider: ${String(exhaustive)}`);
    }
  }
}

function simulatorRouterConfig(
  simUrl: string,
  members: readonly SimStackMember[]
): RouterConfig {
  return parseRouterConfig({
    endpoints: members.map((member) => {
      const dialect = dialectFor(member.provider);
      return {
        endpointId: member.id,
        model: member.model,
        provider: member.provider ?? "openai",
        baseUrl:
          dialect === "google" ? `${simUrl}/v1beta` : `${simUrl}/v1`,
        dialect
      };
    }),
    defaultEndpointId: members[0]?.id
  });
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
  const judgeId =
    options.judgeId ??
    options.members[options.members.length - 1]?.id ??
    first.id;
  const judgeModel =
    options.members.find((member) => member.id === judgeId)?.model ??
    first.model;
  const panelMembers = options.members.filter((member) => member.id !== judgeId);
  const panel = panelMembers.length > 0 ? panelMembers : [first];
  const ensembles =
    options.ensembles !== undefined && options.ensembles.length > 0
      ? options.ensembles.map((ensemble) => ({
          name: ensemble.name,
          members: [...ensemble.memberIds],
          judge: ensemble.judgeId ?? judgeId,
          ...(ensemble.synthesizerId !== undefined
            ? { synthesizer: ensemble.synthesizerId }
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
            members: panel.map((member) => member.id),
            judge: judgeId,
            ...(options.unbounded === true ? {} : { k: options.k ?? 1 })
          }
        ];

  const sim = await startProviderSim();
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
        config: simulatorRouterConfig(sim.url, options.members)
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
