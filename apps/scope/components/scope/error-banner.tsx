import { AlertTriangle } from "lucide-react";

/** The one inline banner for collector fetch failures, shared by every page. */
export function ErrorBanner({ error }: { error: string | undefined }) {
  if (error === undefined) return null;
  return (
    <div className="text-muted-foreground border-destructive/40 bg-destructive/5 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
      <AlertTriangle className="text-destructive size-4 shrink-0" />
      Collector unreachable ({error}) — retrying live.
    </div>
  );
}
