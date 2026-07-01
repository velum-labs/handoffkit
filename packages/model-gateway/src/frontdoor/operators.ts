/**
 * Kernel operators for the fusion front-door turn.
 *
 * The front-door turn is expressed as a runtime graph:
 *
 *   panel -> fuse -> finalize
 *
 * The operators are thin: they own graph structure, provenance, and typed
 * artifact boundaries, and delegate the actual side-effecting work (running the
 * panel, calling the Python `trajectories:fuse` step, metering/persisting the
 * result) to injected implementations supplied by {@link FusionBackend}. This is
 * the same pattern as `ModelGenerateOperator` wrapping a `ModelClient`: the
 * kernel owns admission/budget/trace/replay, the implementation owns the wire.
 */

import { captureWireResponse, WireArtifactTypes } from "@fusionkit/kernel";
import type { Operator } from "@fusionkit/kernel";
import type { WireTrajectory } from "@fusionkit/protocol";

export const FrontdoorArtifactTypes = {
  Task: "frontdoor_task",
  CandidateSet: "frontdoor_candidate_set",
  FuseResponse: "frontdoor_fuse_response",
  Response: "frontdoor_response"
} as const;

export const FrontdoorOperatorKinds = {
  Panel: "frontdoor.panel",
  Fuse: "frontdoor.fuse",
  Finalize: "frontdoor.finalize"
} as const;

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

export type CandidateSetValue = { candidates: readonly WireTrajectory[] };

/**
 * The injected implementation of a single front-door fusion turn. Each field is
 * a phase the operators drive; {@link FusionBackend} supplies closures that reuse
 * its existing session/panel/fuse/cost/trace logic.
 */
export type FrontdoorFusionTurn = {
  /** Resolve the turn's candidate trajectories (panel phase). */
  resolveCandidates: () => Promise<readonly WireTrajectory[]>;
  /** Emit the judge.request trace and POST the fuse step; returns its response. */
  runFuseStep: (candidates: readonly WireTrajectory[]) => Promise<Response>;
  /** Meter cost, emit judge.final/thinking, persist the turn, apply any notice. */
  finalize: (response: Response) => Promise<Response>;
};

/** panel: resolve candidate trajectories for this turn. */
export function frontdoorPanelOperator(turn: FrontdoorFusionTurn): Operator {
  return {
    spec: {
      id: FrontdoorOperatorKinds.Panel,
      kind: FrontdoorOperatorKinds.Panel,
      requiredInputTypes: [FrontdoorArtifactTypes.Task],
      outputTypes: [FrontdoorArtifactTypes.CandidateSet],
      sideEffects: "external_tool"
    },
    run: async (_inputs, ctx) => {
      let candidates: readonly WireTrajectory[];
      try {
        candidates = await turn.resolveCandidates();
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

/** fuse: POST the candidate trajectories to `trajectories:fuse`. */
export function frontdoorFuseOperator(turn: FrontdoorFusionTurn): Operator {
  return {
    spec: {
      id: FrontdoorOperatorKinds.Fuse,
      kind: FrontdoorOperatorKinds.Fuse,
      requiredInputTypes: [FrontdoorArtifactTypes.CandidateSet],
      outputTypes: [WireArtifactTypes.WireResponse, FrontdoorArtifactTypes.FuseResponse],
      sideEffects: "external_tool"
    },
    run: async (inputs, ctx) => {
      const set = inputs.find((artifact) => artifact.type === FrontdoorArtifactTypes.CandidateSet)?.value as
        | CandidateSetValue
        | undefined;
      if (set === undefined) throw new Error("frontdoor.fuse missing candidate set artifact");
      const raw = await turn.runFuseStep(set.candidates);
      const captured = await captureWireResponse(raw);
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

/** finalize: meter/trace/persist the fused response and hand it back. */
export function frontdoorFinalizeOperator(turn: FrontdoorFusionTurn): Operator {
  return {
    spec: {
      id: FrontdoorOperatorKinds.Finalize,
      kind: FrontdoorOperatorKinds.Finalize,
      requiredInputTypes: [FrontdoorArtifactTypes.FuseResponse],
      outputTypes: [FrontdoorArtifactTypes.Response],
      sideEffects: "none"
    },
    run: async (inputs, ctx) => {
      const response = inputs.find((artifact) => artifact.type === FrontdoorArtifactTypes.FuseResponse)?.value;
      if (!(response instanceof Response)) throw new Error("frontdoor.finalize missing fuse response artifact");
      const finalized = await turn.finalize(response);
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
