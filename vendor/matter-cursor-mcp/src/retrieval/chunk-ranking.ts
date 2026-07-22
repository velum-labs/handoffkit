import type { MatterAnnotation } from "../matter/schemas.js";
import type { MarkdownChunk } from "./markdown-chunker.js";

export const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with"
]);

export interface ScoredChunk extends MarkdownChunk {
  score: number;
}

export function rankChunks(
  query: string,
  chunks: MarkdownChunk[],
  annotations: MatterAnnotation[] = []
): ScoredChunk[] {
  const queryTerms = uniqueTerms(query);
  const phrase = normalizeForSearch(query);
  const annotationSnippets = annotations
    .map((annotation) => normalizeForSearch(annotation.text))
    .filter((text) => text.length >= 20);

  return chunks
    .map((chunk) => {
      const chunkNormalized = normalizeForSearch(chunk.text);
      const chunkTerms = new Set(tokenize(chunkNormalized));
      const headingTerms = new Set(tokenize(chunk.heading_path.join(" ")));
      const overlapCount = queryTerms.filter((term) => chunkTerms.has(term)).length;
      const headingOverlap = queryTerms.filter((term) => headingTerms.has(term)).length;
      const phraseBonus = phrase.length > 0 && chunkNormalized.includes(phrase) ? 3 : 0;
      const annotationBoost = annotationSnippets.some(
        (snippet) => chunkNormalized.includes(snippet) || snippet.includes(chunkNormalized.slice(0, 80))
      )
        ? 2
        : 0;
      const score = overlapCount + headingOverlap * 1.5 + phraseBonus + annotationBoost;
      return { ...chunk, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

export function uniqueTerms(input: string): string[] {
  return [...new Set(tokenize(input))];
}

export function tokenize(input: string): string[] {
  return normalizeForSearch(input)
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1 && !STOPWORDS.has(term));
}

export function normalizeForSearch(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}
