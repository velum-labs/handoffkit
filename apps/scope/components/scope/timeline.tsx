import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { componentColor, fmtDuration } from "@/lib/format";
import type { StoredEvent } from "@/lib/types";

/** A compact trace waterfall: every event placed proportionally on the run's timeline. */
export function Timeline({
  events,
  startedAt,
  durationMs
}: {
  events: StoredEvent[];
  startedAt: number;
  durationMs: number;
}) {
  const span = Math.max(1, durationMs);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Timeline</CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea viewportClassName="max-h-[440px] pr-3">
          <div className="space-y-1">
            {events.map((event) => {
              const offset = Math.max(0, event.ts - startedAt);
              const left = Math.min(100, (offset / span) * 100);
              const color = componentColor(event.component);
              return (
                <div
                  key={event.id}
                  className="hover:bg-accent/50 grid grid-cols-[64px_180px_1fr] items-center gap-3 rounded-md px-2 py-1.5"
                >
                  <span className="mono text-muted-foreground text-right text-xs">
                    {fmtDuration(offset)}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
                    <span className="truncate text-xs font-medium" style={{ color }}>
                      {event.component}
                    </span>
                    <span className="text-muted-foreground mono truncate text-xs">
                      {event.event_type}
                    </span>
                  </div>
                  <div className="bg-muted/40 relative h-1.5 rounded-full">
                    <span
                      className="absolute top-0 size-1.5 -translate-x-1/2 rounded-full"
                      style={{ left: `${left}%`, background: color }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
