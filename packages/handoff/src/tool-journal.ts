import { canonicalize, PROTOCOL_VERSIONS, sha256Hex } from "@warrant/protocol";
import type { ToolCallRecord, ToolJournal } from "@warrant/protocol";

export class HandoffToolJournal {
  private readonly entries: ToolCallRecord[] = [];

  get length(): number {
    return this.entries.length;
  }

  append(record: ToolCallRecord): void {
    this.entries.push(record);
  }

  failureCount(): number {
    return this.entries.filter((entry) => entry.error !== undefined).length;
  }

  totalDurationMs(): number {
    return this.entries.reduce((total, entry) => total + entry.durationMs, 0);
  }

  snapshot(): { blob: Buffer; hash: string } | undefined {
    if (this.entries.length === 0) return undefined;
    const journal: ToolJournal = {
      version: PROTOCOL_VERSIONS.toolJournal,
      entries: [...this.entries]
    };
    const blob = Buffer.from(canonicalize(journal), "utf8");
    return { blob, hash: sha256Hex(blob) };
  }
}
