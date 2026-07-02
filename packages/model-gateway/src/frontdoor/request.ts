/**
 * The top-level `fusion-frontdoor-request` kernel graph and its routing scheduler.
 *
 * Request routing is expressed as first-class operators and a scheduler decision,
 * not imperative backend branching:
 *
 *   budget-gate -> (budget-stop)
 *               -> resolve-model -> fusion
 *                                -> vendor-proxy -> (response) | (failover -> fusion-failover)
 *
 * `FrontdoorRequestScheduler` inspects the `budget-gate` / `resolve-model` /
 * `vendor-proxy` decision artifacts and runs only the chosen branch. Rate-limit
 * failover is therefore a scheduler decision over a classified outcome artifact,
 * not a recursive call inside the vendor proxy.
 */

import { createArtifact, FusionRuntime, nodesById } from "@fusionkit/kernel";
import type {
  Artifact,
  Operator,
  OperatorGraph,
  OperatorGraphNode,
  Scheduler,
  SchedulerExecutionContext,
  SchedulerRunResult
} from "@fusionkit/kernel";

import { mergeEventsWithNarration } from "./narration.js";
import { eventsToSseResponse } from "./sse.js";
import {
  FrontdoorArtifactTypes,
  FrontdoorOperatorKinds,
  frontdoorBudgetGateOperator,
  frontdoorBudgetStopOperator,
  frontdoorResolveModelOperator,
  frontdoorVendorProxyOperator
} from "./operators.js";
import type { BudgetValue, FailoverValue, RouteValue } from "./operators.js";
import type { FrontdoorRequestValue, FrontdoorServices } from "./types.js";
import { runFusionFrontdoorTurn, streamFusionFrontdoorTurn } from "./workflow.js";

export const FUSION_FRONTDOOR_REQUEST_WORKFLOW = "fusion-frontdoor-request" as const;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "fusion_error" } }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/**
 * Run the fused turn for a request and return its `Response`: a streamed SSE
 * response (via the streaming runtime + SSE adapter) or a buffered JSON response
 * (mapping a panel failure to a 502 + turn eviction).
 */
async function runFusionTurnResponse(
  services: FrontdoorServices,
  req: FrontdoorRequestValue
): Promise<Response> {
  const runId = `${req.sessionKey}:t${req.turn}`;
  if (req.streaming) {
    // Reasoning traces: narrate panel/judge progress into the stream while the
    // panel runs. Best-effort — a narration failure must never break the turn.
    const narration = services.openTurnNarration?.(req);
    const events = streamFusionFrontdoorTurn(services, req, { runId });
    const merged = narration !== undefined ? mergeEventsWithNarration(events, narration) : events;
    return eventsToSseResponse(merged, {
      ...(req.notice !== undefined ? { notice: req.notice } : {}),
      onError: () => {
        narration?.close();
        services.evictTurn(req);
      },
      onComplete: () => narration?.close()
    });
  }
  const outcome = await runFusionFrontdoorTurn(services, req, { runId });
  if (outcome.kind === "panel_error") {
    services.evictTurn(req);
    console.error(`fusion: panel phase failed: ${errorText(outcome.error)}`);
    return jsonError(502, errorText(outcome.error));
  }
  return outcome.response;
}

function requestOf(inputs: readonly Artifact[]): FrontdoorRequestValue {
  const request = inputs.find((artifact) => artifact.type === FrontdoorArtifactTypes.Request)?.value as
    | FrontdoorRequestValue
    | undefined;
  if (request === undefined) throw new Error("frontdoor dispatch operator missing request artifact");
  return request;
}

/** dispatch.fusion: run the fused turn for the (possibly failover-augmented) request. */
function frontdoorDispatchFusionOperator(
  services: FrontdoorServices,
  augment: (req: FrontdoorRequestValue, inputs: readonly Artifact[]) => FrontdoorRequestValue
): Operator {
  return {
    spec: {
      id: FrontdoorOperatorKinds.DispatchFusion,
      kind: FrontdoorOperatorKinds.DispatchFusion,
      requiredInputTypes: [FrontdoorArtifactTypes.Request],
      outputTypes: [FrontdoorArtifactTypes.Response],
      sideEffects: "external_tool"
    },
    run: async (inputs, ctx) => [
      ctx.createArtifact({
        id: `${ctx.nodeId}.response`,
        type: FrontdoorArtifactTypes.Response,
        value: await runFusionTurnResponse(services, augment(requestOf(inputs), inputs)),
        visibility: "user",
        leakage: "none"
      })
    ]
  };
}

/** Runs the budget gate, then routes to budget-stop, fusion, or vendor-proxy —
 *  with vendor pre-stream failover re-entering the fusion turn — by inspecting
 *  the decision artifacts. Only the chosen branch runs. */
