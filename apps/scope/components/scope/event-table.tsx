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
import { candidateIdOf, modelIdOf, signalKey } from "@/lib/types";
import type { StoredEvent, StoredSignal, StoredSpan } from "@/lib/types";
import { cn } from "@/lib/utils";

function tsOf(signal: StoredSignal): number {
  return signal.kind === "span" ? signal.start_ms : signal.ts_ms;
}

/**
 * The raw signal backstop: every ingested span and event for a session,
 * filterable by component and free text, with row click opening the
 * inspector. Makes signal names with no dedicated view
 * (fusion.tool.execution, fusion.cost, …) reachable.
 */
export function EventTable({
  spans,
  events = [],
  startedAt,
  onInspect
}: {
  spans: StoredSpan[];
  events?: StoredEvent[];
  startedAt: number;
  onInspect: (signals: StoredSignal[]) => void;
}) {
  const [component, setComponent] = useState<string>("all");
  const [query, setQuery] = useState("");

  const signals = useMemo(() => {
    const merged: StoredSignal[] = [
      ...spans.map((span): StoredSignal => ({ kind: "span", ...span })),
      ...events.map((event): StoredSignal => ({ kind: "event", ...event }))
    ];
    return merged.sort((a, b) => tsOf(a) - tsOf(b));
  }, [spans, events]);

  const components = useMemo(() => {
    const present = new Set(signals.map((signal) => signal.component));
    return ["all", ...present];
  }, [signals]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return signals.filter((signal) => {
      if (component !== "all" && signal.component !== component) return false;
      if (q.length === 0) return true;
      const haystack = [
        signal.name,
        signal.kind,
        signal.component,
        signal.kind === "span" ? signal.span_id : (signal.span_id ?? ""),
        candidateIdOf(signal) ?? "",
        modelIdOf(signal) ?? ""
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [signals, component, query]);

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
        <p className="text-muted-foreground text-sm">No matching signals.</p>
      ) : (
        <ScrollArea viewportClassName="max-h-[440px]">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[72px] text-right">Offset</TableHead>
                <TableHead className="w-[56px]">Kind</TableHead>
                <TableHead className="w-[120px]">Component</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Candidate / model</TableHead>
                <TableHead className="w-[72px] text-right">Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((signal) => (
                <TableRow
                  key={signalKey(signal)}
                  className="cursor-pointer"
                  onClick={() => onInspect([signal])}
                >
                  <TableCell className="mono text-muted-foreground text-right text-xs">
                    {fmtDuration(Math.max(0, tsOf(signal) - startedAt))}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{signal.kind}</TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <span
                        className="size-2 rounded-full"
                        style={{ background: componentColor(signal.component) }}
                      />
                      {signal.component}
                    </span>
                  </TableCell>
                  <TableCell className={cn("mono text-xs")}>{signal.name}</TableCell>
                  <TableCell className="mono text-muted-foreground max-w-[200px] truncate text-xs">
                    {candidateIdOf(signal) ?? modelIdOf(signal) ?? "—"}
                  </TableCell>
                  <TableCell className="mono text-muted-foreground text-right text-xs">
                    {signal.kind === "span" ? fmtDuration(signal.end_ms - signal.start_ms) : "—"}
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
