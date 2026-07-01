/**
 * The `fusion-frontdoor-turn` kernel workflow: composes the front-door operators
 * into a graph and runs it through {@link FusionRuntime}, so the turn's execution
 * (admission, budget, provenance, trace, replay) is kernel-owned rather than a
 * bespoke procedure inside the backend.
 */

import { createArtifact, FusionRuntime, RuntimeExecutionError, StaticDAGScheduler } from "@fusionkit/kernel";
import type { Artifact } from "@fusionkit/kernel";

import {
  FrontdoorArtifactTypes,
  FrontdoorPanelError,
  frontdoorFinalizeOperator,
  frontdoorFuseOperator,
  frontdoorPanelOperator
} from "./operators.js";
import type { FrontdoorFusionTurn } from "./operators.js";

export const FUSION_FRONTDOOR_TURN_WORKFLOW = "fusion-frontdoor-turn" as const;

export type FrontdoorTurnOutcome =
  | { kind: "response"; response: Response }
  | { kind: "panel_error"; error: unknown };

/**
 * Run one non-streaming front-door fusion turn as a kernel graph:
 * `panel -> fuse -> finalize`. Returns the finalized `Response`, or a
 * `panel_error` outcome (which the backend maps to a 502 + turn eviction). A
 * fuse-phase failure (e.g. an aborted fetch) is rethrown so the caller rejects,
 * matching the legacy behavior.
 */
export async function runFusionFrontdoorTurn(
  turn: FrontdoorFusionTurn,
  options: { runId?: string } = {}
): Promise<FrontdoorTurnOutcome> {
  const task = createArtifact({
    id: "frontdoor.task",
    type: FrontdoorArtifactTypes.Task,
    value: {},
    visibility: "runtime",
    leakage: "none"
  });
  const graph = {
    id: FUSION_FRONTDOOR_TURN_WORKFLOW,
    inputArtifactIds: [task.id],
    nodes: [
      { id: "panel", operator: frontdoorPanelOperator(turn), inputs: [{ artifactId: task.id }] },
      { id: "fuse", operator: frontdoorFuseOperator(turn), inputs: [{ nodeId: "panel" }] },
      { id: "finalize", operator: frontdoorFinalizeOperator(turn), inputs: [{ nodeId: "fuse" }] }
    ]
  };
  try {
    const result = await new FusionRuntime().run({
      graph,
      scheduler: new StaticDAGScheduler(FUSION_FRONTDOOR_TURN_WORKFLOW),
      artifacts: [task],
      ...(options.runId !== undefined ? { runId: options.runId } : {})
    });
    const response = result.finalArtifacts.find(
      (artifact: Artifact): artifact is Artifact<Response> => artifact.value instanceof Response
    )?.value;
    if (!(response instanceof Response)) throw new Error("fusion-frontdoor-turn produced no Response");
    return { kind: "response", response };
  } catch (error) {
    const cause = error instanceof RuntimeExecutionError ? error.cause : error;
    if (cause instanceof FrontdoorPanelError) {
      return { kind: "panel_error", error: cause.cause ?? cause };
    }
    throw error;
  }
}
