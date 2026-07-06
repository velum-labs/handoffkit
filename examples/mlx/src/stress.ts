/**
 * MLX stress test.
 *
 * Provisions a FusionKit-owned mlx-lm server, drives concurrent AI SDK calls,
 * and reports latency/throughput/error metrics. Apple Silicon only.
 *
 *   FUSIONKIT_MLX_MODEL              HF repo id
 *   FUSIONKIT_MLX_DIR                owned MLX directory override
 *   FUSIONKIT_MLX_STRESS_REQUESTS    measured requests (default: 64)
 *   FUSIONKIT_MLX_STRESS_CONCURRENCY concurrent in-flight requests (default: 8)
 *   FUSIONKIT_MLX_STRESS_WARMUP      unmeasured warmup requests (default: 2)
 *   FUSIONKIT_MLX_STRESS_MODE        text | object | mixed (default: mixed)
 *   FUSIONKIT_MLX_STRESS_MAX_TOKENS  max output tokens per request (default: 64)
 */
import { generateText, jsonSchema, Output } from "ai";

import {
  defaultMlxDir,
  mlxServer,
  type ManagedServerEvent
} from "@fusionkit/adapter-ai-sdk";
import { GATEWAY_DEFAULT_MLX_MODEL } from "@fusionkit/registry";

const DEFAULT_MODEL = GATEWAY_DEFAULT_MLX_MODEL;
const DEFAULT_REQUESTS = 64;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_WARMUP = 2;
const DEFAULT_MAX_OUTPUT_TOKENS = 64;

type StressMode = "text" | "object" | "mixed";
type RequestKind = "text" | "object";

type StressConfig = {
  model: string;
  dir: string | undefined;
  requests: number;
  concurrency: number;
  warmup: number;
  mode: StressMode;
  maxOutputTokens: number;
};

type StressResult = {
  index: number;
  kind: RequestKind;
  ok: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  chars: number;
  error?: string;
};

function assertPlatform(): void {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    console.error(
      `MLX requires macOS on Apple Silicon; this host is ${process.platform}/${process.arch}.`
    );
    process.exit(1);
  }
}

function step(text: string): void {
  console.log(`▸ ${text}`);
}

function detail(text: string): void {
  for (const line of text.split("\n")) {
    console.log(`  ${line}`);
  }
}

function ok(text: string): void {
  console.log(`✓ ${text}`);
}

function parsePositiveInteger(
  name: string,
  defaultValue: number,
  options: { allowZero?: boolean } = {}
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number(raw);
  const lowerBound = options.allowZero ? 0 : 1;
  if (!Number.isInteger(parsed) || parsed < lowerBound) {
    throw new Error(`${name} must be an integer >= ${lowerBound}, got "${raw}"`);
  }
  return parsed;
}

function parseMode(): StressMode {
  const raw = process.env.FUSIONKIT_MLX_STRESS_MODE ?? "mixed";
  switch (raw) {
    case "text":
    case "object":
    case "mixed":
      return raw;
    default:
      throw new Error(
        `FUSIONKIT_MLX_STRESS_MODE must be text, object, or mixed, got "${raw}"`
      );
  }
}

function readConfig(): StressConfig {
  const requests = parsePositiveInteger(
    "FUSIONKIT_MLX_STRESS_REQUESTS",
    DEFAULT_REQUESTS
  );
  const concurrency = parsePositiveInteger(
    "FUSIONKIT_MLX_STRESS_CONCURRENCY",
    DEFAULT_CONCURRENCY
  );
  return {
    model: process.env.FUSIONKIT_MLX_MODEL ?? DEFAULT_MODEL,
    dir: process.env.FUSIONKIT_MLX_DIR,
    requests,
    concurrency: Math.min(concurrency, requests),
    warmup: parsePositiveInteger("FUSIONKIT_MLX_STRESS_WARMUP", DEFAULT_WARMUP, {
      allowZero: true
    }),
    mode: parseMode(),
    maxOutputTokens: parsePositiveInteger(
      "FUSIONKIT_MLX_STRESS_MAX_TOKENS",
      DEFAULT_MAX_OUTPUT_TOKENS
    )
  };
}

