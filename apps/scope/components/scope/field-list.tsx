import { cn } from "@/lib/utils";

export type Field = {
  label: string;
  value: React.ReactNode;
  /** Render the value in the monospace font (ids, paths, urls, models). */
  mono?: boolean;
};

/**
 * A flat single-column definition list: label left, value right. The unified
 * replacement for ad-hoc key/value grids — skips fields with empty values.
 */
export function FieldList({ fields, className }: { fields: Field[]; className?: string }) {
  const visible = fields.filter(
    (field) => field.value !== undefined && field.value !== null && field.value !== ""
  );
  if (visible.length === 0) return null;
  return (
    <dl className={cn("text-sm", className)}>
      {visible.map((field) => (
        <div
          key={field.label}
          className="border-border/60 flex items-start gap-4 border-b py-1.5 last:border-0"
        >
          <dt className="text-muted-foreground w-40 shrink-0 text-xs leading-5">{field.label}</dt>
          <dd className={cn("min-w-0 flex-1 break-words", field.mono && "mono text-xs leading-5")}>
            {field.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
