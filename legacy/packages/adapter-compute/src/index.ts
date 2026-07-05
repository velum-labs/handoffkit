/**
 * @fusionkit/adapter-compute is a ComputeSDK-shaped compute surface over
 * governed runner sessions.
 *
 * The shape matches what ComputeSDK users already write: compute.sandbox.create,
 * sandbox.runCommand, and sandbox.filesystem.writeFile. The substrate is
 * FusionKit governance: every command is a signed run contract executed in a
 * governed session with an offline-verifiable receipt.
 *
 * Each command runs in a fresh session materialized from the current workspace
 * state. Continuity flows through the workspace's git history, not through a
 * long-lived remote process. The adapter stages inputs as commits and pulls
 * outputs back after each command, so sequential commands compose. A
 * filesystem.writeFile call stages input files locally for the next command; it
 * is not a remote mutation because nothing exists remotely between commands.
 */
export { governedCompute, GovernedSandbox, withCompute } from "./sandbox.js";
export type {
  CommandResult,
  GovernedCompute,
  GovernedComputeConfig,
  SandboxRunRecord
} from "./sandbox.js";
