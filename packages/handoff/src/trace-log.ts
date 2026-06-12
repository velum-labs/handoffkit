import type { HandoffTraceEvent } from "./handoff.js";

export class HandoffTraceLog {
  private readonly events: HandoffTraceEvent[] = [];

  append(event: HandoffTraceEvent): void {
    this.events.push(event);
  }

  snapshot(): HandoffTraceEvent[] {
    return [...this.events];
  }
}
