"use client";

import { useState } from "react";

import { CopyButton } from "@/components/scope/copy-button";
import { Button } from "@/components/ui/button";
import { JsonTree } from "@/components/ui/json-tree";
import { cn } from "@/lib/utils";

/**
 * A JSON payload viewer: a collapsible tree by default with a Tree/Raw toggle
 * and a copy button. Falls back to a plain block for non-object primitives.
 */

function stringify(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

export function JsonView({
  data,
  maxHeight = "300px",
  defaultView = "tree"
}: {
  data: unknown;
  maxHeight?: string;
  defaultView?: "tree" | "raw";
}) {
  const [view, setView] = useState<"tree" | "raw">(defaultView);
  const raw = stringify(data);
  const isContainer = typeof data === "object" && data !== null;

  if (!isContainer) {
    return (
      <div className="group/code relative">
        <CopyButton
          value={raw}
          className="absolute top-1.5 right-1.5 z-10 opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100"
        />
        <pre className="mono text-xs leading-relaxed">{raw}</pre>
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <div className="flex items-center justify-between gap-2 border-b px-2 py-1">
        <div className="flex items-center gap-0.5">
          <Button
            type="button"
            variant={view === "tree" ? "secondary" : "ghost"}
            size="xs"
            onClick={() => setView("tree")}
          >
            Tree
          </Button>
          <Button
            type="button"
            variant={view === "raw" ? "secondary" : "ghost"}
            size="xs"
            onClick={() => setView("raw")}
          >
            Raw
          </Button>
        </div>
        <CopyButton value={raw} />
      </div>
      <div className={cn("scrollbar-thin overflow-auto p-2")} style={{ maxHeight }}>
        {view === "tree" ? (
          <JsonTree data={data} />
        ) : (
          <pre className="mono text-xs leading-relaxed">{raw}</pre>
        )}
      </div>
    </div>
  );
}
