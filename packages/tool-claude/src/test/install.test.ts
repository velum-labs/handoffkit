import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import test from "node:test";

import {
  installClaudeIntegration,
  uninstallClaudeIntegration
} from "../install.js";
import type { ClaudeInstallOwner } from "../install.js";

type ClaudeInstallWriteBoundary =
  | "install-pending"
  | "install-settings"
  | "install-committed"
  | "uninstall-pending"
  | "uninstall-settings"
  | "uninstall-committed";

const testingGlobal = globalThis as typeof globalThis & {
  __routekitClaudeInstallFaultInjector?: (
    reached: ClaudeInstallWriteBoundary
  ) => void;
};

const OWNER: ClaudeInstallOwner = {
  id: "example-host",
  displayName: "Example Host",
  installCommand: "example install claude",
  uninstallCommand: "example uninstall claude",
  startCommand: "example serve"
};

function install(
  configDirectory: string,
  gatewayUrl = "http://127.0.0.1:9999/",
  authToken?: string
) {
  return installClaudeIntegration({
    gatewayUrl,
    ...(authToken !== undefined ? { authToken } : {}),
    owner: OWNER,
    claudeConfigDir: configDirectory
  });
}

test("Claude managed install updates and restores the exact original settings", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "routekit-claude-install-"));
  const configPath = join(configDirectory, "settings.json");
  const original = '{ "permissions": { "allow": ["Bash(git status)"] } }\n';
  writeFileSync(configPath, original);
  try {
    const installed = await install(
      configDirectory,
      "http://127.0.0.1:9999/",
      "gateway-secret"
    );
    assert.equal(installed.action, "installed");
    assert.deepEqual(installed.managedKeys.sort(), [
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"
    ]);
    const settings = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(settings.permissions, { allow: ["Bash(git status)"] });
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9999");
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "gateway-secret");
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    const manifestPath = join(
      configDirectory,
      `.${OWNER.id}-integration.json`
    );
    assert.deepEqual(
      {
        version: JSON.parse(readFileSync(manifestPath, "utf8")).version,
        state: JSON.parse(readFileSync(manifestPath, "utf8")).state,
        mode: statSync(manifestPath).mode & 0o777
      },
      { version: 2, state: "installed", mode: 0o600 }
    );

    assert.equal(
      (
        await install(
          configDirectory,
          "http://127.0.0.1:8888",
          "updated-secret"
        )
      ).action,
      "updated"
    );
    assert.equal(
      JSON.parse(readFileSync(configPath, "utf8")).env.ANTHROPIC_BASE_URL,
      "http://127.0.0.1:8888"
    );

    assert.equal(
      (
        await uninstallClaudeIntegration({
          ownerId: OWNER.id,
          claudeConfigDir: configDirectory
        })
      ).removed,
      true
    );
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(
      existsSync(manifestPath),
      false
    );
  } finally {
    rmSync(configDirectory, { recursive: true, force: true });
  }
});

test("Claude uninstall preserves user edits made after install", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "routekit-claude-edits-"));
  const configPath = join(configDirectory, "settings.json");
  try {
    await install(configDirectory);
    const settings = JSON.parse(readFileSync(configPath, "utf8"));
    settings.theme = "dark";
    settings.env.USER_SETTING = "kept";
    writeFileSync(configPath, `${JSON.stringify(settings, null, 2)}\n`);

    await uninstallClaudeIntegration({
      ownerId: OWNER.id,
      claudeConfigDir: configDirectory
    });
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      theme: "dark",
      env: { USER_SETTING: "kept" }
    });
  } finally {
    rmSync(configDirectory, { recursive: true, force: true });
  }
});

test("Claude install refuses malformed settings and user-owned env conflicts", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "routekit-claude-conflict-"));
  const configPath = join(configDirectory, "settings.json");
  try {
    writeFileSync(configPath, "{not-json");
    await assert.rejects(install(configDirectory), /not valid JSON/);
    writeFileSync(
      configPath,
      `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://user.example" } })}\n`
    );
    await assert.rejects(
      install(configDirectory),
      /already define env\.ANTHROPIC_BASE_URL/
    );
    assert.equal(
      existsSync(join(configDirectory, `.${OWNER.id}-integration.json`)),
      false
    );
  } finally {
    rmSync(configDirectory, { recursive: true, force: true });
  }
});

