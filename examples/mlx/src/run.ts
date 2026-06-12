/**
 * MLX generation smoke test.
 *
 * Provisions a Warrant-owned mlx-lm server and runs a single generateText call.
 * Apple Silicon only.
 *
 *   WARRANT_MLX_MODEL            HF repo id (default: prism-ml/Ternary-Bonsai-4B-mlx-2bit)
 *   WARRANT_MLX_DIR              owned MLX directory override (default: ~/.warrant/mlx)
 *   WARRANT_MLX_IDLE_SHUTDOWN_MS idle shutdown (default: 0 — stay up through the run)
 *   WARRANT_MLX_PROMPT           prompt override
 */
import { generateText } from "ai";

import {
  defaultMlxDir,
  mlxServer,
  type ManagedServerEvent
} from "@warrant/adapter-ai-sdk";

const DEFAULT_MODEL = "prism-ml/Ternary-Bonsai-4B-mlx-2bit";
const DEFAULT_PROMPT =
  "In one short sentence, explain what MLX is useful for on Apple Silicon.";

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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

function parseIdleShutdownMs(): number {
  const raw = process.env.WARRANT_MLX_IDLE_SHUTDOWN_MS;
  if (raw === undefined || raw === "") return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`WARRANT_MLX_IDLE_SHUTDOWN_MS must be a non-negative number, got "${raw}"`);
  }
  return parsed;
}

function hintOnStartupFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (!/healthy|startup|exited during startup/i.test(message)) return;
  console.error("");
  console.error("First run can take several minutes: provisioning the Python env and");
  console.error("downloading model weights into the owned HF cache.");
  console.error(`Server log: ${defaultMlxDir()}/logs/server.log`);
}

async function main(): Promise<void> {
  assertPlatform();

  const model = process.env.WARRANT_MLX_MODEL ?? DEFAULT_MODEL;
  const dir = process.env.WARRANT_MLX_DIR;
  const idleShutdownMs = parseIdleShutdownMs();
  const prompt = process.env.WARRANT_MLX_PROMPT ?? DEFAULT_PROMPT;

  console.log("");
  console.log("MLX generation smoke test");
  console.log(`  model: ${model}`);
  console.log(`  mlx dir: ${dir ?? defaultMlxDir()}`);
  console.log("");

  const local = mlxServer({
    model,
    ...(dir ? { env: { dir } } : {}),
    idleShutdownMs,
    onEvent: onServerEvent
  });

  try {
    step("provision MLX env and start mlx_lm server");
    try {
      await local.start();
    } catch (error) {
      hintOnStartupFailure(error);
      throw error;
    }

    const envInfo = local.env.info();
    detail(`provisioned: ${envInfo.provisioned}`);
    if (envInfo.manifest) {
      detail(`toolchain: ${envInfo.manifest.toolchain}`);
      detail(`package: ${envInfo.manifest.packageSpec}`);
    }
    detail(`disk footprint: ${formatBytes(envInfo.diskBytes)}`);
    ok(`server status: ${local.status()}`);

    step("generateText with the local MLX model");
    detail(`prompt: ${prompt}`);
    const result = await generateText({ model: local, prompt });
    const text = result.text.trim();
    if (text.length === 0) {
      throw new Error("model returned empty text");
    }
    ok(`model answered (${text.length} chars): "${text.slice(0, 200)}${text.length > 200 ? "…" : ""}"`);

    step("final diagnostics");
    detail(`server status: ${local.status()}`);
    detail(`base URL: ${local.baseURL() ?? "(stopped)"}`);
    ok("smoke test passed");
  } finally {
    await local.stop();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
