import { randomBytes } from "node:crypto";

import { startGateway } from "../server.js";
import { openSubscriptionRelays } from "./gateway.js";
import type { SubscriptionAccountConfigs } from "./gateway.js";
import { RelayOnlyBackend } from "./relay.js";
import type { SubscriptionRelay, SubscriptionRelayDialect } from "./relay.js";
import { snapshotsToUsage } from "./wire.js";
import type { SubscriptionUsageResponse } from "./wire.js";

export type StartSubscriptionProxyOptions = {
  /** Per-provider account-set configuration (source + selection policy). */
  accounts: SubscriptionAccountConfigs;
  host?: string;
  port?: number;
  /** Ingress proxy token clients must present; generated when omitted. */
  token?: string;
};

/** A running subscription proxy: a native reverse proxy over pooled accounts. */
export type SubscriptionProxy = {
  url(): string;
  port(): number;
  /** The ingress token clients present (and the proxy verifies). */
  readonly token: string;
  /** Which provider relays are live behind this proxy. */
  readonly providers: readonly SubscriptionRelayDialect[];
  /** The live per-account usage snapshot (in-process; no self HTTP call). */
  usage(): SubscriptionUsageResponse;
  close(): Promise<void>;
};

/**
 * Raised when no provider has a usable account, so the proxy would serve
 * nothing. Callers surface the enrollment hint.
 */
export class NoSubscriptionAccountsError extends Error {
  constructor() {
    super(
      "no subscription accounts are available; sign in with the official CLI or enroll an account"
    );
    this.name = "NoSubscriptionAccountsError";
  }
}

function generateToken(): string {
  return `fk-proxy-${randomBytes(24).toString("base64url")}`;
}

/**
 * Start a provider-native subscription proxy in one call: open the configured
 * account sets into relays, front them with a relay-only gateway, and return a
 * handle exposing the URL, ingress token, live usage snapshot, and teardown.
 * The CLI `fusionkit proxy serve` is a thin wrapper over this.
 */
export async function startSubscriptionProxy(
  options: StartSubscriptionProxyOptions
): Promise<SubscriptionProxy> {
  const { relays } = await openSubscriptionRelays({ accounts: options.accounts });
  const live = Object.entries(relays).filter(
    (entry): entry is [SubscriptionRelayDialect, SubscriptionRelay] => entry[1] !== undefined
  );
  if (live.length === 0) throw new NoSubscriptionAccountsError();

  const token = options.token ?? generateToken();
  const gateway = await startGateway({
    backend: new RelayOnlyBackend(),
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    authToken: token,
    subscriptionRelays: relays
  });

  return {
    url: () => gateway.url(),
    port: () => gateway.port(),
    token,
    providers: live.map(([dialect]) => dialect),
    usage: () => snapshotsToUsage(live.map(([, relay]) => relay.snapshot?.())),
    close: () => gateway.close()
  };
}