function failOnceAt(boundary: ClaudeInstallWriteBoundary): void {
  let failed = false;
  testingGlobal.__routekitClaudeInstallFaultInjector = (reached) => {
    if (!failed && reached === boundary) {
      failed = true;
      throw new Error(`simulated crash after ${boundary}`);
    }
  };
}

function clearFaultInjector(): void {
  delete testingGlobal.__routekitClaudeInstallFaultInjector;
}

function spawnBlockedInstall(
  configDirectory: string,
  boundary: ClaudeInstallWriteBoundary
): ChildProcess {
  const installModule = new URL("../install.js", import.meta.url).href;
  const script = `
    const [moduleUrl, configDirectory, boundary] = process.argv.slice(1);
    const { installClaudeIntegration } = await import(moduleUrl);
    globalThis.__routekitClaudeInstallFaultInjector = (reached) => {
      if (reached !== boundary) return;
      process.send?.({ boundary: reached });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    };
    await installClaudeIntegration({
      gatewayUrl: "http://127.0.0.1:9999",
      owner: ${JSON.stringify(OWNER)},
      claudeConfigDir: configDirectory
    });
  `;
  return spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      script,
      installModule,
      configDirectory,
      boundary
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] }
  );
}

async function waitForBoundary(
  child: ChildProcess,
  boundary: ClaudeInstallWriteBoundary
): Promise<void> {
  const [message] = await Promise.race([
    once(child, "message"),
    once(child, "exit").then(([code, signal]) => {
      throw new Error(
        `install child exited before ${boundary} (code=${String(code)}, signal=${String(signal)})`
      );
    })
  ]);
  assert.deepEqual(message, { boundary });
}

async function killAndWait(child: ChildProcess): Promise<void> {
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

test("install recovery is safe at every atomic write boundary", async () => {
  const boundaries: ClaudeInstallWriteBoundary[] = [
    "install-pending",
    "install-settings",
    "install-committed"
  ];
  for (const boundary of boundaries) {
    const configDirectory = mkdtempSync(
      join(tmpdir(), `routekit-claude-${boundary}-`)
    );
    const configPath = join(configDirectory, "settings.json");
    const original = `{"boundary":${JSON.stringify(boundary)}}\n`;
    writeFileSync(configPath, original);
    try {
      failOnceAt(boundary);
      await assert.rejects(install(configDirectory), /simulated crash/);
      clearFaultInjector();
      await install(configDirectory);
      await uninstallClaudeIntegration({
        ownerId: OWNER.id,
        claudeConfigDir: configDirectory
      });
      assert.equal(readFileSync(configPath, "utf8"), original);
    } finally {
      clearFaultInjector();
      rmSync(configDirectory, { recursive: true, force: true });
    }
  }
});

test("update recovery rolls back settings and manifest at every write boundary", async () => {
  const boundaries: ClaudeInstallWriteBoundary[] = [
    "install-pending",
    "install-settings",
    "install-committed"
  ];
  for (const boundary of boundaries) {
    const configDirectory = mkdtempSync(
      join(tmpdir(), `routekit-claude-update-${boundary}-`)
    );
    const configPath = join(configDirectory, "settings.json");
    const original = '{"theme":"light"}\n';
    writeFileSync(configPath, original);
    try {
      await install(configDirectory, "http://127.0.0.1:7000");
      failOnceAt(boundary);
      await assert.rejects(
        install(configDirectory, "http://127.0.0.1:7001"),
        /simulated crash/
      );
      clearFaultInjector();
      await install(configDirectory, "http://127.0.0.1:7002");
      assert.equal(
        JSON.parse(readFileSync(configPath, "utf8")).env.ANTHROPIC_BASE_URL,
        "http://127.0.0.1:7002"
      );
      await uninstallClaudeIntegration({
        ownerId: OWNER.id,
        claudeConfigDir: configDirectory
      });
      assert.equal(readFileSync(configPath, "utf8"), original);
    } finally {
      clearFaultInjector();
      rmSync(configDirectory, { recursive: true, force: true });
    }
  }
});

test("uninstall recovery finishes idempotently at every write boundary", async () => {
  const boundaries: ClaudeInstallWriteBoundary[] = [
    "uninstall-pending",
    "uninstall-settings",
    "uninstall-committed"
  ];
  for (const boundary of boundaries) {
    const configDirectory = mkdtempSync(
      join(tmpdir(), `routekit-claude-${boundary}-`)
    );
    const configPath = join(configDirectory, "settings.json");
    const original = '{"theme":"light"}\n';
    writeFileSync(configPath, original);
    try {
      await install(configDirectory);
      failOnceAt(boundary);
      await assert.rejects(
        uninstallClaudeIntegration({
          ownerId: OWNER.id,
          claudeConfigDir: configDirectory
        }),
        /simulated crash/
      );
      clearFaultInjector();
      await uninstallClaudeIntegration({
        ownerId: OWNER.id,
        claudeConfigDir: configDirectory
      });
      assert.equal(readFileSync(configPath, "utf8"), original);
      assert.equal(
        existsSync(join(configDirectory, `.${OWNER.id}-integration.json`)),
        false
      );
    } finally {
      clearFaultInjector();
      rmSync(configDirectory, { recursive: true, force: true });
    }
  }
});

test("uninstall recovery refuses an unexpected external settings edit", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "routekit-claude-recovery-edit-"));
  const configPath = join(configDirectory, "settings.json");
  try {
    await install(configDirectory);
    failOnceAt("uninstall-pending");
    await assert.rejects(
      uninstallClaudeIntegration({
        ownerId: OWNER.id,
        claudeConfigDir: configDirectory
      }),
      /simulated crash/
    );
    clearFaultInjector();
    writeFileSync(configPath, '{"external":true}\n');
    await assert.rejects(
      uninstallClaudeIntegration({
        ownerId: OWNER.id,
        claudeConfigDir: configDirectory
      }),
      /refused to overwrite the external edit/
    );
    assert.equal(readFileSync(configPath, "utf8"), '{"external":true}\n');
  } finally {
    clearFaultInjector();
    rmSync(configDirectory, { recursive: true, force: true });
  }
});

