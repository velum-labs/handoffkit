/**
 * Missing-argument pickers: id-taking subcommands prompt with a fuzzy picker
 * when the argument is omitted on an interactive TTY, and fail with the usual
 * guidance everywhere else (scripts, CI, --json, --no-input). The picked value
 * is always exactly what the argument would have been, so `--json` scripts and
 * interactive humans travel the same code path afterwards.
 */
import { canPromptInteractively, fuzzySelect, isInteractive } from "@fusionkit/cli-ui";
import type { SelectOption } from "@fusionkit/cli-ui";

import { fail } from "./errors.js";

/** True when a missing argument may be resolved with an interactive picker. */
export function canPickInteractively(): boolean {
  return canPromptInteractively() && isInteractive();
}

/**
 * Resolve an optional positional argument: the given value when present, an
 * interactive fuzzy pick on a TTY, or `fail(missing)` otherwise. `empty` is
 * the failure when there is nothing to pick from.
 */
export async function argOrPick<T extends string>(input: {
  given: T | undefined;
  message: string;
  options: () => ReadonlyArray<SelectOption<T>>;
  /** Optional live loader: the list starts on `options` and updates when this lands. */
  refresh?: () => Promise<ReadonlyArray<SelectOption<T>>>;
  refreshNote?: string;
  /** Failure when the argument is required (non-interactive). */
  missing: string;
  /** Failure when the picker would be empty (defaults to `missing`). */
  empty?: string;
  placeholder?: string;
}): Promise<T> {
  if (input.given !== undefined) return input.given;
  if (!canPickInteractively()) fail(input.missing);
  const options = input.options();
  if (options.length === 0 && input.refresh === undefined) fail(input.empty ?? input.missing);
  return fuzzySelect<T>({
    message: input.message,
    options,
    ...(input.refresh !== undefined ? { refresh: input.refresh } : {}),
    ...(input.refreshNote !== undefined ? { refreshNote: input.refreshNote } : {}),
    ...(input.placeholder !== undefined ? { placeholder: input.placeholder } : {})
  });
}
