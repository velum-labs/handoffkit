/**
 * The `fusion-frontdoor-turn` kernel workflow: composes the front-door turn
 * operators into a graph and runs it through {@link FusionRuntime}. Every operator
 * is stable (constructed with the shared services) and reads the per-turn
 * {@link FrontdoorRequestValue} from the request artifact.
 */

import { createArtifact, FusionRuntime, RuntimeExecutionError, StaticDAGScheduler } from "@fusionkit/kernel";
import type { Artifact, RuntimeEvent } from "@fusionkit/kernel";

import {
  FrontdoorArtifactTypes,
  FrontdoorPanelError,
  frontdoorFinalizeOperator,
  frontdoorFuseOperator,
  frontdoorPanelOperator,
  frontdoorStreamingFuseOperator
} from "./operators.js";
import type { FrontdoorRequestValue, FrontdoorServices } from "./types.js";

export const FUSION_FRONTDOOR_TURN_WORKFLOW = "fusion-frontdoor-turn" as const;

export type FrontdoorTurnOutcome =
  | { kind: "response"; response: Response }
  | { kind: "panel_error"; error: unknown };

export function frontdoorRequestArtifact(req: FrontdoorRequestValue): Artifact<FrontdoorRequestValue> {
  return createArtifact<FrontdoorRequestValue>({
    id: "frontdoor.request",
    type: FrontdoorArtifactTypes.Request,
    value: req,
    visibility: "runtime",
    leakage: "none"
  });
}

/**
 * Run one buffered front-door fusion turn as a kernel graph:
 * `panel -> fuse -> finalize`. Returns the finalized `Response`, or a
 * `panel_error` outcome (which the backend maps to a 502 + turn eviction). A
 * fuse-phase failure (e.g. an aborted fetch) is rethrown so the caller rejects.
 */
export async function runFusionFrontdoorTurn(
  services: FrontdoorServices,
  req: FrontdoorRequestValue,
  options: { runId?: string } = {}
): Promise<FrontdoorTurnOutcome> {
  const request = frontdoorRequestArtifact(req);
  const graph = {
    id: FUSION_FRONTDOOR_TURN_WORKFLOW,
    inputArtifactIds: [request.id],
    nodes: [
      { id: "panel", operator: frontdoorPanelOperator(services), inputs: [{ artifactId: request.id }] },
      {
        id: "fuse",
        operator: frontdoorFuseOperator(services),
        inputs: [{ artifactId: request.id }, { nodeId: "panel" }]
      },
      {
        id: "finalize",
        operator: frontdoorFinalizeOperator(services),
        inputs: [{ artifactId: request.id }, { nodeId: "fuse" }]
      }
    ]
  };
  try {
    const result = await new FusionRuntime().run({
      graph,
      scheduler: new StaticDAGScheduler(FUSION_FRONTDOOR_TURN_WORKFLOW),
      artifacts: [request],
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

/**
 * Run one streaming front-door fusion turn as a kernel graph
 * (`panel -> fuse.stream`) and expose it as a runtime event stream. The panel
 * runs first (the SSE adapter emits keepalives meanwhile); the streaming fuse
 * operator then pipes the Python step's SSE bytes as `sse.chunk` events. A panel
 * or fuse failure surfaces as a terminal `error` event.
 */
export function streamFusionFrontdoorTurn(
  services: FrontdoorServices,
  req: FrontdoorRequestValue,
  options: { runId?: string } = {}
): AsyncIterable<RuntimeEvent> {
  const request = frontdoorRequestArtifact(req);
  const graph = {
    id: FUSION_FRONTDOOR_TURN_WORKFLOW,
    inputArtifactIds: [request.id],
    nodes: [
      { id: "panel", operator: frontdoorPanelOperator(services), inputs: [{ artifactId: request.id }] },
      {
        id: "fuse",
        operator: frontdoorStreamingFuseOperator(services),
        inputs: [{ artifactId: request.id }, { nodeId: "panel" }]
      }
    ]
  };
  return new FusionRuntime().stream({
    graph,
    scheduler: new StaticDAGScheduler(FUSION_FRONTDOOR_TURN_WORKFLOW),
    artifacts: [request],
    ...(options.runId !== undefined ? { runId: options.runId } : {})
  });
}