test("install recovery refuses an unexpected external settings edit", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "routekit-claude-install-edit-"));
  const configPath = join(configDirectory, "settings.json");
  writeFileSync(configPath, '{"before":true}\n');
  try {
    failOnceAt("install-settings");
    await assert.rejects(install(configDirectory), /simulated crash/);
    clearFaultInjector();
    writeFileSync(configPath, '{"external":true}\n');
    await assert.rejects(
      install(configDirectory),
      /refused to overwrite the external edit/
    );
    assert.equal(readFileSync(configPath, "utf8"), '{"external":true}\n');
  } finally {
    clearFaultInjector();
    rmSync(configDirectory, { recursive: true, force: true });
  }
});

test("explicit config directory wins over CLAUDE_CONFIG_DIR, which wins over the default", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-claude-precedence-"));
  const environmentDirectory = join(root, "environment");
  const explicitDirectory = join(root, "explicit");
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = environmentDirectory;
    const fromEnvironment = await installClaudeIntegration({
      gatewayUrl: "http://127.0.0.1:9999",
      owner: OWNER
    });
    assert.equal(fromEnvironment.configPath, join(environmentDirectory, "settings.json"));
    const explicit = await installClaudeIntegration({
      gatewayUrl: "http://127.0.0.1:9999",
      owner: OWNER,
      claudeConfigDir: explicitDirectory
    });
    assert.equal(explicit.configPath, join(explicitDirectory, "settings.json"));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("install never persists or takes ownership of ANTHROPIC_MODEL", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "routekit-claude-model-"));
  const configPath = join(configDirectory, "settings.json");
  const original = '{"env":{"ANTHROPIC_MODEL":"user-choice"}}\n';
  writeFileSync(configPath, original);
  try {
    const result = await install(configDirectory);
    const settings = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(settings.env.ANTHROPIC_MODEL, "user-choice");
    assert.equal(result.managedKeys.includes("ANTHROPIC_MODEL"), false);
    await uninstallClaudeIntegration({
      ownerId: OWNER.id,
      claudeConfigDir: configDirectory
    });
    assert.equal(readFileSync(configPath, "utf8"), original);
  } finally {
    rmSync(configDirectory, { recursive: true, force: true });
  }
});

