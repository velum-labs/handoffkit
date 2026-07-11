"use client";

import { X } from "lucide-react";
import { Dialog } from "radix-ui";

import { FieldList } from "@/components/scope/field-list";
import { JsonView } from "@/components/scope/json-view";
import { Button } from "@/components/ui/button";
import { componentColor, fmtDateTime, fmtDuration } from "@/lib/format";
import { candidateIdOf, modelIdOf, signalKey } from "@/lib/types";
import type { StoredSignal } from "@/lib/types";

function tsOf(signal: StoredSignal): number {
  return signal.kind === "span" ? signal.start_ms : signal.ts_ms;
}

/**
 * A slide-over inspector for spans and events: full metadata plus the raw
 * attributes. The escape hatch that makes every signal —
 * fusion.tool.execution, fusion.cost, narration beats, … — fully
 * inspectable.
 */
export function EventInspector({
  signals,
  startedAt,
  onClose
}: {
  signals: StoredSignal[] | undefined;
  /** Session start, for showing each signal's relative offset. */
  startedAt?: number;
  onClose: () => void;
}) {
  const open = signals !== undefined && signals.length > 0;
  const first = signals?.[0];
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="data-[state=open]:animate-in data-[state=open]:fade-in-0 fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="bg-background data-[state=open]:animate-in data-[state=open]:slide-in-from-right fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l shadow-lg outline-none">
          <Dialog.Description className="sr-only">
            Metadata and raw attributes for the selected signals.
          </Dialog.Description>
          {first !== undefined && signals !== undefined ? (
            <>
              <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
                <Dialog.Title asChild>
                  <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: componentColor(first.component) }}
                    />
                    <span className="mono truncate">{first.name}</span>
                    <span className="text-muted-foreground font-normal">{first.component}</span>
                    <span className="text-muted-foreground border-border rounded border px-1 text-[10px] font-normal">
                      {first.kind}
                    </span>
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
                    ...(first.kind === "span"
                      ? [
                          { label: "Span", value: first.span_id, mono: true },
                          { label: "Parent span", value: first.parent_span_id, mono: true }
                        ]
                      : [{ label: "Owning span", value: first.span_id, mono: true }]),
                    { label: "Candidate", value: candidateIdOf(first), mono: true },
                    { label: "Model", value: modelIdOf(first), mono: true },
                    { label: "Service", value: first.service, mono: true },
                    {
                      label: "Status",
                      value: first.kind === "span" && first.status !== "unset" ? first.status : undefined,
                      mono: true
                    }
                  ]}
                />
                {signals.map((signal) => (
                  <div key={signalKey(signal)} className="space-y-2">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="mono text-sm font-medium">{signal.name}</span>
                      <span className="text-muted-foreground mono text-xs">
                        {fmtDateTime(tsOf(signal))}
                        {startedAt !== undefined
                          ? ` · +${fmtDuration(Math.max(0, tsOf(signal) - startedAt))}`
                          : ""}
                        {signal.kind === "span" && signal.end_ms - signal.start_ms > 0
                          ? ` · ${fmtDuration(signal.end_ms - signal.start_ms)}`
                          : ""}
                      </span>
                    </div>
                    {signal.kind === "span" && signal.status_message !== undefined ? (
                      <p className="text-destructive mono text-xs">{signal.status_message}</p>
                    ) : null}
                    {Object.keys(signal.attributes).length > 0 ? (
                      <JsonView data={signal.attributes} maxHeight="50vh" />
                    ) : (
                      <p className="text-muted-foreground text-sm">
                        This {signal.kind} carries no attributes.
                      </p>
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
