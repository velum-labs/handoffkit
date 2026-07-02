"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Collapsible } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * The one flat layout primitive for every page: a full-width collapsible
 * section with a heading row (title, count, folded summary, right-side meta).
 * Sections stack vertically and are separated by borders — no cards, no grids.
 */
export function Section({
  title,
  count,
  summary,
  meta,
  defaultOpen = true,
  children,
  className
}: {
  title: React.ReactNode;
  /** Small count/qualifier rendered next to the title. */
  count?: React.ReactNode;
  /** Muted one-line summary shown while the section is folded. */
  summary?: React.ReactNode;
  /** Right-aligned metadata, always visible. */
  meta?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className={cn("border-b", className)}>
      <div className="flex items-center gap-3 py-2.5">
        <Collapsible.Trigger asChild>
          <button
            type="button"
            className="group flex min-w-0 flex-1 items-center gap-2 text-left"
            aria-expanded={open}
          >
            <ChevronRight
              className={cn(
                "text-muted-foreground size-4 shrink-0 transition-transform",
                open && "rotate-90"
              )}
            />
            <span className="text-sm font-semibold tracking-tight">{title}</span>
            {count !== undefined ? (
              <span className="text-muted-foreground shrink-0 text-xs">{count}</span>
            ) : null}
            {!open && summary !== undefined ? (
              <span className="text-muted-foreground min-w-0 truncate text-xs">{summary}</span>
            ) : null}
          </button>
        </Collapsible.Trigger>
        {meta !== undefined ? <div className="flex shrink-0 items-center gap-2">{meta}</div> : null}
      </div>
      <Collapsible.Content className="pb-5 pl-6">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}

/**
 * A lightweight inline fold for secondary content inside a section (prompts,
 * payloads, long step lists). Collapsed by default.
 */
export function Fold({
  label,
  count,
  defaultOpen = false,
  children,
  className
}: {
  label: React.ReactNode;
  count?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className={className}>
      <Collapsible.Trigger asChild>
        <button
          type="button"
          aria-expanded={open}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 py-1 text-xs transition-colors"
        >
          <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
          {label}
          {count !== undefined ? <span className="opacity-70">{count}</span> : null}
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content className="pt-1 pl-4.5">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}

/**
 * A collapsible row for repeated entities (candidates, judge steps,
 * environments): a rich header line that expands into detail. Rows are flat;
 * stack them inside a `divide-y` container.
 */
export function CollapsibleRow({
  header,
  meta,
  defaultOpen = false,
  children,
  className
}: {
  header: React.ReactNode;
  /** Right-aligned header metadata, always visible. */
  meta?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className={cn("py-1", className)}>
      <div className="flex items-center gap-3">
        <Collapsible.Trigger asChild>
          <button
            type="button"
            aria-expanded={open}
            className="hover:bg-accent/40 -mx-1 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1.5 text-left transition-colors"
          >
            <ChevronRight
              className={cn(
                "text-muted-foreground size-3.5 shrink-0 transition-transform",
                open && "rotate-90"
              )}
            />
            <span className="flex min-w-0 flex-1 items-center gap-2">{header}</span>
          </button>
        </Collapsible.Trigger>
        {meta !== undefined ? (
          <div className="text-muted-foreground flex shrink-0 items-center gap-3 text-xs">{meta}</div>
        ) : null}
      </div>
      <Collapsible.Content className="space-y-3 pt-1 pb-3 pl-5.5">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}
