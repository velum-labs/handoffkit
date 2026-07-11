"use client";

import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { componentColor, fmtDuration } from "@/lib/format";
import { candidateIdOf, isMarker, modelIdOf, TRACE_COMPONENTS } from "@/lib/types";
import type { StoredSpan } from "@/lib/types";
import { cn } from "@/lib/utils";

type Track = {
  key: string;
  spanId: string;
  parentSpanId?: string;
  component: string;
  label: string;
  detail?: string;
  startTs: number;
  endTs: number;
  isPoint: boolean;
  depth: number;
  /** The underlying span, for inspection. */
  spans: StoredSpan[];
};

// Grid column template + horizontal padding shared by the ruler and every row,
// so the bar column lines up exactly with the gridline/cursor overlay. The
// label column is sized to fit the longest span names (fusion.candidate,
// fusion.judge.thinking, …) plus a candidate id without truncating.
const GRID = "grid grid-cols-[56px_260px_1fr_56px] gap-3 px-2";
const BAR_COL_LEFT_PX = 8 + 56 + 12 + 260 + 12; // px-2 + col + gap + col + gap
const BAR_COL_RIGHT_PX = 8 + 56 + 12; // px-2 + last col + gap
const TICKS = [0, 0.25, 0.5, 0.75, 1];

function detailOf(span: StoredSpan): string | undefined {
  return candidateIdOf(span) ?? modelIdOf(span) ?? undefined;
}

/** Walk parent_span_id chains to compute an indentation depth per span. */
function buildDepths(spans: StoredSpan[]): Map<string, number> {
  const parent = new Map<string, string | undefined>();
  for (const span of spans) {
    if (!parent.has(span.span_id)) parent.set(span.span_id, span.parent_span_id);
  }
  const depths = new Map<string, number>();
  const depthOf = (spanId: string, seen: Set<string>): number => {
    const cached = depths.get(spanId);
    if (cached !== undefined) return cached;
    const parentId = parent.get(spanId);
    if (parentId === undefined || !parent.has(parentId) || seen.has(spanId)) {
      depths.set(spanId, 0);
      return 0;
    }
    seen.add(spanId);
    const depth = depthOf(parentId, seen) + 1;
    depths.set(spanId, depth);
    return depth;
  };
  for (const spanId of parent.keys()) depthOf(spanId, new Set());
  return depths;
}

/** Spans are already the waterfall: duration bars for units, markers for signals. */
function buildTracks(spans: StoredSpan[]): Track[] {
  const depths = buildDepths(spans);
  return spans
    .map(
      (span): Track => ({
        key: `span-${span.id}`,
        spanId: span.span_id,
        parentSpanId: span.parent_span_id,
        component: span.component,
        label: span.name,
        detail: detailOf(span),
        startTs: span.start_ms,
        endTs: span.end_ms,
        isPoint: isMarker(span),
        depth: depths.get(span.span_id) ?? 0,
        spans: [span]
      })
    )
    .sort((a, b) => a.startTs - b.startTs || a.endTs - b.endTs);
}

function Legend({ components }: { components: string[] }) {
  if (components.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {components.map((component) => (
        <span key={component} className="text-muted-foreground inline-flex items-center gap-1.5 text-[11px]">
          <span className="size-2 rounded-full" style={{ background: componentColor(component) }} />
          {component}
        </span>
      ))}
    </div>
  );
}

/**
 * The trace waterfall: unit spans render as bars, markers as points. Every
 * row is clickable and opens the span inspector.
 */
