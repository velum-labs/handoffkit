/**
 * Shared test doubles for the harness backends: a fake harness adapter and a
 * sandbox provider over a local directory. Together they exercise the entire
 * generic backend path (staging, transcript, mirror-back, event chain)
 * through the real `HarnessAgent`, replacing only what would otherwise need
 * cloud credentials or a microVM.
 */
import { execFile, spawn as spawnChild } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";

import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
  HarnessV1Session,
  HarnessV1StreamPart
} from "@ai-sdk/harness";

import type { HarnessAdapter } from "../index.js";

const execFileAsync = promisify(execFile);

const usage = {
  inputTokens: { total: 7, noCache: 7, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: 3, reasoning: undefined }
};

export type FakeHarnessLog = {
  prompts: string[];
  envSeen: Record<string, string>[];
  workDirs: string[];
  destroyed: number;
};

export function emptyHarnessLog(): FakeHarnessLog {
  return { prompts: [], envSeen: [], workDirs: [], destroyed: 0 };
}

/**
 * A fake harness adapter that reads a staged workspace file and writes a
 * result file through the sandbox surface, then emits a clean structured
 * stream. `harnessId` lets a test label it as claude-code, pi, etc.; the
 * behavior is identical because the generic backend treats every binding the
 * same way.
 */
export function fakeHarness(log: FakeHarnessLog, harnessId = "fake-harness"): HarnessAdapter {
  const resumeState = {
    harnessId,
    specificationVersion: "harness-v1",
    data: {}
  } as const;
  return {
    specificationVersion: "harness-v1",
    harnessId,
    builtinTools: {},
    doStart: async (start) => {
      const sandbox = start.sandboxSession.restricted();
      log.workDirs.push(start.sessionWorkDir);
      const session: HarnessV1Session = {
        sessionId: start.sessionId,
        isResume: false,
        doPromptTurn: async ({ prompt, emit }) => {
          const promptText = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
          log.prompts.push(promptText);
          const staged = await sandbox.readTextFile({
            path: `${start.sessionWorkDir}/data.txt`
          });
          await sandbox.writeTextFile({
            path: `${start.sessionWorkDir}/result.txt`,
            content: `lines=${(staged ?? "").trim().split("\n").length}\n`
          });
          const parts: HarnessV1StreamPart[] = [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "governed harness turn" },
            { type: "text-end", id: "t1" },
            { type: "file-change", event: "create", path: "result.txt" },
            { type: "finish-step", finishReason: { unified: "stop", raw: "end_turn" }, usage },
            { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, totalUsage: usage }
          ];
          for (const part of parts) emit(part);
          return {
            submitToolResult: async () => undefined,
            done: Promise.resolve()
          };
        },
        doCompact: async () => {
          throw new Error("compaction unsupported by the fake harness");
        },
        doContinueTurn: async ({ emit }) => {
          emit({ type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, totalUsage: usage });
          return { submitToolResult: async () => undefined, done: Promise.resolve() };
        },
        doSuspendTurn: async () => ({ ...resumeState, type: "continue-turn" }),
        doDetach: async () => ({ ...resumeState, type: "resume-session" }),
        doStop: async () => ({ ...resumeState, type: "resume-session" }),
        doDestroy: async () => {
          log.destroyed += 1;
        }
      };
      return session;
    }
  };
}

/**
 * A sandbox provider over a local directory: `run`/`spawn` execute through
 * /bin/sh and the file surface is node:fs. Implements the same
 * `HarnessV1SandboxProvider` contract as the real providers, so the generic
 * backend's staging and mirror-back run unchanged.
 */
export function fakeLocalSandboxProvider(root: string): HarnessV1SandboxProvider {
  async function runCommand(
    command: string,
    workingDirectory?: string
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", command], {
        cwd: workingDirectory ?? root
      });
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return {
        exitCode: typeof failure.code === "number" ? failure.code : 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? ""
      };
    }
  }

  const session: HarnessV1NetworkSandboxSession = {
    id: "fake-local-sandbox",
    description: `fake local sandbox at ${root}`,
    defaultWorkingDirectory: root,
    ports: [4000],
    getPortUrl: async ({ port, protocol }) => `${protocol ?? "http"}://127.0.0.1:${port}/`,
    stop: async () => undefined,
    restricted: () => session,
    readFile: async ({ path }) => {
      try {
        return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
      } catch {
        return null;
      }
    },
    readBinaryFile: async ({ path }) => {
      try {
        return new Uint8Array(await readFile(path));
      } catch {
        return null;
      }
    },
    readTextFile: async ({ path }) => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return null;
      }
    },
    writeFile: async ({ path, content }) => {
      const chunks: Uint8Array[] = [];
      const reader = content.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.concat(chunks));
    },
    writeBinaryFile: async ({ path, content }) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
    writeTextFile: async ({ path, content }) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    },
    run: async ({ command, workingDirectory }) => runCommand(command, workingDirectory),
    spawn: async ({ command, workingDirectory }) => {
      const child = spawnChild("/bin/sh", ["-c", command], {
        cwd: workingDirectory ?? root
      });
      return {
        ...(child.pid !== undefined ? { pid: child.pid } : {}),
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        wait: () =>
          new Promise<{ exitCode: number }>((resolve) => {
            child.on("close", (code) => resolve({ exitCode: code ?? 0 }));
          }),
        kill: async () => {
          child.kill();
        }
      };
    }
  };

  return {
    specificationVersion: "harness-sandbox-v1",
    providerId: "fake-local",
    createSession: async () => session
  };
}
