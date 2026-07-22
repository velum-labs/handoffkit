export type MatterErrorCode =
  | "configuration_error"
  | "authentication_error"
  | "forbidden"
  | "not_found"
  | "validation_error"
  | "rate_limited"
  | "transient_error"
  | "protocol_error";

export class MatterError extends Error {
  readonly code: MatterErrorCode;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly status?: number;

  constructor(
    code: MatterErrorCode,
    message: string,
    retryable: boolean,
    options: { requestId?: string; status?: number; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.retryable = retryable;
    this.requestId = options.requestId;
    this.status = options.status;
  }
}

export class MatterConfigurationError extends MatterError {
  constructor(message: string, options: { requestId?: string; cause?: unknown } = {}) {
    super("configuration_error", message, false, options);
  }
}

export class MatterAuthenticationError extends MatterError {
  constructor(message: string, options: { requestId?: string; status?: number; cause?: unknown } = {}) {
    super("authentication_error", message, false, options);
  }
}

export class MatterForbiddenError extends MatterError {
  constructor(message: string, options: { requestId?: string; status?: number; cause?: unknown } = {}) {
    super("forbidden", message, false, options);
  }
}

export class MatterNotFoundError extends MatterError {
  constructor(message: string, options: { requestId?: string; status?: number; cause?: unknown } = {}) {
    super("not_found", message, false, options);
  }
}

export class MatterValidationError extends MatterError {
  constructor(message: string, options: { requestId?: string; status?: number; cause?: unknown } = {}) {
    super("validation_error", message, false, options);
  }
}

export class MatterRateLimitError extends MatterError {
  constructor(message: string, options: { requestId?: string; status?: number; cause?: unknown } = {}) {
    super("rate_limited", message, true, options);
  }
}

export class MatterTransientError extends MatterError {
  constructor(message: string, options: { requestId?: string; status?: number; cause?: unknown } = {}) {
    super("transient_error", message, true, options);
  }
}

export class MatterProtocolError extends MatterError {
  constructor(message: string, options: { requestId?: string; status?: number; cause?: unknown } = {}) {
    super("protocol_error", message, false, options);
  }
}

export function toMatterError(error: unknown): MatterError {
  if (error instanceof MatterError) {
    return error;
  }

  if (error instanceof Error) {
    return new MatterTransientError(error.message, { cause: error });
  }

  return new MatterTransientError("Unexpected Matter client failure");
}
