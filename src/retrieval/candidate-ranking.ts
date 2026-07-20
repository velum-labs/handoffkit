import type { MatterAnnotation, MatterItem } from "../matter/schemas.js";
import { uniqueTerms } from "./chunk-ranking.js";

// Transparent, deterministic candidate-ranking weights from SPEC Stage 3.
export const CANDIDATE_RANKING_WEIGHTS = {
  matter_relevance_max: 100,
  all_required_tags: 25,
  has_annotation: 10,
  has_non_empty_note: 15,
  query_match_in_note: 20,
  favorite: 5,
  recency_max: 5,
  recency_window_days: 90
} as const;

export interface CandidateForRanking {
  item: MatterItem;
  matterRank: number | null;
  scannedWindow: number;
  requiredTagIds: string[];
  annotations: MatterAnnotation[];
}

export interface RankedCandidate extends CandidateForRanking {
  selectionScore: number;
  selectionReasons: string[];
  annotationCount: number;
  noteCount: number;
  queryMatchInNote: boolean;
}

export function rankCandidates(
  query: string,
  candidates: CandidateForRanking[],
  nowMs = Date.now()
): RankedCandidate[] {
  const queryTerms = uniqueTerms(query);
  return candidates
    .map((candidate) => scoreCandidate(candidate, queryTerms, nowMs))
    .sort((a, b) => b.selectionScore - a.selectionScore || a.item.id.localeCompare(b.item.id));
}

function scoreCandidate(candidate: CandidateForRanking, queryTerms: string[], nowMs: number): RankedCandidate {
  const reasons: string[] = [];
  let score = 0;

  if (candidate.matterRank !== null) {
    const relevance = relevanceContribution(candidate.matterRank, candidate.scannedWindow);
    score += relevance;
    reasons.push(`matter_search_rank_${candidate.matterRank}`);
  } else {
    reasons.push("supplemental_list_candidate");
  }

  const itemTagIds = new Set(candidate.item.tags.map((tag) => tag.id));
  const hasAllRequiredTags =
    candidate.requiredTagIds.length > 0 && candidate.requiredTagIds.every((tagId) => itemTagIds.has(tagId));
  if (hasAllRequiredTags) {
    score += CANDIDATE_RANKING_WEIGHTS.all_required_tags;
    reasons.push("all_required_tags");
  }

  const annotationCount = candidate.annotations.length;
  if (annotationCount > 0) {
    score += CANDIDATE_RANKING_WEIGHTS.has_annotation;
    reasons.push("has_annotation");
  }

  const noteCount = candidate.annotations.filter((annotation) => (annotation.note ?? "").trim().length > 0).length;
  if (noteCount > 0) {
    score += CANDIDATE_RANKING_WEIGHTS.has_non_empty_note;
    reasons.push("contains_user_note");
  }

  const queryMatchInNote = candidate.annotations.some((annotation) => {
    const note = (annotation.note ?? "").toLowerCase();
    return queryTerms.some((term) => note.includes(term));
  });
  if (queryMatchInNote) {
    score += CANDIDATE_RANKING_WEIGHTS.query_match_in_note;
    reasons.push("query_match_in_user_note");
  }

  if (candidate.item.is_favorite) {
    score += CANDIDATE_RANKING_WEIGHTS.favorite;
    reasons.push("favorite");
  }

  const recency = recencyContribution(candidate.item.updated_at, nowMs);
  if (recency > 0) {
    score += recency;
    reasons.push("recently_updated");
  }

  return {
    ...candidate,
    selectionScore: Number(score.toFixed(3)),
    selectionReasons: reasons,
    annotationCount,
    noteCount,
    queryMatchInNote
  };
}

export function relevanceContribution(rank: number, scannedWindow: number): number {
  if (rank <= 0) {
    return 0;
  }
  if (scannedWindow <= 1) {
    return CANDIDATE_RANKING_WEIGHTS.matter_relevance_max;
  }
  const ratio = 1 - (rank - 1) / (scannedWindow - 1);
  return Math.max(0, CANDIDATE_RANKING_WEIGHTS.matter_relevance_max * ratio);
}

export function recencyContribution(updatedAt: string, nowMs: number): number {
  const updatedMs = Date.parse(updatedAt);
  if (Number.isNaN(updatedMs) || updatedMs > nowMs) {
    return 0;
  }
  const windowMs = CANDIDATE_RANKING_WEIGHTS.recency_window_days * 24 * 60 * 60 * 1_000;
  const ageMs = nowMs - updatedMs;
  if (ageMs >= windowMs) {
    return 0;
  }
  return CANDIDATE_RANKING_WEIGHTS.recency_max * (1 - ageMs / windowMs);
}
