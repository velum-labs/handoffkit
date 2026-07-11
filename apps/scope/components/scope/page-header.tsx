import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** A consistent sticky page header: title, optional subtitle, and right-side slot. */
export function PageHeader({
  title,
  subtitle,
  children,
  className
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "bg-background/80 sticky top-0 z-20 flex items-center justify-between gap-4 border-b px-8 py-5 backdrop-blur",
        className
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <SidebarTrigger className="-ml-1 shrink-0" />
        <Separator orientation="vertical" className="h-6 shrink-0" />
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle !== undefined ? (
            <p className="text-muted-foreground mt-0.5 truncate text-sm">{subtitle}</p>
          ) : null}
        </div>
      </div>
      {children !== undefined ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </header>
  );
}

/**
 * A small pulsing dot indicating the live event stream connection. One meaning
 * everywhere: connected to the collector's SSE stream (not "no fetch error").
 * The label column has a fixed width so toggling live/offline never nudges the
 * neighboring header controls.
 */
export function LiveDot({ active }: { active: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="text-muted-foreground inline-flex items-center gap-1.5 text-xs"
          role="status"
          aria-label={active ? "Live event stream connected" : "Live event stream disconnected"}
        >
          <span className="relative flex size-2">
            {active ? (
              <span className="bg-(--status-success) absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:animate-none" />
            ) : null}
            <span
              className={cn(
                "relative inline-flex size-2 rounded-full",
                active ? "bg-(--status-success)" : "bg-muted-foreground/40"
              )}
            />
          </span>
          <span className="w-9">{active ? "live" : "offline"}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {active ? "Live event stream connected" : "Live event stream disconnected — reconnecting"}
      </TooltipContent>
    </Tooltip>
  );
}