export class FrontdoorRequestScheduler implements Scheduler {
  readonly id = FUSION_FRONTDOOR_REQUEST_WORKFLOW;
  readonly family = "frontdoor-request";

  async schedule(graph: OperatorGraph, ctx: SchedulerExecutionContext): Promise<SchedulerRunResult> {
    const byId = nodesById(graph);
    const node = (id: string): OperatorGraphNode => {
      const found = byId.get(id);
      if (found === undefined) throw new Error(`fusion-frontdoor-request graph missing node ${id}`);
      return found;
    };
    const first = (artifacts: readonly Artifact[]): string[] => (artifacts[0] !== undefined ? [artifacts[0].id] : []);

    const [budget] = await ctx.runNode(node("budget-gate"));
    const exceeded = (budget?.value as BudgetValue | undefined)?.exceeded === true;
    ctx.recordTrace({
      type: "scheduler.decision",
      nodeId: "budget-gate",
      operatorId: FrontdoorOperatorKinds.BudgetGate,
      payload: { budget_exceeded: exceeded }
    });
    if (exceeded) return { finalArtifactIds: first(await ctx.runNode(node("budget-stop"))) };

    const [route] = await ctx.runNode(node("resolve-model"));
    const decision = (route?.value as RouteValue | undefined)?.route ?? "fusion";
    ctx.recordTrace({
      type: "scheduler.decision",
      nodeId: "resolve-model",
      operatorId: FrontdoorOperatorKinds.ResolveModel,
      payload: { route: decision }
    });
    if (decision === "fusion") return { finalArtifactIds: first(await ctx.runNode(node("fusion"))) };

    const vendorOutputs = await ctx.runNode(node("vendor-proxy"));
    const response = vendorOutputs.find((artifact) => artifact.type === FrontdoorArtifactTypes.Response);
    if (response !== undefined) return { finalArtifactIds: [response.id] };
    ctx.recordTrace({
      type: "scheduler.decision",
      nodeId: "vendor-proxy",
      operatorId: FrontdoorOperatorKinds.VendorProxy,
      payload: { failover: true }
    });
    return { finalArtifactIds: first(await ctx.runNode(node("fusion-failover"))) };
  }
}

/**
 * Execute a full front-door request as the `fusion-frontdoor-request` kernel
 * graph and return the resulting `Response` (budget stop, fused turn, vendor
 * reply, or fused failover).
 */
export async function runFrontdoorRequest(
  services: FrontdoorServices,
  req: FrontdoorRequestValue
): Promise<Response> {
  const request = createArtifact<FrontdoorRequestValue>({
    id: "frontdoor.request",
    type: FrontdoorArtifactTypes.Request,
    value: req,
    visibility: "runtime",
    leakage: "none"
  });
  const fusionDispatch = frontdoorDispatchFusionOperator(services, (base) => base);
  const failoverDispatch = frontdoorDispatchFusionOperator(services, (base, inputs) => {
    const failover = inputs.find((artifact) => artifact.type === FrontdoorArtifactTypes.Failover)?.value as
      | FailoverValue
      | undefined;
    return failover === undefined
      ? base
      : { ...base, excludeModelIds: failover.excludeModelIds, notice: failover.notice };
  });
  const graph: OperatorGraph = {
    id: FUSION_FRONTDOOR_REQUEST_WORKFLOW,
    inputArtifactIds: [request.id],
    nodes: [
      { id: "budget-gate", operator: frontdoorBudgetGateOperator(services), inputs: [{ artifactId: request.id }] },
      { id: "budget-stop", operator: frontdoorBudgetStopOperator(services), inputs: [{ artifactId: request.id }] },
      { id: "resolve-model", operator: frontdoorResolveModelOperator(services), inputs: [{ artifactId: request.id }] },
      { id: "fusion", operator: fusionDispatch, inputs: [{ artifactId: request.id }] },
      { id: "vendor-proxy", operator: frontdoorVendorProxyOperator(services), inputs: [{ artifactId: request.id }] },
      {
        id: "fusion-failover",
        operator: failoverDispatch,
        inputs: [{ artifactId: request.id }, { nodeId: "vendor-proxy", type: FrontdoorArtifactTypes.Failover }]
      }
    ]
  };
  const result = await new FusionRuntime().run({
    graph,
    scheduler: new FrontdoorRequestScheduler(),
    artifacts: [request],
    runId: `${req.sessionKey}:request`
  });
  const response = result.finalArtifacts.find(
    (artifact: Artifact): artifact is Artifact<Response> => artifact.value instanceof Response
  )?.value;
  if (!(response instanceof Response)) throw new Error("fusion-frontdoor-request produced no Response");
  return response;
}
