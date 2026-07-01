/**
 * Kernel-backed gateway execution primitives.
 *
 * These route the model-gateway's front-door HTTP steps through the runtime
 * kernel so admission control, provenance, budgets, traces, and replay records
 * are owned by {@link FusionRuntime} rather than by ad-hoc `fetch` calls buried
 * inside the gateway. The gateway injects {@link createKernelFuseStepRunner} as
 * its `runFuseStep`, so the Python `trajectories:fuse` sidecar step executes as a
 * named kernel operator whose request/response are captured as typed wire
 * artifacts (see {@link captureWireResponse}).
 */

import { createArtifact, FusionRuntime, StaticDAGScheduler } from "./runtime.js";
import type { Artifact, Operator } from "./runtime.js";
import { captureWireResponse, WireArtifactTypes } from "./wire-artifacts.js";
import type { FuseStepRunInput, FuseStepRunner } from "@fusionkit/model-gateway";

export const KERNEL_FUSE_STEP_WORKFLOW = "legacy-trajectory-fuse-step" as const;

/** The default HTTP transport for the fuse step (injectable for tests). */
export type FuseStepTransport = (input: FuseStepRunInput) => Promise<Response>;

const defaultTransport: FuseStepTransport = (request) =>
  fetch(request.stepUrl, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    ...(request.signal !== undefined ? { signal: request.signal } : {})
  });

/**
 * Build a {@link FuseStepRunner} that executes the Python `trajectories:fuse`
 * step as a one-node kernel workflow. The live `Response` is returned to the
 * gateway verbatim (streaming preserved), while a typed `wire_response` artifact
 * records the replay-relevant envelope.
 */
export function createKernelFuseStepRunner(transport: FuseStepTransport = defaultTransport): FuseStepRunner {
  return async (request) => {
    const requestArtifact = createArtifact<FuseStepRunInput>({
      id: "trajectory-fuse-step.request",
      type: WireArtifactTypes.TrajectoryFuseStepRequest,
      value: request,
      visibility: "runtime",
      leakage: "none"
    });
    const operator: Operator = {
      spec: {
        id: "legacy.python.trajectories_fuse",
        kind: "legacy.python.trajectory_fuse_step",
        requiredInputTypes: [WireArtifactTypes.TrajectoryFuseStepRequest],
        outputTypes: [WireArtifactTypes.WireResponse, WireArtifactTypes.TrajectoryFuseStepResponse],
        sideEffects: "external_tool"
      },
      run: async (inputs, ctx) => {
        const value = inputs[0]?.value as FuseStepRunInput | undefined;
        if (value === undefined) throw new Error("trajectory fuse step missing request artifact");
        const raw = await transport(value);
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
            type: WireArtifactTypes.TrajectoryFuseStepResponse,
            value: captured.response,
            visibility: "runtime",
            leakage: "none"
          })
        ];
      }
    };
    const result = await new FusionRuntime().run({
      graph: {
        id: KERNEL_FUSE_STEP_WORKFLOW,
        inputArtifactIds: [requestArtifact.id],
        nodes: [{ id: "fuse-step", operator, inputs: [{ artifactId: requestArtifact.id }] }]
      },
      scheduler: new StaticDAGScheduler(KERNEL_FUSE_STEP_WORKFLOW),
      artifacts: [requestArtifact],
      ...(request.signal !== undefined ? { signal: request.signal } : {})
    });
    const response = result.finalArtifacts.find(
      (artifact): artifact is Artifact<Response> => artifact.value instanceof Response
    )?.value;
    if (!(response instanceof Response)) throw new Error("trajectory fuse step produced no Response");
    return response;
  };
}