test("updating a legacy install removes its formerly managed ANTHROPIC_MODEL", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "routekit-claude-legacy-model-"));
  const configPath = join(configDirectory, "settings.json");
  const manifestPath = join(configDirectory, `.${OWNER.id}-integration.json`);
  const original = '{"theme":"light"}\n';
  const installed = `${JSON.stringify(
    {
      theme: "light",
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:7000",
        ANTHROPIC_AUTH_TOKEN: "routekit",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        ANTHROPIC_MODEL: "claude-code/legacy"
      }
    },
    null,
    2
  )}\n`;
  writeFileSync(configPath, installed);
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        version: 1,
        ownerId: OWNER.id,
        originalContent: original,
        exactRestoreEligible: true,
        installedContentHashes: [
          createHash("sha256").update(installed).digest("hex")
        ],
        managedEnvValues: {
          ANTHROPIC_BASE_URL: ["http://127.0.0.1:7000"],
          ANTHROPIC_AUTH_TOKEN: ["routekit"],
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: ["1"],
          ANTHROPIC_MODEL: ["claude-code/legacy"]
        }
      },
      null,
      2
    )}\n`
  );
  try {
    await install(configDirectory, "http://127.0.0.1:7001");
    const settings = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal("ANTHROPIC_MODEL" in settings.env, false);
    await uninstallClaudeIntegration({
      ownerId: OWNER.id,
      claudeConfigDir: configDirectory
    });
    assert.equal(readFileSync(configPath, "utf8"), original);
  } finally {
    rmSync(configDirectory, { recursive: true, force: true });
  }
});

function writeInterruptedLegacyUpdate(
  configDirectory: string,
  phase: "before-settings" | "after-settings"
): { configPath: string; manifestPath: string; original: string } {
  const configPath = join(configDirectory, "settings.json");
  const manifestPath = join(configDirectory, `.${OWNER.id}-integration.json`);
  const original = '{"theme":"light"}\n';
  const content = (baseUrl: string, authToken: string, model: string): string =>
    `${JSON.stringify(
      {
        theme: "light",
        env: {
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_AUTH_TOKEN: authToken,
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
          ANTHROPIC_MODEL: model
        }
      },
      null,
      2
    )}\n`;
  const before = content(
    "http://127.0.0.1:7000",
    "before-token",
    "claude-code/before"
  );
  const after = content(
    "http://127.0.0.1:7001",
    "after-token",
    "claude-code/after"
  );
  writeFileSync(configPath, phase === "before-settings" ? before : after);
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        version: 1,
        ownerId: OWNER.id,
        originalContent: original,
        exactRestoreEligible: true,
        installedContentHashes: [before, after].map((value) =>
          createHash("sha256").update(value).digest("hex")
        ),
        managedEnvValues: {
          ANTHROPIC_BASE_URL: [
            "http://127.0.0.1:7000",
            "http://127.0.0.1:7001"
          ],
          ANTHROPIC_AUTH_TOKEN: ["before-token", "after-token"],
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: ["1"],
          ANTHROPIC_MODEL: [
            "claude-code/before",
            "claude-code/after"
          ]
        }
      },
      null,
      2
    )}\n`
  );
  return { configPath, manifestPath, original };
}

test("install migrates interrupted v1 updates before and after settings", async () => {
  for (const phase of ["before-settings", "after-settings"] as const) {
    const configDirectory = mkdtempSync(
      join(tmpdir(), `routekit-claude-v1-install-${phase}-`)
    );
    const { configPath, manifestPath, original } =
      writeInterruptedLegacyUpdate(configDirectory, phase);
    try {
      const result = await install(
        configDirectory,
        "http://127.0.0.1:7002",
        "final-token"
      );
      assert.equal(result.action, "updated");
      const settings = JSON.parse(readFileSync(configPath, "utf8"));
      assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:7002");
      assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "final-token");
      assert.equal("ANTHROPIC_MODEL" in settings.env, false);
      assert.deepEqual(
        {
          version: JSON.parse(readFileSync(manifestPath, "utf8")).version,
          state: JSON.parse(readFileSync(manifestPath, "utf8")).state
        },
        { version: 2, state: "installed" }
      );
      await uninstallClaudeIntegration({
        ownerId: OWNER.id,
        claudeConfigDir: configDirectory
      });
      assert.equal(readFileSync(configPath, "utf8"), original);
    } finally {
      rmSync(configDirectory, { recursive: true, force: true });
    }
  }
});

