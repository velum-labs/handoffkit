import type { StackEvent, StackReporter } from "../fusion-quickstart.js";

import { StepList } from "./steps.js";
import type { StepInput } from "./steps.js";

export type BootView = {
  /** Feed this to `startFusionStack({ report })` to drive the live checklist. */
  report: StackReporter;
  /** Settle the checklist and leave the final frame in place. */
  stop: () => void;
};

export type BootServer = { id: string; label: string };

/**
 * A live boot checklist: one row per panel server, an optional synthesizer row,
 * and the gateway row. Maps {@link StackEvent}s onto a {@link StepList} so the
 * user watches the real stack come up (spinners, elapsed time, check marks)
 * instead of staring at a silent pause.
 */
export function createBootView(input: {
  servers: readonly BootServer[];
  includeSynth: boolean;
  includeDashboard?: boolean;
  title?: string;
}): BootView {
  const steps: StepInput[] = [
    ...(input.includeDashboard === true ? [{ id: "dashboard", label: "observability dashboard" }] : []),
    ...input.servers.map((server) => ({ id: `srv:${server.id}`, label: `panel · ${server.label}` })),
    ...(input.includeSynth ? [{ id: "synth", label: "synthesizer (fusionkit serve)" }] : []),
    { id: "gw", label: "fusion gateway" }
  ];
  const list = new StepList(steps, input.title !== undefined ? { title: input.title } : {});
  list.start();

  const report: StackReporter = (event: StackEvent) => {
    switch (event.kind) {
      case "dashboard.start":
        list.setActive("dashboard");
        break;
      case "dashboard.ready":
        list.setDone("dashboard", event.detail);
        break;
      case "dashboard.fail":
        list.setFailed("dashboard", event.detail);
        break;
      case "server.start":
        list.setActive(`srv:${event.id}`);
        break;
      case "server.progress":
        list.setDetail(`srv:${event.id}`, event.detail);
        break;
      case "server.ready":
        list.setDone(`srv:${event.id}`, event.detail);
        break;
      case "server.fail":
        list.setFailed(`srv:${event.id}`, event.detail);
        break;
      case "synth.start":
        list.setActive("synth");
        break;
      case "synth.ready":
        list.setDone("synth", event.detail);
        break;
      case "gateway.start":
        list.setActive("gw");
        break;
      case "gateway.ready":
        list.setDone("gw", event.detail);
        break;
      default: {
        const exhaustive: never = event;
        throw new Error(`unknown stack event: ${String(exhaustive)}`);
      }
    }
  };

  return { report, stop: () => list.stop() };
}
