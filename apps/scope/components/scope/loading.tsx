import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading placeholders shaped like the content they stand in for (stat strip,
 * table rows), so the swap from skeleton to data does not shift the layout.
 */

export function StatStripSkeleton({ stats = 5 }: { stats?: number }) {
  return (
    <div className="flex flex-wrap gap-x-10 gap-y-3 border-b pb-5">
      {Array.from({ length: stats }).map((_, index) => (
        <div key={index}>
          <Skeleton className="h-3.5 w-14" />
          <Skeleton className="mt-1.5 h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-1">
      <Skeleton className="h-9 w-full opacity-60" />
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}
