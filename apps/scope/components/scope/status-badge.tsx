import { Badge } from "@/components/ui/badge";
import { statusColor } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A status pill with a colored dot, used for sessions, candidates, and calls. */
export function StatusBadge({ status, className }: { status: string | undefined; className?: string }) {
  const label = status ?? "unknown";
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-medium capitalize", className)}>
      <span className="size-1.5 rounded-full" style={{ background: statusColor(status) }} />
      {label}
    </Badge>
  );
}
