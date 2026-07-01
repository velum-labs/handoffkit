/**
 * Kernel operators for the fusion front-door request and turn.
 *
 * Every operator is stable: it is constructed with the shared
 * {@link FrontdoorServices} and reads the per-turn {@link FrontdoorRequestValue}
 * from its input artifact. No operator captures a per-turn closure. The kernel
 * owns admission/budget/trace/replay and the routing decision; the services own
 * the side-effecting wire (panel, fuse step, vendor proxy, cost/trace).
 */

import { captureWireResponse, WireArtifactTypes } from "@fusionkit/kernel";
import type { Artifact, Operator, RuntimeEvent, StreamingOperator } from "@fusionkit/kernel";
import type { WireTrajectory } from "@fusionkit/protocol";

import type {
  FrontdoorRequestValue,
  FrontdoorServices,
  VendorProxyOutcome
} from "./types.js";

export const FrontdoorArtifactTypes = {
  Request: "frontdoor_request",
  Budget: "frontdoor_budget",
  Route: "frontdoor_route",
  Failover: "frontdoor_failover",
  CandidateSet: "frontdoor_candidate_set",
  FuseResponse: "frontdoor_fuse_response",
  StreamComplete: "frontdoor_stream_complete",
  Response: "frontdoor_response"
} as const;

export const FrontdoorOperatorKinds = {
  BudgetGate: "frontdoor.budget-gate",
  BudgetStop: "frontdoor.budget-stop",
  ResolveModel: "frontdoor.resolve-model",
  VendorProxy: "frontdoor.vendor-proxy",
  DispatchFusion: "frontdoor.dispatch.fusion",
  Panel: "frontdoor.panel",
  Fuse: "frontdoor.fuse",
  FuseStream: "frontdoor.fuse.stream",
  Finalize: "frontdoor.finalize"
} as const;

/** A fuse-phase failure whose message has already been surfaced (judge.final
 *  error emitted). It marks the run failed so the gateway evicts the turn and
 *  the SSE adapter emits the terminal error event. */
export class FrontdoorFuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontdoorFuseError";
  }
}

/** A panel-phase failure. The gateway maps this to a 502 and evicts the turn,
 *  matching the legacy "panel produced no usable candidates" behavior, while a
 *  fuse-phase failure (e.g. an aborted fetch) propagates as a rejection. */
export class FrontdoorPanelError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "FrontdoorPanelError";
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", { value: cause, configurable: true, writable: true });
    }
  }
}

export type BudgetValue = { exceeded: boolean };
export type RouteValue = { route: "fusion" | "passthrough" };
export type FailoverValue = { excludeModelIds: readonly string[]; notice: string };
export type CandidateSetValue = { candidates: readonly WireTrajectory[] };

function requestOf(inputs: readonly Artifact[]): FrontdoorRequestValue {
  const request = inputs.find((artifact) => artifact.type === FrontdoorArtifactTypes.Request)?.value as
    | FrontdoorRequestValue
    | undefined;
  if (request === undefined) throw new Error("frontdoor operator missing request artifact");
  return request;
}

function candidateSetOf(inputs: readonly Artifact[]): CandidateSetValue {
  const set = inputs.find((artifact) => artifact.type === FrontdoorArtifactTypes.CandidateSet)?.value as
    | CandidateSetValue
    | undefined;
  if (set === undefined) throw new Error("frontdoor fuse operator missing candidate set artifact");
  return set;
}

// --- request-level operators (decisions) ----------------------------------

/** budget-gate: compute whether the conversation has exceeded the budget cap. */
export function frontdoorBudgetGateOperator(services: FrontdoorServices): Operator {
  return {
    spec: {
      id: FrontdoorOperatorKinds.BudgetGate,
      kind: FrontdoorOperatorKinds.BudgetGate,
      requiredInputTypes: [FrontdoorArtifactTypes.Request],
      outputTypes: [FrontdoorArtifactTypes.Budget],
      sideEffects: "none"
    },
    run: (inputs, ctx) => {
      const req = requestOf(inputs);
      const exceeded =
        services.budgetUsd !== undefined && services.costTotalUsd(req.sessionKey) >= services.budgetUsd;
      return [
        ctx.createArtifact<BudgetValue>({
          id: `${ctx.nodeId}.budget`,
          type: FrontdoorArtifactTypes.Budget,
          value: { exceeded },
          visibility: "runtime",
          leakage: "none"
        })
      ];
    }
  };
}

