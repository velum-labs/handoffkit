/**
 * The top-level `fusion-frontdoor-request` kernel graph.
 *
 * This lifts the request-level routing that used to be imperative branching in
 * `FusionBackend.chat` into first-class operators and a routing scheduler:
 *
 *   budget-gate -> (budget-stop) | (resolve-model -> fusion | passthrough)
 *
 * `FrontdoorRequestScheduler` inspects the `budget-gate` and `resolve-model`
 * decision artifacts and runs only the chosen branch — a genuine scheduler
 * decision rather than a static DAG. Each branch dispatches into a named turn
 * graph (`fusion-frontdoor-turn` / `fusion-passthrough-turn`).
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

import { FrontdoorArtifactTypes, FrontdoorOperatorKinds } from "./operators.js";

export const FUSION_FRONTDOOR_REQUEST_WORKFLOW = "fusion-frontdoor-request" as const;

export type FrontdoorRoute = "passthrough" | "fusion";

/** The injected implementation of a front-door request: the surface-level
 *  budget gate and requested-model resolution, plus the two turn dispatchers. */
export type FrontdoorRequestTurn = {
  isBudgetExceeded: () => boolean;
  budgetStop: () => Response;
  resolveRoute: () => FrontdoorRoute;
  runFusion: () => Promise<Response>;
  runPassthrough: () => Promise<Response>;
};

type BudgetValue = { exceeded: boolean };
type RouteValue = { route: FrontdoorRoute };

function budgetGateOperator(turn: FrontdoorRequestTurn): Operator {
  return {
    spec: {
      id: FrontdoorOperatorKinds.BudgetGate,
      kind: FrontdoorOperatorKinds.BudgetGate,
      requiredInputTypes: [FrontdoorArtifactTypes.Task],
      outputTypes: [FrontdoorArtifactTypes.Budget],
      sideEffects: "none"
    },
    run: (_inputs, ctx) => [
      ctx.createArtifact<BudgetValue>({
        id: `${ctx.nodeId}.budget`,
        type: FrontdoorArtifactTypes.Budget,
        value: { exceeded: turn.isBudgetExceeded() },
        visibility: "runtime",
        leakage: "none"
      })
    ]
  };
}

function budgetStopOperator(turn: FrontdoorRequestTurn): Operator {
  return {
    spec: {
      id: FrontdoorOperatorKinds.BudgetStop,
      kind: FrontdoorOperatorKinds.BudgetStop,
      requiredInputTypes: [FrontdoorArtifactTypes.Budget],
      outputTypes: [FrontdoorArtifactTypes.Response],
      sideEffects: "none"
    },
    run: (_inputs, ctx) => [
      ctx.createArtifact({
        id: `${ctx.nodeId}.response`,
        type: FrontdoorArtifactTypes.Response,
        value: turn.budgetStop(),
        visibility: "user",
        leakage: "none"
      })
    ]
  };
}

function resolveModelOperator(turn: FrontdoorRequestTurn): Operator {
  return {
    spec: {
      id: FrontdoorOperatorKinds.ResolveModel,
      kind: FrontdoorOperatorKinds.ResolveModel,
      requiredInputTypes: [FrontdoorArtifactTypes.Task],
      outputTypes: [FrontdoorArtifactTypes.Route],
      sideEffects: "none"
    },
    run: (_inputs, ctx) => [
      ctx.createArtifact<RouteValue>({
        id: `${ctx.nodeId}.route`,
        type: FrontdoorArtifactTypes.Route,
        value: { route: turn.resolveRoute() },
        visibility: "runtime",
        leakage: "none"
      })
    ]
  };
}

function dispatchOperator(
  turn: FrontdoorRequestTurn,
  route: FrontdoorRoute
): Operator {
  const kind = route === "passthrough" ? FrontdoorOperatorKinds.DispatchPassthrough : FrontdoorOperatorKinds.DispatchFusion;
  return {
    spec: {
      id: kind,
      kind,
      requiredInputTypes: [FrontdoorArtifactTypes.Route],
      outputTypes: [FrontdoorArtifactTypes.Response],
      sideEffects: "external_tool"
    },
    run: async (_inputs, ctx) => [
      ctx.createArtifact({
        id: `${ctx.nodeId}.response`,
        type: FrontdoorArtifactTypes.Response,
        value: route === "passthrough" ? await turn.runPassthrough() : await turn.runFusion(),
        visibility: "user",
        leakage: "none"
      })
    ]
  };
}

/** Runs the budget gate, then routes to budget-stop, passthrough, or fusion by
 *  inspecting the decision artifacts — running only the chosen branch. */
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
    const firstId = (artifacts: readonly Artifact[]): string[] => (artifacts[0] !== undefined ? [artifacts[0].id] : []);

    const [budget] = await ctx.runNode(node("budget-gate"));
    const exceeded = (budget?.value as BudgetValue | undefined)?.exceeded === true;
    ctx.recordTrace({
      type: "scheduler.decision",
      nodeId: "budget-gate",
      operatorId: FrontdoorOperatorKinds.BudgetGate,
      payload: { budget_exceeded: exceeded }
    });
    if (exceeded) {
      return { finalArtifactIds: firstId(await ctx.runNode(node("budget-stop"))) };
    }

    const [route] = await ctx.runNode(node("resolve-model"));
    const decision = (route?.value as RouteValue | undefined)?.route ?? "fusion";
    ctx.recordTrace({
      type: "scheduler.decision",
      nodeId: "resolve-model",
      operatorId: FrontdoorOperatorKinds.ResolveModel,
      payload: { route: decision }
    });
    return { finalArtifactIds: firstId(await ctx.runNode(node(decision === "passthrough" ? "passthrough" : "fusion"))) };
  }
}

/**
 * Execute a full front-door request as the `fusion-frontdoor-request` kernel
 * graph and return the resulting `Response` (budget stop, passthrough reply, or
 * fused turn — streamed or buffered).
 */
export async function runFrontdoorRequest(
  turn: FrontdoorRequestTurn,
  options: { runId?: string } = {}
): Promise<Response> {
  const task = createArtifact({
    id: "frontdoor.request.task",
    type: FrontdoorArtifactTypes.Task,
    value: {},
    visibility: "runtime",
    leakage: "none"
  });
  const graph: OperatorGraph = {
    id: FUSION_FRONTDOOR_REQUEST_WORKFLOW,
    inputArtifactIds: [task.id],
    nodes: [
      { id: "budget-gate", operator: budgetGateOperator(turn), inputs: [{ artifactId: task.id }] },
      { id: "budget-stop", operator: budgetStopOperator(turn), inputs: [{ nodeId: "budget-gate" }] },
      { id: "resolve-model", operator: resolveModelOperator(turn), inputs: [{ artifactId: task.id }] },
      { id: "fusion", operator: dispatchOperator(turn, "fusion"), inputs: [{ nodeId: "resolve-model" }] },
      { id: "passthrough", operator: dispatchOperator(turn, "passthrough"), inputs: [{ nodeId: "resolve-model" }] }
    ]
  };
  const result = await new FusionRuntime().run({
    graph,
    scheduler: new FrontdoorRequestScheduler(),
    artifacts: [task],
    ...(options.runId !== undefined ? { runId: options.runId } : {})
  });
  const response = result.finalArtifacts.find(
    (artifact: Artifact): artifact is Artifact<Response> => artifact.value instanceof Response
  )?.value;
  if (!(response instanceof Response)) throw new Error("fusion-frontdoor-request produced no Response");
  return response;
}
