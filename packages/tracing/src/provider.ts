/**
 * Process-wide OpenTelemetry tracer provider for the fusion stack.
 *
 * `initFusionTracing()` is idempotent and cheap: it always installs a
 * provider with the in-process span listener (which the gateway's reasoning
 * narrator and the CLI's product telemetry subscribe to), and adds a batched
 * OTLP/HTTP exporter only when `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set —
 * so runs without a collector never open sockets.
 *
 * All OTLP transport behavior (endpoint, headers, timeouts) follows the
 * standard `OTEL_EXPORTER_OTLP_TRACES_*` environment variables.
 */
import { context, propagation, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import { listenerSpanProcessor } from "./listener.js";

let provider: NodeTracerProvider | undefined;
let providerServiceName: string | undefined;

/** True when spans will actually be exported over OTLP. */
export function isTraceExportConfigured(): boolean {
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return endpoint !== undefined && endpoint.length > 0;
}

export type InitFusionTracingOptions = {
  /** OTel `service.name` resource attribute (e.g. "fusionkit-gateway"). */
  serviceName: string;
  /** Extra span processors (used by tests to capture spans in memory). */
  spanProcessors?: SpanProcessor[];
};

/**
 * Install the fusion tracer provider. Safe to call more than once; the first
 * call wins (matching how the stack boots: CLI first, then gateway pieces).
 */
export function initFusionTracing(options: InitFusionTracingOptions): void {
  if (provider !== undefined) return;
  const processors: SpanProcessor[] = [listenerSpanProcessor(), ...(options.spanProcessors ?? [])];
  if (isTraceExportConfigured()) {
    processors.push(
      new BatchSpanProcessor(new OTLPTraceExporter(), {
        // Live dashboards want markers quickly; 500ms batches keep exports
        // frequent without per-span requests.
        scheduledDelayMillis: 500
      })
    );
  }
  const created = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": options.serviceName }),
    spanProcessors: processors
  });
  // register() installs the default W3C composite propagator
  // (tracecontext + baggage) alongside the async-hooks context manager.
  created.register();
  provider = created;
  providerServiceName = options.serviceName;
}

/** The active provider's service name, if tracing was initialized. */
export function fusionTracingServiceName(): string | undefined {
  return providerServiceName;
}

/** Flush all pending spans (bounded by the exporter's own timeout). */
export async function flushFusionTracing(): Promise<void> {
  await provider?.forceFlush().catch(() => undefined);
}

/** Flush and shut the provider down. Called from the CLI's disposer chain. */
export async function shutdownFusionTracing(): Promise<void> {
  const active = provider;
  provider = undefined;
  providerServiceName = undefined;
  await active?.shutdown().catch(() => undefined);
}

/**
 * Test-only: tear down the provider registration so a fresh init can run.
 * Also disconnects the global tracer/propagator registrations.
 */
export async function resetFusionTracingForTest(): Promise<void> {
  await shutdownFusionTracing();
  trace.disable();
  context.disable();
  propagation.disable();
}
