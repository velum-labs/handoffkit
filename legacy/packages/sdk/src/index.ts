/**
 * @fusionkit/sdk is a thin client over the governance plane API.
 *
 * Protocol primitives such as verification, hashing, and wire types live in
 * @fusionkit/protocol. Consumers import them from the protocol package rather
 * than through this SDK.
 */
export { PlaneClient, PlaneClientError } from "./client.js";
