import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  lstatSync,
  mkdirSync,
  readSync
} from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

const CURSOR_STATE_FILES = Object.freeze([
  "cli-config.json",
  "agent-cli-state.json"
]);
const CURSOR_DEFAULT_PROFILE_DATABASES = Object.freeze([
  join("User", "globalStorage", "state.vscdb"),
  join("User", "globalStorage", "state.vscdb.backup")
]);
const CURSOR_DEFAULT_PROFILE_SETTINGS = Object.freeze([
  join("User", "settings.json")
]);

function updateHashFromFile(hash, path) {
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
}

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
    hash.update(`file:${stat.size}:`);
    updateHashFromFile(hash, path);
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
  const hash = createHash("sha256");
  let count = 0;
  const settings = snapshotAllowlistedState(
    directory,
    CURSOR_DEFAULT_PROFILE_SETTINGS
  );
  hash.update(`settings:${settings.count}:${settings.digest};`);
  count += settings.count;
  for (const name of CURSOR_DEFAULT_PROFILE_DATABASES) {
    const path = join(directory, name);
    hash.update(`${name}:`);
    if (!existsSync(path)) {
      hash.update("missing;");
      continue;
    }
    const stat = lstatSync(path);
    assert.equal(
      stat.isSymbolicLink(),
      false,
      "Cursor default-profile databases cannot be symbolic links"
    );
    assert.ok(
      stat.isFile(),
      "Cursor default-profile databases must be regular files"
    );
    const selected = spawnSync(
      "sqlite3",
      [
        "-readonly",
        path,
        "SELECT key, hex(value) FROM ItemTable " +
          "WHERE key GLOB 'cursorAuth/*' ORDER BY key;"
      ],
      {
        encoding: "buffer",
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    assert.equal(
      selected.status,
      0,
      "failed to snapshot Cursor default-profile auth rows"
    );
    const rows = selected.stdout;
    hash.update(`auth-rows:${rows.length}:`);
    hash.update(rows);
    hash.update(";");
    if (rows.length > 0) count += 1;
  }
  return { count, digest: hash.digest("hex") };
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

export function prepareCursorAuthentication(
  sourceDirectory,
  destinationDirectory,
  env = process.env
) {
  const before = snapshotCursorState(sourceDirectory);
  const envKeyAvailable =
    typeof env.CURSOR_API_KEY === "string" && env.CURSOR_API_KEY.length > 0;
  if (envKeyAvailable) {
    return {
      authSource: "env-key",
      directory: undefined,
      verify() {
        const after = snapshotCursorState(sourceDirectory);
        return {
          authSource: "env-key",
          unchanged:
            before.count === after.count && before.digest === after.digest
        };
      }
    };
  }

  const staged = stageCursorState(sourceDirectory, destinationDirectory);
  const authSource = staged.stagedCount > 0 ? "staged-config" : "none";
  return {
    authSource,
    directory: authSource === "staged-config" ? staged.directory : undefined,
    verify() {
      return {
        authSource,
        unchanged: staged.verify().unchanged
      };
    }
  };
}
