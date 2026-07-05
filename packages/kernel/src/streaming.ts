import type { Artifact, BudgetPolicy, OperatorGraph, RuntimeEvent, RuntimeExecutionResult, Scheduler } from "./types.js";
import { RuntimeExecutionError } from "./types.js";
export type { RuntimeEvent, StreamingOperator } from "./types.js";

export type RuntimeRunInput = {
  graph: OperatorGraph;
  scheduler: Scheduler;
  artifacts?: readonly Artifact[];
  budget?: BudgetPolicy;
  runId?: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
};

export function streamRuntime(
  run: (input: RuntimeRunInput, streamOptions: { sink: (event: RuntimeEvent) => void }) => Promise<RuntimeExecutionResult>,
  input: RuntimeRunInput
): AsyncIterable<RuntimeEvent> {
  return (async function* streamEvents() {
    const events: RuntimeEvent[] = [];
    let finished = false;
    let notify: (() => void) | undefined;
    const wake = (): void => {
      const resume = notify;
      notify = undefined;
      resume?.();
    };
    const sink = (event: RuntimeEvent): void => {
      events.push(event);
      wake();
    };
    const settled = run(input, { sink })
      .then((result): { ok: true; result: RuntimeExecutionResult } => ({ ok: true, result }))
      .catch((error: unknown): { ok: false; error: unknown } => ({ ok: false, error }))
      .finally(() => {
        finished = true;
        wake();
      });
    for (;;) {
      while (events.length > 0) {
        const next = events.shift();
        if (next !== undefined) yield next;
      }
      if (finished) break;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
    const outcome = await settled;
    while (events.length > 0) {
      const next = events.shift();
      if (next !== undefined) yield next;
    }
    if (outcome.ok) {
      yield { type: "final", result: outcome.result };
      return;
    }
    if (outcome.error instanceof RuntimeExecutionError) {
      yield { type: "error", error: outcome.error };
      return;
    }
    throw outcome.error;
  })();
}
export type { FusionRuntime } from "./engine.js";
