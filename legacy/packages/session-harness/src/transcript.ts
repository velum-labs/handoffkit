/**
 * Structured session transcript: the harness's typed event stream rendered
 * as one JSON line per part. This becomes the run's log artifact, replacing
 * the merged stdout/stderr a CLI invocation would have produced — every
 * tool call, file-change notice, and finish reason the harness reported is
 * preserved verbatim and hash-addressed in the receipt.
 *
 * The recorder is deliberately liberal in what it accepts: harness stream
 * parts are an experimental, evolving union (`@ai-sdk/harness` canary), so
 * known part types are mapped to stable transcript shapes and unknown types
 * are recorded by name only. Nothing here throws on a novel part.
 */

type AnyPart = { type: string } & Record<string, unknown>;

/** One JSON line of the transcript. */
export type TranscriptLine = { part: string } & Record<string, unknown>;

function jsonSafe(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? String(v) : v))
    );
  } catch {
    return String(value);
  }
}

export class TranscriptRecorder {
  private readonly lines: TranscriptLine[] = [];
  private readonly textById = new Map<string, { kind: "text" | "reasoning"; text: string }>();
  private failed = false;

  /** Ingest one stream part from the harness agent's full stream. */
  ingest(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    const part = value as AnyPart;
    if (typeof part.type !== "string") return;

    switch (part.type) {
      case "start":
      case "start-step":
      case "finish-step":
      case "text-start":
      case "reasoning-start":
      case "raw":
        return; // structural framing; no evidence content of its own
      case "stream-start": {
        this.push({
          part: "stream-start",
          ...(part.modelId !== undefined ? { modelId: part.modelId } : {}),
          ...(Array.isArray(part.warnings) && part.warnings.length > 0
            ? { warnings: jsonSafe(part.warnings) }
            : {})
        });
        return;
      }
      case "text-delta": {
        this.appendText("text", part);
        return;
      }
      case "reasoning-delta": {
        this.appendText("reasoning", part);
        return;
      }
      case "text-end": {
        this.flushText("text", part);
        return;
      }
      case "reasoning-end": {
        this.flushText("reasoning", part);
        return;
      }
      case "tool-call": {
        this.push({
          part: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: jsonSafe(part.input)
        });
        return;
      }
      case "tool-result": {
        // HarnessV1 emits `result`; the AI SDK stream surface emits `output`.
        const output = "output" in part ? part.output : part.result;
        this.push({
          part: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: jsonSafe(output),
          ...(part.isError === true ? { isError: true } : {})
        });
        return;
      }
      case "tool-error": {
        this.push({
          part: "tool-error",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          error: errorMessage(part.error)
        });
        return;
      }
      case "tool-approval-request": {
        this.push({
          part: "tool-approval-request",
          approvalId: part.approvalId,
          toolCallId: part.toolCallId
        });
        return;
      }
      case "file-change": {
        this.push({ part: "file-change", event: part.event, path: part.path });
        return;
      }
      case "compaction": {
        // tokensBefore/tokensAfter quantify how much context the runtime
        // dropped — evidence for judging a candidate that "forgot" late in a run.
        this.push({
          part: "compaction",
          trigger: part.trigger,
          summary: part.summary,
          ...(typeof part.tokensBefore === "number" ? { tokensBefore: part.tokensBefore } : {}),
          ...(typeof part.tokensAfter === "number" ? { tokensAfter: part.tokensAfter } : {})
        });
        return;
      }
      case "finish": {
        const finishReason = finishReasonOf(part.finishReason);
        if (finishReason === "error") this.failed = true;
        this.push({
          part: "finish",
          finishReason,
          ...(part.totalUsage !== undefined ? { totalUsage: jsonSafe(part.totalUsage) } : {})
        });
        return;
      }
      case "error":
      case "abort": {
        this.failed = true;
        this.push({ part: part.type, error: errorMessage(part.error) });
        return;
      }
      default: {
        // Unknown/novel part types: record the occurrence without an
        // unbounded payload, so the transcript stays evidence-shaped even
        // as the experimental harness union evolves.
        this.push({ part: part.type });
        return;
      }
    }
  }

  /** Record a turn-level failure (a thrown stream/iteration error). */
  fail(error: unknown): void {
    this.failed = true;
    this.push({ part: "turn-failed", error: errorMessage(error) });
  }

  /** 0 when the turn finished cleanly, 1 when any error part was seen. */
  exitCode(): number {
    return this.failed ? 1 : 0;
  }

  /** Render the transcript as a JSONL buffer, optionally truncated. */
  toBuffer(maxBytes?: number): Buffer {
    this.flushAllText();
    const body = this.lines.map((line) => JSON.stringify(line)).join("\n");
    const buffer = Buffer.from(body.length > 0 ? `${body}\n` : "", "utf8");
    if (maxBytes !== undefined && buffer.byteLength > maxBytes) {
      return buffer.subarray(0, maxBytes);
    }
    return buffer;
  }

  private push(line: TranscriptLine): void {
    this.lines.push(line);
  }

  private appendText(kind: "text" | "reasoning", part: AnyPart): void {
    const id = typeof part.id === "string" ? part.id : `${kind}:anonymous`;
    // HarnessV1 emits `delta`; the AI SDK stream surface emits `text`.
    const deltaValue = "delta" in part ? part.delta : part.text;
    const delta = typeof deltaValue === "string" ? deltaValue : "";
    const entry = this.textById.get(id) ?? { kind, text: "" };
    entry.text += delta;
    this.textById.set(id, entry);
  }

  private flushText(kind: "text" | "reasoning", part: AnyPart): void {
    const id = typeof part.id === "string" ? part.id : `${kind}:anonymous`;
    const entry = this.textById.get(id);
    if (!entry) return;
    this.textById.delete(id);
    if (entry.text.length === 0) return;
    this.push({ part: entry.kind, text: entry.text });
  }

  private flushAllText(): void {
    for (const entry of this.textById.values()) {
      if (entry.text.length > 0) this.push({ part: entry.kind, text: entry.text });
    }
    this.textById.clear();
  }
}

/**
 * A finish reason is a plain string on the AI SDK stream surface and a
 * `{ unified, raw? }` object at the harness/provider level; accept both.
 */
function finishReasonOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "unified" in value) {
    const unified = (value as { unified: unknown }).unified;
    if (typeof unified === "string") return unified;
  }
  return "unknown";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(jsonSafe(error));
  } catch {
    return String(error);
  }
}