/** budget-stop: format the refusal response for an over-budget turn. */
export function frontdoorBudgetStopOperator(services: FrontdoorServices): Operator {
  return {
    spec: {
      id: FrontdoorOperatorKinds.BudgetStop,
      kind: FrontdoorOperatorKinds.BudgetStop,
      requiredInputTypes: [FrontdoorArtifactTypes.Request],
      outputTypes: [FrontdoorArtifactTypes.Response],
      sideEffects: "none"
    },
    run: (inputs, ctx) => [
      ctx.createArtifact({
        id: `${ctx.nodeId}.response`,
        type: FrontdoorArtifactTypes.Response,
        value: services.budgetStopResponse(requestOf(inputs)),
        visibility: "user",
        leakage: "none"
      })
    ]
  };
}

/** resolve-model: decide whether the requested model routes to fusion or a vendor. */
export function frontdoorResolveModelOperator(services: FrontdoorServices): Operator {
  return {
    spec: {
      id: FrontdoorOperatorKinds.ResolveModel,
      kind: FrontdoorOperatorKinds.ResolveModel,
      requiredInputTypes: [FrontdoorArtifactTypes.Request],
      outputTypes: [FrontdoorArtifactTypes.Route],
      sideEffects: "none"
    },
    run: (inputs, ctx) => {
      const req = requestOf(inputs);
      const route = services.isNativeModel(req.chat.model) ? "passthrough" : "fusion";
      return [
        ctx.createArtifact<RouteValue>({
          id: `${ctx.nodeId}.route`,
          type: FrontdoorArtifactTypes.Route,
          value: { route },
          visibility: "runtime",
          leakage: "none"
        })
      ];
    }
  };
}

/** vendor-proxy: proxy the turn to the native vendor; emit a classified outcome.
 *  A `response` outcome carries the vendor/error reply; a `failover` outcome
 *  hands control back to the scheduler to run the fusion turn. */
export function frontdoorVendorProxyOperator(services: FrontdoorServices): Operator {
  return {
    spec: {
      id: FrontdoorOperatorKinds.VendorProxy,
      kind: FrontdoorOperatorKinds.VendorProxy,
      requiredInputTypes: [FrontdoorArtifactTypes.Request],
      outputTypes: [WireArtifactTypes.WireResponse, FrontdoorArtifactTypes.Response, FrontdoorArtifactTypes.Failover],
      sideEffects: "external_tool"
    },
    run: async (inputs, ctx) => {
      const req = requestOf(inputs);
      const outcome: VendorProxyOutcome = await services.proxyVendor(req);
      if (outcome.kind === "failover") {
        return [
          ctx.createArtifact<FailoverValue>({
            id: `${ctx.nodeId}.failover`,
            type: FrontdoorArtifactTypes.Failover,
            value: { excludeModelIds: outcome.excludeModelIds, notice: outcome.notice },
            visibility: "runtime",
            leakage: "none"
          })
        ];
      }
      const captured = await captureWireResponse(outcome.response);
      return [
        ctx.createArtifact({
          id: `${ctx.nodeId}.wire`,
          type: WireArtifactTypes.WireResponse,
          value: captured.value,
          visibility: "runtime",
          leakage: "none",
          ...(captured.value.contentType !== null ? { contentType: captured.value.contentType } : {})
        }),
        ctx.createArtifact({
          id: `${ctx.nodeId}.response`,
          type: FrontdoorArtifactTypes.Response,
          value: captured.response,
          visibility: "user",
          leakage: "none"
        })
      ];
    }
  };
}

// --- fusion turn operators -------------------------------------------------

/** panel: resolve candidate trajectories for this turn. */
export function frontdoorPanelOperator(services: FrontdoorServices): Operator {
  return {
    spec: {
      id: FrontdoorOperatorKinds.Panel,
      kind: FrontdoorOperatorKinds.Panel,
      requiredInputTypes: [FrontdoorArtifactTypes.Request],
      outputTypes: [FrontdoorArtifactTypes.CandidateSet],
      sideEffects: "external_tool"
    },
    run: async (inputs, ctx) => {
      const req = requestOf(inputs);
      let candidates: readonly WireTrajectory[];
      try {
        candidates = await services.resolvePanelCandidates(req);
      } catch (error) {
        throw new FrontdoorPanelError(error);
      }
      const value: CandidateSetValue = { candidates };
      return [
        ctx.createArtifact({
          id: `${ctx.nodeId}.candidates`,
          type: FrontdoorArtifactTypes.CandidateSet,
          value,
          visibility: "runtime",
          leakage: "none"
        })
      ];
    }
  };
}

