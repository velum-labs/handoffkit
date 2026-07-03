import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { resolveCursorkitCli } from "@fusionkit/ensemble";
import {
  CURSOR_BRIDGE_MODEL_NAME,
  FUSION_PANEL_MODEL,
  commandOnPath,
  freePort,
  readEnv,
  terminate
} from "@fusionkit/tools";

import { cursorBridgeEnv } from "./bridge-config.js";

type CursorFrontDoorOutcome = {
  id: string;
  status: "passed" | "failed";
  reason?: string;
  request_path?: string;
  evidence: string[];
};

type CursorFrontDoorOutcomeProducer = () => Promise<CursorFrontDoorOutcome>;

export type CursorAcpProducerInput = {
  gatewayUrl: string;
  sentinel: string;
  repo: string;
  command?: string;
  modelName?: string;
  timeoutMs?: number;
};

export function buildCursorAcpProducer(
  input: CursorAcpProducerInput
): CursorFrontDoorOutcomeProducer | undefined {
  const command = input.command ?? "cursor-agent";
  // The live Cursor ACP probe drives the real cursor-agent CLI through the
  // bundled Cursorkit bridge, so it stays opt-in: without the live flag the
  // acceptance suite reports this door as `blocked` rather than spawning live
  // tooling (keeping deterministic runs free of credential/CLI dependencies).
  if (readEnv(process.env, "FUSIONKIT_GATEWAY_LIVE_CURSOR") !== "1") {
    return undefined;
  }
  if (!commandOnPath(command)) {
    return undefined;
  }
  return () => runCursorAcpOutcome({ ...input, command });
}

async function runCursorAcpOutcome(
  input: Required<Pick<CursorAcpProducerInput, "command">> & CursorAcpProducerInput
): Promise<CursorFrontDoorOutcome> {
  const modelName = input.modelName ?? CURSOR_BRIDGE_MODEL_NAME;
  // Reserve a real free loopback port so parallel probes cannot collide.
  const bridgePort = await freePort();
  const bridgeEnv = cursorBridgeEnv({
    port: bridgePort,
    gatewayUrl: input.gatewayUrl,
    modelName,
    providerModel: FUSION_PANEL_MODEL
  });

  const { serveCli } = resolveCursorkitCli();
  let bridgeOut = "";
  // detached: the bridge may spawn children; teardown kills the whole group.
  const bridge = spawn(process.execPath, [serveCli, "serve"], {
    env: bridgeEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  bridge.stdout.on("data", (chunk: Buffer) => {
    bridgeOut += chunk.toString("utf8");
  });
  bridge.stderr.on("data", (chunk: Buffer) => {
    bridgeOut += chunk.toString("utf8");
  });

  const evidence: string[] = [];
  try {
    const deadline = Date.now() + 20_000;
    while (!/bridge listening/.test(bridgeOut) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!/bridge listening/.test(bridgeOut)) {
      return {
        id: "cursor-acp",
        status: "failed",
        reason: "cursorkit_bridge_did_not_start",
        evidence
      };
    }

    const acpText = await driveCursorAgentSentinel({
      command: input.command,
      bridgePort,
      modelName,
      cwd: input.repo,
      sentinel: input.sentinel,
      timeoutMs: input.timeoutMs ?? 120_000
    });
    if (acpText.includes(input.sentinel)) {
      evidence.push(input.sentinel);
      return {
        id: "cursor-acp",
        status: "passed",
        request_path: "/agent.v1.AgentService/Run",
        evidence
      };
    }
    return {
      id: "cursor-acp",
      status: "failed",
      reason: "sentinel_not_observed_in_cursor_session_update",
      evidence
    };
  } catch (error) {
    return {
      id: "cursor-acp",
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
      evidence
    };
  } finally {
    // Process-group SIGTERM with SIGKILL escalation, not a bare child kill.
    terminate(bridge);
  }
}

async function driveCursorAgentSentinel(input: {
  command: string;
  bridgePort: number;
  modelName: string;
  cwd: string;
  sentinel: string;
  timeoutMs: number;
}): Promise<string> {
  const acp = spawn(
    input.command,
    [
      "--endpoint",
      `http://127.0.0.1:${input.bridgePort}`,
      "--model",
      input.modelName,
      "--mode",
      "ask",
      "acp"
    ],
    { cwd: input.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] }
  );
  let acpText = "";
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  const rl = createInterface({ input: acp.stdout });
  const send = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    acp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  rl.on("line", (line) => {
    let message: {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const waiter = pending.get(Number(message.id));
      if (waiter === undefined) return;
      pending.delete(Number(message.id));
      if (message.error !== undefined) waiter.reject(message.error);
      else waiter.resolve(message.result);
      return;
    }
    if (message.method !== undefined) {
      if (message.method === "session/update") acpText += JSON.stringify(message.params);
      if (message.id !== undefined) {
        acp.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "skipped", reason: "acceptance" } } })}\n`
        );
      }
    }
  });
  const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
    Promise.race([
      promise,
      new Promise<T>((_resolve, reject) =>
        setTimeout(() => reject(new Error("ACP step timed out")), ms)
      )
    ]);
  try {
    await withTimeout(
      send("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false
        },
        clientInfo: { name: "fusionkit-acceptance", version: "0.1.0" }
      }),
      60_000
    );
    await withTimeout(send("authenticate", { methodId: "cursor_login" }), 60_000);
    const session = (await withTimeout(
      send("session/new", { cwd: input.cwd, mcpServers: [] }),
      60_000
    )) as { sessionId?: string; session?: { id?: string } };
    const sessionId = session.sessionId ?? session.session?.id;
    if (sessionId === undefined) return acpText;
    await withTimeout(
      send("session/prompt", {
        sessionId,
        prompt: [
          {
            type: "text",
            text: `Reply with exactly this token and nothing else: ${input.sentinel}`
          }
        ]
      }),
      input.timeoutMs
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return acpText;
  } finally {
    rl.close();
    terminate(acp);
  }
}
