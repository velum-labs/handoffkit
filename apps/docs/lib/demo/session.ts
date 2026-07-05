import "server-only";

import { Sandbox } from "@vercel/sandbox";

import {
  DEMO_ENV_FILE,
  DEMO_MAX_CONCURRENT_SESSIONS,
  DEMO_NETWORK_ALLOW,
  DEMO_SESSION_PREFIX,
  DEMO_SESSION_TAG,
  DEMO_SESSION_TIMEOUT_MS,
  DEMO_TEMPLATE_NAME
} from "./constants";

/** Explicit access-token credentials for non-OIDC environments (local dev). */
function tokenCredentials(): { token: string; teamId: string; projectId: string } | undefined {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (token !== undefined && teamId !== undefined && projectId !== undefined) {
    return { token, teamId, projectId };
  }
  return undefined;
}

/** Whether the live demo backend has everything it needs. */
export function isDemoConfigured(): boolean {
  const hasSandboxAuth = process.env.VERCEL_OIDC_TOKEN !== undefined || tokenCredentials() !== undefined;
  return hasSandboxAuth && process.env.OPENROUTER_API_KEY !== undefined;
}

export type DemoSession = {
  sandboxName: string;
  /** PTY WebSocket endpoint; connect to `${url}?token=${token}`. */
  url: string;
  token: string;
  expiresAt: number;
};

export class DemoCapacityError extends Error {
  constructor() {
    super("demo session capacity reached");
    this.name = "DemoCapacityError";
  }
}

export class DemoTemplateMissingError extends Error {
  constructor() {
    super(`template sandbox "${DEMO_TEMPLATE_NAME}" has no snapshot; run \`pnpm demo:provision\``);
    this.name = "DemoTemplateMissingError";
  }
}

/** Sandbox statuses that count against the concurrency cap. */
const LIVE_STATUSES = new Set(["running", "pending"]);

async function countLiveSessions(): Promise<number> {
  const result = await Sandbox.list({ tags: { ...DEMO_SESSION_TAG }, ...tokenCredentials() });
  let live = 0;
  for await (const sandbox of result) {
    if (LIVE_STATUSES.has(sandbox.status)) live += 1;
  }
  return live;
}

/**
 * Fork a per-visitor session sandbox from the pre-provisioned template and
 * open its interactive PTY. The provider key is written into a root-owned file
 * inside the VM (sourced by the launch wrapper) rather than passed through the
 * browser.
 */
export async function createDemoSession(): Promise<DemoSession> {
  if ((await countLiveSessions()) >= DEMO_MAX_CONCURRENT_SESSIONS) {
    throw new DemoCapacityError();
  }

  const sandboxName = `${DEMO_SESSION_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.fork({
      sourceSandbox: DEMO_TEMPLATE_NAME,
      name: sandboxName,
      timeout: DEMO_SESSION_TIMEOUT_MS,
      persistent: false,
      tags: { ...DEMO_SESSION_TAG },
      networkPolicy: { allow: [...DEMO_NETWORK_ALLOW] },
      env: {
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "",
        FUSIONKIT_SKIP_KEY_VALIDATION: "1"
      },
      ...tokenCredentials()
    });
  } catch (error) {
    if (error instanceof Error && /not[_ ]?found|no such sandbox|404/i.test(error.message)) {
      throw new DemoTemplateMissingError();
    }
    throw error;
  }

  // The interactive PTY does not necessarily inherit sandbox-level env, so the
  // launch wrapper (`demo-shell.sh`, baked into the template) also sources this
  // file. The key stays inside the VM; the browser only ever sees the PTY url.
  await sandbox.writeFiles([
    {
      path: DEMO_ENV_FILE,
      content: Buffer.from(
        `OPENROUTER_API_KEY=${process.env.OPENROUTER_API_KEY ?? ""}\nFUSIONKIT_SKIP_KEY_VALIDATION=1\n`
      ),
      mode: 0o600
    }
  ]);

  const { url, token } = await sandbox.openInteractive();
  return {
    sandboxName,
    url,
    token,
    expiresAt: Date.now() + DEMO_SESSION_TIMEOUT_MS
  };
}

/** Stop a session sandbox early (visitor closed the terminal). */
export async function stopDemoSession(sandboxName: string): Promise<void> {
  if (!sandboxName.startsWith(DEMO_SESSION_PREFIX)) return;
  const sandbox = await Sandbox.get({ name: sandboxName, resume: false, ...tokenCredentials() });
  await sandbox.stop();
}
