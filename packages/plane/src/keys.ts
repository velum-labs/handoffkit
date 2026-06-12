import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync
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

/** Default env var carrying the master key; override via resolveMasterKey. */
export const DEFAULT_MASTER_KEY_ENV = "WARRANT_MASTER_KEY";

/**
 * Decode master-key material. Canonical form is 64 hex chars (32 bytes) —
 * what generateMasterKeyHex produces and what we recommend. A non-hex value
 * is treated as raw UTF-8 bytes (a passphrase). We deliberately do NOT
 * second-guess with base64 decoding, which is what made the order
 * ambiguous: hex or passphrase, nothing in between.
 */
function decodeMaterial(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
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
  options: { createIfMissing?: boolean; envVar?: string } = {}
): MasterKey {
  const fromEnv = process.env[options.envVar ?? DEFAULT_MASTER_KEY_ENV];
  if (fromEnv && fromEnv.length > 0) {
    return { material: decodeMaterial(fromEnv) };
  }
  if (existsSync(keyFilePath)) {
    return { material: decodeMaterial(readFileSync(keyFilePath, "utf8")) };
  }
  if (options.createIfMissing) {
    mkdirSync(dirname(keyFilePath), { recursive: true });
    const hex = generateMasterKeyHex();
    writeFileSync(keyFilePath, hex, { mode: KEY_FILE_MODE });
    return { material: Buffer.from(hex, "hex") };
  }
  throw new Error(
    `no master key: set ${options.envVar ?? DEFAULT_MASTER_KEY_ENV} or provide a key file at ${keyFilePath}`
  );
}

export type SealedBlob = {
  version: "warrant.sealed.v1";
  salt: string;
  iv: string;
  tag: string;
  data: string;
};

// AES-256-GCM sealing parameters. These bind to AES-256 (32-byte key,
// 12-byte GCM IV) and a 16-byte scrypt salt. scrypt uses Node's defaults
// (N=16384, r=8, p=1), which are appropriate for sealing small, infrequent
// payloads (the org key and the secret file). scryptSync is acceptable here
// precisely because these payloads are small and sealed/opened rarely.
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const KEY_FILE_MODE = 0o600;

/** AES-256-GCM with a per-blob scrypt-derived key. */
export function seal(master: MasterKey, plaintext: Buffer): SealedBlob {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(master.material, salt, KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
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

function assertSealedBlob(value: unknown): asserts value is SealedBlob {
  const blob = value as Partial<SealedBlob> | null;
  if (
    !blob ||
    blob.version !== "warrant.sealed.v1" ||
    typeof blob.salt !== "string" ||
    typeof blob.iv !== "string" ||
    typeof blob.tag !== "string" ||
    typeof blob.data !== "string"
  ) {
    throw new Error("sealed blob is malformed or not a warrant.sealed.v1 envelope");
  }
}

export function open(master: MasterKey, blob: SealedBlob): Buffer {
  assertSealedBlob(blob);
  const key = scryptSync(master.material, Buffer.from(blob.salt, "base64"), KEY_BYTES);
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
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  assertSealedBlob(parsed);
  return open(master, parsed);
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

