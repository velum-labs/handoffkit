/**
 * A tiny wizard runner: ordered steps over a shared state object, with Esc
 * back-navigation (steps receive prompts created with `allowBack: true` and
 * return {@link BACK} to go back one step). Each step prints a dim
 * `step N/M · title` header so a finished wizard reads as a transcript of the
 * journey; skipped steps disappear from the count.
 */
import { BACK } from "./prompt.js";
import type { Back } from "./prompt.js";
import { isInteractive, uiStream } from "./runtime.js";
import { dim } from "./theme.js";

export type WizardStep<S> = {
  id: string;
  title: string;
  /** Run the step: return the next state, or BACK to go back one step. */
  run: (state: S) => Promise<S | Back>;
  /** When true for the current state the step is skipped (both directions). */
  skip?: (state: S) => boolean;
};

export async function runWizard<S>(input: {
  steps: ReadonlyArray<WizardStep<S>>;
  initial: S;
}): Promise<S> {
  const out = uiStream();
  let state = input.initial;
  // Snapshots of the state as it was when each step started, so going back
  // replays from exactly where that step began.
  const snapshots: S[] = [];
  let index = 0;
  while (index < input.steps.length) {
    const step = input.steps[index];
    if (step === undefined) break;
    if (step.skip !== undefined && step.skip(state)) {
      snapshots[index] = state;
      index += 1;
      continue;
    }
    const active = input.steps.filter((candidate) => candidate.skip === undefined || !candidate.skip(state));
    const position = active.indexOf(step);
    if (position >= 0 && active.length > 1 && isInteractive()) {
      out.write(`${dim(`step ${position + 1}/${active.length} · ${step.title} ${position > 0 ? "(esc goes back)" : ""}`.trimEnd())}\n`);
    }
    snapshots[index] = state;
    const result = await step.run(state);
    if (result === BACK) {
      // Walk back past skipped steps; stay on the first step when already there.
      let previous = index - 1;
      while (previous >= 0) {
        const candidate = input.steps[previous];
        const snapshot = snapshots[previous];
        if (candidate !== undefined && snapshot !== undefined && (candidate.skip === undefined || !candidate.skip(snapshot))) break;
        previous -= 1;
      }
      if (previous >= 0) {
        index = previous;
        state = snapshots[previous] as S;
      }
      continue;
    }
    state = result;
    index += 1;
  }
  return state;
}
