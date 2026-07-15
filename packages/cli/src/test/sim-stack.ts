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

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scriptFusedTurn, simRouterConfigYaml, startEngine, startProviderSim } from "@fusionkit/testkit";
import type { EngineHandle, FusedTurnScript, ProviderSimHandle, SimEndpointSpec } from "@fusionkit/testkit";
import type { OnRateLimitPolicy, SessionStore } from "@fusionkit/gateway";
import type { Gateway, ModelPricing } from "@routekit/gateway";

import { fusionModelId } from "@fusionkit/registry";
import { harnessDriversEnabled } from "@fusionkit/tools";

import { startFusionStepGateway } from "../gateway.js";
import type { GatewayEnsembleConfig } from "../gateway.js";
import type { PromptOverrides } from "../fusion-config.js";
import { startDriverEndpointGateways } from "../fusion/stack.js";
import type { UnifiedHarnessKind } from "@fusionkit/ensemble";

export type SimStackMember = SimEndpointSpec;

/** One named ensemble routed by the gateway (a subset of the stack's members). */
export type SimStackEnsemble = {
  name: string;
  /** Member endpoint ids that fan out for this ensemble. */
  memberIds: readonly string[];
  /** Judge endpoint id; defaults to the stack judge. */
  judgeId?: string;
  synthesizerId?: string;
  k?: number;
  /** Per-ensemble judge/synthesizer prompt overrides (sent on the fuse step). */
  prompts?: PromptOverrides;
};

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
  /**
   * Named ensembles (session-default first); each becomes its own advertised
   * fused model (`fusion-<name>`, first is also `fusion-panel`'s default).
   * When unset, one implicit ensemble spans every non-judge member.
   */
  ensembles?: readonly SimStackEnsemble[];
  /** WS4 durable session store (e.g. `InMemorySessionStore` for assertions). */
  sessionStore?: SessionStore;
  /** WS4 persisted session id to bind to the first conversation after restart. */
  resumeId?: string;
  /** Per-model token pricing overrides (WS7 cost accounting). */
  pricing?: Readonly<Record<string, ModelPricing>>;
  /** WS5 rate-limit / credit failover policy for vendor passthrough models. */
  onRateLimit?: OnRateLimitPolicy;
  /** WS7 budget cap (USD) for the session's gateway-observed cost. */
  budgetUsd?: number;
  /** Optional bearer token protecting every gateway route. */
  authToken?: string;
  /** Hard wall-clock budget for one panel phase. */
  panelTimeoutMs?: number;
  /** Grace after the first successful candidate before aborting stragglers. */
  stragglerGraceMs?: number;
  /** Harness used for managed panel rollouts (default `agent`). */
  harness?: UnifiedHarnessKind;
  /** Omit the ensemble k boundary (managed unbounded rollout). */
  unbounded?: boolean;
}): Promise<SimFusionStack> {
  const first = options.members[0];
  if (first === undefined) throw new Error("at least one member is required");
  const judgeId = options.judgeId ?? options.members[options.members.length - 1]?.id ?? first.id;
  const judgeModel = options.members.find((member) => member.id === judgeId)?.model ?? first.model;
  const panelMembers = options.members.filter((member) => member.id !== judgeId);
  const panel = panelMembers.length > 0 ? panelMembers : [first];

  const memberById = new Map(options.members.map((member) => [member.id, member]));
  const toEnsembleConfig = (ensemble: SimStackEnsemble): GatewayEnsembleConfig => {
    const ensembleJudgeId = ensemble.judgeId ?? judgeId;
    const ensembleJudge = memberById.get(ensembleJudgeId);
    return {
      name: ensemble.name,
      modelId: fusionModelId(ensemble.name),
      models: ensemble.memberIds.map((id) => {
        const member = memberById.get(id);
        if (member === undefined) throw new Error(`unknown ensemble member id ${id}`);
        return { id: member.id, model: member.model };
      }),
      judgeEndpointId: ensembleJudgeId,
      judgeModelName: ensembleJudge?.model ?? judgeModel,
      ...(ensemble.synthesizerId !== undefined ? { synthesizerEndpointId: ensemble.synthesizerId } : {}),
      ...(ensemble.k !== undefined
        ? { k: ensemble.k }
        : options.unbounded === true
          ? {}
          : { k: options.k ?? 1 }),
      ...(ensemble.prompts !== undefined ? { prompts: ensemble.prompts } : {})
    };
  };
  const ensembles: GatewayEnsembleConfig[] =
    options.ensembles !== undefined && options.ensembles.length > 0
      ? options.ensembles.map(toEnsembleConfig)
      : [
          {
            name: "default",
            modelId: "fusion-panel",
            models: panel.map((member) => ({ id: member.id, model: member.model })),
            judgeEndpointId: judgeId,
            judgeModelName: judgeModel,
            ...(options.unbounded === true ? {} : { k: options.k ?? 1 })
          }
        ];

  const sim = await startProviderSim();
  let engine: EngineHandle | undefined;
  let gateway: Gateway | undefined;
  let driverEndpointClose: () => Promise<void> = async () => {};
  const outputRoot = mkdtempSync(join(tmpdir(), "sim-stack-out-"));
  // Managed harnesses require a real source repository so each candidate can
  // receive its own disposable worktree. Initializing it for every stack is
  // cheap and keeps switching k/harness axes a configuration-only change.
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
  const close = async (): Promise<void> => {
    await gateway?.close();
    await driverEndpointClose();
    await engine?.close();
    await sim.close();
    rmSync(outputRoot, { recursive: true, force: true });
  };
  try {
    engine = await startEngine({
      configYaml: simRouterConfigYaml({ simUrl: sim.url, members: options.members, judgeId })
    });
    let endpoints = Object.fromEntries(
      options.members.map((member) => [member.id, engine?.url ?? ""])
    );
    const driverHarness =
      options.harness === "codex" ||
      options.harness === "claude-code" ||
      options.harness === "cursor-acp" ||
      options.harness === "cursor-desktop";
    if (driverHarness && harnessDriversEnabled()) {
      const driverEndpoints = await startDriverEndpointGateways({
        models: panel.map((member) => ({ id: member.id, model: member.model })),
        modelEndpoints: endpoints
      });
      endpoints = driverEndpoints.endpoints;
      driverEndpointClose = driverEndpoints.close;
    }
    gateway = await startFusionStepGateway({
      config: {
        fusionBackendUrl: engine.url,
        repo: outputRoot,
        outputRoot,
        harnesses: [options.harness ?? "agent"],
        models: panel.map((member) => ({ id: member.id, model: member.model })),
        ensembles,
        modelEndpoints: endpoints,
        timeoutMs: 120_000,
        ...(options.sessionStore !== undefined ? { sessionStore: options.sessionStore } : {}),
        ...(options.resumeId !== undefined ? { resumeId: options.resumeId } : {}),
        ...(options.pricing !== undefined ? { pricing: options.pricing } : {}),
        ...(options.onRateLimit !== undefined ? { onRateLimit: options.onRateLimit } : {}),
        ...(options.budgetUsd !== undefined ? { budgetUsd: options.budgetUsd } : {}),
        ...(options.panelTimeoutMs !== undefined ? { panelTimeoutMs: options.panelTimeoutMs } : {}),
        ...(options.stragglerGraceMs !== undefined
          ? { stragglerGraceMs: options.stragglerGraceMs }
          : {})
      },
      host: "127.0.0.1",
      port: 0,
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {})
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
