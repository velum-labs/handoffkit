/**
 * A single-consumer async channel: producers `push` values (or `close`), the
 * consumer drains them via `[Symbol.asyncIterator]`. Used by transport-driven
 * drivers (ACP, SSE) to bridge notification callbacks into the `sendTurn`
 * async iterable.
 */
export class AsyncChannel<T> {
  readonly #queue: T[] = [];
  #waiter: ((result: IteratorResult<T>) => void) | undefined;
  #closed = false;
  #error: unknown;

  push(value: T): void {
    if (this.#closed) return;
    if (this.#waiter !== undefined) {
      const resolve = this.#waiter;
      this.#waiter = undefined;
      resolve({ value, done: false });
      return;
    }
    this.#queue.push(value);
  }

  close(error?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    if (this.#waiter !== undefined) {
      const resolve = this.#waiter;
      this.#waiter = undefined;
      if (error !== undefined) {
        // Surface the error on the next() call site.
        resolve({ value: undefined as never, done: true });
      } else {
        resolve({ value: undefined as never, done: true });
      }
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.#queue.length > 0) {
        yield this.#queue.shift() as T;
        continue;
      }
      if (this.#closed) {
        if (this.#error !== undefined) throw this.#error;
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.#waiter = resolve;
      });
      if (next.done === true) {
        if (this.#error !== undefined) throw this.#error;
        return;
      }
      yield next.value;
    }
  }
}
