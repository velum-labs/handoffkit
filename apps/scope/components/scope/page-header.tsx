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
        "bg-background/80 sticky top-0 z-10 flex items-center justify-between gap-4 border-b px-8 py-5 backdrop-blur",
        className
      )}
    >
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle !== undefined ? (
          <p className="text-muted-foreground mt-0.5 truncate text-sm">{subtitle}</p>
        ) : null}
      </div>
      {children !== undefined ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </header>
  );
}

/** A small pulsing dot + label indicating an active SSE connection. */
export function LiveDot({ active, label = "live" }: { active: boolean; label?: string }) {
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
      <span className="relative flex size-2">
        {active ? (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60 motion-reduce:animate-none" />
        ) : null}
        <span
          className={cn(
            "relative inline-flex size-2 rounded-full",
            active ? "bg-emerald-500" : "bg-muted-foreground/40"
          )}
        />
      </span>
      {label}
    </span>
  );
}
