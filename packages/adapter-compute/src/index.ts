/**
 * @warrant/adapter-compute — a ComputeSDK-shaped compute surface over
 * governed runner sessions.
 *
 * The shape matches what ComputeSDK users already write —
 * `compute.sandbox.create()`, `sandbox.runCommand(...)`,
 * `sandbox.filesystem.writeFile(...)` — but the substrate is Warrant:
 * every command is a signed run contract executed in a governed session
 * with an offline-verifiable receipt. Honest semantics, stated plainly:
 *
 * - Each command runs in a *fresh* session materialized from the current
 *   workspace state; continuity flows through the workspace's git history,
 *   not through a long-lived remote process.
 * - The adapter stages inputs as commits and pulls outputs back after each
 *   command, so sequential commands compose.
 * - `filesystem.writeFile` stages input files locally for the next command;
 *   it is not a remote mutation (nothing exists remotely between commands).
 */
export { governedCompute, GovernedSandbox } from "./sandbox.js";
export type {
  CommandResult,
  GovernedCompute,
  GovernedComputeConfig,
  SandboxRunRecord
} from "./sandbox.js";
