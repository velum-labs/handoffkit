import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync
} from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

const CURSOR_STATE_FILES = Object.freeze([
  "cli-config.json",
  "agent-cli-state.json"
]);
const CURSOR_DEFAULT_PROFILE_FILES = Object.freeze([
  join("User", "globalStorage", "state.vscdb"),
  join("User", "globalStorage", "state.vscdb.backup"),
  join("User", "settings.json")
]);

export function cursorConfigDirectory(env = process.env) {
  if (env.CURSOR_CONFIG_DIR) return env.CURSOR_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "cursor");
  assert.ok(env.HOME, "HOME is required to locate Cursor CLI state");
  return join(env.HOME, ".cursor");
}

export function snapshotAllowlistedState(directory, relativePaths) {
  const hash = createHash("sha256");
  let count = 0;
  relativePaths.forEach((name, index) => {
    assert.ok(
      typeof name === "string" &&
        name.length > 0 &&
        !isAbsolute(name) &&
        !normalize(name).split(/[\\/]/).includes(".."),
      "state allowlist entries must stay below their root"
    );
    const path = join(directory, name);
    hash.update(`${index}:`);
    if (!existsSync(path)) {
      hash.update("missing;");
      return;
    }
    let current = directory;
    const parts = normalize(name).split(/[\\/]/);
    for (const [partIndex, part] of parts.entries()) {
      current = join(current, part);
      const component = lstatSync(current);
      assert.equal(component.isSymbolicLink(), false, "Cursor state paths cannot be symbolic links");
      if (partIndex < parts.length - 1) {
        assert.ok(component.isDirectory(), "Cursor state parents must be directories");
      }
    }
    const stat = lstatSync(path);
    assert.ok(stat.isFile(), "Cursor state must be regular files");
    const bytes = readFileSync(path);
    hash.update(`file:${bytes.length}:`);
    hash.update(bytes);
    hash.update(";");
    count += 1;
  });
  return { count, digest: hash.digest("hex") };
}

export function snapshotCursorState(directory) {
  return snapshotAllowlistedState(directory, CURSOR_STATE_FILES);
}

export function cursorDefaultProfileDirectory(
  env = process.env,
  operatingSystem = process.platform
) {
  assert.ok(env.HOME, "HOME is required to locate the Cursor default profile");
  if (operatingSystem === "darwin") {
    return join(env.HOME, "Library", "Application Support", "Cursor");
  }
  if (operatingSystem === "win32") {
    assert.ok(env.APPDATA, "APPDATA is required to locate the Cursor default profile");
    return join(env.APPDATA, "Cursor");
  }
  return join(env.XDG_CONFIG_HOME ?? join(env.HOME, ".config"), "Cursor");
}

export function snapshotCursorDefaultProfile(directory) {
  return snapshotAllowlistedState(directory, CURSOR_DEFAULT_PROFILE_FILES);
}

export function stageCursorState(sourceDirectory, destinationDirectory) {
  const before = snapshotCursorState(sourceDirectory);
  mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 });
  CURSOR_STATE_FILES.forEach((name) => {
    const source = join(sourceDirectory, name);
    if (!existsSync(source)) return;
    const destination = join(destinationDirectory, name);
    copyFileSync(source, destination);
    chmodSync(destination, 0o600);
  });
  const staged = snapshotCursorState(destinationDirectory);
  return {
    directory: destinationDirectory,
    stagedCount: staged.count,
    verify() {
      const after = snapshotCursorState(sourceDirectory);
      return {
        before,
        after,
        unchanged:
          before.count === after.count && before.digest === after.digest
      };
    }
  };
}