test("uninstall migrates interrupted v1 updates before and after settings", async () => {
  for (const phase of ["before-settings", "after-settings"] as const) {
    const configDirectory = mkdtempSync(
      join(tmpdir(), `routekit-claude-v1-uninstall-${phase}-`)
    );
    const { configPath, manifestPath, original } =
      writeInterruptedLegacyUpdate(configDirectory, phase);
    try {
      assert.equal(
        (
          await uninstallClaudeIntegration({
            ownerId: OWNER.id,
            claudeConfigDir: configDirectory
          })
        ).removed,
        true
      );
      assert.equal(readFileSync(configPath, "utf8"), original);
      assert.equal(existsSync(manifestPath), false);
    } finally {
      rmSync(configDirectory, { recursive: true, force: true });
    }
  }
});

test("legacy migration refuses unrecognized settings without overwriting", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "routekit-claude-v1-external-"));
  const { configPath, manifestPath } =
    writeInterruptedLegacyUpdate(configDirectory, "after-settings");
  const external = '{"external":true}\n';
  writeFileSync(configPath, external);
  const manifest = readFileSync(manifestPath, "utf8");
  try {
    await assert.rejects(
      install(configDirectory),
      /does not match the current settings/
    );
    assert.equal(readFileSync(configPath, "utf8"), external);
    assert.equal(readFileSync(manifestPath, "utf8"), manifest);
  } finally {
    rmSync(configDirectory, { recursive: true, force: true });
  }
});

