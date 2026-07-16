import type { ToolLaunchContext, ToolLaunchSpec } from "./types.js";

export type ToolDisposer = () => void | Promise<void>;

export type DisposerRunner = {
  register(dispose: ToolDisposer): void;
  run(): Promise<void>;
};

/** Collect teardown callbacks and run them once in reverse registration order. */
export function createDisposerRunner(): DisposerRunner {
  const disposers: ToolDisposer[] = [];
  let running: Promise<void> | undefined;
  let started = false;
  return {
    register: (dispose) => {
      if (started) throw new Error("cannot register a disposer after teardown started");
      disposers.push(dispose);
    },
    run: () => {
      if (!started) {
        started = true;
        running = (async () => {
          const errors: unknown[] = [];
          for (
            let dispose = disposers.pop();
            dispose !== undefined;
            dispose = disposers.pop()
          ) {
            try {
              await dispose();
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length === 1) throw errors[0];
          if (errors.length > 1) throw new AggregateError(errors, "tool launch teardown failed");
        })();
      }
      return running!;
    }
  };
}

export type CreateToolLaunchContextInput = {
  spec: ToolLaunchSpec;
  log: ToolLaunchContext["log"];
  prepareForPassthrough: ToolLaunchContext["prepareForPassthrough"];
  registerPort: ToolLaunchContext["registerPort"];
  unregisterPort: ToolLaunchContext["unregisterPort"];
};

export type ToolLaunchContextHandle = {
  context: ToolLaunchContext;
  dispose(): Promise<void>;
};

/** Pair host lifecycle services with a launch spec and one disposer runner. */
export function createToolLaunchContext(
  input: CreateToolLaunchContextInput
): ToolLaunchContextHandle {
  const disposers = createDisposerRunner();
  return {
    context: {
      spec: input.spec,
      log: input.log,
      prepareForPassthrough: input.prepareForPassthrough,
      registerPort: input.registerPort,
      unregisterPort: input.unregisterPort,
      registerDisposer: disposers.register
    },
    dispose: disposers.run
  };
}
