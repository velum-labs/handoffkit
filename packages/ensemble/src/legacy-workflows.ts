import { graph, refs } from "./kernel.js";
import { createTaskArtifact } from "./kernel-helpers.js";
import { StaticDAGScheduler } from "./runtime.js";
import { runEnsemble } from "./run.js";
import type {
  Artifact,
  Operator,
  OperatorRunContext,
  OperatorSpec,
  TaskSpec
} from "./runtime.js";
import type { EnsembleDescriptor, EnsembleRunResult } from "./harness.js";
import type { ChatMessage } from "./fusion-operators.js";
import type { KernelWorkflow } from "./kernel.js";
import type { WireTrajectory } from "@fusionkit/protocol";

export const LegacyArtifactTypes = {
  EnsembleDescriptor: "ensemble_descriptor",
  EnsembleRunResult: "ensemble_run_result",
  TrajectoryFuseRequest: "trajectory_fuse_request",
  TrajectoryFuseResponse: "trajectory_fuse_response"
} as const;

export class LegacyRunEnsembleOperator implements Operator {
  readonly spec: OperatorSpec = {
    id: "legacy.run-ensemble",
    kind: "legacy.ensemble.run",
    requiredInputTypes: [LegacyArtifactTypes.EnsembleDescriptor],
    outputTypes: [LegacyArtifactTypes.EnsembleRunResult],
    sideEffects: "write_workspace"
  };

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const descriptor = inputs.find((artifact) => artifact.type === LegacyArtifactTypes.EnsembleDescriptor)?.value as
      | EnsembleDescriptor
      | undefined;
    if (descriptor === undefined) throw new Error("legacy ensemble workflow requires an EnsembleDescriptor artifact");
    const result = await runEnsemble(descriptor);
    return [
      ctx.createArtifact<EnsembleRunResult>({
        id: `${ctx.nodeId}.result`,
        type: LegacyArtifactTypes.EnsembleRunResult,
        value: result,
        visibility: "developer",
        leakage: "none"
      })
    ];
  }
}

export type TrajectoryFuseRequest = {
  stepUrl: string;
  model: string;
  messages: ChatMessage[];
  trajectories: WireTrajectory[];
  stream?: boolean;
  tools?: unknown;
  toolChoice?: unknown;
  headers?: Record<string, string>;
};

export class PythonTrajectoryFuseOperator implements Operator {
  readonly spec: OperatorSpec = {
    id: "legacy.python-trajectories-fuse",
    kind: "legacy.python.trajectories_fuse",
    requiredInputTypes: [LegacyArtifactTypes.TrajectoryFuseRequest],
    outputTypes: [LegacyArtifactTypes.TrajectoryFuseResponse],
    sideEffects: "external_tool"
  };

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const request = inputs.find((artifact) => artifact.type === LegacyArtifactTypes.TrajectoryFuseRequest)?.value as
      | TrajectoryFuseRequest
      | undefined;
    if (request === undefined) throw new Error("trajectory fuse workflow requires a request artifact");
    const response = await fetch(request.stepUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...(request.headers ?? {}) },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        trajectories: request.trajectories,
        ...(request.stream !== undefined ? { stream: request.stream } : {}),
        ...(request.tools !== undefined ? { tools: request.tools } : {}),
        ...(request.toolChoice !== undefined ? { tool_choice: request.toolChoice } : {})
      })
    });
    if (!response.ok) {
      throw new Error(`trajectories:fuse failed: ${response.status} ${(await response.text()).slice(0, 500)}`);
    }
    const value = request.stream === true ? await response.text() : await response.json();
    return [
      ctx.createArtifact({
        id: `${ctx.nodeId}.response`,
        type: LegacyArtifactTypes.TrajectoryFuseResponse,
        value,
        visibility: "runtime",
        leakage: "none"
      })
    ];
  }
}

export type EnsembleRunWorkflowInput = {
  descriptor: EnsembleDescriptor;
  task?: TaskSpec;
};

export function ensembleRunWorkflow(input: EnsembleRunWorkflowInput): KernelWorkflow {
  const task = createTaskArtifact({ ...(input.task ?? { id: "ensemble-run", prompt: input.descriptor.prompt }) });
  const descriptor = {
    id: "ensemble-descriptor",
    type: LegacyArtifactTypes.EnsembleDescriptor,
    value: input.descriptor,
    visibility: "developer" as const,
    leakage: "none" as const,
    provenance: {
      inputArtifactIds: [task.id],
      createdAt: new Date().toISOString()
    }
  };
  return graph("legacy-ensemble-run")
    .task(task)
    .artifact(descriptor)
    .node("run-ensemble", new LegacyRunEnsembleOperator(), {
      inputs: [refs.artifact(descriptor.id)]
    })
    .scheduler(new StaticDAGScheduler())
    .compile();
}

export type PythonTrajectoryFuseWorkflowInput = {
  request: TrajectoryFuseRequest;
};

export function pythonTrajectoryFuseWorkflow(input: PythonTrajectoryFuseWorkflowInput): KernelWorkflow {
  const task = createTaskArtifact({ id: "trajectory-fuse", prompt: "Fuse trajectories" });
  const request = {
    id: "trajectory-fuse-request",
    type: LegacyArtifactTypes.TrajectoryFuseRequest,
    value: input.request,
    visibility: "runtime" as const,
    leakage: "none" as const,
    provenance: {
      inputArtifactIds: [task.id],
      createdAt: new Date().toISOString()
    }
  };
  return graph("legacy-python-trajectory-fuse")
    .task(task)
    .artifact(request)
    .node("trajectory-fuse", new PythonTrajectoryFuseOperator(), {
      inputs: [refs.artifact(request.id)]
    })
    .scheduler(new StaticDAGScheduler())
    .compile();
}

export const LegacyOperatorKinds = {
  EnsembleRun: "legacy.ensemble.run",
  PythonTrajectoryFuse: "legacy.python.trajectories_fuse",
  DirectLocalTurn: "legacy.local.direct_turn",
  FusionFrontdoorTurn: "legacy.fusion.frontdoor_turn"
} as const;
