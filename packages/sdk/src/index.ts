/**
 * @warrant/sdk — a thin client over the plane API. Protocol primitives
 * (verification, hashing, wire types) live in @warrant/protocol; consumers
 * import them from there rather than through this package.
 */
export { PlaneClient, PlaneClientError } from "./client.js";
