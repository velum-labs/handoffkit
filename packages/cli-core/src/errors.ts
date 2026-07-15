import { createPresenter, uiStream } from "@routekit/cli-ui";

import { emitJson, isJsonMode } from "./context.js";

export type CliErrorInput = {
  message: string;
  code?: string;
  details?: readonly string[];
  hint?: string;
  tryCommand?: string;
  docs?: string;
  exitCode?: number;
  plain?: boolean;
};

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
  throw new CliError(typeof message === "string" ? { message, plain: true } : message);
}
