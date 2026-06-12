import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { generateEd25519KeyPair } from "@warrant/protocol";

/**
 * A master key protects everything the plane stores at rest (the org
 * signing key, the secret store). It is supplied out-of-band via the
 * WARRANT_MASTER_KEY environment variable, or persisted to a 0600 key file
 * generated at init. It is never written into config.json, so config alone
 * is not enough to decrypt anything.
 */
export type MasterKey = { readonly material: Buffer };

// TODO(hardcoded): master-key env var name is fixed; not overridable for multi-tenant or test harnesses.
const MASTER_KEY_ENV = "WARRANT_MASTER_KEY";

function decodeMaterial(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
  // TODO(brittle): ambiguous decode order (hex → base64 → utf8) can misinterpret keys; prefer one canonical encoding.
  try {
    const b = Buffer.from(trimmed, "base64");
    if (b.length >= 16) return b;
  } catch {
    // fall through
  }
  return Buffer.from(trimmed, "utf8");
}

export function generateMasterKeyHex(): string {
  return randomBytes(32).toString("hex");
}

/** Build a MasterKey from raw material (hex/base64/utf8); for tests and CLI. */
export function masterKeyFromMaterial(raw: string): MasterKey {
  return { material: decodeMaterial(raw) };
}

/**
 * Resolve the master key: WARRANT_MASTER_KEY if set, otherwise the key file
 * at `keyFilePath`. When `createIfMissing` is true and neither exists, a new
 * key is generated and written to the key file (mode 0600).
 */
export function resolveMasterKey(
  keyFilePath: string,
  options: { createIfMissing?: boolean } = {}
): MasterKey {
  const fromEnv = process.env[MASTER_KEY_ENV];
  if (fromEnv && fromEnv.length > 0) {
    return { material: decodeMaterial(fromEnv) };
  }
  if (existsSync(keyFilePath)) {
    return { material: decodeMaterial(readFileSync(keyFilePath, "utf8")) };
  }
  if (options.createIfMissing) {
    mkdirSync(dirname(keyFilePath), { recursive: true });
    const hex = generateMasterKeyHex();
    writeFileSync(keyFilePath, hex, { mode: 0o600 }); // TODO(hardcoded): key file mode 0o600 is not configurable.
    return { material: Buffer.from(hex, "hex") };
  }
  throw new Error(
    `no master key: set ${MASTER_KEY_ENV} or provide a key file at ${keyFilePath}`
  );
}

export type SealedBlob = {
  version: "warrant.sealed.v1";
  salt: string;
  iv: string;
  tag: string;
  data: string;
};

/** AES-256-GCM with a per-blob scrypt-derived key. */
export function seal(master: MasterKey, plaintext: Buffer): SealedBlob {
  // TODO(hardcoded): scrypt N/r/p defaults, salt (16B), IV (12B), and key length (32) are not tunable or documented here.
  const salt = randomBytes(16);
  // TODO(brittle): scryptSync blocks the event loop on every seal/open; use async scrypt or worker thread for large payloads.
  const key = scryptSync(master.material, salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: "warrant.sealed.v1",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64")
  };
}

export function open(master: MasterKey, blob: SealedBlob): Buffer {
  const key = scryptSync(master.material, Buffer.from(blob.salt, "base64"), 32);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(blob.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(blob.data, "base64")),
    decipher.final()
  ]);
}

export function sealToFile(
  master: MasterKey,
  path: string,
  plaintext: Buffer
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(seal(master, plaintext)), { mode: 0o600 });
}

export function openFromFile(master: MasterKey, path: string): Buffer {
  // TODO(brittle): SealedBlob JSON is parsed without schema validation; corrupt/tampered files fail opaquely at decrypt.
  const blob = JSON.parse(readFileSync(path, "utf8")) as SealedBlob;
  return open(master, blob);
}

export type OrgKeyPair = { publicKeyPem: string; privateKeyPem: string };

/**
 * Source of the org signing key pair. The private key is held in memory by
 * the plane but stored encrypted at rest by the provider. External KMS
 * integrations implement this same interface.
 */
export interface KeyProvider {
  getOrgKeyPair(): OrgKeyPair;
}

/**
 * File-backed key provider: public key in PEM, private key sealed with the
 * master key. Generates a fresh key pair on first use when allowed.
 */
export class FileKeyProvider implements KeyProvider {
  constructor(
    private readonly master: MasterKey,
    private readonly publicKeyPath: string,
    private readonly privateKeySealedPath: string
  ) {}

  ensure(): OrgKeyPair {
    if (
      existsSync(this.publicKeyPath) &&
      existsSync(this.privateKeySealedPath)
    ) {
      return this.getOrgKeyPair();
    }
    const pair = generateEd25519KeyPair();
    mkdirSync(dirname(this.publicKeyPath), { recursive: true });
    writeFileSync(this.publicKeyPath, pair.publicKeyPem, { mode: 0o600 });
    sealToFile(
      this.master,
      this.privateKeySealedPath,
      Buffer.from(pair.privateKeyPem, "utf8")
    );
    return pair;
  }

  getOrgKeyPair(): OrgKeyPair {
    return {
      publicKeyPem: readFileSync(this.publicKeyPath, "utf8"),
      privateKeyPem: openFromFile(
        this.master,
        this.privateKeySealedPath
      ).toString("utf8")
    };
  }
}

/** Constant-time token comparison to avoid leaking match position via timing. */
export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
