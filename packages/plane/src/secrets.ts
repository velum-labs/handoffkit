import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type EncryptedFile = {
  version: "warrant.secrets.v1";
  iv: string;
  tag: string;
  data: string;
};

/**
 * Org secret store: a single AES-256-GCM encrypted JSON file.
 * Values exist in plaintext only in memory and in the broker-to-runner
 * release channel; they never appear in contracts, events, or receipts.
 */
export class SecretStore {
  private readonly path: string;
  private readonly key: Buffer;

  constructor(path: string, keyHex: string) {
    if (!/^[0-9a-f]{64}$/.test(keyHex)) {
      throw new Error("secret store key must be 32 bytes of hex");
    }
    this.path = path;
    this.key = Buffer.from(keyHex, "hex");
  }

  static generateKeyHex(): string {
    return randomBytes(32).toString("hex");
  }

  private load(): Record<string, string> {
    if (!existsSync(this.path)) return {};
    const file = JSON.parse(readFileSync(this.path, "utf8")) as EncryptedFile;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(file.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(file.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(file.data, "base64")),
      decipher.final()
    ]);
    return JSON.parse(plaintext.toString("utf8")) as Record<string, string>;
  }

  private save(values: Record<string, string>): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(values), "utf8")),
      cipher.final()
    ]);
    const file: EncryptedFile = {
      version: "warrant.secrets.v1",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64")
    };
    writeFileSync(this.path, JSON.stringify(file), { mode: 0o600 });
  }

  set(name: string, value: string): void {
    const values = this.load();
    values[name] = value;
    this.save(values);
  }

  names(): string[] {
    return Object.keys(this.load()).sort();
  }

  release(names: string[]): { name: string; value: string }[] {
    const values = this.load();
    return names.map((name) => {
      const value = values[name];
      if (value === undefined) {
        throw new Error(`secret "${name}" is not in the store`);
      }
      return { name, value };
    });
  }
}
