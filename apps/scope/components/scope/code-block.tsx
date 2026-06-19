import { CopyButton } from "@/components/scope/copy-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/**
 * A monospace payload block with a hover copy button. Optionally scrolls within
 * a max height; used for prompts, trajectories, JSON dumps, and final outputs.
 */
export function CodeBlock({
  value,
  className,
  viewportClassName,
  muted = false
}: {
  value: string;
  className?: string;
  viewportClassName?: string;
  muted?: boolean;
}) {
  const pre = (
    <pre className={cn("mono text-xs leading-relaxed", muted && "text-muted-foreground")}>
      {value}
    </pre>
  );
  return (
    <div className={cn("group/code relative", muted && "bg-muted/40 rounded-md p-3", className)}>
      <CopyButton
        value={value}
        className="absolute top-1.5 right-1.5 z-10 opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100"
      />
      {viewportClassName ? (
        <ScrollArea viewportClassName={cn("pr-3", viewportClassName)}>{pre}</ScrollArea>
      ) : (
        pre
      )}
    </div>
  );
}
