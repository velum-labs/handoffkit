import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify
} from "node:crypto";

import { sha256Hex } from "@routekit/contracts";

import { KEY_ID_HEX_LENGTH } from "./constants.js";

export type KeyPairPem = {
  publicKeyPem: string;
  privateKeyPem: string;
};

export function generateEd25519KeyPair(): KeyPairPem {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString()
  };
}

/**
 * Stable identifier for a public key: the algorithm tag plus a truncated
 * SHA-256 fingerprint of its PEM. The fingerprint length is a deliberate,
 * shared constant (KEY_ID_HEX_LENGTH) — 64 bits is ample to identify an
 * enrolled key while keeping ids short.
 */
export function keyIdFromPublicPem(publicKeyPem: string): string {
  return `ed25519:${sha256Hex(publicKeyPem.trim()).slice(0, KEY_ID_HEX_LENGTH)}`;
}

export function signData(privateKeyPem: string, data: string | Buffer): string {
  const key = createPrivateKey(privateKeyPem);
  const payload = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return cryptoSign(null, payload, key).toString("base64");
}

export function verifyData(
  publicKeyPem: string,
  data: string | Buffer,
  signatureB64: string
): boolean {
  const key = createPublicKey(publicKeyPem);
  const payload = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  try {
    return cryptoVerify(null, payload, key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}
