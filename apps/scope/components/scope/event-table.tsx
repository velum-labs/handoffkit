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
import type { StoredEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The raw event backstop: every ingested event for a session, filterable by
 * component and free text, with row click opening the event inspector. Makes
 * event types with no dedicated view (tool.execution, cursor.route, log)
 * reachable.
 */
export function EventTable({
  events,
  startedAt,
  onInspect
}: {
  events: StoredEvent[];
  startedAt: number;
  onInspect: (events: StoredEvent[]) => void;
}) {
  const [component, setComponent] = useState<string>("all");
  const [query, setQuery] = useState("");

  const components = useMemo(() => {
    const present = new Set(events.map((event) => event.component));
    return ["all", ...present];
  }, [events]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((event) => {
      if (component !== "all" && event.component !== component) return false;
      if (q.length === 0) return true;
      const haystack = [
        event.event_type,
        event.component,
        event.span_id,
        event.candidate_id ?? "",
        event.model_id ?? ""
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [events, component, query]);

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
            placeholder="Filter by type, span, model…"
            aria-label="Filter events"
            className="border-input bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-lg border pr-2.5 pl-8 text-sm outline-none focus-visible:ring-3"
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="text-muted-foreground text-sm">No matching events.</p>
      ) : (
        <ScrollArea viewportClassName="max-h-[440px]">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[72px] text-right">Offset</TableHead>
                <TableHead className="w-[120px]">Component</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Candidate / model</TableHead>
                <TableHead>Span</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((event) => (
                <TableRow
                  key={event.id}
                  className="cursor-pointer"
                  onClick={() => onInspect([event])}
                >
                  <TableCell className="mono text-muted-foreground text-right text-xs">
                    {fmtDuration(Math.max(0, event.ts - startedAt))}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <span
                        className="size-2 rounded-full"
                        style={{ background: componentColor(event.component) }}
                      />
                      {event.component}
                    </span>
                  </TableCell>
                  <TableCell className={cn("mono text-xs")}>{event.event_type}</TableCell>
                  <TableCell className="mono text-muted-foreground max-w-[200px] truncate text-xs">
                    {event.candidate_id ?? event.model_id ?? "—"}
                  </TableCell>
                  <TableCell className="mono text-muted-foreground max-w-[140px] truncate text-xs">
                    {event.span_id}
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
