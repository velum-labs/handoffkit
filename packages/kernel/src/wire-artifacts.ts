/**
 * Typed wire artifacts for kernel-executed HTTP surfaces.
 *
 * The kernel executes gateway/backend calls as operator graphs. Returning a raw
 * `Response` is enough to preserve wire behavior, but a `Response` is opaque to
 * the runtime's replay/outcome records. {@link WireResponseValue} captures the
 * replay-relevant envelope of a response (status, headers, content type, whether
 * it streams, and — for a buffered, non-streaming reply — its parsed/raw body) so
 * an operator can emit a durable, JSON-serializable artifact alongside the live
 * `Response` it hands back to the caller.
 */

export type WireResponseValue = {
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  contentType: string | null;
  streaming: boolean;
  body?: unknown;
  bodyText?: string;
};

export const WireArtifactTypes = {
  BackendRequest: "backend_request",
  BackendResponse: "backend_response",
  WireResponse: "wire_response",
  TrajectoryFuseStepRequest: "trajectory_fuse_step_request",
  TrajectoryFuseStepResponse: "trajectory_fuse_step_response"
} as const;

function headerRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function isStreamingContentType(contentType: string | null): boolean {
  return contentType !== null && contentType.includes("text/event-stream");
}

/**
 * Capture a response as a replay-clean {@link WireResponseValue}.
 *
 * A streaming (`text/event-stream`) or bodyless response is passed through
 * untouched — its live bytes cannot be buffered without breaking streaming — and
 * the captured value records only the envelope with `streaming: true`. A
 * non-streaming response is fully buffered, its body parsed (JSON when the
 * content type says so, else raw text), and a fresh equivalent `Response` is
 * returned so the caller can still consume it.
 */
export async function captureWireResponse(
  response: Response
): Promise<{ value: WireResponseValue; response: Response }> {
  const contentType = response.headers.get("content-type");
  const headers = headerRecord(response.headers);
  const streaming = isStreamingContentType(contentType) || response.body === null;
  if (streaming) {
    return {
      value: {
        status: response.status,
        ...(response.statusText.length > 0 ? { statusText: response.statusText } : {}),
        headers,
        contentType,
        streaming: true
      },
      response
    };
  }
  const bodyText = await response.text();
  let body: unknown;
  if (contentType !== null && contentType.includes("application/json")) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = undefined;
    }
  }
  const value: WireResponseValue = {
    status: response.status,
    ...(response.statusText.length > 0 ? { statusText: response.statusText } : {}),
    headers,
    contentType,
    streaming: false,
    ...(body !== undefined ? { body } : {}),
    bodyText
  };
  const rebuilt = new Response(bodyText, {
    status: response.status,
    ...(response.statusText.length > 0 ? { statusText: response.statusText } : {}),
    headers: response.headers
  });
  return { value, response: rebuilt };
}
