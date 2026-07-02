"use client";

import { X } from "lucide-react";
import { Dialog } from "radix-ui";

import { FieldList } from "@/components/scope/field-list";
import { JsonView } from "@/components/scope/json-view";
import { Button } from "@/components/ui/button";
import { componentColor, fmtDateTime, fmtDuration } from "@/lib/format";
import type { StoredEvent } from "@/lib/types";

/**
 * A slide-over inspector for trace events: full metadata plus the raw payload.
 * Accepts one event (raw event table) or a span's started/finished pair
 * (timeline). The escape hatch that makes every event type — tool.execution,
 * cursor.route, log, … — fully inspectable.
 */
export function EventInspector({
  events,
  startedAt,
  onClose
}: {
  events: StoredEvent[] | undefined;
  /** Session start, for showing each event's relative offset. */
  startedAt?: number;
  onClose: () => void;
}) {
  const open = events !== undefined && events.length > 0;
  const first = events?.[0];
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="data-[state=open]:animate-in data-[state=open]:fade-in-0 fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content
          className="bg-background data-[state=open]:animate-in data-[state=open]:slide-in-from-right fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l shadow-lg outline-none"
          aria-describedby={undefined}
        >
          {first !== undefined && events !== undefined ? (
            <>
              <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
                <Dialog.Title asChild>
                  <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: componentColor(first.component) }}
                    />
                    <span className="mono truncate">
                      {events.length > 1
                        ? first.event_type.replace(/\.(started|finished)$/, "")
                        : first.event_type}
                    </span>
                    <span className="text-muted-foreground font-normal">{first.component}</span>
                  </h2>
                </Dialog.Title>
                <Dialog.Close asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Close inspector">
                    <X />
                  </Button>
                </Dialog.Close>
              </div>
              <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
                <FieldList
                  fields={[
                    { label: "Span", value: first.span_id, mono: true },
                    { label: "Parent span", value: first.parent_span_id, mono: true },
                    { label: "Candidate", value: first.candidate_id, mono: true },
                    { label: "Model", value: first.model_id, mono: true },
                    { label: "Session", value: first.session_id, mono: true },
                    { label: "Schema", value: first.schema_version, mono: true }
                  ]}
                />
                {events.map((event) => (
                  <div key={event.id} className="space-y-2">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="mono text-sm font-medium">{event.event_type}</span>
                      <span className="text-muted-foreground mono text-xs">
                        {fmtDateTime(event.ts)}
                        {startedAt !== undefined
                          ? ` · +${fmtDuration(Math.max(0, event.ts - startedAt))}`
                          : ""}
                        {` · seq ${event.seq}`}
                      </span>
                    </div>
                    {event.payload !== undefined ? (
                      <JsonView data={event.payload} maxHeight="50vh" />
                    ) : (
                      <p className="text-muted-foreground text-sm">This event carries no payload.</p>
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
