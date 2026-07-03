/**
 * The process runtime drivers build on, re-exported so a driver package
 * depends only on `@fusionkit/harness-core`: allowlisted child envs, capture
 * runs with group-kill + SIGTERM->SIGKILL escalation, logged long-lived
 * children, readiness helpers, and port allocation.
 */
export {
  buildChildEnv,
  freePort,
  runCliCapture,
  spawnLogged,
  terminate,
  waitForHttp,
  waitForOutput,
  withDeadline,
  withTimeout
} from "@fusionkit/runtime-utils";
export type {
  BuildChildEnvInput,
  CliCaptureOptions,
  CliCaptureResult,
  LoggedChild,
  LoggedSpawnOptions
} from "@fusionkit/runtime-utils";
