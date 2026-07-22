import type { Command } from "commander";

import { cyan, dim, glyph, uiStream, yellow } from "@routekit/cli-ui";

export function levenshtein(left: string, right: string): number {
  const distance: number[] = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = distance[0] as number;
    distance[0] = row;
    for (let col = 1; col <= right.length; col += 1) {
      const previous = distance[col] as number;
      distance[col] = Math.min(
        previous + 1,
        (distance[col - 1] as number) + 1,
        diagonal + (left[row - 1] === right[col - 1] ? 0 : 1)
      );
      diagonal = previous;
    }
  }
  return distance[right.length] as number;
}

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

export function findFlagTypos(
  known: readonly string[],
  args: readonly string[]
): Array<{ given: string; suggestion: string }> {
  const typos: Array<{ given: string; suggestion: string }> = [];
  for (const arg of args) {
    if (arg === "--") break;
    if (!arg.startsWith("--")) continue;
    const name = arg.split("=")[0] ?? arg;
    if (name.length < 5 || known.includes(name)) continue;
    let best: { flag: string; distance: number } | undefined;
    for (const flag of known) {
      const distance = levenshtein(name, flag);
      if (best === undefined || distance < best.distance) best = { flag, distance };
    }
    const threshold = name.length >= 8 ? 2 : 1;
    if (best !== undefined && best.distance > 0 && best.distance <= threshold) {
      typos.push({ given: name, suggestion: best.flag });
    }
  }
  return typos;
}

export function warnPassthroughTypos(
  command: Command,
  args: readonly string[],
  input: { productName: string; forwardedTo: string }
): void {
  for (const typo of findFlagTypos(knownLongFlags(command), args)) {
    uiStream().write(
      `${yellow(glyph.warn())} ${typo.given} is not a ${input.productName} flag — did you mean ${cyan(typo.suggestion)}? ` +
        `${dim(`(it will be forwarded to ${input.forwardedTo} as-is; ${input.productName} flags must precede ${input.forwardedTo} args)`)}\n`
    );
  }
}