function requestKind(index: number, mode: StressMode): RequestKind {
  switch (mode) {
    case "text":
      return "text";
    case "object":
      return "object";
    case "mixed":
      return index % 2 === 0 ? "object" : "text";
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

function textPrompt(index: number): string {
  return (
    `Request ${index}: in one short sentence, name one useful property of ` +
    "MLX on Apple Silicon."
  );
}

function objectPrompt(index: number): string {
  return (
    `Request ${index}: answer with the capital city of France in the required ` +
    "schema."
  );
}

function numberFromRecord(value: unknown, key: string): number {
  if (typeof value !== "object" || value === null) return 0;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : 0;
}

function usageNumbers(usage: unknown): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  const inputTokens = numberFromRecord(usage, "inputTokens");
  const outputTokens = numberFromRecord(usage, "outputTokens");
  const totalTokens =
    numberFromRecord(usage, "totalTokens") || inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function onServerEvent(event: ManagedServerEvent): void {
  switch (event.type) {
    case "starting":
      detail(`mlx_lm server starting on port ${event.port}`);
      break;
    case "ready":
      detail(
        `server ready at ${event.baseURL} (pid ${event.pid}, startup ${event.startupMs}ms)`
      );
      break;
    case "stopped":
      detail(`server stopped (${event.reason})`);
      break;
    case "crashed":
      detail(`server crashed (exit code ${event.exitCode})`);
      break;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

async function runOne(
  model: Parameters<typeof generateText>[0]["model"],
  config: StressConfig,
  index: number
): Promise<StressResult> {
  const kind = requestKind(index, config.mode);
  const started = process.hrtime.bigint();
  try {
    if (kind === "object") {
      const result = await generateText({
        model,
        prompt: objectPrompt(index),
        maxOutputTokens: config.maxOutputTokens,
        output: Output.object({
          schema: jsonSchema<{ capital: string }>({
            type: "object",
            properties: { capital: { type: "string" } },
            required: ["capital"]
          })
        })
      });
      const usage = usageNumbers(result.usage);
      return {
        index,
        kind,
        ok: true,
        latencyMs: elapsedMs(started),
        ...usage,
        chars: JSON.stringify(result.output).length
      };
    }

    const result = await generateText({
      model,
      prompt: textPrompt(index),
      maxOutputTokens: config.maxOutputTokens
    });
    const usage = usageNumbers(result.usage);
    return {
      index,
      kind,
      ok: true,
      latencyMs: elapsedMs(started),
      ...usage,
      chars: result.text.length
    };
  } catch (error) {
    return {
      index,
      kind,
      ok: false,
      latencyMs: elapsedMs(started),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      chars: 0,
      error: errorMessage(error)
    };
  }
}

function elapsedMs(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

async function runBatch(
  model: Parameters<typeof generateText>[0]["model"],
  config: StressConfig
): Promise<StressResult[]> {
  const results: StressResult[] = [];
  let next = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= config.requests) return;
      const result = await runOne(model, config, index);
      results[index] = result;
      completed++;
      if (completed % Math.max(1, Math.floor(config.requests / 10)) === 0) {
        detail(`completed ${completed}/${config.requests}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: config.concurrency }, () => worker())
  );
  return results;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))] ?? 0;
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function formatRate(value: number): string {
  return value.toFixed(2);
}

function summarize(results: StressResult[], elapsedMsTotal: number): string {
  const successes = results.filter((result) => result.ok);
  const failures = results.filter((result) => !result.ok);
  const latencies = successes
    .map((result) => result.latencyMs)
    .sort((a, b) => a - b);
  const totalOutputTokens = successes.reduce(
    (sum, result) => sum + result.outputTokens,
    0
  );
  const totalTokens = successes.reduce(
    (sum, result) => sum + result.totalTokens,
    0
  );
  const elapsedSeconds = elapsedMsTotal / 1000;
  const byKind = (kind: RequestKind): string => {
    const subset = results.filter((result) => result.kind === kind);
    const okCount = subset.filter((result) => result.ok).length;
    return `${kind}: ${okCount}/${subset.length} ok`;
  };

  const lines = [
    `requests: ${successes.length}/${results.length} ok (${failures.length} failed)`,
    `elapsed: ${(elapsedMsTotal / 1000).toFixed(2)}s`,
    `throughput: ${formatRate(successes.length / elapsedSeconds)} req/s`,
    `output token throughput: ${formatRate(totalOutputTokens / elapsedSeconds)} tok/s`,
    `total token throughput: ${formatRate(totalTokens / elapsedSeconds)} tok/s`,
    `latency min/p50/p90/p95/p99/max: ${formatMs(latencies[0] ?? 0)} / ${formatMs(
      percentile(latencies, 50)
    )} / ${formatMs(percentile(latencies, 90))} / ${formatMs(
      percentile(latencies, 95)
    )} / ${formatMs(percentile(latencies, 99))} / ${formatMs(
      latencies.at(-1) ?? 0
    )}`,
    `${byKind("text")}; ${byKind("object")}`
  ];

  if (failures.length > 0) {
    lines.push("errors:");
    for (const failure of failures.slice(0, 5)) {
      const firstLine = failure.error?.split("\n")[0] ?? "unknown error";
      lines.push(`  #${failure.index} ${failure.kind}: ${firstLine}`);
    }
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  assertPlatform();
  const config = readConfig();

  console.log("");
  console.log("MLX stress test");
  console.log(`  model: ${config.model}`);
  console.log(`  mlx dir: ${config.dir ?? defaultMlxDir()}`);
  console.log(`  mode: ${config.mode}`);
  console.log(`  requests: ${config.requests}`);
  console.log(`  concurrency: ${config.concurrency}`);
  console.log(`  warmup: ${config.warmup}`);
  console.log(`  max output tokens: ${config.maxOutputTokens}`);
  console.log("");

  const local = mlxServer({
    model: config.model,
    ...(config.dir ? { env: { dir: config.dir } } : {}),
    idleShutdownMs: 0,
    structured: config.mode !== "text",
    onEvent: onServerEvent
  });

  try {
    step("provision MLX env and start mlx_lm server");
    await local.start();
    ok(`server status: ${local.status()}`);

    if (config.warmup > 0) {
      step(`warm up with ${config.warmup} sequential request(s)`);
      for (let index = 0; index < config.warmup; index++) {
        const result = await runOne(local, config, index);
        if (!result.ok) {
          throw new Error(`warmup request ${index} failed: ${result.error}`);
        }
      }
      ok("warmup complete");
    }

    step("run measured concurrent load");
    const started = process.hrtime.bigint();
    const results = await runBatch(local, config);
    const totalMs = elapsedMs(started);

    step("summary");
    detail(summarize(results, totalMs));
  } finally {
    await local.stop();
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exit(1);
});
