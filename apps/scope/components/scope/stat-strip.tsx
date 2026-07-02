import { cn } from "@/lib/utils";

export type Stat = {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
};

/** A flat horizontal strip of headline stats (label above, value below). */
export function StatStrip({ stats, className }: { stats: Stat[]; className?: string }) {
  const visible = stats.filter(
    (stat) => stat.value !== undefined && stat.value !== null && stat.value !== ""
  );
  if (visible.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-x-10 gap-y-3", className)}>
      {visible.map((stat) => (
        <div key={stat.label} className="min-w-0">
          <div className="text-muted-foreground text-xs">{stat.label}</div>
          <div className={cn("mt-0.5 text-sm font-medium", stat.mono && "mono")}>{stat.value}</div>
        </div>
      ))}
    </div>
  );
}
