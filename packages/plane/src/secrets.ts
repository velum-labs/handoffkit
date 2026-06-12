import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { open, seal } from "./keys.js";
import type { MasterKey, SealedBlob } from "./keys.js";

type SecretEntry = {
  value: string;
  updatedAt: string;
};

/**
 * Org secret store: a single AES-256-GCM file sealed with the plane master
 * key (scrypt-derived per write). Values exist in plaintext only in memory
 * and in the broker-to-runner release channel; they never appear in
 * contracts, events, or receipts, and the encryption key is not derivable
 * from config.json alone.
 */
export class SecretStore {
  private readonly path: string;
  private readonly master: MasterKey;

  constructor(path: string, master: MasterKey) {
    this.path = path;
    this.master = master;
  }

  private load(): Record<string, SecretEntry> {
    if (!existsSync(this.path)) return {};
    const blob = JSON.parse(readFileSync(this.path, "utf8")) as SealedBlob;
    const plaintext = open(this.master, blob).toString("utf8");
    return JSON.parse(plaintext) as Record<string, SecretEntry>;
  }

  private save(values: Record<string, SecretEntry>): void {
    const blob = seal(this.master, Buffer.from(JSON.stringify(values), "utf8"));
    writeFileSync(this.path, JSON.stringify(blob), { mode: 0o600 });
  }

  set(name: string, value: string): void {
    const values = this.load();
    values[name] = { value, updatedAt: new Date().toISOString() };
    this.save(values);
  }

  /** Rotate a secret's value, preserving its name; errors if absent. */
  rotate(name: string, value: string): void {
    const values = this.load();
    if (values[name] === undefined) {
      throw new Error(`secret "${name}" is not in the store`);
    }
    values[name] = { value, updatedAt: new Date().toISOString() };
    this.save(values);
  }

  remove(name: string): boolean {
    const values = this.load();
    if (values[name] === undefined) return false;
    delete values[name];
    this.save(values);
    return true;
  }

  names(): string[] {
    return Object.keys(this.load()).sort();
  }

  release(names: string[]): { name: string; value: string }[] {
    const values = this.load();
    return names.map((name) => {
      const entry = values[name];
      if (entry === undefined) {
        throw new Error(`secret "${name}" is not in the store`);
      }
      return { name, value: entry.value };
    });
  }
}
