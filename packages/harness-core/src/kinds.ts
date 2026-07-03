import type { ModelFusionHarnessKind } from "@fusionkit/protocol";

/**
 * The single harness-kind vocabulary. Every layer (drivers, panel fanout,
 * launchers, status probes) uses these exact identifiers; the protocol's
 * `ModelFusionHarnessKind` is mapped at the wire boundary only, via
 * {@link toModelFusionHarnessKind}.
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

/**
 * Map the canonical kind onto the protocol's wire vocabulary. `opencode` has
 * no protocol value yet, so its records are labeled `generic` until the
 * protocol schema bundle adds it.
 */
export function toModelFusionHarnessKind(kind: HarnessKind): ModelFusionHarnessKind {
  switch (kind) {
    case "codex":
      return "codex";
    case "claude_code":
      return "claude_code";
    case "cursor":
      return "cursor";
    case "opencode":
      return "generic";
    case "generic":
      return "generic";
    default: {
      const exhausted: never = kind;
      throw new Error(`unsupported harness kind: ${String(exhausted)}`);
    }
  }
}
