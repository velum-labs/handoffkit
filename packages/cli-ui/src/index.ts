/**
 * @fusionkit/cli-ui — the fusionkit terminal UX layer.
 *
 * One presenter contract, two implementations: rich Ink (React) rendering on
 * interactive TTYs, ordered plain-text lines everywhere else (CI, pipes,
 * `FUSIONKIT_NO_TUI=1`). All UI goes to stderr; stdout stays reserved for
 * machine payloads and the launched tool's output.
 */
import { InkPresenter } from "./ink/presenter.js";
import { PlainPresenter } from "./plain.js";
import type { Presenter } from "./presenter.js";
import { isInteractive } from "./runtime.js";

export * from "./theme.js";
export * from "./runtime.js";
export * from "./format.js";
export * from "./presenter.js";
export { PlainPresenter, renderKeyValueLines, renderTableLines } from "./plain.js";
export { InkPresenter, mountInk, settleInk } from "./ink/presenter.js";
export { select, multiselect, confirm, text, done, note } from "./prompt.js";
export type { SelectOption } from "./prompt.js";

/**
 * The presenter for this invocation: Ink when attached to an interactive TTY,
 * plain line logs otherwise. `forceNonInteractive()` (the `--json` /
 * `--no-input` flags) flips this to plain for the rest of the process.
 */
export function createPresenter(options: { interactive?: boolean } = {}): Presenter {
  const interactive = options.interactive ?? isInteractive();
  return interactive ? new InkPresenter() : new PlainPresenter();
}
