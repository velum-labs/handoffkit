import { canPromptInteractively, fuzzySelect, isInteractive } from "@routekit/cli-ui";
import type { SelectOption } from "@routekit/cli-ui";

import { fail } from "./errors.js";

export function canPickInteractively(): boolean {
  return canPromptInteractively() && isInteractive();
}

export async function argOrPick<T extends string>(input: {
  given: T | undefined;
  message: string;
  options: () => ReadonlyArray<SelectOption<T>>;
  refresh?: () => Promise<ReadonlyArray<SelectOption<T>>>;
  refreshNote?: string;
  missing: string;
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
