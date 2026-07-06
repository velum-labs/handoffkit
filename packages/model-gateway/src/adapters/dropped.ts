/**
 * Honest dialect drops (WS6.1).
 *
 * The dialect adapters (Anthropic / Responses / Cursor) cannot model every
 * field of every wire format. What they must never do is discard a field
 * silently: every deliberate drop goes through {@link droppedField}, which
 * makes the loss observable twice over — once per process on stderr (so a
 * developer running the gateway sees it) and as a `fusion.dialect.dropped`
 * attribute on the enclosing turn span (so traces show exactly which fields a
 * turn lost in translation).
 *
 * The adapters are pure translation functions with no span in scope, so the
 * span is ambient: request handling wraps translation (and the streamed
 * follow-up work) in {@link withDroppedFieldSpan}, and the recorder picks it
 * up through AsyncLocalStorage.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { appendSpanListAttribute } from "@fusionkit/tracing";
import type { FusionSpan } from "@fusionkit/tracing";

export type DialectName = "anthropic" | "responses" | "cursor";

/** Span attribute collecting `dialect.field` entries for every dropped field. */
export const DIALECT_DROPPED_ATTRIBUTE = "fusion.dialect.dropped";

const ambientSpan = new AsyncLocalStorage<FusionSpan>();
const warned = new Set<string>();

/** Run `fn` with `span` as the recording target for {@link droppedField}. */
export function withDroppedFieldSpan<T>(span: FusionSpan, fn: () => T): T {
  return ambientSpan.run(span, fn);
}

/**
 * Record that `field` of an inbound `dialect` request/response was dropped in
 * translation. `ctx` optionally narrows where (e.g. "tool_result").
 */
export function droppedField(dialect: DialectName, field: string, ctx?: string): void {
  const entry = ctx !== undefined ? `${dialect}.${ctx}.${field}` : `${dialect}.${field}`;
  const span = ambientSpan.getStore();
  if (span !== undefined) appendSpanListAttribute(span.span, DIALECT_DROPPED_ATTRIBUTE, entry);
  if (warned.has(entry)) return;
  warned.add(entry);
  process.stderr.write(
    `fusionkit gateway: ${dialect} field "${ctx !== undefined ? `${ctx}.` : ""}${field}" is not translated and was dropped\n`
  );
}

/** Test hook: forget which drops have already warned. */
export function resetDroppedFieldWarnings(): void {
  warned.clear();
}
