/**
 * Shared CLI failure helpers.
 *
 * `fail(message)` keeps the one-line `error: ...` contract (tests assert the
 * wording) for terse validation failures. Richer failures throw or pass a
 * {@link CliError}: one error shape rendered three ways — a red framed panel
 * on human UI, prefixed plain lines under --quiet, and a structured
 * `{ error: { code, message, hint?, try?, docs?, details? } }` payload in
 * --json mode. Every field is optional except the message, and the `try`
 * field is always a copy-pasteable next command.
 */
import { createPresenter, uiStream } from "@fusionkit/cli-ui";

import { emitJson, isJsonMode } from "./context.js";

export type CliErrorInput = {
  message: string;
  /** Stable machine-readable code for --json consumers (default: "error"). */
  code?: string;
  /** Supporting evidence, e.g. a distilled log tail. */
  details?: readonly string[];
  /** A human explanation of what likely went wrong / what to check. */
  hint?: string;
  /** A copy-pasteable next command. */
  tryCommand?: string;
  /** A docs URL for the failure area. */
  docs?: string;
  /** Process exit code (default 1). */
  exitCode?: number;
  /** Render as a one-line `error: <message>` instead of the framed panel. */
  plain?: boolean;
};

/** A CLI failure carrying presentation fields for the error panel. */
export class CliError extends Error {
  readonly code: string;
  readonly details?: readonly string[];
  readonly hint?: string;
  readonly tryCommand?: string;
  readonly docs?: string;
  readonly exitCode: number;
  readonly plain: boolean;

  constructor(input: CliErrorInput) {
    super(input.message);
    this.name = "CliError";
    this.code = input.code ?? "error";
    if (input.details !== undefined) this.details = input.details;
    if (input.hint !== undefined) this.hint = input.hint;
    if (input.tryCommand !== undefined) this.tryCommand = input.tryCommand;
    if (input.docs !== undefined) this.docs = input.docs;
    this.exitCode = input.exitCode ?? 1;
    this.plain = input.plain === true;
  }
}

/** The --json payload for a CliError (also used by the top-level handler). */
export function cliErrorPayload(error: CliError): { error: Record<string, unknown> } {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: [...error.details] } : {}),
      ...(error.hint !== undefined ? { hint: error.hint } : {}),
      ...(error.tryCommand !== undefined ? { try: error.tryCommand } : {}),
      ...(error.docs !== undefined ? { docs: error.docs } : {})
    }
  };
}

/** Render a CliError to the human UI channel and return its exit code. */
export function renderCliError(error: CliError): number {
  if (isJsonMode()) {
    emitJson(cliErrorPayload(error));
    return error.exitCode;
  }
  if (error.plain) {
    uiStream().write(`error: ${error.message}\n`);
    return error.exitCode;
  }
  const presenter = createPresenter({ interactive: false });
  presenter.errorPanel({
    message: error.message,
    ...(error.details !== undefined ? { details: error.details } : {}),
    ...(error.hint !== undefined ? { hint: error.hint } : {}),
    ...(error.tryCommand !== undefined ? { tryCommand: error.tryCommand } : {}),
    ...(error.docs !== undefined ? { docs: error.docs } : {})
  });
  return error.exitCode;
}

export function fail(message: string | CliErrorInput): never {
  if (typeof message === "string") throw new CliError({ message, plain: true });
  throw new CliError(message);
}
