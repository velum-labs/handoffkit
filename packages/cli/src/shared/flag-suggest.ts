/**
 * The passthrough flag-typo guard. Launcher commands forward unknown args to
 * the coding tool by design (`--allowUnknownOption`), which silently swallows
 * misspelled fusionkit flags: `fusionkit codex --buget 5` forwards `--buget`
 * to codex without a word. Before handing args over, warn when a forwarded
 * long flag is a near-miss of a real fusionkit flag — the flag is still
 * forwarded (it may genuinely belong to the tool), but the typo is no longer
 * silent.
 */
import type { Command } from "commander";

import { uiStream, cyan, dim, glyph, yellow } from "@fusionkit/cli-ui";

/** Classic Levenshtein distance (small inputs only: flag names). */
export function levenshtein(left: string, right: string): number {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const distance: number[] = Array.from({ length: cols }, (_, index) => index);
  for (let row = 1; row < rows; row++) {
    let previousDiagonal = distance[0] as number;
    distance[0] = row;
    for (let col = 1; col < cols; col++) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      const next = Math.min(
        (distance[col] as number) + 1,
        (distance[col - 1] as number) + 1,
        previousDiagonal + cost
      );
      previousDiagonal = distance[col] as number;
      distance[col] = next;
    }
  }
  return distance[cols - 1] as number;
}

/** The long flag names (`--budget`, ...) a command accepts, program flags included. */
export function knownLongFlags(command: Command): string[] {
  const flags = new Set<string>();
  let current: Command | null = command;
  while (current !== null) {
    for (const option of current.options) {
      if (option.long !== undefined && option.long !== null) flags.add(option.long);
    }
    current = current.parent;
  }
  return [...flags];
}

/**
 * Find near-miss forwarded flags: tokens shaped like `--flag` (value suffixes
 * stripped) that are not a known flag but are within edit distance of one.
 * Exported for tests; rendering lives in {@link warnPassthroughTypos}.
 */
export function findFlagTypos(
  known: readonly string[],
  args: readonly string[]
): Array<{ given: string; suggestion: string }> {
  const typos: Array<{ given: string; suggestion: string }> = [];
  for (const arg of args) {
    if (arg === "--") break; // explicit passthrough sentinel: trust everything after
    if (!arg.startsWith("--")) continue;
    const name = arg.split("=")[0] ?? arg;
    if (name.length < 5) continue; // too short to suggest confidently
    if (known.includes(name)) continue; // consumed flags never land here, but be safe
    let best: { flag: string; distance: number } | undefined;
    for (const flag of known) {
      const distance = levenshtein(name, flag);
      if (best === undefined || distance < best.distance) best = { flag, distance };
    }
    if (best === undefined) continue;
    const threshold = name.length >= 8 ? 2 : 1;
    if (best.distance > 0 && best.distance <= threshold) {
      typos.push({ given: name, suggestion: best.flag });
    }
  }
  return typos;
}

/** Print one warning per near-miss forwarded flag (never fails the run). */
export function warnPassthroughTypos(command: Command, args: readonly string[], tool: string): void {
  for (const typo of findFlagTypos(knownLongFlags(command), args)) {
    uiStream().write(
      `${yellow(glyph.warn())} ${typo.given} is not a fusionkit flag — did you mean ${cyan(typo.suggestion)}? ` +
        `${dim(`(it will be forwarded to ${tool} as-is; fusionkit flags must precede ${tool} args)`)}\n`
    );
  }
}
