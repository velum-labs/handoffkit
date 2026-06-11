import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { generateEd25519KeyPair } from "../protocol/keys.js";
import type { Policy } from "../protocol/types.js";
import { defaultPolicy } from "../plane/policy.js";
import { SecretStore } from "../plane/secrets.js";

export type CliConfig = {
  version: "warrant.config.v1";
  planeUrl: string;
  port: number;
  adminToken: string;
  enrollToken: string;
  secretsKeyHex: string;
  requestedBy: string;
};

export type WarrantHome = {
  dir: string;
  config: CliConfig;
  policy: Policy;
  planePublicKeyPem: string;
  planePrivateKeyPem: string;
};

export function initHome(dir: string): WarrantHome {
  mkdirSync(join(dir, "keys"), { recursive: true });
  const configPath = join(dir, "config.json");
  if (existsSync(configPath)) {
    throw new Error(`already initialized: ${configPath} exists`);
  }
  const port = 7172;
  const config: CliConfig = {
    version: "warrant.config.v1",
    planeUrl: `http://127.0.0.1:${port}`,
    port,
    adminToken: randomBytes(32).toString("base64url"),
    enrollToken: randomBytes(32).toString("base64url"),
    secretsKeyHex: SecretStore.generateKeyHex(),
    requestedBy: process.env.USER ?? "operator"
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

  const policy = defaultPolicy();
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy, null, 2));

  const keys = generateEd25519KeyPair();
  writeFileSync(join(dir, "keys", "plane.pub.pem"), keys.publicKeyPem, {
    mode: 0o600
  });
  writeFileSync(join(dir, "keys", "plane.key.pem"), keys.privateKeyPem, {
    mode: 0o600
  });

  return {
    dir,
    config,
    policy,
    planePublicKeyPem: keys.publicKeyPem,
    planePrivateKeyPem: keys.privateKeyPem
  };
}

export function loadHome(dir: string): WarrantHome {
  const configPath = join(dir, "config.json");
  if (!existsSync(configPath)) {
    throw new Error(`not initialized: run "warrant init" first (missing ${configPath})`);
  }
  const config = JSON.parse(readFileSync(configPath, "utf8")) as CliConfig;
  const policy = JSON.parse(
    readFileSync(join(dir, "policy.json"), "utf8")
  ) as Policy;
  return {
    dir,
    config,
    policy,
    planePublicKeyPem: readFileSync(join(dir, "keys", "plane.pub.pem"), "utf8"),
    planePrivateKeyPem: readFileSync(join(dir, "keys", "plane.key.pem"), "utf8")
  };
}

export function secretStoreFor(home: WarrantHome): SecretStore {
  return new SecretStore(join(home.dir, "secrets.enc"), home.config.secretsKeyHex);
}
