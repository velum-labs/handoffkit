/**
 * Process-wide cleanup registry (WS7.1).
 *
 * A single LIFO stack of teardown callbacks that runs on normal exit and on
 * SIGINT/SIGTERM, so a crashing or interrupted CLI still removes its worktrees,
 * kills its supervised process groups, and releases other resources instead of
 * leaking them. Importing this module installs the signal/exit handlers exactly
 * once; the handlers re-raise the conventional exit code (130 for SIGINT, 143
 * for SIGTERM) after cleanups have run.
 */

/** Whole-run bound: no shutdown may block longer than this on cleanups. */
const HARD_TIMEOUT_MS = 5_000;

/**
 * Effective shutdown bound. Long-lived services with a drain window (e.g. a
 * gateway finishing in-flight LLM streams) may extend it; the default stays
 * tight so interactive CLIs exit promptly.
 */
let hardTimeoutMs = HARD_TIMEOUT_MS;

/** Raise (never lower) the shutdown bound to cover a service's drain grace. */
export function extendCleanupGrace(ms: number): void {
  hardTimeoutMs = Math.max(hardTimeoutMs, ms);
}

/** Conventional exit codes: 128 + signal number (SIGINT=2, SIGTERM=15). */
const SIGINT_EXIT_CODE = 130;
const SIGTERM_EXIT_CODE = 143;

type CleanupFn = () => void | Promise<void>;

const registry: CleanupFn[] = [];
let started = false;
let installed = false;
let signalReceived = false;

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`cleanup callback failed: ${message}\n`);
}

/**
 * Register a teardown callback. Returns an idempotent unregister function that
 * removes the callback before it fires (e.g. a supervised child unregisters its
 * group-kill once it exits cleanly).
 */
export function registerCleanup(fn: CleanupFn): () => void {
  installSignalHandlers();
  registry.push(fn);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const index = registry.lastIndexOf(fn);
    if (index >= 0) registry.splice(index, 1);
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * Run every registered cleanup once, LIFO, swallowing (but logging) individual
 * errors. The whole run is bounded by {@link HARD_TIMEOUT_MS} so a hung async
 * callback cannot stall shutdown. Idempotent: a second call is a no-op.
 */
export async function runCleanups(): Promise<void> {
  if (started) return;
  started = true;
  const callbacks = registry.splice(0).reverse();
  const runAll = (async () => {
    for (const callback of callbacks) {
      try {
        await callback();
      } catch (error) {
        reportError(error);
      }
    }
  })();
  await Promise.race([runAll, delay(hardTimeoutMs)]);
}

/**
 * The synchronous slice of {@link runCleanups}, for the `exit` handler where the
 * event loop is already closed: each callback is invoked and any returned
 * promise is abandoned (only synchronous work can complete during `exit`).
 */
function runCleanupsSync(): void {
  if (started) return;
  started = true;
  const callbacks = registry.splice(0).reverse();
  for (const callback of callbacks) {
    try {
      void callback();
    } catch (error) {
      reportError(error);
    }
  }
}

function handleTerminationSignal(exitCode: number): void {
  // A second signal (e.g. an impatient Ctrl+C during a drain) must not be
  // swallowed: skip the remaining grace and exit right away.
  if (signalReceived) {
    process.exit(exitCode);
  }
  signalReceived = true;
  // Never wedge on shutdown: force the exit even if the cleanup run somehow
  // outlives its own bound. Unref'd so it cannot itself keep the loop alive.
  const forced = setTimeout(() => process.exit(exitCode), hardTimeoutMs + 2_000);
  forced.unref();
  void runCleanups().finally(() => process.exit(exitCode));
}

function installSignalHandlers(): void {
  if (installed) return;
  installed = true;
  // Signal listeners replace Node's default (which would exit immediately) so
  // cleanups run first; `exit` covers the normal-termination path. None of
  // these keep the event loop alive on their own.
  process.on("SIGINT", () => handleTerminationSignal(SIGINT_EXIT_CODE));
  process.on("SIGTERM", () => handleTerminationSignal(SIGTERM_EXIT_CODE));
  process.on("exit", () => runCleanupsSync());
}

installSignalHandlers();
