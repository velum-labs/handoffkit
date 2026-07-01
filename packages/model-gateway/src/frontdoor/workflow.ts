/**
 * The `fusion-frontdoor-turn` kernel workflow: composes the front-door operators
 * into a graph and runs it through {@link FusionRuntime}, so the turn's execution
 * (admission, budget, provenance, trace, replay) is kernel-owned rather than a
 * bespoke procedure inside the backend.
 */

import { createArtifact, FusionRuntime, RuntimeExecutionError, StaticDAGScheduler } from "@fusionkit/kernel";
import type { Artifact, RuntimeEvent } from "@fusionkit/kernel";

import {
  FrontdoorArtifactTypes,
  FrontdoorPanelError,
  frontdoorFinalizeOperator,
  frontdoorFuseOperator,
  frontdoorPanelOperator,
  frontdoorPassthroughOperator,
  frontdoorStreamingFuseOperator
} from "./operators.js";
import type {
  FrontdoorFusionStreamTurn,
  FrontdoorFusionTurn,
  FrontdoorPassthroughTurn
} from "./operators.js";

export const FUSION_PASSTHROUGH_TURN_WORKFLOW = "fusion-passthrough-turn" as const;

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

/**
 * Run a native-passthrough turn as a one-node kernel graph, so the vendor proxy
 * (and its failover into the fusion workflow) is kernel-owned. Returns the live
 * `Response` (vendor reply, fused failover stream, or error).
 */
export async function runFusionPassthroughTurn(
  turn: FrontdoorPassthroughTurn,
  options: { runId?: string } = {}
): Promise<Response> {
  const task = createArtifact({
    id: "frontdoor.task",
    type: FrontdoorArtifactTypes.Task,
    value: {},
    visibility: "runtime",
    leakage: "none"
  });
  const result = await new FusionRuntime().run({
    graph: {
      id: FUSION_PASSTHROUGH_TURN_WORKFLOW,
      inputArtifactIds: [task.id],
      nodes: [
        { id: "passthrough", operator: frontdoorPassthroughOperator(turn), inputs: [{ artifactId: task.id }] }
      ]
    },
    scheduler: new StaticDAGScheduler(FUSION_PASSTHROUGH_TURN_WORKFLOW),
    artifacts: [task],
    ...(options.runId !== undefined ? { runId: options.runId } : {})
  });
  const response = result.finalArtifacts.find(
    (artifact: Artifact): artifact is Artifact<Response> => artifact.value instanceof Response
  )?.value;
  if (!(response instanceof Response)) throw new Error("fusion-passthrough-turn produced no Response");
  return response;
}

/**
 * Run one streaming front-door fusion turn as a kernel graph
 * (`panel -> fuse.stream`) and expose it as a runtime event stream. The panel
 * runs first (the SSE adapter emits keepalives meanwhile); the streaming fuse
 * operator then pipes the Python step's SSE bytes as `sse.chunk` events. A panel
 * or fuse failure surfaces as a terminal `error` event.
 */
export function streamFusionFrontdoorTurn(
  turn: FrontdoorFusionStreamTurn,
  options: { runId?: string } = {}
): AsyncIterable<RuntimeEvent> {
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
      {
        id: "panel",
        operator: frontdoorPanelOperator({ resolveCandidates: turn.resolveCandidates }),
        inputs: [{ artifactId: task.id }]
      },
      { id: "fuse", operator: frontdoorStreamingFuseOperator(turn), inputs: [{ nodeId: "panel" }] }
    ]
  };
  return new FusionRuntime().stream({
    graph,
    scheduler: new StaticDAGScheduler(FUSION_FRONTDOOR_TURN_WORKFLOW),
    artifacts: [task],
    ...(options.runId !== undefined ? { runId: options.runId } : {})
  });
}
