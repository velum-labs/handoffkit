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

import { simRouterConfigYaml, startEngine, startProviderSim } from "@fusionkit/testkit";
import type { EngineHandle, ProviderSimHandle, SimEndpointSpec } from "@fusionkit/testkit";
import type { Gateway } from "@fusionkit/model-gateway";

import { startFusionStepGateway } from "../gateway.js";

export type SimStackMember = SimEndpointSpec;

export type SimFusionStack = {
  /** The scripted provider (queue behaviors / read the journal here). */
  sim: ProviderSimHandle;
  /** The real Python engine (router: passthrough + trajectories:fuse). */
  engine: EngineHandle;
  /** The real Node gateway (what a coding tool points at). */
  gateway: Gateway;
  gatewayUrl: string;
  close: () => Promise<void>;
};

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
    return { sim, engine, gateway, gatewayUrl: gateway.url(), close };
  } catch (error) {
    await close();
    throw error;
  }
}
