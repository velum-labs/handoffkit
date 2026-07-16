/**
 * k = 1 proposal panel: each member is one stateless chat completion over the
 * caller's exact `(messages, tools)` — no managed harness, no worktree, no
 * isolation, because fusionkit executes nothing on a member's behalf. A
 * member's tool calls are never auto-run; they are encoded as `function_call`
 * items on the candidate wire (a *proposal* the judge+synthesizer may adopt),
 * and its text as a `message` item. The caller's harness executes whichever
 * step the synthesizer commits.
 *
 * Kernel-native like the trajectory panel: the fanout runs as a one-node
 * `PanelGenerateOperator` graph so it shares the artifact/provenance/budget
 * substrate (`runFusionPanelWorkflow` is the k>1 sibling).
 */

import { ATTR } from "@fusionkit/protocol";
import type { WireTrajectory } from "@fusionkit/protocol";
import { jsonAttr, startFusionSpan } from "@fusionkit/tracing";
import type { FusionTraceCarrier } from "@fusionkit/tracing";

import { PanelGenerateOperator } from "./fusion-operators.js";
import { FusionRuntime, StaticDAGScheduler, createArtifact } from "./runtime.js";
import { STRAGGLER_ABANDONED, settleWithStragglerGrace } from "./run.js";
import { chatCompletionsUrl } from "./unified-url.js";
import type { EnsembleModel } from "./harness.js";

/** Bound a member's single completion so a hung endpoint cannot wedge a round. */
const DEFAULT_PROPOSE_TIMEOUT_MS = 600_000;

export type ProposalPanelOptions = {
  id?: string;
  /** Panel members; each makes exactly one chat completion. */
  models: readonly EnsembleModel[];
  /** The caller's message history, verbatim (system/user/assistant/tool). */
  messages: readonly unknown[];
  /** The caller's tool definitions / tool_choice, verbatim. */
  tools?: unknown;
  toolChoice?: unknown;
  /** Fallback OpenAI-compatible base URL (the shared router). */
  fusionBackendUrl: string;
  /** Per-member endpoint base URLs keyed by `EnsembleModel.id`. */
  modelEndpoints?: Record<string, string>;
  fusionApiKey?: string;
  timeoutMs?: number;
  /** Abort unfinished siblings this long after the first successful proposal. */
  stragglerGraceMs?: number;
  signal?: AbortSignal;
  /** Trace carrier of the enclosing turn; proposer spans nest under it. */
  trace?: FusionTraceCarrier;
  turn?: number;
};

type ChatCompletionMessage = {
  content?: unknown;
  /** Out-of-band reasoning returned by the member router (provider-normalized). */
  reasoning_content?: unknown;
  /** Token-stream reasoning spelling used by local/OpenAI-compatible servers. */
  reasoning?: unknown;
  tool_calls?: Array<{
    id?: unknown;
    function?: { name?: unknown; arguments?: unknown };
  }>;
};

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) =>
        part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : ""
      )
      .join("");
  }
  return "";
}

/** Map one member's completion onto the candidate wire (message + function_call items). */
function completionToWire(input: {
  candidateId: string;
  model: EnsembleModel;
  message: ChatCompletionMessage | undefined;
  usage?: unknown;
}): WireTrajectory {
  const items: Array<Record<string, unknown>> = [];
  let index = 0;
  const reasoning =
    typeof input.message?.reasoning_content === "string"
      ? input.message.reasoning_content
      : typeof input.message?.reasoning === "string"
        ? input.message.reasoning
        : "";
  if (reasoning.length > 0) {
    items.push({ index: index++, type: "reasoning", text: reasoning });
  }
  const text = asText(input.message?.content);
  if (text.length > 0) items.push({ index: index++, type: "message", text });
  for (const call of input.message?.tool_calls ?? []) {
    items.push({
      index: index++,
      type: "function_call",
      ...(typeof call.id === "string" ? { call_id: call.id } : {}),
      ...(typeof call.function?.name === "string" ? { name: call.function.name } : {}),
      arguments: typeof call.function?.arguments === "string" ? call.function.arguments : "{}"
    });
  }
  const usage = normalizeUsage(input.usage);
  return {
    trajectory_id: input.candidateId,
    model_id: input.model.id,
    model: input.model.model,
    candidate_id: input.candidateId,
    // No harness produced this candidate (single stateless completion), so the
    // contract's optional harness_kind is omitted rather than invented.
    status: "succeeded",
    items,
    final_output: text,
    ...(usage !== undefined ? { usage } : {}),
    end_reason: { kind: "completed" }
  };
}

