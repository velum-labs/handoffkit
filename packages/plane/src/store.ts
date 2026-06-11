import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { sha256Hex } from "@warrant/protocol";
import type {
  ActorRef,
  ChainedEvent,
  Receipt,
  RunContract,
  RunRequest,
  RunStatus
} from "@warrant/protocol";

export type { RunRequest };

export type RunRecord = {
  id: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  request: RunRequest;
  consentRequirements: string[];
  approvals: { actor: ActorRef; ts: string }[];
  contract?: RunContract;
  claimedBy?: string;
  failureMessage?: string;
};

export type RunnerRecord = {
  runnerId: string;
  pool: string;
  publicKeyPem: string;
  tokenHash: string;
  enrolledAt: string;
};

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export class FsStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    for (const dir of ["runs", "blobs", "keys"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
  }

  private runDir(runId: string): string {
    const dir = join(this.root, "runs", runId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  saveRun(record: RunRecord): void {
    writeJsonAtomic(join(this.runDir(record.id), "run.json"), record);
  }

  getRun(runId: string): RunRecord | undefined {
    const path = join(this.root, "runs", runId, "run.json");
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as RunRecord;
  }

  listRunIds(): string[] {
    return readdirSync(join(this.root, "runs"));
  }

  appendEvents(runId: string, events: ChainedEvent[]): void {
    const path = join(this.runDir(runId), "events.jsonl");
    const lines = events.map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(path, lines + "\n", { flag: "a" });
  }

  getEvents(runId: string): ChainedEvent[] {
    const path = join(this.root, "runs", runId, "events.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as ChainedEvent);
  }

  saveReceipt(runId: string, receipt: Receipt): void {
    writeJsonAtomic(join(this.runDir(runId), "receipt.json"), receipt);
  }

  getReceipt(runId: string): Receipt | undefined {
    const path = join(this.root, "runs", runId, "receipt.json");
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as Receipt;
  }

  putBlob(content: Buffer): string {
    const hash = sha256Hex(content);
    const path = join(this.root, "blobs", hash);
    if (!existsSync(path)) writeFileSync(path, content);
    return hash;
  }

  getBlob(hash: string): Buffer | undefined {
    if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
    const path = join(this.root, "blobs", hash);
    if (!existsSync(path)) return undefined;
    return readFileSync(path);
  }

  saveRunners(runners: RunnerRecord[]): void {
    writeJsonAtomic(join(this.root, "runners.json"), runners);
  }

  getRunners(): RunnerRecord[] {
    const path = join(this.root, "runners.json");
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, "utf8")) as RunnerRecord[];
  }

  saveKeyFile(name: string, pem: string): void {
    writeFileSync(join(this.root, "keys", name), pem, { mode: 0o600 });
  }

  getKeyFile(name: string): string | undefined {
    const path = join(this.root, "keys", name);
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf8");
  }
}
