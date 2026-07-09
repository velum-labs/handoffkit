/**
 * @fusionkit/testkit — cross-stack test tooling (never published).
 *
 * Composable layers for realistic end-to-end tests (see docs/testing.md):
 *
 * - {@link startProviderSim}: the scriptable provider simulator
 *   (python/fusionkit-testkit) as a child process, driven over its HTTP
 *   control plane and observed through its wire journal.
 * - {@link simRouterConfigYaml}: real `fusionkit serve` router configs whose
 *   endpoints all point at the simulator.
 * - {@link startEngine}: the REAL Python fusion engine as a child process —
 *   the same entrypoint the production CLI spawns.
 * - {@link parseSse} / {@link sseText}: structured SSE observation.
 * - {@link detectStackTooling}: honest skip-gating for environments without
 *   the Python toolchain.
 */

export { DOOR_PROFILES, callDoor, doorFrames } from "./doors.js";
export type { DoorProfile, DoorRequestInput, DoorToolCall, DoorToolExchange } from "./doors.js";
export type {
  SimBehavior,
  SimBehaviorInput,
  SimDialect,
  SimError,
  SimJournalEntry,
  SimToolCall
} from "./behaviors.js";
export { asBehavior, simErrors } from "./behaviors.js";
export { startEngine } from "./engine.js";
export type { EngineHandle } from "./engine.js";
export { freePort, spawnCaptured, waitForHttpReady } from "./proc.js";
export type { SpawnedProcess } from "./proc.js";
export { startProviderSim } from "./provider-sim.js";
export type { ProviderSimHandle, SimCallFilter } from "./provider-sim.js";
export { detectStackTooling, repoRoot, stackToolingSkip, uvRunArgv } from "./python.js";
export type { StackTooling } from "./python.js";
export { CODEX_TEST_TOKEN_ENV, simRouterConfigYaml } from "./router-config.js";
export type { SimEndpointSpec } from "./router-config.js";
export { judgeAnalysis, scriptFusedTurn } from "./scenarios.js";
export type { FusedTurnScript } from "./scenarios.js";
export { parseSse, sseDone, sseReasoning, sseText } from "./sse.js";
export type { SseFrame } from "./sse.js";
