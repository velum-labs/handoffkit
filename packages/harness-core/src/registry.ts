import { HarnessError } from "./errors.js";
import type { AnyHarnessDriver, DriverContext, HarnessInstance } from "./contract.js";
import type { HarnessKind } from "./kinds.js";

/**
 * Explicit driver registry: drivers are registered by the composition root
 * (CLI entrypoint, test setup), never via module-import side effects or
 * mutable module-level globals.
 */
export class DriverRegistry {
  readonly #drivers = new Map<HarnessKind, AnyHarnessDriver>();

  register(driver: AnyHarnessDriver): this {
    if (this.#drivers.has(driver.kind)) {
      throw new Error(`harness driver already registered for kind "${driver.kind}"`);
    }
    this.#drivers.set(driver.kind, driver);
    return this;
  }

  get(kind: HarnessKind): AnyHarnessDriver | undefined {
    return this.#drivers.get(kind);
  }

  list(): readonly AnyHarnessDriver[] {
    return [...this.#drivers.values()];
  }

  /**
   * Decode the raw config through the driver's own schema (exactly once,
   * here) and create an instance. Unknown kinds and config decode failures
   * are classified `HarnessError`s, not bare throws.
   */
  async createInstance(
    kind: HarnessKind,
    rawConfig: unknown,
    context?: DriverContext
  ): Promise<HarnessInstance> {
    const driver = this.#drivers.get(kind);
    if (driver === undefined) {
      throw new HarnessError("invalid_config", `no harness driver registered for kind "${kind}"`);
    }
    const decoded = driver.configSchema.safeParse(rawConfig);
    if (!decoded.success) {
      throw new HarnessError(
        "invalid_config",
        `invalid ${kind} driver config: ${decoded.error.message}`,
        { cause: decoded.error }
      );
    }
    return driver.createInstance(decoded.data, context);
  }
}
