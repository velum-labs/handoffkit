/**
 * The single server-sent-events codec for the gateway (WS5.1).
 *
 * Every hand-rolled `data:`-line parser in the gateway used to assume one JSON
 * document per `data:` line, re-split the whole accumulated buffer on each
 * chunk, and swallow parse errors with `catch {}`. {@link SseDecoder} replaces
 * all of them with one incremental, spec-compliant parser: multi-line `data:`
 * fields are joined with "\n", `event:`/`id:` fields are carried, `:` comment
 * lines are ignored, CRLF is tolerated, and byte chunks are decoded through a
 * streaming {@link TextDecoder} so an event may be split at any byte boundary
 * (including mid-rune). Parsing is O(total bytes): a scan cursor remembers how
 * far the buffer has already been searched for a line terminator, so feeding a
 * large event in many small chunks never rescans the prefix.
 */

/** One decoded SSE event. `data` is the joined payload (never includes the field name). */
export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

/**
 * A structurally-invalid SSE stream: a trailing partial event on flush, or (for
 * {@link ChatStreamAssembler}) a malformed JSON payload. Carries a bounded
 * snippet of the offending text so truncation/corruption is never silent.
 */
export class SseParseError extends Error {
  readonly snippet: string | undefined;
  constructor(message: string, snippet?: string) {
    super(message);
    this.name = "SseParseError";
    this.snippet = snippet;
  }
}

const SNIPPET_LIMIT = 200;

/**
 * Decode a fully-buffered SSE text into its events, best-effort. Unlike
 * {@link SseDecoder.flush}, a trailing partial event is tolerated (dropped)
 * rather than thrown: the buffered-scan callers (cost / provenance metering,
 * failover signal detection, trajectory reconstruction) run post-hoc over text
 * the gateway itself already buffered, where a truncated tail must not crash
 * metering. Live stream parsing keeps using {@link SseDecoder} directly, where
 * truncation is a real error.
 */
export function decodeBufferedSse(text: string): SseEvent[] {
  const decoder = new SseDecoder();
  const events = decoder.feed(text);
  try {
    events.push(...decoder.flush());
  } catch (error) {
    if (!(error instanceof SseParseError)) throw error;
    // Best-effort: a trailing partial event is dropped, not fatal.
  }
  return events;
}

export class SseDecoder {
  readonly #textDecoder = new TextDecoder();
  #buffer = "";
  /** How far into `#buffer` we have already searched for "\n" without finding one. */
  #scanPos = 0;
  #dataLines: string[] = [];
  #event: string | undefined;
  #id: string | undefined;

  /** Feed the next chunk (bytes or already-decoded text) and return any completed events. */
  feed(chunk: Uint8Array | string): SseEvent[] {
    const text = typeof chunk === "string" ? chunk : this.#textDecoder.decode(chunk, { stream: true });
    if (text.length > 0) this.#buffer += text;
    return this.#drain();
  }

  /**
   * Signal end of stream. Returns any final completed events, then throws
   * {@link SseParseError} if a non-empty partial event remains buffered —
   * trailing truncation must never be silent.
   */
  flush(): SseEvent[] {
    const tail = this.#textDecoder.decode();
    if (tail.length > 0) this.#buffer += tail;
    const events = this.#drain();
    const hasPendingFields = this.#dataLines.length > 0 || this.#event !== undefined || this.#id !== undefined;
    if (this.#buffer.length > 0 || hasPendingFields) {
      const snippet = (this.#buffer.length > 0 ? this.#buffer : this.#dataLines.join("\n")).slice(0, SNIPPET_LIMIT);
      throw new SseParseError("SSE stream ended mid-event (trailing partial data was buffered)", snippet);
    }
    return events;
  }

  #drain(): SseEvent[] {
    const events: SseEvent[] = [];
    let lineStart = 0;
    let searchFrom = this.#scanPos;
    for (;;) {
      const idx = this.#buffer.indexOf("\n", searchFrom);
      if (idx === -1) break;
      let line = this.#buffer.slice(lineStart, idx);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#processLine(line, events);
      lineStart = idx + 1;
      searchFrom = idx + 1;
    }
    if (lineStart > 0) this.#buffer = this.#buffer.slice(lineStart);
    // Everything remaining has been searched for "\n" (none found past lineStart).
    this.#scanPos = this.#buffer.length;
    return events;
  }

  #processLine(line: string, events: SseEvent[]): void {
    if (line === "") {
      this.#dispatch(events);
      return;
    }
    if (line.startsWith(":")) return; // comment
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        this.#dataLines.push(value);
        break;
      case "event":
        this.#event = value;
        break;
      case "id":
        this.#id = value;
        break;
      default:
        // `retry:` and any unknown field are ignored per the SSE spec.
        break;
    }
  }

  #dispatch(events: SseEvent[]): void {
    if (this.#dataLines.length === 0) {
      // A blank line with no accumulated data (e.g. after a lone comment) is
      // not an event; reset the non-data fields per the SSE dispatch rules.
      this.#event = undefined;
      this.#id = undefined;
      return;
    }
    const event: SseEvent = { data: this.#dataLines.join("\n") };
    if (this.#event !== undefined) event.event = this.#event;
    if (this.#id !== undefined) event.id = this.#id;
    events.push(event);
    this.#dataLines = [];
    this.#event = undefined;
    this.#id = undefined;
  }
}
