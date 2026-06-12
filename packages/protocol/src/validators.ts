import { HEX_HASH_PATTERN } from "./vocabulary.js";
import { isAgentKind, isDisclosureMode, isSessionIsolation } from "./vocabulary.js";
import type {
  AgentKind,
  DisclosureMode,
  ManifestFile,
  SessionIsolation,
  WorkspaceManifest
} from "./types.js";

export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const POOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
export const RUN_ID_PATTERN = /^run_[A-Za-z0-9_-]+$/;
export const WORKSPACE_RELATIVE_PATH_PATTERN =
  /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)(?!.*\\)(?!.*\0).+$/;

export function parseHashHex(value: string, field = "hash"): string {
  if (!HEX_HASH_PATTERN.test(value)) {
    throw new Error(`${field} must be a 64-character lowercase hex sha256`);
  }
  return value;
}

export function parseSecretName(value: string): string {
  if (!SECRET_NAME_PATTERN.test(value)) {
    throw new Error(
      `secret name "${value}" must be a POSIX environment identifier`
    );
  }
  return value;
}

export function parsePoolName(value: string): string {
  if (!POOL_NAME_PATTERN.test(value)) {
    throw new Error(`pool name "${value}" contains unsupported characters`);
  }
  return value;
}

export function parseRunId(value: string): string {
  if (!RUN_ID_PATTERN.test(value)) {
    throw new Error(`run id "${value}" is malformed`);
  }
  return value;
}

export function parseHostAllowlistEntry(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    trimmed.length === 0 ||
    trimmed.length > 253 ||
    trimmed.includes("/") ||
    trimmed.includes("@") ||
    trimmed.includes(":")
  ) {
    throw new Error(`host allowlist entry "${value}" is not a bare host name`);
  }
  return trimmed;
}

export function parseWorkspaceManifestPath(value: string): string {
  if (!WORKSPACE_RELATIVE_PATH_PATTERN.test(value)) {
    throw new Error(`workspace path "${value}" must be a safe relative path`);
  }
  return value;
}

export function parseManifestFile(file: ManifestFile): ManifestFile {
  return {
    path: parseWorkspaceManifestPath(file.path),
    hash: parseHashHex(file.hash, "manifest file hash"),
    bytes: file.bytes
  };
}

export function parseWorkspaceManifest(
  manifest: WorkspaceManifest
): WorkspaceManifest {
  return {
    version: manifest.version,
    baseRef: manifest.baseRef,
    bundleHash: parseHashHex(manifest.bundleHash, "bundleHash"),
    ...(manifest.dirtyDiffHash
      ? { dirtyDiffHash: parseHashHex(manifest.dirtyDiffHash, "dirtyDiffHash") }
      : {}),
    untrackedFiles: manifest.untrackedFiles.map(parseManifestFile),
    deniedPatterns: [...manifest.deniedPatterns],
    deniedPaths: manifest.deniedPaths.map(parseWorkspaceManifestPath)
  };
}

export function parseAgentKind(value: string): AgentKind {
  if (!isAgentKind(value)) throw new Error(`unknown agent kind "${value}"`);
  return value;
}

export function parseSessionIsolation(value: string): SessionIsolation {
  if (!isSessionIsolation(value)) {
    throw new Error(`unknown session isolation "${value}"`);
  }
  return value;
}

export function parseDisclosureMode(value: string): DisclosureMode {
  if (!isDisclosureMode(value)) {
    throw new Error(`unknown disclosure mode "${value}"`);
  }
  return value;
}
