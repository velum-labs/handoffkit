/**
 * A minimal external store the imperative presenter controllers mutate and Ink
 * components subscribe to (via `useSyncExternalStore`), bridging the CLI's
 * imperative call sites with React's declarative rendering.
 */
export class Store<T> {
  private state: T;
  private readonly listeners = new Set<() => void>();

  constructor(initial: T) {
    this.state = initial;
  }

  get = (): T => this.state;

  set = (updater: (previous: T) => T): void => {
    this.state = updater(this.state);
    for (const listener of this.listeners) listener();
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}
