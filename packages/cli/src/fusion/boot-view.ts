/**
 * The live boot checklist: one row per panel server, an optional synthesizer
 * row, and the gateway row. Maps {@link StackEvent}s onto the presenter's
 * checklist surface so the user watches the real stack come up (spinners,
 * elapsed time, check marks) instead of staring at a silent pause — and the
 * checklist settles cleanly before the coding agent inherits the terminal.
 */
import { createPresenter } from "@velum-labs/routekit-cli-ui";
import type { Presenter, StepInput } from "@velum-labs/routekit-cli-ui";

import type { StackEvent, StackReporter } from "./env.js";

export type BootView = {
  /** Feed this to `startFusionStack({ report })` to drive the live checklist. */
  report: StackReporter;
  /** Settle the checklist and leave the final frame in place. */
  stop: () => void;
};

export type BootServer = { id: string; label: string };

export function createBootView(
  input: {
    servers: readonly BootServer[];
    includeSynth: boolean;
    includeDashboard?: boolean;
    title?: string;
  },
  presenter: Presenter = createPresenter()
): BootView {
  const steps: StepInput[] = [
    ...(input.includeDashboard === true ? [{ id: "dashboard", label: "observability dashboard" }] : []),
    ...input.servers.map((server) => ({ id: `srv:${server.id}`, label: `panel · ${server.label}` })),
    ...(input.includeSynth ? [{ id: "synth", label: "synthesizer (fusionkit serve)" }] : []),
    { id: "gw", label: "fusion gateway" }
  ];
  const list = presenter.checklist(steps, input.title !== undefined ? { title: input.title } : {});

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
