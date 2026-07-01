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
import type { Operator, RuntimeEvent, StreamingOperator } from "@fusionkit/kernel";
import type { WireTrajectory } from "@fusionkit/protocol";

export const FrontdoorArtifactTypes = {
  Task: "frontdoor_task",
  CandidateSet: "frontdoor_candidate_set",
  FuseResponse: "frontdoor_fuse_response",
  StreamComplete: "frontdoor_stream_complete",
  Response: "frontdoor_response"
} as const;

export const FrontdoorOperatorKinds = {
  Passthrough: "frontdoor.passthrough",
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

/**
 * The injected implementation of a native-passthrough turn: proxy the request to
 * the vendor via the router. Rate-limit/credit failover (which re-enters the
 * fusion workflow with the throttled vendor excluded) and mid-stream resume
 * notices are owned by the proxy implementation, which returns the final
 * `Response` (vendor reply, fused failover stream, or a clear error).
 */
export type FrontdoorPassthroughTurn = {
  proxy: () => Promise<Response>;
};

/** passthrough: proxy the turn to a native vendor model. */
export function frontdoorPassthroughOperator(turn: FrontdoorPassthroughTurn): Operator {
  return {
    spec: {
      id: FrontdoorOperatorKinds.Passthrough,
      kind: FrontdoorOperatorKinds.Passthrough,
      requiredInputTypes: [FrontdoorArtifactTypes.Task],
      outputTypes: [WireArtifactTypes.WireResponse, FrontdoorArtifactTypes.Response],
      sideEffects: "external_tool"
    },
    run: async (_inputs, ctx) => {
      const captured = await captureWireResponse(await turn.proxy());
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

/** panel: resolve candidate trajectories for this turn. */
export function frontdoorPanelOperator(turn: {
  resolveCandidates: () => Promise<readonly WireTrajectory[]>;
}): Operator {
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

/**
 * The injected implementation of a streaming front-door fusion turn. The panel
 * phase reuses {@link FrontdoorFusionTurn.resolveCandidates}; the fuse phase
 * streams the Python step's SSE bytes and meters/traces on completion.
 */
export type FrontdoorFusionStreamTurn = {
  resolveCandidates: () => Promise<readonly WireTrajectory[]>;
  /** Emit judge.request and POST the streaming fuse step; returns its response. */
  openFuseStream: (candidates: readonly WireTrajectory[]) => Promise<Response>;
  /** Non-2xx / bodyless fuse reply: emit judge.final error before failing. */
  onUpstreamError: (status: number, detail: string) => void;
  /** Clean completion: meter cost + emit judge.final/thinking from the SSE tail. */
  onComplete: (sseBuffer: string) => void;
  /** An exception mid-stream (e.g. an aborted fetch): emit judge.final error. */
  onException?: (message: string) => void;
};

/** fuse (streaming): pipe the fuse step's SSE bytes as `sse.chunk` events. */
export function frontdoorStreamingFuseOperator(turn: FrontdoorFusionStreamTurn): StreamingOperator {
  const spec = {
    id: FrontdoorOperatorKinds.FuseStream,
    kind: FrontdoorOperatorKinds.FuseStream,
    requiredInputTypes: [FrontdoorArtifactTypes.CandidateSet],
    outputTypes: [FrontdoorArtifactTypes.StreamComplete],
    sideEffects: "external_tool" as const
  };
  return {
    spec,
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
      const set = inputs.find((artifact) => artifact.type === FrontdoorArtifactTypes.CandidateSet)?.value as
        | CandidateSetValue
        | undefined;
      if (set === undefined) throw new Error("frontdoor.fuse.stream missing candidate set artifact");
      try {
        const response = await turn.openFuseStream(set.candidates);
        if (!response.ok || response.body === null) {
          const detail = response.body === null ? "no stream" : (await response.text()).slice(0, 800);
          turn.onUpstreamError(response.status, detail);
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
        turn.onComplete(buffer);
      } catch (error) {
        if (!(error instanceof FrontdoorFuseError)) {
          turn.onException?.(error instanceof Error ? error.message : String(error));
        }
        throw error;
      }
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
