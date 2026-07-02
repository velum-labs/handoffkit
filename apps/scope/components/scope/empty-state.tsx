/** A designed empty state for pages and sections with no data yet. */
export function EmptyState({
  title,
  hint,
  icon
}: {
  title: string;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-16 text-center">
      {icon !== undefined ? <div className="text-muted-foreground">{icon}</div> : null}
      <div className="font-medium">{title}</div>
      {hint !== undefined ? <div className="text-muted-foreground max-w-md text-sm">{hint}</div> : null}
    </div>
  );
}
