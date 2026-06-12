/**
 * Versioned schema identifiers and shared enumerations, referenced instead
 * of inlining string literals across packages. The literal-typed `as const`
 * values still satisfy the corresponding `version: "..."` fields.
 */
import type { RunStatus } from "./types.js";

export const PROTOCOL_VERSIONS = {
  contract: "warrant.contract.v1",
  receipt: "warrant.receipt.v1",
  event: "warrant.event.v1",
  manifest: "warrant.manifest.v1",
  policy: "warrant.policy.v1",
  checkpoint: "warrant.checkpoint.v1",
  envelope: "warrant.envelope.v1",
  bundle: "warrant.bundle.v1",
  toolJournal: "warrant.tooljournal.v1",
  sealed: "warrant.sealed.v1"
} as const;

/** Run states from which no further transition occurs. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "completed",
  "failed",
  "cancelled"
];

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * Length (in hex characters) of the public-key fingerprint embedded in a
 * key id. 16 hex = 64 bits of a SHA-256 digest: ample collision resistance
 * for identifying enrolled keys while keeping ids short and readable.
 */
export const KEY_ID_HEX_LENGTH = 16;
