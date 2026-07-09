// A tiny in-script OTLP/HTTP JSON collector for e2e drivers: accepts
// ExportTraceServiceRequest posts on /v1/traces and ExportLogsServiceRequest
// posts on /v1/logs, flattens spans + events, and answers the questions the
// drivers ask (signal-name counts, components, trace ids). Point the stack at
// it with OTEL_EXPORTER_OTLP_ENDPOINT (the exporters append the signal paths).
import { createServer } from "node:http";

function decodeId(raw, hexLength) {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  if (new RegExp(`^[0-9a-fA-F]{${hexLength}}$`).test(raw)) return raw.toLowerCase();
  try {
    const hex = Buffer.from(raw, "base64").toString("hex");
    return hex.length === hexLength ? hex : undefined;
  } catch {
    return undefined;
  }
}

function decodeAttributes(attributes) {
  return Object.fromEntries(
    (attributes ?? []).map((attr) => [
      attr.key,
      attr.value?.stringValue ?? attr.value?.intValue ?? attr.value?.doubleValue ?? attr.value?.boolValue
    ])
  );
}

export async function startOtlpCapture() {
  const spans = [];
  const events = [];

  const ingestTraces = (parsed) => {
    for (const resourceSpan of parsed.resourceSpans ?? []) {
      const service = (resourceSpan.resource?.attributes ?? []).find(
        (attr) => attr.key === "service.name"
      )?.value?.stringValue;
      for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
        for (const span of scopeSpan.spans ?? []) {
          spans.push({
            name: span.name,
            scope: scopeSpan.scope?.name,
            service,
            traceId: decodeId(span.traceId, 32) ?? span.traceId,
            spanId: decodeId(span.spanId, 16) ?? span.spanId,
            attributes: decodeAttributes(span.attributes)
          });
        }
      }
    }
  };

  const ingestLogs = (parsed) => {
    for (const resourceLog of parsed.resourceLogs ?? []) {
      const service = (resourceLog.resource?.attributes ?? []).find(
        (attr) => attr.key === "service.name"
      )?.value?.stringValue;
      for (const scopeLog of resourceLog.scopeLogs ?? []) {
        for (const record of scopeLog.logRecords ?? []) {
          if (record.eventName === undefined || record.eventName.length === 0) continue;
          events.push({
            name: record.eventName,
            scope: scopeLog.scope?.name,
            service,
            traceId: decodeId(record.traceId, 32) ?? record.traceId,
            spanId: decodeId(record.spanId, 16) ?? record.spanId,
            attributes: decodeAttributes(record.attributes)
          });
        }
      }
    }
  };

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        if (req.url?.startsWith("/v1/logs")) ingestLogs(parsed);
        else ingestTraces(parsed);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ partialSuccess: {} }));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid OTLP JSON" }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    /** Base endpoint for OTEL_EXPORTER_OTLP_ENDPOINT (signal paths appended by exporters). */
    baseEndpoint: `http://127.0.0.1:${port}`,
    spans,
    events,
    analyze() {
      const counts = {};
      const eventCounts = {};
      const scopes = {};
      const traceIds = new Set();
      for (const span of spans) {
        const name = span.name?.startsWith("chat") ? "chat" : span.name;
        counts[name] = (counts[name] ?? 0) + 1;
        if (span.scope !== undefined) scopes[span.scope] = (scopes[span.scope] ?? 0) + 1;
        traceIds.add(span.traceId);
      }
      for (const event of events) {
        eventCounts[event.name] = (eventCounts[event.name] ?? 0) + 1;
        if (event.scope !== undefined) scopes[event.scope] = (scopes[event.scope] ?? 0) + 1;
        traceIds.add(event.traceId);
      }
      return { counts, eventCounts, scopes, traceIds: [...traceIds] };
    },
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}
