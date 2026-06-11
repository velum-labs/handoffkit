import { createHash } from "node:crypto";

import { canonicalize } from "./jcs.js";

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Content hash of a protocol object: sha256 over its canonical JSON. */
export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalize(value));
}
