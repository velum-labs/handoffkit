/**
 * Warrant SDK: a thin client over the plane API plus the protocol
 * primitives needed to verify receipts without trusting the plane.
 */
export { PlaneClient, PlaneClientError } from "./client.js";
export type { RunRequestInput, RunView } from "./client.js";
export { verifyReceiptBundle } from "../protocol/receipt.js";
export { verifyChain } from "../protocol/chain.js";
export { contractHash } from "../protocol/contract.js";
export { canonicalize } from "../protocol/jcs.js";
export { hashCanonical, sha256Hex } from "../protocol/hash.js";
export {
  generateEd25519KeyPair,
  keyIdFromPublicPem,
  signData,
  verifyData
} from "../protocol/keys.js";
export { PolicyDeniedError } from "../protocol/types.js";
export type {
  AgentKind,
  ChainedEvent,
  DisclosureMode,
  Policy,
  Receipt,
  ReceiptBundle,
  RunContract,
  RunEvent,
  RunStatus,
  WorkspaceManifest
} from "../protocol/types.js";