function failedWire(candidateId: string, model: EnsembleModel, detail: string): WireTrajectory {
  return {
    trajectory_id: candidateId,
    model_id: model.id,
    model: model.model,
    candidate_id: candidateId,
    status: "failed",
    items: [],
    final_output: `panel proposer ${model.id} failed: ${detail}`,
    end_reason: { kind: "exit_error", detail }
  };
}

function normalizeUsage(usage: unknown): WireTrajectory["usage"] {
  if (usage === null || typeof usage !== "object") return undefined;
  const source = usage as Record<string, unknown>;
  const pick = (key: string): number | undefined =>
    typeof source[key] === "number" ? (source[key] as number) : undefined;
  const out = {
    ...(pick("prompt_tokens") !== undefined ? { prompt_tokens: pick("prompt_tokens") } : {}),
    ...(pick("completion_tokens") !== undefined ? { completion_tokens: pick("completion_tokens") } : {}),
    ...(pick("total_tokens") !== undefined ? { total_tokens: pick("total_tokens") } : {})
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/** One member's single completion against its endpoint; failures become failed candidates. */
async function proposeOne(
  model: EnsembleModel,
  ordinal: number,
  options: ProposalPanelOptions
): Promise<WireTrajectory> {
  const candidateId = `${options.id ?? "propose"}_${model.id}_${ordinal}`;
  const baseUrl = options.modelEndpoints?.[model.id] ?? options.fusionBackendUrl;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROPOSE_TIMEOUT_MS;
  const signal =
    options.signal !== undefined
      ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
  const identity = {
    [ATTR.FUSION_CANDIDATE_ID]: candidateId,
    [ATTR.FUSION_TRAJECTORY_ID]: candidateId,
    [ATTR.FUSION_MODEL_ID]: model.id,
    [ATTR.GEN_AI_REQUEST_MODEL]: model.model,
    [ATTR.FUSION_TURN]: options.turn
  };
  const candidateSpan =
    options.trace !== undefined
      ? startFusionSpan("panel-model", "fusion.candidate", options.trace, identity)
      : undefined;
  candidateSpan?.event("panel-model", "fusion.candidate.started", identity);
  let wire: WireTrajectory;
  try {
    const response = await fetch(chatCompletionsUrl(baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.fusionApiKey !== undefined ? { authorization: `Bearer ${options.fusionApiKey}` } : {})
      },
      body: JSON.stringify({
        // The shared router routes by namespaced model id; a dedicated backend ignores it.
        model: model.id,
        messages: options.messages,
        ...(options.tools !== undefined ? { tools: options.tools } : {}),
        ...(options.toolChoice !== undefined ? { tool_choice: options.toolChoice } : {}),
        stream: false
      }),
      signal
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 400);
      wire = failedWire(candidateId, model, `endpoint returned ${response.status}${detail ? `: ${detail}` : ""}`);
    } else {
      const payload = (await response.json()) as {
        choices?: Array<{ message?: ChatCompletionMessage }>;
        usage?: unknown;
      };
      const message = payload.choices?.[0]?.message;
      if (message === undefined) {
        wire = failedWire(candidateId, model, "endpoint returned no choices");
      } else {
        wire = completionToWire({ candidateId, model, message, usage: payload.usage });
      }
    }
  } catch (error) {
    wire = failedWire(candidateId, model, error instanceof Error ? error.message : String(error));
  }
  if (candidateSpan !== undefined) {
    const proposedCalls = (wire.items ?? []).filter((item) => item.type === "function_call");
    candidateSpan.end({
      status: wire.status === "succeeded" ? "succeeded" : "failed",
      attributes: {
        // What the narrator (and dashboard) mine: the outcome shape, a bounded
        // answer preview, and the proposed batch with bounded arguments.
        [ATTR.FUSION_FINISH_REASON]:
          wire.status !== "succeeded" ? "error" : proposedCalls.length > 0 ? "tool_calls" : "stop",
        [ATTR.FUSION_FINAL_OUTPUT_PREVIEW]: wire.final_output.slice(0, 400),
        [ATTR.FUSION_PROPOSED_CALLS]: jsonAttr(
          proposedCalls.map((item) => ({
            ...(typeof item.name === "string" ? { name: item.name } : {}),
            arguments_preview: (typeof item.arguments === "string" ? item.arguments : "").slice(0, 160)
          }))
        ),
        [ATTR.FUSION_TOOL_CALL_COUNT]: proposedCalls.length
      }
    });
  }
  return wire;
}

