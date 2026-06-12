import type { RunStatus } from "@warrant/protocol";

import { conflict } from "./domain-errors.js";

type RunTransition =
  | { from: "created"; to: "claimed" | "cancelled" }
  | { from: "awaiting_approval"; to: "created" | "cancelled" }
  | { from: "claimed"; to: "running" | "completed" | "failed" | "cancelled" }
  | { from: "provisioning"; to: "running" | "failed" | "cancelled" }
  | { from: "running"; to: "completed" | "failed" | "cancelled" };

const ALLOWED_TRANSITIONS = new Map<RunStatus, readonly RunStatus[]>([
  ["created", ["claimed", "cancelled"]],
  ["awaiting_approval", ["created", "cancelled"]],
  ["claimed", ["running", "completed", "failed", "cancelled"]],
  ["provisioning", ["running", "failed", "cancelled"]],
  ["running", ["completed", "failed", "cancelled"]],
  ["completed", []],
  ["failed", []],
  ["cancelled", []]
]);

function canTransitionRunStatus(from: RunStatus, to: RunStatus): boolean {
  return ALLOWED_TRANSITIONS.get(from)?.includes(to) ?? false;
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRunStatus(from, to)) {
    throw conflict(`cannot transition run from ${from} to ${to}`);
  }
}
