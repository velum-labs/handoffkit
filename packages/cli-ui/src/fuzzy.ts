/**
 * The fuzzy matcher behind `fuzzySelect` and dynamic shell completion: a
 * case-insensitive subsequence match with a small scoring model (consecutive
 * runs and word starts score higher, earlier and shorter matches win ties).
 * Dependency-free so completion can use it without pulling in Ink.
 */

export type FuzzyMatch = {
  /** Higher is better; only comparable across matches for the same query. */
  score: number;
  /** Indices of matched characters in the original text (for highlighting). */
  positions: readonly number[];
};

/** True when `ch` starts a word (after a separator or a case boundary). */
function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1] ?? "";
  if (/[\s\-_/.:=]/.test(prev)) return true;
  const ch = text[index] ?? "";
  return /[a-z]/.test(prev) && /[A-Z]/.test(ch);
}

/**
 * Match `query` as a subsequence of `text`. Returns undefined when the query
 * does not match. An empty query matches everything with score 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | undefined {
  if (query.length === 0) return { score: 0, positions: [] };
  const lowerQuery = query.toLowerCase();
  const lowerText = text.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let textIndex = 0;
  let previousMatch = -2;
  for (let queryIndex = 0; queryIndex < lowerQuery.length; queryIndex++) {
    const ch = lowerQuery[queryIndex] ?? "";
    const found = lowerText.indexOf(ch, textIndex);
    if (found === -1) return undefined;
    positions.push(found);
    score += 1;
    if (found === previousMatch + 1) score += 2; // consecutive run
    if (isWordStart(text, found)) score += 3; // word-start hit
    previousMatch = found;
    textIndex = found + 1;
  }
  // Earlier first hit and shorter text read as tighter matches.
  const first = positions[0] ?? 0;
  score += Math.max(0, 3 - first * 0.5);
  score -= text.length * 0.01;
  return { score, positions };
}

export type FuzzyResult<T> = { item: T; match: FuzzyMatch };

/** Filter and rank `items` by fuzzy-matching `query` against `textOf(item)`. */
export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  textOf: (item: T) => string
): FuzzyResult<T>[] {
  const results: FuzzyResult<T>[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, textOf(item));
    if (match !== undefined) results.push({ item, match });
  }
  if (query.length > 0) results.sort((left, right) => right.match.score - left.match.score);
  return results;
}
