import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { writeFileAtomic } from "@routekit/runtime";

type TransactionFile = {
  role: "account" | "config" | "revisions";
  relativePath?: string;
  existed: boolean;
  backup?: string;
  sha256?: string;
  mode?: number;
};

type AccountTransactionManifest = {
  version: 1;
  id: string;
  state: "prepared" | "committed";
  kind: string;
  provider: string;
  labels: string[];
  files: TransactionFile[];
};

export type PreparedAccountTransaction = {
  directory: string;
  manifest: AccountTransactionManifest;
};

export type AccountTransactionRecovery = {
  recovered: number;
  cleaned: number;
};

function transactionsRoot(home: string): string {
  return join(home, "account-transactions");
}

function manifestPath(directory: string): string {
  return join(directory, "transaction.json");
}

function revisionsPath(home: string): string {
  return join(home, "daemon-revisions.json");
}

function hash(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function accountRelativePath(home: string, path: string): string {
  const normalizedHome = resolve(home);
  const normalizedPath = resolve(path);
  const value = relative(normalizedHome, normalizedPath);
  if (
    value.length === 0 ||
    isAbsolute(value) ||
    value === ".." ||
    value.startsWith(`..${sep}`)
  ) {
    throw new Error("account transaction target must be inside RouteKit home");
  }
  return value;
}

function targetPath(
  file: TransactionFile,
  home: string,
  configPath: string
): string {
  if (file.role === "config") return configPath;
  if (file.role === "revisions") return revisionsPath(home);
  if (typeof file.relativePath !== "string") {
    throw new Error("account transaction manifest has no account path");
  }
  const path = resolve(home, file.relativePath);
  accountRelativePath(home, path);
  return path;
}

function writeManifest(directory: string, manifest: AccountTransactionManifest): void {
  writeFileAtomic(manifestPath(directory), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600
  });
  chmodSync(manifestPath(directory), 0o600);
}

function parseManifest(directory: string): AccountTransactionManifest {
  const parsed = JSON.parse(readFileSync(manifestPath(directory), "utf8")) as
    Partial<AccountTransactionManifest>;
  if (
    parsed.version !== 1 ||
    typeof parsed.id !== "string" ||
    (parsed.state !== "prepared" && parsed.state !== "committed") ||
    typeof parsed.kind !== "string" ||
    typeof parsed.provider !== "string" ||
    !Array.isArray(parsed.labels) ||
    !parsed.labels.every((label) => typeof label === "string") ||
    !Array.isArray(parsed.files)
  ) {
    throw new Error("invalid account transaction manifest");
  }
  return parsed as AccountTransactionManifest;
}

export function prepareAccountTransaction(input: {
  home: string;
  configPath: string;
  accountPaths: string[];
  kind: string;
  provider: string;
  labels: string[];
}): PreparedAccountTransaction {
  const root = transactionsRoot(input.home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const id = randomUUID();
  const directory = join(root, id);
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  const descriptors: Array<{
    role: TransactionFile["role"];
    path: string;
    relativePath?: string;
  }> = [
    ...[...new Set(input.accountPaths)].map((path) => ({
      role: "account" as const,
      path,
      relativePath: accountRelativePath(input.home, path)
    })),
    { role: "config" as const, path: input.configPath },
    { role: "revisions" as const, path: revisionsPath(input.home) }
  ];
  try {
    const files = descriptors.map((descriptor, index): TransactionFile => {
      if (!existsSync(descriptor.path)) {
        return {
          role: descriptor.role,
          ...(descriptor.relativePath !== undefined
            ? { relativePath: descriptor.relativePath }
            : {}),
          existed: false
        };
      }
      const backup = `backup-${index}.bin`;
      const backupPath = join(directory, backup);
      copyFileSync(descriptor.path, backupPath);
      chmodSync(backupPath, 0o600);
      const bytes = readFileSync(backupPath);
      return {
        role: descriptor.role,
        ...(descriptor.relativePath !== undefined
          ? { relativePath: descriptor.relativePath }
          : {}),
        existed: true,
        backup,
        sha256: hash(bytes),
        mode: statSync(descriptor.path).mode & 0o777
      };
    });
    const manifest: AccountTransactionManifest = {
      version: 1,
      id,
      state: "prepared",
      kind: input.kind,
      provider: input.provider,
      labels: [...input.labels],
      files
    };
    // The manifest is the prepare record and is deliberately written only
    // after every rollback backup is durable.
    writeManifest(directory, manifest);
    return { directory, manifest };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function restorePreparedTransaction(
  transaction: PreparedAccountTransaction,
  home: string,
  configPath: string
): void {
  for (const file of transaction.manifest.files) {
    const path = targetPath(file, home, configPath);
    if (!file.existed) {
      rmSync(path, { force: true });
      continue;
    }
    if (file.backup === undefined || file.sha256 === undefined) {
      throw new Error("account transaction backup metadata is incomplete");
    }
    const backupPath = join(transaction.directory, file.backup);
    const bytes = readFileSync(backupPath);
    if (hash(bytes) !== file.sha256) {
      throw new Error("account transaction backup failed integrity validation");
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileAtomic(path, bytes.toString("utf8"), { mode: file.mode ?? 0o600 });
    chmodSync(path, file.mode ?? 0o600);
  }
}

export function rollbackAccountTransaction(
  transaction: PreparedAccountTransaction,
  home: string,
  configPath: string
): void {
  restorePreparedTransaction(transaction, home, configPath);
  cleanupAccountTransaction(transaction);
}

export function markAccountTransactionCommitted(
  transaction: PreparedAccountTransaction
): void {
  transaction.manifest = { ...transaction.manifest, state: "committed" };
  writeManifest(transaction.directory, transaction.manifest);
}

export function cleanupAccountTransaction(
  transaction: PreparedAccountTransaction
): void {
  rmSync(transaction.directory, { recursive: true, force: true });
  const root = dirname(transaction.directory);
  try {
    if (readdirSync(root).length === 0) {
      rmSync(root, { recursive: true, force: true });
    }
  } catch {
    // Cleanup is retried on daemon startup when a committed manifest remains.
  }
}

/**
 * Restore every transaction that did not reach its durable commit marker.
 * This must run before config/revisions are read and before a router or sidecar
 * is started.
 */
export function recoverAccountTransactions(
  home: string,
  configPath: string
): AccountTransactionRecovery {
  const root = transactionsRoot(home);
  if (!existsSync(root)) return { recovered: 0, cleaned: 0 };
  let recovered = 0;
  let cleaned = 0;
  for (const name of readdirSync(root).sort()) {
    const directory = join(root, name);
    if (!existsSync(manifestPath(directory))) {
      rmSync(directory, { recursive: true, force: true });
      cleaned += 1;
      continue;
    }
    const manifest = parseManifest(directory);
    const transaction = { directory, manifest };
    if (manifest.state === "prepared") {
      restorePreparedTransaction(transaction, home, configPath);
      recovered += 1;
    } else {
      cleaned += 1;
    }
    rmSync(directory, { recursive: true, force: true });
  }
  try {
    if (readdirSync(root).length === 0) {
      rmSync(root, { recursive: true, force: true });
    }
  } catch {
    // A concurrent observer or filesystem cleanup race is harmless.
  }
  return { recovered, cleaned };
}
