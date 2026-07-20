import type { MatterAnnotation } from "../matter/schemas.js";

export interface CandidateExcerpt {
  excerpt_id: string;
  heading_path: string[];
  start_char: number;
  end_char: number;
  score: number;
  text: string;
}

export interface BudgetSourceInput {
  itemId: string;
  annotations: MatterAnnotation[];
  excerpts: CandidateExcerpt[];
  completeMarkdownCharCount: number;
}

export interface BudgetAnnotation {
  id: string;
  text: string;
  note: string | null;
  updated_at: string;
}

export interface BudgetSourceAllocation {
  itemId: string;
  annotations: BudgetAnnotation[];
  source_excerpts: CandidateExcerpt[];
  omitted_annotation_ids: string[];
  omitted_excerpt_ids: string[];
  markdown_was_truncated_for_bundle: boolean;
  complete_markdown_char_count: number;
  returned_annotation_chars: number;
  returned_source_excerpt_chars: number;
}

export interface BudgetAllocation {
  sources: BudgetSourceAllocation[];
  returned_annotation_chars: number;
  returned_source_excerpt_chars: number;
  returned_total_chars: number;
  budget_exhausted: boolean;
  warnings: string[];
}

export function allocateBudget(options: {
  sources: BudgetSourceInput[];
  maxTotalChars: number;
  maxCharsPerItem: number;
  minimumExcerptChars?: number;
}): BudgetAllocation {
  const minimumExcerptChars = options.minimumExcerptChars ?? 500;
  const allocations = options.sources.map((source) => ({
    itemId: source.itemId,
    annotations: [] as BudgetAnnotation[],
    source_excerpts: [] as CandidateExcerpt[],
    omitted_annotation_ids: [] as string[],
    omitted_excerpt_ids: [] as string[],
    markdown_was_truncated_for_bundle: false,
    complete_markdown_char_count: source.completeMarkdownCharCount,
    returned_annotation_chars: 0,
    returned_source_excerpt_chars: 0,
    itemRemaining: options.maxCharsPerItem,
    nextExcerptIndex: 0,
    source
  }));

  let totalRemaining = options.maxTotalChars;

  for (const allocation of allocations) {
    for (const annotation of allocation.source.annotations) {
      const chars = annotationChars(annotation);
      if (chars <= allocation.itemRemaining && chars <= totalRemaining) {
        allocation.annotations.push(annotationOutput(annotation));
        allocation.returned_annotation_chars += chars;
        allocation.itemRemaining -= chars;
        totalRemaining -= chars;
      } else {
        allocation.omitted_annotation_ids.push(annotation.id);
      }
    }
  }

  for (const allocation of allocations) {
    if (allocation.source.excerpts.length === 0 || allocation.itemRemaining <= 0 || totalRemaining <= 0) {
      allocation.omitted_excerpt_ids.push(...allocation.source.excerpts.map((excerpt) => excerpt.excerpt_id));
      continue;
    }
    const excerpt = allocation.source.excerpts[0];
    const desired = Math.min(excerpt.text.length, minimumExcerptChars);
    const available = Math.min(allocation.itemRemaining, totalRemaining);
    if (available <= 0) {
      allocation.omitted_excerpt_ids.push(excerpt.excerpt_id);
      continue;
    }
    const included = takeExcerpt(excerpt, Math.min(desired, available));
    allocation.source_excerpts.push(included);
    allocation.returned_source_excerpt_chars += included.text.length;
    allocation.itemRemaining -= included.text.length;
    totalRemaining -= included.text.length;
    allocation.nextExcerptIndex = 1;
    if (included.text.length < excerpt.text.length) {
      allocation.markdown_was_truncated_for_bundle = true;
    }
  }

  for (const allocation of allocations) {
    while (
      allocation.nextExcerptIndex < allocation.source.excerpts.length &&
      allocation.itemRemaining > 0 &&
      totalRemaining > 0
    ) {
      const excerpt = allocation.source.excerpts[allocation.nextExcerptIndex];
      const available = Math.min(allocation.itemRemaining, totalRemaining);
      const included = takeExcerpt(excerpt, available);
      allocation.source_excerpts.push(included);
      allocation.returned_source_excerpt_chars += included.text.length;
      allocation.itemRemaining -= included.text.length;
      totalRemaining -= included.text.length;
      allocation.nextExcerptIndex += 1;
      if (included.text.length < excerpt.text.length) {
        allocation.markdown_was_truncated_for_bundle = true;
        break;
      }
    }

    for (let i = allocation.nextExcerptIndex; i < allocation.source.excerpts.length; i += 1) {
      allocation.omitted_excerpt_ids.push(allocation.source.excerpts[i].excerpt_id);
    }
    if (allocation.omitted_excerpt_ids.length > 0) {
      allocation.markdown_was_truncated_for_bundle = true;
    }
  }

  const publicAllocations = allocations.map((allocation) => ({
    itemId: allocation.itemId,
    annotations: allocation.annotations,
    source_excerpts: allocation.source_excerpts,
    omitted_annotation_ids: allocation.omitted_annotation_ids,
    omitted_excerpt_ids: allocation.omitted_excerpt_ids,
    markdown_was_truncated_for_bundle: allocation.markdown_was_truncated_for_bundle,
    complete_markdown_char_count: allocation.complete_markdown_char_count,
    returned_annotation_chars: allocation.returned_annotation_chars,
    returned_source_excerpt_chars: allocation.returned_source_excerpt_chars
  }));
  const returned_annotation_chars = publicAllocations.reduce((sum, source) => sum + source.returned_annotation_chars, 0);
  const returned_source_excerpt_chars = publicAllocations.reduce(
    (sum, source) => sum + source.returned_source_excerpt_chars,
    0
  );
  const warnings = publicAllocations.flatMap((source) => {
    const entries: string[] = [];
    if (source.omitted_annotation_ids.length > 0) {
      entries.push(`Omitted annotations for ${source.itemId}: ${source.omitted_annotation_ids.join(", ")}`);
    }
    if (source.omitted_excerpt_ids.length > 0) {
      entries.push(`Omitted excerpts for ${source.itemId}: ${source.omitted_excerpt_ids.join(", ")}`);
    }
    return entries;
  });

  return {
    sources: publicAllocations,
    returned_annotation_chars,
    returned_source_excerpt_chars,
    returned_total_chars: returned_annotation_chars + returned_source_excerpt_chars,
    budget_exhausted: totalRemaining <= 0,
    warnings
  };
}

function annotationChars(annotation: MatterAnnotation): number {
  return annotation.text.length + (annotation.note ?? "").length;
}

function annotationOutput(annotation: MatterAnnotation): BudgetAnnotation {
  return {
    id: annotation.id,
    text: annotation.text,
    note: annotation.note ?? null,
    updated_at: annotation.updated_at
  };
}

function takeExcerpt(excerpt: CandidateExcerpt, maxChars: number): CandidateExcerpt {
  const text = excerpt.text.length <= maxChars ? excerpt.text : excerpt.text.slice(0, maxChars);
  return {
    ...excerpt,
    end_char: excerpt.start_char + text.length,
    text
  };
}
