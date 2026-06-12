import { isAbsolute, relative, resolve, sep } from "node:path";

import { parseWorkspaceManifestPath } from "@warrant/protocol";

declare const workspaceRootBrand: unique symbol;
declare const workspaceRelativePathBrand: unique symbol;

export type WorkspaceRoot = string & { readonly [workspaceRootBrand]: true };
export type WorkspaceRelativePath = string & {
  readonly [workspaceRelativePathBrand]: true;
};

function normalizeSlashes(path: string): string {
  return path.split("\\").join("/");
}

export function parseWorkspaceRoot(path: string): WorkspaceRoot {
  if (path.length === 0) throw new Error("workspace root must not be empty");
  return resolve(path) as WorkspaceRoot;
}

export function parseWorkspaceRelativePath(path: string): WorkspaceRelativePath {
  return parseWorkspaceManifestPath(normalizeSlashes(path)) as WorkspaceRelativePath;
}

export function resolveInsideWorkspace(
  root: WorkspaceRoot | string,
  relativePath: WorkspaceRelativePath | string
): string {
  const rootPath = parseWorkspaceRoot(root);
  const rel = parseWorkspaceRelativePath(String(relativePath));
  const resolved = resolve(rootPath, rel);
  const back = relative(rootPath, resolved);
  if (
    back === ".." ||
    back.startsWith(`..${sep}`) ||
    isAbsolute(back)
  ) {
    throw new Error(`workspace path escapes root: ${relativePath}`);
  }
  return resolved;
}
