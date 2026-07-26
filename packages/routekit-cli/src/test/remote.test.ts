import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  activeRemote,
  deleteRemoteToken,
  normalizeRemoteUrl,
  putRemote,
  readRemoteRegistry,
  readRemoteToken,
  remoteTokenPath,
  remotesPath,
  removeRemote,
  useRemote,
  validateSshHost,
  writeRemoteToken
} from "../remotes.js";
import { redactSensitiveText, runSshRelay } from "../ssh-control.js";
import {
  assertLocalTarget,
  resetTargetSelectionForTest,
  selectedRemoteMetadata,
  setTargetSelection
} from "../target.js";
import { resolveLauncherPreparation } from "../commands/launchers.js";
import { parseControlRelayEnvelope, relayLocalControl } from "../control-relay.js";

function withRouteKitHome<T>(home: string, run: () => T): T {
  const previous = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = home;
  try {
    return run();
  } finally {
    resetTargetSelectionForTest();
    if (previous === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previous;
  }
}

async function withRouteKitHomeAsync<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = home;
  try {
    return await run();
  } finally {
    resetTargetSelectionForTest();
    if (previous === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previous;
  }
}

test("remote registry is private and active selection has explicit precedence", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-remotes-"));
  withRouteKitHome(home, () => {
    putRemote({
      name: "mini",
      gatewayUrl: "https://gateway.example/",
      sshHost: "velum-mini",
      addedAt: "2026-07-26T00:00:00.000Z"
    });
    putRemote({
      name: "backup",
      gatewayUrl: "https://backup.example",
      sshHost: "backup-host",
      addedAt: "2026-07-26T00:00:01.000Z"
    }, false);

    assert.equal(statSync(remotesPath()).mode & 0o777, 0o600);
    assert.equal(readFileSync(remotesPath(), "utf8").includes("token"), false);
    assert.equal(activeRemote()?.name, "mini");
    assert.equal(selectedRemoteMetadata()?.name, "mini");
    assert.throws(() => assertLocalTarget("start"), /manages the local daemon/);

    setTargetSelection({ local: false, remote: "backup" });
    assert.equal(selectedRemoteMetadata()?.name, "backup");
    setTargetSelection({ local: true });
    assert.equal(selectedRemoteMetadata(), undefined);
    assert.doesNotThrow(() => assertLocalTarget("start"));
    setTargetSelection({ local: true, remote: "mini" });
    assert.equal(selectedRemoteMetadata(), undefined);

    useRemote(undefined);
    assert.equal(readRemoteRegistry().active, undefined);
  });
});

test("file credential fallback uses mode 0600 and removal deletes credentials", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-remote-token-"));
  await withRouteKitHomeAsync(home, async () => {
    await writeRemoteToken("mini", "private-token", { platform: "linux" });
    assert.equal(statSync(remoteTokenPath("mini")).mode & 0o777, 0o600);
    assert.equal(await readRemoteToken("mini", { platform: "linux" }), "private-token");
    await deleteRemoteToken("mini", { platform: "linux" });
    assert.equal(await readRemoteToken("mini", { platform: "linux" }), undefined);
  });
});

test("macOS credential storage uses a generic-password keychain entry", async () => {
  const calls: string[][] = [];
  const runKeychain = async (args: readonly string[]): Promise<string> => {
    calls.push([...args]);
    return args[0] === "find-generic-password" ? "from-keychain" : "";
  };
  await writeRemoteToken("mini", "private-token", { platform: "darwin", runKeychain });
  assert.equal(
    await readRemoteToken("mini", { platform: "darwin", runKeychain }),
    "from-keychain"
  );
  await deleteRemoteToken("mini", { platform: "darwin", runKeychain });
  assert.deepEqual(calls.map((args) => args[0]), [
    "add-generic-password",
    "find-generic-password",
    "delete-generic-password"
  ]);
  assert.ok(calls.every((args) => args.includes("routekit-remote")));
  await assert.rejects(
    writeRemoteToken("mini", "must-not-leak", {
      platform: "darwin",
      runKeychain: async () => {
        throw new Error("security failed for must-not-leak");
      }
    }),
    (error: unknown) => {
      assert.doesNotMatch(String(error), /must-not-leak/);
      return true;
    }
  );
});

