export type WireTrajectory = {
  trajectory_id: string;
  model_id: string;
  status: string;
  final_output: string;
  items?: Array<Record<string, unknown>>;
  candidate_id?: string;
  model?: string;
  harness_kind?: string;
  diff?: string;
  verification?: { status: string; evidence?: string[]; exit_code?: number };
  metadata?: Record<string, unknown>;
};

export function isWireTrajectory(value: unknown): value is WireTrajectory {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<WireTrajectory>;
  return (
    typeof record.trajectory_id === "string" &&
    record.trajectory_id.length > 0 &&
    typeof record.model_id === "string" &&
    record.model_id.length > 0 &&
    typeof record.status === "string" &&
    record.status.length > 0 &&
    typeof record.final_output === "string"
  );
}

export function assertWireTrajectory(value: unknown, context = "wire trajectory"): asserts value is WireTrajectory {
  if (!isWireTrajectory(value)) {
    throw new Error(`${context} is missing required trajectory_id, model_id, status, or final_output fields`);
  }
}

export function normalizeWireTrajectories(values: readonly unknown[]): WireTrajectory[] {
  return values.map((value, index) => {
    assertWireTrajectory(value, `wire trajectory[${index}]`);
    return value;
  });
}
