/**
 * The full-stack simulation harness: provider simulator (scripted Python
 * child) -> REAL `fusionkit serve` engine (spawned Python child) -> REAL Node
 * fusion gateway (`startFusionStepGateway`, the production front door).
 *
 * This is the composition root for cross-process end-to-end tests: everything
 * between a coding tool's HTTP request and the provider wire runs as shipped,
 * while the provider itself is scriptable (behavior queues) and observable
 * (the wire journal). Test-only helper — lives under `src/test/` so it never
 * ships, but is shared by any suite that wants the whole stack.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scriptFusedTurn, simRouterConfigYaml, startEngine, startProviderSim } from "@fusionkit/testkit";
import type { EngineHandle, FusedTurnScript, ProviderSimHandle, SimEndpointSpec } from "@fusionkit/testkit";
import type { Gateway } from "@fusionkit/model-gateway";

import { startFusionStepGateway } from "../gateway.js";

export type SimStackMember = SimEndpointSpec;

/**
 * Thin typed fetch helpers for every HTTP door the gateway serves, so tests
 * read as "hit this surface" instead of re-assembling fetch plumbing. Each
 * returns the raw `Response` — status, headers, and body stay assertable.
 */
export type GatewayDoors = {
  /** POST /v1/chat/completions (OpenAI chat dialect; Cursorkit/generic tools). */
  chat: (body: Record<string, unknown>) => Promise<Response>;
  /** POST /v1/messages (Anthropic Messages dialect; Claude Code). */
  messages: (body: Record<string, unknown>) => Promise<Response>;
  /** POST /v1/messages/count_tokens (Claude Code's preflight). */
  countTokens: (body: Record<string, unknown>) => Promise<Response>;
  /** POST /v1/responses (OpenAI Responses dialect; Codex). */
  responses: (body: Record<string, unknown>) => Promise<Response>;
  /** POST /v1/cursor/chat/completions (Cursor's BYOK Responses-hybrid door). */
  cursorChat: (body: Record<string, unknown>) => Promise<Response>;
  /** POST /v1/embeddings (documented as unsupported on the fusion gateway). */
  embeddings: (body: Record<string, unknown>) => Promise<Response>;
  /** GET /v1/models (OpenAI shape; anthropicShape adds Claude's discovery header). */
  models: (options?: { anthropicShape?: boolean }) => Promise<Response>;
  /** GET /v1/models/{id} (Claude Code's single-model validation probe). */
  model: (id: string) => Promise<Response>;
  /** GET /v1/cursor/models (Cursor probes relative to its BYOK base URL). */
  cursorModels: () => Promise<Response>;
};

export type SimFusionStack = {
  /** The scripted provider (queue behaviors / read the journal here). */
  sim: ProviderSimHandle;
  /** The real Python engine (router: passthrough + trajectories:fuse). */
  engine: EngineHandle;
  /** The real Node gateway (what a coding tool points at). */
  gateway: Gateway;
  gatewayUrl: string;
  /** Every gateway HTTP door, as a typed fetch helper. */
  door: GatewayDoors;
  /**
   * Reset the provider journal/queues and script one full fused turn (panel
   * candidates + judge analysis + synthesized answer) in a single call.
   * `judgeModel` defaults to this stack's judge endpoint.
   */
  scriptFusedTurn: (script: Omit<FusedTurnScript, "judgeModel"> & { judgeModel?: string }) => Promise<void>;
  close: () => Promise<void>;
};

function buildDoors(gatewayUrl: string): GatewayDoors {
  const post = (path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    fetch(`${gatewayUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body)
    });
  return {
    chat: (body) => post("/v1/chat/completions", body),
    messages: (body) => post("/v1/messages", body, { "anthropic-version": "2023-06-01" }),
    countTokens: (body) => post("/v1/messages/count_tokens", body, { "anthropic-version": "2023-06-01" }),
    responses: (body) => post("/v1/responses", body),
    cursorChat: (body) => post("/v1/cursor/chat/completions", body),
    embeddings: (body) => post("/v1/embeddings", body),
    models: (options = {}) =>
      fetch(`${gatewayUrl}/v1/models`, {
        headers: options.anthropicShape === true ? { "anthropic-version": "2023-06-01" } : {}
      }),
    model: (id) => fetch(`${gatewayUrl}/v1/models/${encodeURIComponent(id)}`),
    cursorModels: () => fetch(`${gatewayUrl}/v1/cursor/models`)
  };
}

/**
 * Boot the whole stack. `members` become router endpoints (all backed by the
 * simulator) and the panel of one `fusion-panel` ensemble, judged by
 * `judgeId` (defaults to the last member). `k` defaults to 1 (proposal mode:
 * members are single completions — no worktrees or coding-agent binaries), so
 * the stack is fully exercised without external tools.
 */
export async function startSimFusionStack(options: {
  members: readonly SimStackMember[];
  judgeId?: string;
  k?: number;
}): Promise<SimFusionStack> {
  const first = options.members[0];
  if (first === undefined) throw new Error("at least one member is required");
  const judgeId = options.judgeId ?? options.members[options.members.length - 1]?.id ?? first.id;
  const judgeModel = options.members.find((member) => member.id === judgeId)?.model ?? first.model;
  const panelMembers = options.members.filter((member) => member.id !== judgeId);
  const panel = panelMembers.length > 0 ? panelMembers : [first];

  const sim = await startProviderSim();
  let engine: EngineHandle | undefined;
  let gateway: Gateway | undefined;
  const outputRoot = mkdtempSync(join(tmpdir(), "sim-stack-out-"));
  const close = async (): Promise<void> => {
    await gateway?.close();
    await engine?.close();
    await sim.close();
    rmSync(outputRoot, { recursive: true, force: true });
  };
  try {
    engine = await startEngine({
      configYaml: simRouterConfigYaml({ simUrl: sim.url, members: options.members, judgeId })
    });
    const endpoints = Object.fromEntries(options.members.map((member) => [member.id, engine?.url ?? ""]));
    gateway = await startFusionStepGateway({
      config: {
        fusionBackendUrl: engine.url,
        repo: outputRoot,
        outputRoot,
        harnesses: ["agent"],
        models: panel.map((member) => ({ id: member.id, model: member.model })),
        ensembles: [
          {
            name: "default",
            modelId: "fusion-panel",
            models: panel.map((member) => ({ id: member.id, model: member.model })),
            judgeEndpointId: judgeId,
            judgeModelName: judgeModel,
            k: options.k ?? 1
          }
        ],
        modelEndpoints: endpoints,
        timeoutMs: 120_000
      },
      host: "127.0.0.1",
      port: 0
    });
    const gatewayUrl = gateway.url();
    return {
      sim,
      engine,
      gateway,
      gatewayUrl,
      door: buildDoors(gatewayUrl),
      scriptFusedTurn: async (script) => {
        await sim.reset();
        await scriptFusedTurn(sim, { judgeModel: script.judgeModel ?? judgeModel, ...script });
      },
      close
    };
  } catch (error) {
    await close();
    throw error;
  }
}
