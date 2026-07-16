/**
 * The one harness failure taxonomy. Every driver classifies failures into
 * these codes at the boundary where they occur; retryability and failover
 * category are derived from the code, never hand-picked per call site.
 */
export const HARNESS_ERROR_CODES = [
  /** The CLI binary is not installed / not on PATH. */
  "not_installed",
  /** The CLI is installed but not logged in / no usable credential. */
  "not_authenticated",
  /** The CLI version fails the driver's floor or handshake. */
  "version_unsupported",
  /** The driver rejected its configuration at decode time. */
  "invalid_config",
  /** The session existed but its process/connection has gone away. */
  "session_closed",
  /** A wire payload failed schema/shape validation. */
  "protocol_parse",
  /** The run exceeded its deadline. */
  "timeout",
  /** The run was cancelled via its abort signal. */
  "aborted",
  /** The provider/CLI reported a failure the driver could not classify further. */
  "provider_error"
] as const;

export type HarnessErrorCode = (typeof HARNESS_ERROR_CODES)[number];

/** The gateway's provider-failover taxonomy. */
export type HarnessErrorCategory =
  | "transient"
  | "quota_exhausted"
  | "auth_permanent"
  | "context_overflow"
  | "unknown";

export class HarnessError extends Error {
  readonly code: HarnessErrorCode;
  /** Optional finer-grained failover category when the driver knows better. */
  readonly category: HarnessErrorCategory;

  constructor(
    code: HarnessErrorCode,
    message: string,
    options: { category?: HarnessErrorCategory; cause?: unknown } = {}
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "HarnessError";
    this.code = code;
    this.category = options.category ?? defaultCategoryFor(code);
  }

  get retryable(): boolean {
    return isRetryable(this);
  }
}

function defaultCategoryFor(code: HarnessErrorCode): HarnessErrorCategory {
  switch (code) {
    case "timeout":
    case "session_closed":
      return "transient";
    case "not_authenticated":
      return "auth_permanent";
    case "not_installed":
    case "version_unsupported":
    case "invalid_config":
    case "protocol_parse":
    case "aborted":
    case "provider_error":
      return "unknown";
    default: {
      const exhausted: never = code;
      throw new Error(`unsupported harness error code: ${String(exhausted)}`);
    }
  }
}

/** Retryability is derived from the taxonomy, never hardcoded per call site. */
export function isRetryable(error: HarnessError): boolean {
  if (error.code === "aborted") return false;
  switch (error.category) {
    case "transient":
    case "quota_exhausted":
      return true;
    case "auth_permanent":
    case "context_overflow":
    case "unknown":
      return false;
    default: {
      const exhausted: never = error.category;
      throw new Error(`unsupported harness error category: ${String(exhausted)}`);
    }
  }
}

/** Wrap an arbitrary thrown value as a classified HarnessError. */
export function asHarnessError(value: unknown, fallbackCode: HarnessErrorCode = "provider_error"): HarnessError {
  if (value instanceof HarnessError) return value;
  const errno = value as NodeJS.ErrnoException;
  if (errno?.code === "ENOENT") {
    return new HarnessError("not_installed", errno.message, { cause: value });
  }
  const message = value instanceof Error ? value.message : String(value);
  return new HarnessError(fallbackCode, message, { cause: value });
}
