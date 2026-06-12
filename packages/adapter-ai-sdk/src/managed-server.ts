import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult
} from "@ai-sdk/provider";

import { MlxEnv } from "./mlx-env.js";
import type { MlxEnvOptions, SpawnSpec } from "./mlx-env.js";

/**
 * A managed local model server: a LanguageModelV3 whose backing process is
 * owned by this object. The first generate/stream call starts the server
 * (prepare → spawn → health), concurrent calls share one process, and an
 * idle period with no in-flight calls scales it to zero; the next call
 * transparently restarts it.
 *
 * Composes as the `local` leg of handoffModel: a provisioning failure,
 * cold-start timeout, or crash surfaces as a failed local call, which the
 * routing layer escalates to cloud.
 *
 * This is the app-process, local-first path. Runner/plane-side model-server
 * pools (governed, receipt-producing model serving) are a separate feature.
 */

/** Defaults; every one is overridable per server. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
export const DEFAULT_IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
export const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
const HEALTH_POLL_MS = 250;
/** Last bytes of server output kept for diagnostics. */
const OUTPUT_TAIL_BYTES = 64 * 1024;

export type ManagedServerEvent =
  | { type: "starting"; port: number }
  | { type: "ready"; baseURL: string; pid: number; startupMs: number }
  | { type: "stopped"; reason: "idle" | "explicit" }
  | { type: "crashed"; exitCode: number | null };

export type ManagedServerStatus = "stopped" | "starting" | "running";

export type ManagedModelServerOptions = {
  /** Produce the spawn spec for a given port (env provisioning included). */
  prepare: (port: number) => Promise<SpawnSpec>;
  /** Model id requests are made with (and reported as `modelId`). */
  modelId: string;
  /** Fixed port; defaults to a free port picked per start. */
  port?: number;
  /** Health endpoint polled until the server answers. */
  healthPath?: string;
  startupTimeoutMs?: number;
  /** Idle period after which the process is stopped; 0 disables. */
  idleShutdownMs?: number;
  shutdownGraceMs?: number;
  onEvent?: (event: ManagedServerEvent) => void;
  /** Build the inner model once the server is up. */
  createModel?: (baseURL: string, modelId: string) => LanguageModelV3;
};