/**
 * Run one proposal round: every member proposes in parallel; the returned
 * candidates carry proposals (`function_call` items) and/or text. Member
 * failures degrade to failed candidates with attribution — this only throws
 * on programmer error, mirroring the trajectory panel's contract.
 */
export async function runProposalPanels(options: ProposalPanelOptions): Promise<WireTrajectory[]> {
  const runtime = new FusionRuntime();
  const task = createArtifact({
    id: `${options.id ?? "propose_panels"}.task`,
    type: "task",
    value: {
      id: options.id,
      prompt: "",
      metadata: {
        panel_mode: "step",
        model_ids: options.models.map((model) => model.id)
      }
    },
    visibility: "runtime",
    leakage: "none"
  });
  const panel = new PanelGenerateOperator({
    id: "fusion.panel.propose",
    models: options.models,
    // Proposal members execute nothing: the completion call is the only effect.
    sideEffects: "external_tool",
    runner: async () => {
      const candidateAborts = options.models.map(() => new AbortController());
      const wiresInFlight = options.models.map((model, ordinal) => {
        const candidateSignal = candidateAborts[ordinal]?.signal;
        const signal =
          options.signal !== undefined && candidateSignal !== undefined
            ? AbortSignal.any([options.signal, candidateSignal])
            : (candidateSignal ?? options.signal);
        return proposeOne(model, ordinal, {
          ...options,
          ...(signal !== undefined ? { signal } : {})
        });
      });
      const { settled, abandonedOrdinals } = await settleWithStragglerGrace(wiresInFlight, {
        graceMs: options.stragglerGraceMs,
        isUsable: (wire) => wire.status === "succeeded",
        abandon: (ordinal) =>
          candidateAborts[ordinal]?.abort(new Error(STRAGGLER_ABANDONED))
      });
      const wires = settled.map((result, ordinal) => {
        const model = options.models[ordinal];
        if (model === undefined) throw new Error(`missing proposal model at ordinal ${ordinal}`);
        const candidateId = `${options.id ?? "propose"}_${model.id}_${ordinal}`;
        if (abandonedOrdinals.has(ordinal)) {
          return failedWire(candidateId, model, STRAGGLER_ABANDONED);
        }
        return result.status === "fulfilled"
          ? result.value
          : failedWire(
              candidateId,
              model,
              result.reason instanceof Error ? result.reason.message : String(result.reason)
            );
      });
      return wires.map((wire) => ({
        candidateId: wire.candidate_id ?? wire.trajectory_id,
        modelId: wire.model_id,
        ...(wire.model !== undefined ? { model: wire.model } : {}),
        content: wire.final_output,
        raw: wire,
        metadata: { status: wire.status }
      }));
    }
  });
  const result = await runtime.run({
    runId: `${options.id ?? "propose_panels"}_runtime`,
    graph: {
      id: `${options.id ?? "propose_panels"}_graph`,
      inputArtifactIds: [task.id],
      nodes: [{ id: "panel", operator: panel, inputs: [{ artifactId: task.id }] }]
    },
    scheduler: new StaticDAGScheduler("fusion-propose-static-dag"),
    artifacts: [task],
    budget: {
      id: "fusion-propose-panels",
      maxCandidates: options.models.length,
      maxWorkspaceWriters: 0
    }
  });
  return result.finalArtifacts
    .map((artifact) => (artifact.value as { raw?: unknown }).raw)
    .filter((value): value is WireTrajectory => value !== null && typeof value === "object");
}
