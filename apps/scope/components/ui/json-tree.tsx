"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A small, dependency-free collapsible JSON tree styled with the app's tokens.
 * Objects/arrays render as expandable rows; leaves render typed, color-coded
 * values. Vendored shadcn-style (you own the code) rather than pulling a dep.
 */

const INDENT_PX = 14;
const CHEVRON_PX = 16;

type Entry = { key: string; value: unknown };

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

function entriesOf(value: Record<string, unknown> | unknown[]): Entry[] {
  if (Array.isArray(value)) return value.map((item, index) => ({ key: String(index), value: item }));
  return Object.entries(value).map(([key, val]) => ({ key, value: val }));
}

function ValueSpan({ value }: { value: unknown }) {
  if (value === null) return <span className="text-muted-foreground italic">null</span>;
  switch (typeof value) {
    case "string":
      return <span className="text-(--json-string) break-all">&quot;{value}&quot;</span>;
    case "number":
    case "bigint":
      return <span className="text-(--json-number)">{String(value)}</span>;
    case "boolean":
      return <span className="text-(--json-boolean)">{String(value)}</span>;
    case "undefined":
      return <span className="text-muted-foreground italic">undefined</span>;
    default:
      return <span className="text-muted-foreground break-all">{String(value)}</span>;
  }
}

function JsonNode({
  name,
  value,
  depth,
  defaultExpandedDepth
}: {
  name?: string;
  value: unknown;
  depth: number;
  defaultExpandedDepth: number;
}) {
  const container = isContainer(value);
  const entries = container ? entriesOf(value) : [];
  const expandable = container && entries.length > 0;
  const [open, setOpen] = useState(depth < defaultExpandedDepth);

  if (!expandable) {
    const empty = container ? (Array.isArray(value) ? "[]" : "{}") : undefined;
    return (
      <div
        className="flex items-start gap-1 px-1"
        style={{ paddingLeft: depth * INDENT_PX + CHEVRON_PX }}
      >
        {name !== undefined ? (
          <span className="shrink-0">
            <span className="text-(--json-key)">{name}</span>
            <span className="text-muted-foreground">: </span>
          </span>
        ) : null}
        {empty !== undefined ? <span className="text-muted-foreground">{empty}</span> : <ValueSpan value={value} />}
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const summary = isArray ? `[${entries.length}]` : `{${entries.length}}`;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="hover:bg-accent/50 flex w-full items-center gap-1 rounded px-1 py-0.5 text-left"
        style={{ paddingLeft: depth * INDENT_PX }}
      >
        <ChevronRight
          className={cn("text-muted-foreground size-3 shrink-0 transition-transform", open && "rotate-90")}
        />
        {name !== undefined ? <span className="text-(--json-key)">{name}</span> : null}
        <span className="text-muted-foreground">{summary}</span>
      </button>
      {open ? (
        <div>
          {entries.map((entry) => (
            <JsonNode
              key={entry.key}
              name={entry.key}
              value={entry.value}
              depth={depth + 1}
              defaultExpandedDepth={defaultExpandedDepth}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function JsonTree({
  data,
  defaultExpandedDepth = 1,
  rootName
}: {
  data: unknown;
  defaultExpandedDepth?: number;
  rootName?: string;
}) {
  return (
    <div className="mono text-xs leading-relaxed">
      <JsonNode name={rootName} value={data} depth={0} defaultExpandedDepth={defaultExpandedDepth} />
    </div>
  );
}