function defaultCreateModel(baseURL: string, modelId: string): LanguageModelV3 {
  return createOpenAICompatible({
    name: "warrant-managed-server",
    // The provider appends route paths (e.g. /chat/completions) directly,
    // so the OpenAI-compatible API prefix belongs on the base URL.
    baseURL: `${baseURL}/v1`,
    apiKey: "not-needed"
  })(modelId);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class ManagedModelServer implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "warrant-managed-server";
  readonly modelId: string;

  private readonly options: ManagedModelServerOptions;
  private state: ManagedServerStatus = "stopped";
  private child: ChildProcess | undefined;
  private inner: LanguageModelV3 | undefined;
  private currentBaseURL: string | undefined;
  private startPromise: Promise<void> | undefined;
  private leases = 0;
  private lastUsedMs = 0;
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private outputTail = "";

  constructor(options: ManagedModelServerOptions) {
    this.options = options;
    this.modelId = options.modelId;
  }

  get supportedUrls(): LanguageModelV3["supportedUrls"] {
    return this.inner?.supportedUrls ?? {};
  }

  status(): ManagedServerStatus {
    return this.state;
  }

  /** The server's base URL while running (changes across restarts). */
  baseURL(): string | undefined {
    return this.currentBaseURL;
  }

  /** Eagerly start (optional — calls start lazily on their own). */
  async start(): Promise<void> {
    await this.ensureStarted();
  }

  /** Stop the process and scale to zero. In-flight calls will fail. */
  async stop(): Promise<void> {
    await this.stopProcess("explicit");
  }

  // ---- lifecycle ----

  private ensureStarted(): Promise<void> {
    if (this.state === "running") return Promise.resolve();
    if (!this.startPromise) {
      this.startPromise = this.startProcess().finally(() => {
        this.startPromise = undefined;
      });
    }
    return this.startPromise;
  }

  private async startProcess(): Promise<void> {
    const startedAt = Date.now();
    this.state = "starting";
    try {
      const port = this.options.port ?? (await freePort());
      this.options.onEvent?.({ type: "starting", port });
      const spec = await this.options.prepare(port);

      this.outputTail = "";
      const child = spawn(spec.cmd, spec.args, {
        env: spec.env,
        ...(spec.cwd ? { cwd: spec.cwd } : {}),
        stdio: ["ignore", "pipe", "pipe"]
      });
      this.child = child;

      const log = spec.logFile ? this.openLog(spec.logFile) : undefined;
      const capture = (chunk: Buffer): void => {
        this.outputTail = (this.outputTail + chunk.toString("utf8")).slice(
          -OUTPUT_TAIL_BYTES
        );
        log?.write(chunk);
      };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);

      let exited = false;
      let exitCode: number | null = null;
      child.on("exit", (code) => {
        exited = true;
        exitCode = code;
        log?.end();
        // A process that dies while we believe it is running is a crash:
        // reset so the next call respawns instead of hitting a dead URL.
        if (this.state === "running" && this.child === child) {
          this.clearRunning();
          this.options.onEvent?.({ type: "crashed", exitCode: code });
        }
      });
      child.on("error", (error) => {
        capture(Buffer.from(`spawn error: ${error.message}\n`, "utf8"));
        exited = true;
      });

      const baseURL = `http://127.0.0.1:${port}`;
      const healthURL = `${baseURL}${this.options.healthPath ?? "/v1/models"}`;
      const deadline =
        startedAt + (this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
      for (;;) {
        if (exited) {
          throw new Error(
            `server exited during startup (code ${exitCode}): ${this.outputTail.slice(-2000)}`
          );
        }
        if (Date.now() > deadline) {
          throw new Error(
            `server did not become healthy within ${
              this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
            }ms: ${this.outputTail.slice(-2000)}`
          );
        }
        try {
          const response = await fetch(healthURL);
          await response.arrayBuffer();
          if (response.ok) break;
        } catch {
          // not up yet
        }
        await sleep(HEALTH_POLL_MS);
      }

      this.currentBaseURL = baseURL;
      this.inner = (this.options.createModel ?? defaultCreateModel)(
        baseURL,
        this.options.modelId
      );
      this.state = "running";
      this.lastUsedMs = Date.now();
      this.armIdleTimer();
      this.options.onEvent?.({
        type: "ready",
        baseURL,
        pid: child.pid ?? -1,
        startupMs: Date.now() - startedAt
      });
    } catch (error) {
      await this.killChild();
      this.clearRunning();
      throw error;
    }
  }

  private openLog(path: string): ReturnType<typeof createWriteStream> {
    mkdirSync(dirname(path), { recursive: true });
    return createWriteStream(path, { flags: "a" });
  }

  private armIdleTimer(): void {
    const idleMs = this.options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
    if (idleMs <= 0) return;
    const interval = Math.max(25, Math.floor(idleMs / 4));
    this.idleTimer = setInterval(() => {
      if (
        this.state === "running" &&
        this.leases === 0 &&
        Date.now() - this.lastUsedMs >= idleMs
      ) {
        void this.stopProcess("idle");
      }
    }, interval);
    this.idleTimer.unref?.();
  }

  private clearRunning(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.state = "stopped";
    this.child = undefined;
    this.inner = undefined;
    this.currentBaseURL = undefined;
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const graceMs = this.options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
    timer.unref?.();
    await exited;
    clearTimeout(timer);
  }

  private async stopProcess(reason: "idle" | "explicit"): Promise<void> {
    if (this.state === "stopped") return;
    // Mark stopped first so the exit handler does not report a crash.
    const child = this.child;
    this.clearRunning();
    this.child = child;
    await this.killChild();
    this.child = undefined;
    this.options.onEvent?.({ type: "stopped", reason });
  }

  // ---- leases ----

  private acquire(): void {
    this.leases++;
    this.lastUsedMs = Date.now();
  }

  private release(): void {
    this.leases = Math.max(0, this.leases - 1);
    this.lastUsedMs = Date.now();
  }

  private requireInner(): LanguageModelV3 {
    if (!this.inner) {
      throw new Error("managed server is not running (it may have crashed)");
    }
    return this.inner;
  }

  // ---- LanguageModelV3 ----

  async doGenerate(
    options: LanguageModelV3CallOptions
  ): Promise<LanguageModelV3GenerateResult> {
    this.acquire();
    try {
      await this.ensureStarted();
      return await this.requireInner().doGenerate(options);
    } finally {
      this.release();
    }
  }

  async doStream(
    options: LanguageModelV3CallOptions
  ): Promise<LanguageModelV3StreamResult> {
    this.acquire();
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      this.release();
    };
    try {
      await this.ensureStarted();
      const result = await this.requireInner().doStream(options);
      // The lease is held until the stream settles — close, error, or
      // cancel — so the idle timer can never scale the server to zero
      // while tokens are still flowing.
      const reader = result.stream.getReader();
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        pull: async (controller) => {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              releaseOnce();
              return;
            }
            controller.enqueue(value);
          } catch (error) {
            releaseOnce();
            controller.error(error);
          }
        },
        cancel: (cause) => {
          releaseOnce();
          return reader.cancel(cause);
        }
      });
      return { ...result, stream };
    } catch (error) {
      releaseOnce();
      throw error;
    }
  }
}

/** Create a managed local model server from a prepare hook. */
export function managedModelServer(
  options: ManagedModelServerOptions
): ManagedModelServer {
  return new ManagedModelServer(options);
}

export type MlxServerOptions = {
  /** Hugging Face repo id the server loads (e.g. mlx-community/...). */
  model: string;
  /** Owned-environment configuration, or a pre-built MlxEnv. */
  env?: MlxEnvOptions | MlxEnv;
  /** Extra mlx_lm server flags (e.g. --max-tokens). */
  extraArgs?: string[];
} & Omit<ManagedModelServerOptions, "prepare" | "modelId" | "createModel"> &
  Pick<Partial<ManagedModelServerOptions>, "createModel">;

/**
 * The MLX preset: a managed server whose Python environment is owned by
 * Warrant (see MlxEnv) and whose process is spawned from that env's own
 * interpreter. `handle.env` exposes verify/info/destroy for the footprint.
 */
export function mlxServer(
  options: MlxServerOptions
): ManagedModelServer & { env: MlxEnv } {
  const env =
    options.env instanceof MlxEnv ? options.env : new MlxEnv(options.env);
  const { model, env: _env, extraArgs, ...serverOptions } = options;
  const server = new ManagedModelServer({
    ...serverOptions,
    modelId: model,
    prepare: (port) => env.prepare(model, port, extraArgs ?? [])
  });
  return Object.assign(server, { env });
}
