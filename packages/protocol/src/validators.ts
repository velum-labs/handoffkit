export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const POOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
export const WORKSPACE_RELATIVE_PATH_PATTERN =
  /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)(?!.*\\)(?!.*\0).+$/;

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

