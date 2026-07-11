/**
 * Process-wide OpenTelemetry providers for the fusion stack.
 *
 * `initFusionTracing()` is idempotent and cheap: it always installs a tracer
 * provider and a logger provider with the in-process listeners (which the
 * gateway's reasoning narrator and the CLI's product telemetry subscribe
 * to), and adds batched OTLP/HTTP exporters only when the corresponding
 * standard endpoint is configured — so runs without a collector never open
 * sockets. Unit-of-work spans ride the traces signal; live fusion events
 * ride the logs signal.
 *
 * All OTLP transport behavior (endpoints, headers, timeouts) follows the
 * standard `OTEL_EXPORTER_OTLP_*` environment variables: the signal-specific
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
 * win, else `OTEL_EXPORTER_OTLP_ENDPOINT` is used as the base with the
 * standard `/v1/traces` / `/v1/logs` paths appended by the exporters.
 */
import { context, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";

import { AllowlistLogExporter, AllowlistSpanExporter, isLoopbackOtlpEndpoint } from "./exportable.js";
import {
  hasFusionEventListeners,
  hasSpanListeners,
  listenerLogRecordProcessor,
  listenerSpanProcessor
} from "./listener.js";

let provider: NodeTracerProvider | undefined;
let loggerProvider: LoggerProvider | undefined;
let providerServiceName: string | undefined;
let extraProcessorsInstalled = false;

function configuredOtlpTracesEndpoint(): string | undefined {
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return endpoint !== undefined && endpoint.length > 0 ? endpoint : undefined;
}

function configuredOtlpLogsEndpoint(): string | undefined {
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return endpoint !== undefined && endpoint.length > 0 ? endpoint : undefined;
}

/** True when spans will actually be exported over OTLP. */
export function isTraceExportConfigured(): boolean {
  return configuredOtlpTracesEndpoint() !== undefined;
}

/** True when fusion events will actually be exported over OTLP logs. */
export function isEventExportConfigured(): boolean {
  return configuredOtlpLogsEndpoint() !== undefined;
}

export type InitFusionTracingOptions = {
  /** OTel `service.name` resource attribute (e.g. "fusionkit-gateway"). */
  serviceName: string;
  /** Extra span processors (used by tests to capture spans in memory). */
  spanProcessors?: SpanProcessor[];
  /** Extra log record processors (used by tests to capture events in memory). */
  logRecordProcessors?: LogRecordProcessor[];
};

/**
 * Install the fusion tracer + logger providers. Safe to call more than once;
 * the first call wins (matching how the stack boots: CLI first, then gateway
 * pieces).
 */
export function initFusionTracing(options: InitFusionTracingOptions): void {
  if (provider !== undefined) return;
  extraProcessorsInstalled =
    (options.spanProcessors?.length ?? 0) > 0 || (options.logRecordProcessors?.length ?? 0) > 0;
  const processors: SpanProcessor[] = [listenerSpanProcessor(), ...(options.spanProcessors ?? [])];
  const logProcessors: LogRecordProcessor[] = [
    listenerLogRecordProcessor(),
    ...(options.logRecordProcessors ?? [])
  ];
  // Full-fidelity payloads (prompts, trajectories) only leave the process for
  // a loopback collector or an explicit opt-in; any other destination gets
  // the protocol's EXPORTABLE_ATTRIBUTES allowlist applied per span/event.
  const tracesEndpoint = configuredOtlpTracesEndpoint();
  if (tracesEndpoint !== undefined) {
    const fullFidelity =
      process.env.FUSIONKIT_TRACE_FULL_FIDELITY === "1" || isLoopbackOtlpEndpoint(tracesEndpoint);
    process.stderr.write(
      fullFidelity
        ? `fusionkit tracing: exporting full traces to ${tracesEndpoint}\n`
        : `fusionkit tracing: exporting allowlisted span attributes to ${tracesEndpoint} (FUSIONKIT_TRACE_FULL_FIDELITY=1 to send full traces)\n`
    );
    processors.push(
      new BatchSpanProcessor(new AllowlistSpanExporter(new OTLPTraceExporter(), { fullFidelity }), {
        // Live dashboards want unit spans soon after they end; 500ms batches
        // keep exports frequent without per-span requests.
        scheduledDelayMillis: 500
      })
    );
  }
  const logsEndpoint = configuredOtlpLogsEndpoint();
  if (logsEndpoint !== undefined) {
    const fullFidelity =
      process.env.FUSIONKIT_TRACE_FULL_FIDELITY === "1" || isLoopbackOtlpEndpoint(logsEndpoint);
    logProcessors.push(
      new BatchLogRecordProcessor({
        exporter: new AllowlistLogExporter(new OTLPLogExporter(), { fullFidelity }),
        // Events are the live signal; 500ms batches keep the dashboard fresh.
        scheduledDelayMillis: 500
      })
    );
  }
  const resource = resourceFromAttributes({ "service.name": options.serviceName });
  const created = new NodeTracerProvider({ resource, spanProcessors: processors });
  // register() installs the default W3C composite propagator
  // (tracecontext + baggage) alongside the async-hooks context manager.
  created.register();
  const createdLogger = new LoggerProvider({ resource, processors: logProcessors });
  logs.setGlobalLoggerProvider(createdLogger);
  provider = created;
  loggerProvider = createdLogger;
  providerServiceName = options.serviceName;
}

/** The active provider's service name, if tracing was initialized. */
export function fusionTracingServiceName(): string | undefined {
  return providerServiceName;
}

/**
 * True when emitted spans/events have at least one consumer (an OTLP endpoint
 * or an in-process listener). Callers use this to skip *expensive preparation
 * work* (cloning responses, JSON-parsing bodies) — emission itself is always
 * safe.
 */
export function isFusionTracingActive(): boolean {
  return (
    provider !== undefined &&
    (isTraceExportConfigured() ||
      isEventExportConfigured() ||
      hasSpanListeners() ||
      hasFusionEventListeners() ||
      extraProcessorsInstalled)
  );
}

/** Flush all pending spans and events (bounded by the exporters' timeouts). */
export async function flushFusionTracing(): Promise<void> {
  await provider?.forceFlush().catch(() => undefined);
  await loggerProvider?.forceFlush().catch(() => undefined);
}

/** Flush and shut the providers down. Called from the CLI's disposer chain. */
export async function shutdownFusionTracing(): Promise<void> {
  const active = provider;
  const activeLogger = loggerProvider;
  provider = undefined;
  loggerProvider = undefined;
  providerServiceName = undefined;
  await active?.shutdown().catch(() => undefined);
  await activeLogger?.shutdown().catch(() => undefined);
}

/**
 * Test-only: tear down the provider registrations so a fresh init can run.
 * Also disconnects the global tracer/logger/propagator registrations.
 */
export async function resetFusionTracingForTest(): Promise<void> {
  await shutdownFusionTracing();
  trace.disable();
  context.disable();
  propagation.disable();
  logs.disable();
}
