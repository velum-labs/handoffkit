/**
 * Typed continuation triggers. Deterministic and explainable: every trigger
 * evaluates against observable context state (the tool journal, explicit
 * requests, model routing decisions) — never against a model's opinion.
 */

export type Trigger =
  | { kind: "trigger"; id: "user-requested" }
  | { kind: "trigger"; id: "tool-failed" }
  | { kind: "trigger"; id: "slow-tools"; thresholdMs: number }
  | { kind: "trigger"; id: "model-escalated" };

export const triggers = {
  /** The user (or app) explicitly asked via h.requestContinuation(). */
  userRequested(): Trigger {
    return { kind: "trigger", id: "user-requested" };
  },
  /** Any journaled tool call failed. */
  toolFailed(): Trigger {
    return { kind: "trigger", id: "tool-failed" };
  },
  /** Cumulative journaled tool time exceeded the threshold. */
  slowTools(options: { thresholdMs: number }): Trigger {
    return { kind: "trigger", id: "slow-tools", thresholdMs: options.thresholdMs };
  },
  /** h.model escalated from the local model to the cloud model. */
  modelEscalated(): Trigger {
    return { kind: "trigger", id: "model-escalated" };
  }
};

/** Observable context state that triggers evaluate against. */
export type TriggerState = {
  userRequested: boolean;
  toolFailures: number;
  totalToolDurationMs: number;
  modelEscalations: number;
};

export type FiredTrigger = {
  trigger: Trigger;
  reason: string;
};

export function evaluateTriggers(
  list: Trigger[],
  state: TriggerState
): FiredTrigger[] {
  const fired: FiredTrigger[] = [];
  for (const trigger of list) {
    switch (trigger.id) {
      case "user-requested":
        if (state.userRequested) {
          fired.push({ trigger, reason: "continuation explicitly requested" });
        }
        break;
      case "tool-failed":
        if (state.toolFailures > 0) {
          fired.push({
            trigger,
            reason: `${state.toolFailures} journaled tool call(s) failed`
          });
        }
        break;
      case "slow-tools":
        if (state.totalToolDurationMs > trigger.thresholdMs) {
          fired.push({
            trigger,
            reason: `tools consumed ${state.totalToolDurationMs}ms locally (threshold ${trigger.thresholdMs}ms)`
          });
        }
        break;
      case "model-escalated":
        if (state.modelEscalations > 0) {
          fired.push({
            trigger,
            reason: `the model escalated ${state.modelEscalations} time(s)`
          });
        }
        break;
      default: {
        const exhausted: never = trigger;
        throw new Error(`unreachable trigger: ${String(exhausted)}`);
      }
    }
  }
  return fired;
}
