import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  defaultPolicy,
  FileKeyProvider,
  resolveMasterKey,
  SecretStore
} from "@warrant/plane";
import type { MasterKey } from "@warrant/plane";
import type { Policy } from "@warrant/protocol";

export type CliConfig = {
  version: "warrant.config.v2";
  planeUrl: string;
  port: number;
  /** Bind address for `plane start`. Loopback by default. */
  host: string;
  adminToken: string;
  enrollToken: string;
  requestedBy: string;
};

export type WarrantHome = {
  dir: string;
  config: CliConfig;
  policy: Policy;
  master: MasterKey;
  planePublicKeyPem: string;
  planePrivateKeyPem: string;
};

export type InitOptions = {
  port?: number;
  host?: string;
  /** Public URL clients and runners should use to reach the plane. */
  planeUrl?: string;
};

function masterKeyPath(dir: string): string {
  return join(dir, "master.key");
}

function keyProvider(dir: string, master: MasterKey): FileKeyProvider {
  return new FileKeyProvider(
    master,
    join(dir, "keys", "plane.pub.pem"),
    join(dir, "keys", "plane.key.enc")
  );
}

export function initHome(dir: string, options: InitOptions = {}): WarrantHome {
  mkdirSync(join(dir, "keys"), { recursive: true });
  const configPath = join(dir, "config.json");
  if (existsSync(configPath)) {
    throw new Error(`already initialized: ${configPath} exists`);
  }
  // TODO(hardcoded): default port 7172, host 127.0.0.1
  const port = options.port ?? 7172;
  const host = options.host ?? "127.0.0.1";
  const config: CliConfig = {
    version: "warrant.config.v2",
    planeUrl: options.planeUrl ?? `http://127.0.0.1:${port}`,
    port,
    host,
    adminToken: randomBytes(32).toString("base64url"),
    enrollToken: randomBytes(32).toString("base64url"),
    requestedBy: process.env.USER ?? "operator"
  };
  // Master key: WARRANT_MASTER_KEY if set, otherwise a generated 0600 key
  // file. Config holds no key material, so config alone decrypts nothing.
  const master = resolveMasterKey(masterKeyPath(dir), { createIfMissing: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

  const policy = defaultPolicy();
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy, null, 2));

  const pair = keyProvider(dir, master).ensure();

  return {
    dir,
    config,
    policy,
    master,
    planePublicKeyPem: pair.publicKeyPem,
    planePrivateKeyPem: pair.privateKeyPem
  };
}

export function loadHome(dir: string): WarrantHome {
  const configPath = join(dir, "config.json");
  if (!existsSync(configPath)) {
    throw new Error(`not initialized: run "warrant init" first (missing ${configPath})`);
  }
  const config = JSON.parse(readFileSync(configPath, "utf8")) as CliConfig;
  if (!config.host) config.host = "127.0.0.1";
  const policy = JSON.parse(
    readFileSync(join(dir, "policy.json"), "utf8")
  ) as Policy;
  const master = resolveMasterKey(masterKeyPath(dir));
  const pair = keyProvider(dir, master).getOrgKeyPair();
  return {
    dir,
    config,
    policy,
    master,
    planePublicKeyPem: pair.publicKeyPem,
    planePrivateKeyPem: pair.privateKeyPem
  };
}

export function secretStoreFor(home: WarrantHome): SecretStore {
  return new SecretStore(join(home.dir, "secrets.enc"), home.master);
}
