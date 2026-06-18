/**
 * Real, model-backed coding-harness solve agent.
 *
 * The Fusion Harness Gateway runs this once per panel candidate, inside that
 * candidate's git worktree, with the per-candidate model backend injected via
 * the env (`FUSIONKIT_CHAT_COMPLETIONS_URL`, `FUSIONKIT_MODEL`) and the task in
 * `HARNESS_PROMPT`. It asks that model for a unified diff, applies it, runs the
 * repo's tests, and prints a real transcript. Exit code reflects the test
 * result, so the command harness records a genuine succeeded/failed candidate.
 *
 * No mocks: the patch is produced by the assigned model and verified by really
 * running the repo's test command in the worktree.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_FILE_BYTES = 24_000;
const MAX_CONTEXT_BYTES = 60_000;
const SKIP_DIRS = new Set([".git", "node_modules", ".warrant", "dist", "build", ".venv", "__pycache__"]);
const TEXT_EXT = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".java",
  ".rb", ".php", ".c", ".h", ".cpp", ".hpp", ".json", ".md", ".txt", ".toml", ".yaml", ".yml"
]);

function listRepoFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
        continue;
      }
      const full = join(dir, entry.name);
      const dot = entry.name.lastIndexOf(".");
      const ext = dot >= 0 ? entry.name.slice(dot) : "";
      if (!TEXT_EXT.has(ext)) continue;
      try {
        if (statSync(full).size <= MAX_FILE_BYTES) out.push(full);
      } catch {
        // ignore unreadable entries
      }
    }
  };
  walk(root);
  return out.sort();
}

function buildContext(root: string): string {
  let budget = MAX_CONTEXT_BYTES;
  const parts: string[] = [];
  for (const file of listRepoFiles(root)) {
    if (budget <= 0) break;
    let body: string;
    try {
      body = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = relative(root, file);
    const block = `--- ${rel} ---\n${body}\n`;
    budget -= Buffer.byteLength(block);
    parts.push(block);
  }
  return parts.join("\n");
}

function extractDiff(content: string): string | undefined {
  const fenced = content.match(/```(?:diff|patch)?\s*\n([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? content;
  const start = candidate.search(/^(diff --git |--- )/m);
  if (start < 0) return undefined;
  const diff = candidate.slice(start).trimEnd();
  return diff.length > 0 ? `${diff}\n` : undefined;
}

function applyDiff(root: string, diff: string): { applied: boolean; detail: string } {
  const patchPath = join(root, ".fusion-solve.patch");
  writeFileSync(patchPath, diff);
  for (const args of [["apply", "--whitespace=nowarn", patchPath], ["apply", "--3way", "--whitespace=nowarn", patchPath]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status === 0) return { applied: true, detail: `git ${args[0]} ${args.includes("--3way") ? "(3way)" : ""}`.trim() };
  }
  return { applied: false, detail: "git apply failed for the model-produced diff" };
}

function testCommand(root: string): { command: string; args: string[] } {
  const override = process.env.HARNESS_TEST_COMMAND;
  if (override !== undefined && override.length > 0) {
    const parts = override.split(/\s+/);
    return { command: parts[0] as string, args: parts.slice(1) };
  }
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test !== undefined) return { command: "npm", args: ["test", "--silent"] };
    } catch {
      // fall through to node --test
    }
  }
  return { command: "node", args: ["--test"] };
}

function runTests(root: string): { passed: boolean; output: string } {
  const { command, args } = testCommand(root);
  // Strip NODE_TEST_CONTEXT so a `node --test` subcommand discovers and runs
  // the repo's tests normally, even when the gateway itself runs under a parent
  // test runner (which would otherwise force "test child" mode -> no tests).
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 120_000, env });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(-4000);
  return { passed: result.status === 0, output: `$ ${command} ${args.join(" ")}\n${output}` };
}

async function callModel(prompt: string, context: string): Promise<string> {
  const url = process.env.FUSIONKIT_CHAT_COMPLETIONS_URL;
  const model = process.env.FUSIONKIT_MODEL ?? "local-model";
  if (url === undefined || url.length === 0) {
    throw new Error("FUSIONKIT_CHAT_COMPLETIONS_URL is not set");
  }
  const apiKey = process.env.FUSIONKIT_API_KEY;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      stream: false,
      temperature: 0.2,
      max_tokens: 1024,
      messages: [
        {
          role: "system",
          content:
            "You are a coding agent. Given the repository files and a task, reply with a single " +
            "unified diff (git format, `diff --git` or `---`/`+++` hunks) that accomplishes the task. " +
            "Output ONLY the diff inside a ```diff code block. Do not add explanation."
        },
        {
          role: "user",
          content: `Task: ${prompt}\n\nRepository files:\n${context}`
        }
      ]
    })
  });
  if (!response.ok) {
    throw new Error(`model backend ${model} returned ${response.status}`);
  }
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? "";
}

export async function runSolveAgent(root: string): Promise<number> {
  const modelId = process.env.HARNESS_MODEL_ID ?? "model";
  const prompt = process.env.HARNESS_PROMPT ?? "Fix the failing tests in this repository.";
  const lines: string[] = [`# fusion solve agent (${modelId})`, `task: ${prompt}`, ""];

  let content: string;
  try {
    content = await callModel(prompt, buildContext(root));
  } catch (error) {
    lines.push(`model call failed: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`${lines.join("\n")}\n`);
    return 1;
  }

  const diff = extractDiff(content);
  if (diff === undefined) {
    lines.push("no unified diff found in the model response", "", content.slice(0, 1500));
    process.stdout.write(`${lines.join("\n")}\n`);
    return 1;
  }

  const applied = applyDiff(root, diff);
  lines.push(`patch: ${applied.detail}`);
  if (!applied.applied) {
    lines.push("", "proposed diff:", diff.slice(0, 1500));
    process.stdout.write(`${lines.join("\n")}\n`);
    return 1;
  }

  try {
    execFileSync("git", ["rm", "-f", "--quiet", ".fusion-solve.patch"], { cwd: root });
  } catch {
    // patch file may already be gone; ignore
  }

  const tests = runTests(root);
  lines.push(`tests: ${tests.passed ? "PASS" : "FAIL"}`, "", tests.output);
  process.stdout.write(`${lines.join("\n")}\n`);
  return tests.passed ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  runSolveAgent(process.cwd())
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`fusion-solve-agent crashed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
