/**
 * Provision (or re-provision) the demo template sandbox that landing-page
 * sessions are forked from.
 *
 *   pnpm demo:provision
 *
 * Auth: `VERCEL_OIDC_TOKEN` (via `vercel env pull`) or
 * `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`.
 *
 * The template holds no secrets: the OpenRouter key is injected per-session by
 * the API route. Re-run this script any time the pinned CLI version, panel, or
 * demo repo changes.
 */
import { Sandbox } from "@vercel/sandbox";

import { DEMO_REPO_DIR, DEMO_SHELL_PATH, DEMO_TEMPLATE_NAME, FUSIONKIT_CLI_VERSION } from "../lib/demo/constants";
import { DEMO_REPO_FILES, DEMO_SHELL_SCRIPT } from "../lib/demo/template-files";

function credentials(): { token: string; teamId: string; projectId: string } | Record<string, never> {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (token !== undefined && teamId !== undefined && projectId !== undefined) {
    return { token, teamId, projectId };
  }
  return {};
}

async function run(sandbox: Sandbox, label: string, cmd: string, args: string[]): Promise<void> {
  console.log(`\n== ${label}`);
  const result = await sandbox.runCommand({
    cmd,
    args,
    stdout: process.stdout,
    stderr: process.stderr
  });
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${result.exitCode}`);
  }
}

async function main(): Promise<void> {
  console.log(`provisioning template sandbox "${DEMO_TEMPLATE_NAME}"...`);

  // Recreate from scratch so re-provisioning always yields a clean image.
  try {
    const existing = await Sandbox.get({ name: DEMO_TEMPLATE_NAME, resume: false, ...credentials() });
    console.log("deleting existing template...");
    await existing.delete();
  } catch {
    // No existing template.
  }

  const sandbox = await Sandbox.create({
    name: DEMO_TEMPLATE_NAME,
    runtime: "node24",
    timeout: 20 * 60 * 1000,
    persistent: true,
    snapshotExpiration: 0,
    keepLastSnapshots: { count: 1 },
    ...credentials()
  });
  console.log(`created sandbox "${sandbox.name}"`);

  await run(sandbox, "install uv", "bash", ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"]);

  await run(sandbox, "install @fusionkit/cli + codex", "bash", [
    "-c",
    `sudo npm install -g @fusionkit/cli@${FUSIONKIT_CLI_VERSION} @openai/codex`
  ]);

  await run(sandbox, "warm fusionkit python engine", "bash", [
    "-c",
    `export PATH="$HOME/.local/bin:$PATH" && uvx fusionkit@${FUSIONKIT_CLI_VERSION} --help > /dev/null && echo engine cached`
  ]);

  console.log("\n== write demo repo + launch wrapper");
  await sandbox.writeFiles([
    ...DEMO_REPO_FILES.map((file) => ({ path: file.path, content: Buffer.from(file.content) })),
    { path: DEMO_SHELL_PATH, content: Buffer.from(DEMO_SHELL_SCRIPT), mode: 0o755 }
  ]);

  await run(sandbox, "init demo git repo", "bash", [
    "-c",
    [
      `cd ${DEMO_REPO_DIR}`,
      "git init -q",
      'git config user.email "demo@fusionkit.dev"',
      'git config user.name "fusionkit demo"',
      "git add -A",
      'git commit -qm "demo repo"'
    ].join(" && ")
  ]);

  await run(sandbox, "sanity check binaries", "bash", [
    "-c",
    'export PATH="$HOME/.local/bin:$PATH" && fusionkit --version && codex --version && uvx --version'
  ]);

  console.log("\nstopping sandbox to snapshot...");
  const result = await sandbox.stop();
  console.log(`template ready (snapshot ${result.snapshot?.id ?? "pending"}).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