export function Timeline({
  spans,
  startedAt,
  durationMs,
  live,
  onInspect
}: {
  spans: StoredSpan[];
  startedAt: number;
  durationMs: number;
  /** True while the session is still running (draws the live cursor). */
  live?: boolean;
  onInspect?: (spans: StoredSpan[]) => void;
}) {
  const span = Math.max(1, durationMs);
  const tracks = useMemo(() => buildTracks(spans), [spans]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const { parentOf, collapsible } = useMemo(() => {
    const parent = new Map<string, string | undefined>();
    const childCount = new Map<string, number>();
    for (const track of tracks) {
      parent.set(track.spanId, track.parentSpanId);
      if (track.parentSpanId !== undefined) {
        childCount.set(track.parentSpanId, (childCount.get(track.parentSpanId) ?? 0) + 1);
      }
    }
    const hasChildren = new Set<string>();
    for (const [spanId, count] of childCount) if (count > 0) hasChildren.add(spanId);
    return { parentOf: parent, collapsible: hasChildren };
  }, [tracks]);

  const legendComponents = useMemo(() => {
    const present = new Set(tracks.map((track) => track.component));
    return TRACE_COMPONENTS.filter((component) => present.has(component));
  }, [tracks]);

  const visibleTracks = useMemo(() => {
    if (collapsed.size === 0) return tracks;
    return tracks.filter((track) => {
      let parentId = track.parentSpanId;
      const seen = new Set<string>();
      while (parentId !== undefined && !seen.has(parentId)) {
        if (collapsed.has(parentId)) return false;
        seen.add(parentId);
        parentId = parentOf.get(parentId);
      }
      return true;
    });
  }, [tracks, collapsed, parentOf]);

  const toggle = (spanId: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(spanId)) next.delete(spanId);
      else next.add(spanId);
      return next;
    });
  };

  const gridlineStyle = {
    backgroundImage: "linear-gradient(to right, var(--border) 1px, transparent 1px)",
    backgroundSize: "25% 100%"
  };

  return (
    <div>
      <Legend components={legendComponents} />

      {/* Ruler */}
      <div className={cn(GRID, "mt-3 mb-1 items-end")}>
        <span />
        <span />
        <div className="relative h-4">
          {TICKS.map((frac) => (
            <span
              key={frac}
              className="text-muted-foreground mono absolute bottom-0 text-[10px]"
              style={{
                left: `${frac * 100}%`,
                transform: frac === 0 ? "none" : frac === 1 ? "translateX(-100%)" : "translateX(-50%)"
              }}
            >
              {fmtDuration(span * frac)}
            </span>
          ))}
        </div>
        <span />
      </div>

      <ScrollArea viewportClassName="max-h-[440px]">
        <div className="relative">
          {/* Gridline + live-cursor overlay aligned to the bar column */}
          <div
            className="pointer-events-none absolute inset-y-0 z-0 opacity-40"
            style={{ left: BAR_COL_LEFT_PX, right: BAR_COL_RIGHT_PX, ...gridlineStyle }}
          />
          {live === true ? (
            <div
              className="bg-(--status-success)/60 pointer-events-none absolute inset-y-0 z-0 w-px"
              style={{ right: BAR_COL_RIGHT_PX }}
            />
          ) : null}

          <div className="relative z-10 space-y-1">
            {visibleTracks.map((track) => {
              const offset = Math.max(0, track.startTs - startedAt);
              const left = Math.min(100, (offset / span) * 100);
              const rawWidth = ((track.endTs - track.startTs) / span) * 100;
              const width = Math.max(1, Math.min(100 - left, rawWidth));
              const color = componentColor(track.component);
              const dur = track.endTs - track.startTs;
              const canCollapse = collapsible.has(track.spanId);
              const isOpen = !collapsed.has(track.spanId);
              const durLabel = track.isPoint ? "" : fmtDuration(dur);
              return (
                <div
                  key={track.key}
                  className={cn(
                    GRID,
                    "hover:bg-accent/50 items-center rounded-md py-1",
                    onInspect !== undefined && "cursor-pointer"
                  )}
                  onClick={onInspect !== undefined ? () => onInspect(track.spans) : undefined}
                >
                  <span className="mono text-muted-foreground text-right text-xs">{fmtDuration(offset)}</span>
                  <div
                    className="flex items-center gap-1"
                    style={{ paddingLeft: `${Math.min(track.depth, 5) * 12}px` }}
                  >
                    {canCollapse ? (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          toggle(track.spanId);
                        }}
                        aria-expanded={isOpen}
                        aria-label={isOpen ? "Collapse span" : "Expand span"}
                        className="hover:text-foreground text-muted-foreground -ml-0.5 shrink-0"
                      >
                        <ChevronRight className={cn("size-3 transition-transform", isOpen && "rotate-90")} />
                      </button>
                    ) : (
                      <span className="inline-block size-3 shrink-0" />
                    )}
                    <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
                    <span className="truncate text-xs font-medium" style={{ color }} title={track.label}>
                      {track.label}
                    </span>
                    {track.detail ? (
                      <span
                        className="text-muted-foreground mono truncate text-[11px]"
                        title={track.detail}
                      >
                        {track.detail}
                      </span>
                    ) : null}
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="relative flex h-4 items-center">
                        {track.isPoint ? (
                          <span
                            className="absolute size-2 -translate-x-1/2 rounded-full"
                            style={{ left: `${left}%`, background: color }}
                          />
                        ) : (
                          <span
                            className="absolute h-1.5 rounded-full"
                            style={{
                              left: `${left}%`,
                              width: `${width}%`,
                              background: color,
                              opacity: 0.85
                            }}
                          />
                        )}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <div className="space-y-0.5">
                        {/* Plain text plus a colored dot: the theme-resolved
                            component color is not readable on the inverted
                            tooltip background. */}
                        <div className="flex items-center gap-1.5 font-medium">
                          <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
                          {track.label}
                          <span className="text-background/70 font-normal">{track.component}</span>
                        </div>
                        {track.detail ? <div className="mono">{track.detail}</div> : null}
                        <div className="mono">
                          start {fmtDuration(offset)}
                          {track.isPoint ? "" : ` · ${fmtDuration(dur)}`}
                        </div>
                        <div className="text-background/70">click to inspect</div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                  <span className="mono text-muted-foreground text-right text-[11px]">{durLabel}</span>
                </div>
              );
            })}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
