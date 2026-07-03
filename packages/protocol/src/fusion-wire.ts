export type WireTrajectory = {
  trajectory_id: string;
  model_id: string;
  status: string;
  final_output: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  items?: Array<Record<string, unknown>>;
  candidate_id?: string;
  model?: string;
  harness_kind?: string;
  diff?: string;
  verification?: { status: string; evidence?: string[]; exit_code?: number };
  metadata?: Record<string, unknown>;
  /**
   * Why the candidate's harness run ended (`completed` = the tool reported a
   * finished turn; `aborted` = clean exit without one, i.e. interrupted
   * mid-turn; plus `timeout` / `exit_error` / `spawn_error`). Persisted so
   * early stops are attributable from the session record.
   */
  end_reason?: { kind: string; exit_code?: number; timed_out?: boolean; detail?: string };
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