/** fuse: POST the candidate trajectories to the buffered `trajectories:fuse`. */
export function frontdoorFuseOperator(services: FrontdoorServices): Operator {
  return {
    spec: {
      id: FrontdoorOperatorKinds.Fuse,
      kind: FrontdoorOperatorKinds.Fuse,
      requiredInputTypes: [FrontdoorArtifactTypes.Request, FrontdoorArtifactTypes.CandidateSet],
      outputTypes: [WireArtifactTypes.WireResponse, FrontdoorArtifactTypes.FuseResponse],
      sideEffects: "external_tool"
    },
    run: async (inputs, ctx) => {
      const req = requestOf(inputs);
      const set = candidateSetOf(inputs);
      const captured = await captureWireResponse(await services.runFuseStep(req, set.candidates));
      return [
        ctx.createArtifact({
          id: `${ctx.nodeId}.wire`,
          type: WireArtifactTypes.WireResponse,
          value: captured.value,
          visibility: "runtime",
          leakage: "none",
          ...(captured.value.contentType !== null ? { contentType: captured.value.contentType } : {})
        }),
        ctx.createArtifact({
          id: `${ctx.nodeId}.response`,
          type: FrontdoorArtifactTypes.FuseResponse,
          value: captured.response,
          visibility: "runtime",
          leakage: "none"
        })
      ];
    }
  };
}

/** fuse (streaming): pipe the fuse step's SSE bytes as `sse.chunk` events. */
export function frontdoorStreamingFuseOperator(services: FrontdoorServices): StreamingOperator {
  return {
    spec: {
      id: FrontdoorOperatorKinds.FuseStream,
      kind: FrontdoorOperatorKinds.FuseStream,
      requiredInputTypes: [FrontdoorArtifactTypes.Request, FrontdoorArtifactTypes.CandidateSet],
      outputTypes: [FrontdoorArtifactTypes.StreamComplete],
      sideEffects: "external_tool"
    },
    run: (_inputs, ctx) => [
      ctx.createArtifact({
        id: `${ctx.nodeId}.complete`,
        type: FrontdoorArtifactTypes.StreamComplete,
        value: { streamed: true },
        visibility: "runtime",
        leakage: "none"
      })
    ],
    async *stream(inputs, _ctx): AsyncIterable<RuntimeEvent> {
      const req = requestOf(inputs);
      const set = candidateSetOf(inputs);
      try {
        const response = await services.openFuseStream(req, set.candidates);
        if (!response.ok || response.body === null) {
          const detail = response.body === null ? "no stream" : (await response.text()).slice(0, 800);
          services.onFuseUpstreamError(req, response.status, detail);
          throw new FrontdoorFuseError(`trajectories:fuse ${response.status}: ${detail}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined) {
            const decoded = decoder.decode(value, { stream: true });
            buffer += decoded;
            yield { type: "sse.chunk", data: decoded };
          }
        }
        services.meterAndTraceStream(req, buffer);
      } catch (error) {
        if (!(error instanceof FrontdoorFuseError)) {
          services.onFuseException(req, error instanceof Error ? error.message : String(error));
        }
        throw error;
      }
    }
  };
}

/** finalize: meter/trace/persist the buffered fused response and hand it back. */
export function frontdoorFinalizeOperator(services: FrontdoorServices): Operator {
  return {
    spec: {
      id: FrontdoorOperatorKinds.Finalize,
      kind: FrontdoorOperatorKinds.Finalize,
      requiredInputTypes: [FrontdoorArtifactTypes.Request, FrontdoorArtifactTypes.FuseResponse],
      outputTypes: [FrontdoorArtifactTypes.Response],
      sideEffects: "none"
    },
    run: async (inputs, ctx) => {
      const req = requestOf(inputs);
      const response = inputs.find((artifact) => artifact.type === FrontdoorArtifactTypes.FuseResponse)?.value;
      if (!(response instanceof Response)) throw new Error("frontdoor.finalize missing fuse response artifact");
      const finalized = await services.finalizeFused(req, response);
      return [
        ctx.createArtifact({
          id: `${ctx.nodeId}.response`,
          type: FrontdoorArtifactTypes.Response,
          value: finalized,
          visibility: "user",
          leakage: "none"
        })
      ];
    }
  };
}
