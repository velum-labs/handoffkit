export type PlaneErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "capability_mismatch";

export class PlaneDomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: PlaneErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PlaneDomainError";
  }
}

export function badRequest(message: string): PlaneDomainError {
  return new PlaneDomainError(400, "bad_request", message);
}

export function unauthorized(message: string): PlaneDomainError {
  return new PlaneDomainError(401, "unauthorized", message);
}

export function forbidden(message: string): PlaneDomainError {
  return new PlaneDomainError(403, "forbidden", message);
}

export function notFound(message: string): PlaneDomainError {
  return new PlaneDomainError(404, "not_found", message);
}

export function conflict(message: string): PlaneDomainError {
  return new PlaneDomainError(409, "conflict", message);
}

export function capabilityMismatch(message: string): PlaneDomainError {
  return new PlaneDomainError(422, "capability_mismatch", message);
}

export function isPlaneDomainError(error: unknown): error is PlaneDomainError {
  return error instanceof PlaneDomainError;
}