test("remote removal clears the active selection and file credential", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-remote-remove-"));
  await withRouteKitHomeAsync(home, async () => {
    putRemote({
      name: "mini",
      gatewayUrl: "https://gateway.example",
      sshHost: "velum-mini",
      addedAt: "2026-07-26T00:00:00.000Z"
    });
    await writeRemoteToken("mini", "private-token", { platform: "linux" });
    const removed = await removeRemote("mini", { platform: "linux" });
    assert.equal(removed, true);
    assert.equal(activeRemote(), undefined);
    assert.deepEqual(readRemoteRegistry().remotes, []);
    assert.equal(existsSync(remoteTokenPath("mini")), false);
  });
});

test("remote URLs require authenticated HTTPS and reject URL metadata", () => {
  assert.equal(normalizeRemoteUrl("https://gateway.example/"), "https://gateway.example");
  assert.equal(normalizeRemoteUrl("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");
  assert.equal(normalizeRemoteUrl("http://[::1]:8080/"), "http://[::1]:8080");
  assert.throws(() => normalizeRemoteUrl("http://gateway.example"), /require HTTPS/);
  assert.throws(() => normalizeRemoteUrl("ftp://localhost/gateway"), /require HTTPS/);
  assert.throws(() => normalizeRemoteUrl("https://gateway.example/?token=nope"), /query string/);
  assert.throws(() => normalizeRemoteUrl("https://user:pass@gateway.example"), /credentials/);
  assert.doesNotThrow(() => validateSshHost("alen@velum-mini"));
  assert.throws(() => validateSshHost("-oProxyCommand=bad"), /SSH host/);
  assert.throws(() => validateSshHost("velum mini"), /SSH host/);
});

test("SSH relay uses argv execution, exchanges JSON, and redacts request secrets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-ssh-relay-"));
  const ssh = join(directory, "ssh");
  const argsPath = join(directory, "args.txt");
  const inputPath = join(directory, "input.json");
  writeFileSync(
    ssh,
    [
      "#!/bin/sh",
      "printf '%s\\n' \"$@\" > \"$ROUTEKIT_TEST_ARGS\"",
      "IFS= read -r payload",
      "printf '%s' \"$payload\" > \"$ROUTEKIT_TEST_INPUT\"",
      "printf '%s\\n' '{\"status\":200,\"body\":{\"protocol\":\"control.v1\",\"id\":\"request-1\",\"ok\":true,\"result\":{\"ready\":true}}}'"
    ].join("\n"),
    { mode: 0o700 }
  );
  chmodSync(ssh, 0o700);
  const previousPath = process.env.PATH;
  const previousArgs = process.env.ROUTEKIT_TEST_ARGS;
  const previousInput = process.env.ROUTEKIT_TEST_INPUT;
  process.env.PATH = directory;
  process.env.ROUTEKIT_TEST_ARGS = argsPath;
  process.env.ROUTEKIT_TEST_INPUT = inputPath;
  try {
    const request = {
      protocol: "control.v1",
      id: "request-1",
      method: "accounts.enroll",
      params: { credential: "credential-secret" }
    };
    const result = await runSshRelay({ sshHost: "velum-mini" }, request);
    assert.equal(result.status, 200);
    assert.match(readFileSync(argsPath, "utf8"), /velum-mini\nroutekit\n--local\n--quiet\ndaemon\nexec/);
    assert.deepEqual(JSON.parse(readFileSync(inputPath, "utf8")), request);
    assert.equal(
      redactSensitiveText('failed {"credential":"credential-secret"}', ["credential-secret"]),
      'failed {"credential":"[redacted]"}'
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousArgs === undefined) delete process.env.ROUTEKIT_TEST_ARGS;
    else process.env.ROUTEKIT_TEST_ARGS = previousArgs;
    if (previousInput === undefined) delete process.env.ROUTEKIT_TEST_INPUT;
    else process.env.ROUTEKIT_TEST_INPUT = previousInput;
  }
});

