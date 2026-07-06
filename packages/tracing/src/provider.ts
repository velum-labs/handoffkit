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

import { AllowlistSpanExporter, isLoopbackOtlpEndpoint } from "./exportable.js";
import { hasSpanListeners, listenerSpanProcessor } from "./listener.js";

let provider: NodeTracerProvider | undefined;
let providerServiceName: string | undefined;
let extraProcessorsInstalled = false;

function configuredOtlpEndpoint(): string | undefined {
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return endpoint !== undefined && endpoint.length > 0 ? endpoint : undefined;
}

/** True when spans will actually be exported over OTLP. */
export function isTraceExportConfigured(): boolean {
  return configuredOtlpEndpoint() !== undefined;
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
  extraProcessorsInstalled = (options.spanProcessors?.length ?? 0) > 0;
  const processors: SpanProcessor[] = [listenerSpanProcessor(), ...(options.spanProcessors ?? [])];
  const endpoint = configuredOtlpEndpoint();
  if (endpoint !== undefined) {
    // Full-fidelity spans (prompts, trajectories) only leave the process for
    // a loopback collector or an explicit opt-in; any other destination gets
    // the protocol's EXPORTABLE_ATTRIBUTES allowlist applied per span.
    const fullFidelity =
      process.env.FUSIONKIT_TRACE_FULL_FIDELITY === "1" || isLoopbackOtlpEndpoint(endpoint);
    process.stderr.write(
      fullFidelity
        ? `fusionkit tracing: exporting full traces to ${endpoint}\n`
        : `fusionkit tracing: exporting allowlisted span attributes to ${endpoint} (FUSIONKIT_TRACE_FULL_FIDELITY=1 to send full traces)\n`
    );
    processors.push(
      new BatchSpanProcessor(new AllowlistSpanExporter(new OTLPTraceExporter(), { fullFidelity }), {
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

/**
 * True when emitted spans have at least one consumer (an OTLP endpoint or an
 * in-process listener). Callers use this to skip *expensive preparation work*
 * (cloning responses, JSON-parsing bodies) — emission itself is always safe.
 */
export function isFusionTracingActive(): boolean {
  return (
    provider !== undefined &&
    (isTraceExportConfigured() || hasSpanListeners() || extraProcessorsInstalled)
  );
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
