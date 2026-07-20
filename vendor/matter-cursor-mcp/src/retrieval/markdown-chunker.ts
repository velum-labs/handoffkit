export interface MarkdownChunk {
  index: number;
  heading_path: string[];
  start_char: number;
  end_char: number;
  text: string;
}

export interface ChunkMarkdownOptions {
  targetChars?: number;
  overlapChars?: number;
}

interface Heading {
  level: number;
  title: string;
  offset: number;
}

interface Range {
  start: number;
  end: number;
}

export function chunkMarkdown(markdown: string, options: ChunkMarkdownOptions = {}): MarkdownChunk[] {
  const targetChars = options.targetChars ?? 2_500;
  const overlapChars = options.overlapChars ?? 250;
  if (markdown.length === 0) {
    return [];
  }

  const headings = findHeadings(markdown);
  const codeRanges = findFencedCodeRanges(markdown);
  const chunks: MarkdownChunk[] = [];
  let start = 0;

  while (start < markdown.length) {
    start = adjustStartOutsideCodeFence(start, codeRanges);
    let end = Math.min(markdown.length, start + targetChars);
    if (end < markdown.length) {
      end = preferBoundary(markdown, start, end);
      end = adjustEndOutsideCodeFence(end, codeRanges);
    }
    if (end <= start) {
      end = Math.min(markdown.length, start + targetChars);
    }

    chunks.push({
      index: chunks.length,
      heading_path: headingPathAt(headings, start),
      start_char: start,
      end_char: end,
      text: markdown.slice(start, end)
    });

    if (end >= markdown.length) {
      break;
    }
    start = Math.max(0, end - overlapChars);
  }

  return chunks;
}

function findHeadings(markdown: string): Heading[] {
  const headings: Heading[] = [];
  const headingPattern = /^(#{1,6})\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(markdown)) !== null) {
    headings.push({ level: match[1].length, title: match[2].trim(), offset: match.index });
  }
  return headings;
}

function headingPathAt(headings: Heading[], offset: number): string[] {
  const path: string[] = [];
  for (const heading of headings) {
    if (heading.offset > offset) {
      break;
    }
    path.splice(heading.level - 1);
    path[heading.level - 1] = heading.title;
  }
  return path.filter(Boolean);
}

function findFencedCodeRanges(markdown: string): Range[] {
  const ranges: Range[] = [];
  const fencePattern = /^```.*$/gm;
  let openStart: number | null = null;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(markdown)) !== null) {
    const lineEnd = markdown.indexOf("\n", match.index);
    const fenceEnd = lineEnd === -1 ? markdown.length : lineEnd + 1;
    if (openStart === null) {
      openStart = match.index;
    } else {
      ranges.push({ start: openStart, end: fenceEnd });
      openStart = null;
    }
  }
  if (openStart !== null) {
    ranges.push({ start: openStart, end: markdown.length });
  }
  return ranges;
}

function preferBoundary(markdown: string, start: number, desiredEnd: number): number {
  const min = Math.max(start + 1, desiredEnd - 400);
  const max = Math.min(markdown.length, desiredEnd + 400);
  const window = markdown.slice(min, max);
  const paragraphBreak = window.lastIndexOf("\n\n");
  if (paragraphBreak >= 0) {
    return min + paragraphBreak + 2;
  }
  const newline = window.lastIndexOf("\n");
  if (newline >= 0) {
    return min + newline + 1;
  }
  return desiredEnd;
}

function adjustEndOutsideCodeFence(end: number, ranges: Range[]): number {
  const range = ranges.find((candidate) => end > candidate.start && end < candidate.end);
  return range ? range.end : end;
}

function adjustStartOutsideCodeFence(start: number, ranges: Range[]): number {
  const range = ranges.find((candidate) => start > candidate.start && start < candidate.end);
  return range ? range.end : start;
}
