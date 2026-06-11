import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify
} from "node:crypto";

import { sha256Hex } from "./hash.js";

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

/** Stable identifier for a public key: sha256 of its PEM, truncated. */
export function keyIdFromPublicPem(publicKeyPem: string): string {
  return `ed25519:${sha256Hex(publicKeyPem.trim()).slice(0, 16)}`;
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
