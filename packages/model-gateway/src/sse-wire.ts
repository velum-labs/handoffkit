/** OpenAI chat content-delta SSE chunk. */
export function noticeChunk(text: string): string {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
  })}\n\n`;
}

/** Terminal SSE chunk that marks the turn as failed, followed by [DONE]. */
export function errorEvent(message: string): string {
  return (
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: message }, finish_reason: "error" }]
    })}\n\n` + "data: [DONE]\n\n"
  );
}

/** Terminal SSE chunk carrying a normal finish reason. */
export function finishChunk(reason: string): string {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta: {}, finish_reason: reason }]
  })}\n\n`;
}

/** Reasoning-only OpenAI chat SSE chunk. */
export function reasoningChunk(text: string): string {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }]
  })}\n\n`;
}

/** Wrap a static SSE string as a text/event-stream response. */
export function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
  });
}
