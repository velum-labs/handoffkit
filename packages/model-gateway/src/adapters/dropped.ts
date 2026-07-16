import { AsyncLocalStorage } from "node:async_hooks";

export type DialectName = "anthropic" | "responses" | "cursor";

export const DIALECT_DROPPED_ATTRIBUTE = "routekit.dialect.dropped";

export type DroppedFieldSpan = {
  span: {
    setAttribute(name: string, value: string[]): unknown;
  };
};

const ambientSpan = new AsyncLocalStorage<DroppedFieldSpan>();
const spanEntries = new WeakMap<object, string[]>();
const warned = new Set<string>();

export function withDroppedFieldSpan<T>(span: DroppedFieldSpan, fn: () => T): T {
  return ambientSpan.run(span, fn);
}

export function droppedField(dialect: DialectName, field: string, context?: string): void {
  const entry =
    context !== undefined ? `${dialect}.${context}.${field}` : `${dialect}.${field}`;
  const target = ambientSpan.getStore()?.span;
  if (target !== undefined) {
    const entries = [...(spanEntries.get(target) ?? []), entry];
    spanEntries.set(target, entries);
    target.setAttribute(DIALECT_DROPPED_ATTRIBUTE, entries);
  }
  if (warned.has(entry)) return;
  warned.add(entry);
  process.stderr.write(
    `routekit gateway: ${dialect} field "${
      context !== undefined ? `${context}.` : ""
    }${field}" is not translated and was dropped\n`
  );
}

export function resetDroppedFieldWarnings(): void {
  warned.clear();
}
