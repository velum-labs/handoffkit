/**
 * The single harness-kind vocabulary. Every layer (drivers, orchestrators,
 * launchers, and status probes uses these exact identifiers.
 */
export const HARNESS_KINDS = [
  "codex",
  "claude_code",
  "cursor",
  "opencode",
  "generic"
] as const;

export type HarnessKind = (typeof HARNESS_KINDS)[number];

export function isHarnessKind(value: string): value is HarnessKind {
  return (HARNESS_KINDS as readonly string[]).includes(value);
}
