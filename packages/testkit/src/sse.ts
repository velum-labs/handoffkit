/**
 * SSE observation helpers shared by cross-stack tests, mirroring
 * `fusionkit_testkit.sse` so both suites assert on structured frames instead
 * of re-implementing stream splitting inline.
 */

export type SseFrame = { event?: string; data: unknown };

/** Parse an SSE body into ordered frames (`[DONE]` kept as the literal string). */
export function parseSse(raw: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of raw.split("\n\n")) {
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n");
    if (payload === "[DONE]") {
      frames.push({ ...(event !== undefined ? { event } : {}), data: "[DONE]" });
      continue;
    }
    try {
      frames.push({ ...(event !== undefined ? { event } : {}), data: JSON.parse(payload) });
    } catch {
      // Partial/garbage frames stay observable rather than throwing mid-assertion.
      frames.push({ ...(event !== undefined ? { event } : {}), data: payload });
    }
  }
  return frames;
}

type ChatChunk = {
  object?: string;
  choices?: Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string } }>;
};

/** Concatenated `delta.content` of OpenAI chat-completion chunks. */
export function sseText(frames: readonly SseFrame[]): string {
  return frames
    .map((frame) => {
      const chunk = frame.data as ChatChunk;
      if (typeof frame.data !== "object" || frame.data === null) return "";
      return chunk.choices?.[0]?.delta?.content ?? "";
    })
    .join("");
}

/** Concatenated out-of-band reasoning deltas of OpenAI chat-completion chunks. */
export function sseReasoning(frames: readonly SseFrame[]): string {
  return frames
    .map((frame) => {
      if (typeof frame.data !== "object" || frame.data === null) return "";
      const delta = (frame.data as ChatChunk).choices?.[0]?.delta;
      return (delta?.reasoning_content ?? "") + (delta?.reasoning ?? "");
    })
    .join("");
}

/** True when the stream terminated with the OpenAI `[DONE]` sentinel. */
export function sseDone(frames: readonly SseFrame[]): boolean {
  return frames.some((frame) => frame.data === "[DONE]");
}
