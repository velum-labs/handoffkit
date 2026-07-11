import assert from "node:assert/strict";
import { test } from "node:test";

import { render } from "ink-testing-library";

import { ChecklistView, ProgressView, TaskView } from "../ink/components.js";
import type { ChecklistState, ProgressState, TaskState } from "../ink/components.js";
import { ConfirmPrompt, SelectPrompt } from "../ink/prompts.js";
import { Store } from "../ink/store.js";

const ENTER = "\r";
const ARROW_DOWN = "\u001b[B";

function frame(text: string | undefined): string {
  return text ?? "";
}

test("ChecklistView renders steps and live detail updates", async () => {
  const store = new Store<ChecklistState>({
    title: "booting",
    steps: [
      { id: "a", label: "router", status: "active" },
      { id: "b", label: "gateway", status: "pending" }
    ]
  });
  const { lastFrame, unmount } = render(<ChecklistView store={store} />);
  assert.match(frame(lastFrame()), /booting/);
  assert.match(frame(lastFrame()), /router/);
  assert.match(frame(lastFrame()), /gateway/);

  store.set((state) => ({
    ...state,
    steps: state.steps.map((step) => (step.id === "a" ? { ...step, status: "done" as const, detail: "ready" } : step))
  }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(frame(lastFrame()), /ready/);
  unmount();
});

test("TaskView renders the spinner text and settles", async () => {
  const store = new Store<TaskState>({ text: "warming engine" });
  const { lastFrame, unmount } = render(<TaskView store={store} />);
  assert.match(frame(lastFrame()), /warming engine/);
  store.set(() => ({ text: "warming engine", settled: { kind: "success", text: "engine ready" } }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(frame(lastFrame()), /engine ready/);
  unmount();
});

test("ProgressView renders a bar with percent and totals", () => {
  const store = new Store<ProgressState>({
    label: "model",
    downloaded: 512,
    total: 1024,
    startedAt: Date.now() - 1000
  });
  const { lastFrame, unmount } = render(<ProgressView store={store} />);
  assert.match(frame(lastFrame()), /50%/);
  assert.match(frame(lastFrame()), /512 B \/ 1 KB/);
  unmount();
});

test("SelectPrompt navigates with arrows and submits on enter", async () => {
  let submitted: string | undefined;
  const { stdin, unmount } = render(
    <SelectPrompt
      message="Pick a tool"
      options={[
        { value: "codex", label: "codex" },
        { value: "claude", label: "claude" }
      ]}
      defaultIndex={0}
      onSubmit={(value) => {
        submitted = value;
      }}
      onAbort={() => {
        throw new Error("aborted");
      }}
    />
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  stdin.write(ARROW_DOWN);
  await new Promise((resolve) => setTimeout(resolve, 20));
  stdin.write(ENTER);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(submitted, "claude");
  unmount();
});

test("ConfirmPrompt submits the default on enter and toggles with y/n", async () => {
  let answer: boolean | undefined;
  const { stdin, unmount } = render(
    <ConfirmPrompt
      message="Proceed?"
      defaultValue={true}
      onSubmit={(value) => {
        answer = value;
      }}
      onAbort={() => {
        throw new Error("aborted");
      }}
    />
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  stdin.write("n");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(answer, false);
  unmount();
});