test("SSH relay reports missing executables without exposing secrets", async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), "routekit-empty-path-"));
  try {
    await assert.rejects(
      runSshRelay(
        { sshHost: "velum-mini" },
        { method: "accounts.enroll", params: { credential: "credential-secret" } }
      ),
      (error: unknown) => {
        assert.match(String(error), /ssh was not found on PATH/);
        assert.doesNotMatch(String(error), /credential-secret/);
        return true;
      }
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("active remote launcher preparation injects gateway credentials without a local client", async () => {
  let localClientCalls = 0;
  const prepared = await resolveLauncherPreparation(
    { tool: "codex", model: "codex/gpt-5.5", cwd: "/workspace" },
    {
      resolve: async () => ({
        kind: "remote",
        remote: {
          name: "mini",
          gatewayUrl: "https://gateway.example",
          sshHost: "velum-mini",
          addedAt: "2026-07-26T00:00:00.000Z"
        },
        authToken: "private-token"
      }),
      client: async () => {
        localClientCalls += 1;
        throw new Error("local daemon must not start");
      }
    }
  );
  assert.equal(localClientCalls, 0);
  assert.equal(prepared.gatewayUrl, "https://gateway.example");
  assert.equal(prepared.authToken, "private-token");
  assert.equal(prepared.model, "codex/gpt-5.5");
});

test("active remote status uses SSH control and never creates a local daemon", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-remote-status-"));
  const bin = mkdtempSync(join(tmpdir(), "routekit-remote-bin-"));
  withRouteKitHome(home, () => {
    putRemote({
      name: "mini",
      gatewayUrl: "https://gateway.example",
      sshHost: "velum-mini",
      addedAt: "2026-07-26T00:00:00.000Z"
    });
  });
  const security = join(bin, "security");
  writeFileSync(security, "#!/bin/sh\nprintf '%s\\n' 'private-token'\n", { mode: 0o700 });
  chmodSync(security, 0o700);
  const ssh = join(bin, "ssh");
  writeFileSync(
    ssh,
    [
      `#!${process.execPath}`,
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const envelope = JSON.parse(input);",
      "  const request = envelope.request;",
      "  const results = {",
      "    'daemon.status': { pid: 42, startedAt: new Date(0).toISOString(), packageVersion: '0.9.10', protocolVersion: 'control.v1', generation: 1, configRevision: 1, accountRevision: 1, controlUrl: 'http://127.0.0.1:1', dataUrl: 'https://gateway.example', dataPort: 443, supervisor: 'systemd', draining: false },",
      "    'providers.status': { providers: [] },",
      "    'accounts.status': { accounts: [], revision: 1 },",
      "    'models.list': { defaultModel: 'codex/gpt-5.5', models: [{ id: 'codex/gpt-5.5' }] }",
      "  };",
      "  const body = { protocol: request.protocol, id: request.id, ok: true, result: results[request.method] };",
      "  process.stdout.write(JSON.stringify({ status: 200, body }) + '\\n');",
      "});"
    ].join("\n"),
    { mode: 0o700 }
  );
  chmodSync(ssh, 0o700);
  const cli = fileURLToPath(new URL("../index.js", import.meta.url));
  const output = execFileSync(process.execPath, [cli, "--json", "status"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTEKIT_HOME: home,
      ROUTEKIT_NO_TUI: "1",
      PATH: `${bin}:${process.env.PATH ?? ""}`
    }
  });
  const status = JSON.parse(output) as { remote?: string; daemon?: { dataUrl?: string } };
  assert.equal(status.remote, "mini");
  assert.equal(status.daemon?.dataUrl, "https://gateway.example");
  assert.equal(existsSync(join(home, "services", "daemon.json")), false);
});

test("control relay validates protocol envelopes and reports a stopped daemon", async () => {
  assert.deepEqual(parseControlRelayEnvelope({ kind: "health" }), { kind: "health" });
  assert.throws(
    () => parseControlRelayEnvelope({
      kind: "call",
      request: { protocol: "control.v0", id: "request-1", method: "daemon.status" }
    }),
    /invalid control relay request/
  );
  const home = mkdtempSync(join(tmpdir(), "routekit-relay-empty-"));
  await withRouteKitHomeAsync(home, async () => {
    const result = await relayLocalControl({
      kind: "call",
      request: {
        protocol: "control.v1",
        id: "request-1",
        method: "daemon.status",
        params: {}
      }
    });
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, {
      protocol: "control.v1",
      id: "request-1",
      ok: false,
      error: { code: "unavailable", message: "RouteKit daemon is not running" }
    });
  });
});
