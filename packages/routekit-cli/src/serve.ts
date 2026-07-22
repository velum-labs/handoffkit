import type { Gateway, RouterConfig } from "@routekit/gateway";
import { startRouter as startEmbeddedRouter } from "@routekit/router";

import { registerService } from "./state.js";
import type { ServiceRegistration } from "./state.js";

export type RouterServeOptions = {
  config: RouterConfig;
  host?: string;
  port?: number;
  authToken?: string;
  env?: NodeJS.ProcessEnv;
  portless?: boolean;
  register?: boolean;
  /** SIGTERM drain window for in-flight requests (ms). */
  drainGraceMs?: number;
};

export type RunningRouter = {
  gateway: Gateway;
  url: string;
  close(): Promise<void>;
};

export async function startRouter(options: RouterServeOptions): Promise<RunningRouter> {
  const running = await startEmbeddedRouter({
    config: options.config,
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.drainGraceMs !== undefined ? { drainGraceMs: options.drainGraceMs } : {})
  });

  let registration: ServiceRegistration | undefined;
  if (options.register !== false) {
    registration = await registerService({
      kind: "gateway",
      loopbackUrl: running.gateway.url(),
      port: running.gateway.port(),
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
      ...(options.portless !== undefined ? { portless: options.portless } : {})
    });
  }
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await registration?.release();
    await running.close();
  };
  return {
    gateway: running.gateway,
    url: registration?.url ?? running.url,
    close
  };
}

export async function waitForShutdown(): Promise<never> {
  return await new Promise<never>(() => undefined);
}
