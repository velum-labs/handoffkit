"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { componentColor, fmtDuration } from "@/lib/format";
import { candidateIdOf, modelIdOf } from "@/lib/types";
import type { StoredSpan } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The raw span backstop: every ingested span for a session, filterable by
 * component and free text, with row click opening the span inspector. Makes
 * span names with no dedicated view (fusion.tool.execution, fusion.cost, …)
 * reachable.
 */
export function EventTable({
  spans,
  startedAt,
  onInspect
}: {
  spans: StoredSpan[];
  startedAt: number;
  onInspect: (spans: StoredSpan[]) => void;
}) {
  const [component, setComponent] = useState<string>("all");
  const [query, setQuery] = useState("");

  const components = useMemo(() => {
    const present = new Set(spans.map((span) => span.component));
    return ["all", ...present];
  }, [spans]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return spans.filter((span) => {
      if (component !== "all" && span.component !== component) return false;
      if (q.length === 0) return true;
      const haystack = [
        span.name,
        span.component,
        span.span_id,
        candidateIdOf(span) ?? "",
        modelIdOf(span) ?? ""
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [spans, component, query]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {components.map((name) => (
            <Button
              key={name}
              variant={component === name ? "secondary" : "ghost"}
              size="xs"
              onClick={() => setComponent(name)}
            >
              {name !== "all" ? (
                <span className="size-1.5 rounded-full" style={{ background: componentColor(name) }} />
              ) : null}
              {name}
            </Button>
          ))}
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name, span, model…"
            aria-label="Filter spans"
            className="border-input bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-lg border pr-2.5 pl-8 text-sm outline-none focus-visible:ring-3"
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="text-muted-foreground text-sm">No matching spans.</p>
      ) : (
        <ScrollArea viewportClassName="max-h-[440px]">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[72px] text-right">Offset</TableHead>
                <TableHead className="w-[120px]">Component</TableHead>
                <TableHead>Span</TableHead>
                <TableHead>Candidate / model</TableHead>
                <TableHead className="w-[72px] text-right">Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((span) => (
                <TableRow
                  key={span.id}
                  className="cursor-pointer"
                  onClick={() => onInspect([span])}
                >
                  <TableCell className="mono text-muted-foreground text-right text-xs">
                    {fmtDuration(Math.max(0, span.start_ms - startedAt))}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <span
                        className="size-2 rounded-full"
                        style={{ background: componentColor(span.component) }}
                      />
                      {span.component}
                    </span>
                  </TableCell>
                  <TableCell className={cn("mono text-xs")}>{span.name}</TableCell>
                  <TableCell className="mono text-muted-foreground max-w-[200px] truncate text-xs">
                    {candidateIdOf(span) ?? modelIdOf(span) ?? "—"}
                  </TableCell>
                  <TableCell className="mono text-muted-foreground text-right text-xs">
                    {span.end_ms - span.start_ms > 0 ? fmtDuration(span.end_ms - span.start_ms) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      )}
    </div>
  );
}