test("untouched original settings discard a stale pre-install v1 manifest", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "routekit-claude-v1-original-"));
  const configPath = join(configDirectory, "settings.json");
  const manifestPath = join(configDirectory, `.${OWNER.id}-integration.json`);
  const original = '{"theme":"light"}\n';
  const target = `${JSON.stringify(
    {
      theme: "light",
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:7000",
        ANTHROPIC_AUTH_TOKEN: "routekit",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"
      }
    },
    null,
    2
  )}\n`;
  const writeStaleManifest = (): void => {
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          version: 1,
          ownerId: OWNER.id,
          originalContent: original,
          exactRestoreEligible: true,
          installedContentHashes: [original, target].map((value) =>
            createHash("sha256").update(value).digest("hex")
          ),
          managedEnvValues: {
            ANTHROPIC_BASE_URL: ["http://127.0.0.1:7000"],
            ANTHROPIC_AUTH_TOKEN: ["routekit"],
            CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: ["1"]
          }
        },
        null,
        2
      )}\n`
    );
  };
  writeFileSync(configPath, original);
  try {
    writeStaleManifest();
    assert.equal(
      (
        await uninstallClaudeIntegration({
          ownerId: OWNER.id,
          claudeConfigDir: configDirectory
        })
      ).removed,
      false
    );
    assert.equal(existsSync(manifestPath), false);
    assert.equal(readFileSync(configPath, "utf8"), original);

    writeStaleManifest();
    assert.equal((await install(configDirectory)).action, "installed");
    await uninstallClaudeIntegration({
      ownerId: OWNER.id,
      claudeConfigDir: configDirectory
    });
    assert.equal(readFileSync(configPath, "utf8"), original);
  } finally {
    rmSync(configDirectory, { recursive: true, force: true });
  }
});

test("new config directories are 0700 and exact restore preserves settings mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-claude-mode-"));
  const createdDirectory = join(root, "nested", "claude");
  const existingDirectory = join(root, "existing");
  mkdirSync(existingDirectory);
  const configPath = join(existingDirectory, "settings.json");
  const original = '{"theme":"dark"}\n';
  writeFileSync(configPath, original);
  chmodSync(configPath, 0o640);
  try {
    await install(createdDirectory);
    assert.equal(statSync(createdDirectory).mode & 0o777, 0o700);
    await install(existingDirectory);
    await uninstallClaudeIntegration({
      ownerId: OWNER.id,
      claudeConfigDir: existingDirectory
    });
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(statSync(configPath).mode & 0o777, 0o640);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude config and private files reject symlinks and non-file entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-claude-file-safety-"));
  try {
    const targetDirectory = join(root, "target");
    mkdirSync(targetDirectory);
    const linkedDirectory = join(root, "linked");
    symlinkSync(targetDirectory, linkedDirectory);
    await assert.rejects(
      install(linkedDirectory),
      /must not be a symlink/
    );

    const fileDirectory = join(root, "not-a-directory");
    writeFileSync(fileDirectory, "");
    await assert.rejects(install(fileDirectory), /not a directory/);

    for (const entryName of [
      "settings.json",
      `.${OWNER.id}-integration.json`,
      ".routekit-claude-integration.lock",
      ".routekit-claude-integration.lock.reap"
    ]) {
      const symlinkDirectory = join(root, `symlink-${entryName.replaceAll(".", "-")}`);
      mkdirSync(symlinkDirectory);
      symlinkSync(join(root, "missing-target"), join(symlinkDirectory, entryName));
      await assert.rejects(
        install(symlinkDirectory),
        /must not be a symlink/
      );

      const nonFileDirectory = join(root, `non-file-${entryName.replaceAll(".", "-")}`);
      mkdirSync(nonFileDirectory);
      mkdirSync(join(nonFileDirectory, entryName));
      await assert.rejects(
        install(nonFileDirectory),
        /must be a regular file/
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a partial process lock is stabilized and safely recovered", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "routekit-claude-malformed-lock-"));
  const lockPath = join(configDirectory, ".routekit-claude-integration.lock");
  writeFileSync(lockPath, '{"pid":"not-a-process"}\n');
  try {
    await install(configDirectory);
    assert.equal(existsSync(lockPath), false);
    await uninstallClaudeIntegration({
      ownerId: OWNER.id,
      claudeConfigDir: configDirectory
    });
  } finally {
    rmSync(configDirectory, { recursive: true, force: true });
  }
});

test("normal release does not remove a lock record it no longer owns", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "routekit-claude-replaced-lock-"));
  const lockPath = join(configDirectory, ".routekit-claude-integration.lock");
  testingGlobal.__routekitClaudeInstallFaultInjector = (boundary) => {
    if (boundary !== "install-pending") return;
    const replacement = JSON.parse(readFileSync(lockPath, "utf8"));
    replacement.nonce = "replacement-owner";
    writeFileSync(lockPath, `${JSON.stringify(replacement)}\n`);
    throw new Error("simulated lock replacement");
  };
  try {
    await assert.rejects(
      install(configDirectory),
      /simulated lock replacement/
    );
    assert.equal(
      JSON.parse(readFileSync(lockPath, "utf8")).nonce,
      "replacement-owner"
    );
  } finally {
    clearFaultInjector();
    rmSync(configDirectory, { recursive: true, force: true });
  }
});

test("a live process-owned lock refuses concurrent mutation", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "routekit-claude-lock-"));
  const child = spawnBlockedInstall(configDirectory, "install-pending");
  try {
    await waitForBoundary(child, "install-pending");
    await assert.rejects(
      install(configDirectory),
      /timed out waiting for lifecycle lock/
    );
  } finally {
    await killAndWait(child);
    rmSync(configDirectory, { recursive: true, force: true });
  }
});

test("SIGKILL stale-lock reclamation reaches install transaction recovery", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "routekit-claude-sigkill-"));
  const configPath = join(configDirectory, "settings.json");
  const lockPath = join(configDirectory, ".routekit-claude-integration.lock");
  const original = '{"theme":"light"}\n';
  writeFileSync(configPath, original);
  const child = spawnBlockedInstall(configDirectory, "install-pending");
  try {
    await waitForBoundary(child, "install-pending");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(lock.pid, child.pid);
    assert.equal(typeof lock.processIdentity, "string");
    assert.equal(Number.isFinite(Date.parse(lock.acquiredAt)), true);
    await killAndWait(child);

    assert.equal(existsSync(lockPath), true);
    assert.equal((await install(configDirectory)).action, "installed");
    assert.equal(existsSync(lockPath), false);
    await uninstallClaudeIntegration({
      ownerId: OWNER.id,
      claudeConfigDir: configDirectory
    });
    assert.equal(readFileSync(configPath, "utf8"), original);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await killAndWait(child);
    }
    rmSync(configDirectory, { recursive: true, force: true });
  }
});
