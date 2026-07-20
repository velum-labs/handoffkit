import { MatterValidationError } from "../matter/errors.js";
import type { MatterTag } from "../matter/schemas.js";

export interface ResolvedTags {
  requestedNames: string[];
  tagIds: string[];
  tags: MatterTag[];
}

export function resolveTagNames(tagNames: string[] | undefined, availableTags: MatterTag[]): ResolvedTags {
  const requestedNames = [...new Set((tagNames ?? []).map((name) => name.trim()).filter(Boolean))];
  const byLowerName = new Map(availableTags.map((tag) => [tag.name.toLowerCase(), tag]));
  const resolved: MatterTag[] = [];
  const unknown: string[] = [];

  for (const requested of requestedNames) {
    const tag = byLowerName.get(requested.toLowerCase());
    if (tag) {
      resolved.push(tag);
    } else {
      unknown.push(requested);
    }
  }

  if (unknown.length > 0) {
    const message = unknown
      .map((name) => {
        const suggestions = suggestTagNames(name, availableTags.map((tag) => tag.name));
        return suggestions.length > 0
          ? `Unknown Matter tag '${name}'. Did you mean: ${suggestions.join(", ")}?`
          : `Unknown Matter tag '${name}'.`;
      })
      .join(" ");
    throw new MatterValidationError(message);
  }

  return {
    requestedNames,
    tagIds: resolved.map((tag) => tag.id),
    tags: resolved
  };
}

export function suggestTagNames(input: string, candidates: string[], limit = 5): string[] {
  const normalized = input.toLowerCase();
  return candidates
    .map((candidate) => {
      const lower = candidate.toLowerCase();
      const prefixOrSubstring = lower.startsWith(normalized) || lower.includes(normalized) ? -10 : 0;
      return {
        candidate,
        score: levenshteinDistance(normalized, lower) + prefixOrSubstring
      };
    })
    .filter((entry) => entry.score <= Math.max(3, Math.ceil(normalized.length / 2)))
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

function levenshteinDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + substitutionCost);
    }
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
}
