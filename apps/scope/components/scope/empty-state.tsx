import { Card, CardContent } from "@/components/ui/card";

/** A designed empty state for pages with no data yet. */
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
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        {icon !== undefined ? <div className="text-muted-foreground">{icon}</div> : null}
        <div className="font-medium">{title}</div>
        {hint !== undefined ? <div className="text-muted-foreground max-w-md text-sm">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}
