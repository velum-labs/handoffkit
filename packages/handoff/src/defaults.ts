/**
 * Shared polling and identity defaults used by Handoff.stream and
 * HandoffRun.wait so the two code paths cannot drift apart.
 *
 * The plane API is deliberately poll-based (plain, stateless HTTP): these
 * intervals are the supported transport, and both consumers accept
 * per-call overrides (`pollMs` / `timeoutMs`).
 */

/** Interval between status polls. */
export const DEFAULT_POLL_INTERVAL_MS = 300;
/** Default ceiling for HandoffRun.wait. */
export const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
/** Default ceiling for Handoff.stream. */
export const DEFAULT_STREAM_TIMEOUT_MS = 10 * 60 * 1000;
/** Actor id recorded when no actor is configured and USER is unset. */
export const DEFAULT_ACTOR_ID = "developer";
/** Concurrent blob uploads during workspace checkpointing. */
export const BLOB_UPLOAD_CONCURRENCY = 4;
