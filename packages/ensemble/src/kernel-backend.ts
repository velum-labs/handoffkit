import { createArtifact, FusionRuntime, StaticDAGScheduler } from "./runtime.js";
import type { Backend, BackendRequestOptions } from "@velum-labs/routekit-gateway";
import type { Artifact, Operator } from "./runtime.js";
import { captureWireResponse, WireArtifactTypes } from "./wire-artifacts.js";

type BackendOperation = "chat" | "models" | "embeddings";

type BackendRequestValue = {
  operation: BackendOperation;
  body?: unknown;
};

export type KernelBackendOptions = {
  workflowIds?: Partial<Record<BackendOperation, string>>;
};

/**
 * Compatibility adapter that makes existing model-gateway backends execute as
 * kernel workflows without changing their wire behavior. The wrapped backend
 * still owns the legacy implementation for now; the kernel owns admission,
 * provenance, and the migration seam.
 */
export class KernelBackend implements Backend {
  readonly #inner: Backend;
  readonly #workflowIds: Partial<Record<BackendOperation, string>>;
  readonly defaultModel: string | undefined;

  constructor(inner: Backend, options: KernelBackendOptions = {}) {
    this.#inner = inner;
    this.#workflowIds = options.workflowIds ?? {};
    this.defaultModel = inner.defaultModel;
  }

  listModelIds(): readonly string[] {
    return this.#inner.listModelIds?.() ?? [];
  }

  resolveModel(requested: string | undefined): string | undefined {
    return this.#inner.resolveModel?.(requested) ?? this.#inner.defaultModel;
  }

  chat(body: unknown, signal?: AbortSignal, options: BackendRequestOptions = {}): Promise<Response> {
    return this.#run("chat", body, signal, options);
  }

  models(signal?: AbortSignal): Promise<Response> {
    return this.#run("models", undefined, signal);
  }

  embeddings(body: unknown, signal?: AbortSignal): Promise<Response> {
    return this.#run("embeddings", body, signal);
  }

  async close(): Promise<void> {
    await this.#inner.close?.();
  }

  async #run(
    operation: BackendOperation,
    body: unknown,
    signal: AbortSignal | undefined,
    options: BackendRequestOptions = {}
  ): Promise<Response> {
    const requestArtifact = createArtifact<BackendRequestValue>({
      id: `backend.${operation}.request`,
      type: "backend_request",
      value: body === undefined ? { operation } : { operation, body },
      visibility: "runtime",
      leakage: "none"
    });
    const operator: Operator = {
      spec: {
        id: `legacy.backend.${operation}`,
        kind: `legacy.backend.${operation}`,
        requiredInputTypes: [WireArtifactTypes.BackendRequest],
        outputTypes: [WireArtifactTypes.WireResponse, WireArtifactTypes.BackendResponse],
        sideEffects: "external_tool"
      },
      run: async (inputs, ctx) => {
        const request = inputs[0]?.value as BackendRequestValue | undefined;
        if (request === undefined) throw new Error("kernel backend wrapper missing request artifact");
        const raw =
          request.operation === "chat"
            ? await this.#inner.chat(request.body, signal, options)
            : request.operation === "models"
              ? await this.#inner.models(signal)
              : await this.#inner.embeddings(request.body, signal);
        const { value, response } = await captureWireResponse(raw);
        return [
          ctx.createArtifact({
            id: `${ctx.nodeId}.wire`,
            type: WireArtifactTypes.WireResponse,
            value,
            visibility: "runtime",
            leakage: "none",
            ...(value.contentType !== null ? { contentType: value.contentType } : {})
          }),
          ctx.createArtifact({
            id: `${ctx.nodeId}.response`,
            type: WireArtifactTypes.BackendResponse,
            value: response,
            visibility: "runtime",
            leakage: "none"
          })
        ];
      }
    };
    const workflowId = this.#workflowIds[operation] ?? `legacy-backend-${operation}`;
    const result = await new FusionRuntime().run({
      runId: `backend_${operation}_${Date.now().toString(36)}`,
      graph: {
        id: workflowId,
        inputArtifactIds: [requestArtifact.id],
        nodes: [{ id: operation, operator, inputs: [{ artifactId: requestArtifact.id }] }]
      },
      scheduler: new StaticDAGScheduler(workflowId),
      artifacts: [requestArtifact],
      ...(signal !== undefined ? { signal } : {})
    });
    const response = result.finalArtifacts.find(
      (artifact: Artifact): artifact is Artifact<Response> => artifact.value instanceof Response
    )?.value;
    if (!(response instanceof Response)) throw new Error(`kernel backend ${operation} produced no Response`);
    return response;
  }
}
