import { context, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import { isLoopbackOtlpEndpoint, PolicyLogExporter, PolicySpanExporter } from "./exportable.js";
import type { AttributePolicy } from "./exportable.js";
import {
  hasEventListeners,
  hasSpanListeners,
  listenerLogRecordProcessor,
  listenerSpanProcessor
} from "./listener.js";

export type InitTracingOptions = {
  serviceName: string;
  attributePolicy: AttributePolicy;
  fullFidelityEnvironmentVariable?: string;
  logPrefix?: string;
  spanProcessors?: SpanProcessor[];
  logRecordProcessors?: LogRecordProcessor[];
};

let provider: NodeTracerProvider | undefined;
let loggerProvider: LoggerProvider | undefined;
let serviceName: string | undefined;
let extraProcessorsInstalled = false;

const tracesEndpoint = (): string | undefined => {
  const value =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return value !== undefined && value.length > 0 ? value : undefined;
};
const logsEndpoint = (): string | undefined => {
  const value =
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return value !== undefined && value.length > 0 ? value : undefined;
};

export const isTraceExportConfigured = (): boolean => tracesEndpoint() !== undefined;
export const isEventExportConfigured = (): boolean => logsEndpoint() !== undefined;

export function initTracing(options: InitTracingOptions): void {
  if (provider !== undefined) return;
  extraProcessorsInstalled =
    (options.spanProcessors?.length ?? 0) > 0 || (options.logRecordProcessors?.length ?? 0) > 0;
  const spanProcessors = [listenerSpanProcessor(), ...(options.spanProcessors ?? [])];
  const logProcessors = [
    listenerLogRecordProcessor(),
    ...(options.logRecordProcessors ?? [])
  ];
  const traceEndpoint = tracesEndpoint();
  if (traceEndpoint !== undefined) {
    const fullFidelity =
      (options.fullFidelityEnvironmentVariable !== undefined &&
        process.env[options.fullFidelityEnvironmentVariable] === "1") ||
      isLoopbackOtlpEndpoint(traceEndpoint);
    if (options.logPrefix !== undefined) {
      process.stderr.write(
        fullFidelity
          ? `${options.logPrefix}: exporting full traces to ${traceEndpoint}\n`
          : `${options.logPrefix}: exporting allowlisted span attributes to ${traceEndpoint}\n`
      );
    }
    spanProcessors.push(
      new BatchSpanProcessor(
        new PolicySpanExporter(
          new OTLPTraceExporter(),
          options.attributePolicy,
          fullFidelity
        ),
        { scheduledDelayMillis: 500 }
      )
    );
  }
  const eventEndpoint = logsEndpoint();
  if (eventEndpoint !== undefined) {
    const fullFidelity =
      (options.fullFidelityEnvironmentVariable !== undefined &&
        process.env[options.fullFidelityEnvironmentVariable] === "1") ||
      isLoopbackOtlpEndpoint(eventEndpoint);
    logProcessors.push(
      new BatchLogRecordProcessor({
        exporter: new PolicyLogExporter(
          new OTLPLogExporter(),
          options.attributePolicy,
          fullFidelity
        ),
        scheduledDelayMillis: 500
      })
    );
  }
  const resource = resourceFromAttributes({ "service.name": options.serviceName });
  const created = new NodeTracerProvider({ resource, spanProcessors });
  created.register();
  const createdLogger = new LoggerProvider({ resource, processors: logProcessors });
  logs.setGlobalLoggerProvider(createdLogger);
  provider = created;
  loggerProvider = createdLogger;
  serviceName = options.serviceName;
}

export const tracingServiceName = (): string | undefined => serviceName;
export const isTracingActive = (): boolean =>
  provider !== undefined &&
  (isTraceExportConfigured() ||
    isEventExportConfigured() ||
    hasSpanListeners() ||
    hasEventListeners() ||
    extraProcessorsInstalled);

export async function flushTracing(): Promise<void> {
  await provider?.forceFlush().catch(() => undefined);
  await loggerProvider?.forceFlush().catch(() => undefined);
}

export async function shutdownTracing(): Promise<void> {
  const activeProvider = provider;
  const activeLogger = loggerProvider;
  provider = undefined;
  loggerProvider = undefined;
  serviceName = undefined;
  await activeProvider?.shutdown().catch(() => undefined);
  await activeLogger?.shutdown().catch(() => undefined);
}

export async function resetTracingForTest(): Promise<void> {
  await shutdownTracing();
  trace.disable();
  context.disable();
  propagation.disable();
  logs.disable();
}
