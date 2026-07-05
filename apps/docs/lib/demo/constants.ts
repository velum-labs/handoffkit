/**
 * Shared constants for the landing-page FusionKit demo.
 *
 * The demo runs the real `@fusionkit/cli` inside a Vercel Sandbox microVM and
 * attaches the browser terminal (wterm) to its PTY over WebSocket. Sandboxes
 * are forked per visitor from a pre-provisioned template snapshot (see
 * `scripts/provision-demo-template.ts`) so a session boots in seconds.
 */

/** Template sandbox name; provisioned once, then forked per session. */
export const DEMO_TEMPLATE_NAME = "fusionkit-demo-template";

/** Name prefix for per-visitor session sandboxes. */
export const DEMO_SESSION_PREFIX = "fusionkit-demo-s-";

/** Tag identifying live demo session sandboxes (for concurrency counting). */
export const DEMO_SESSION_TAG = { "fusionkit-demo": "session" } as const;

/** Hard wall-clock cap for one interactive session. */
export const DEMO_SESSION_TIMEOUT_MS = 10 * 60 * 1000;

/** Maximum number of concurrent live session sandboxes. */
export const DEMO_MAX_CONCURRENT_SESSIONS = 3;

/** Per-IP session budget (sessions per window). */
export const DEMO_IP_LIMIT = 4;
export const DEMO_IP_WINDOW_MS = 60 * 60 * 1000;

/** Where the demo repo lives inside the sandbox. */
export const DEMO_REPO_DIR = "/vercel/sandbox/demo";

/** Wrapper script (inside the sandbox) that the PTY session executes. */
export const DEMO_SHELL_PATH = "/vercel/sandbox/demo-shell.sh";

/** File holding the provider key inside the VM (sourced by the wrapper). */
export const DEMO_ENV_FILE = "/vercel/sandbox/.demo-env";

/** Version pins used when provisioning the template. */
export const FUSIONKIT_CLI_VERSION = "0.8.0";

/**
 * OpenRouter `:free` panel. Zero per-token cost; rate limited by OpenRouter
 * (20 req/min; 50 req/day at $0 balance, 1000 req/day after a one-time $10
 * credit purchase).
 */
export const DEMO_PANEL = [
  { id: "qwen3", model: "qwen/qwen3-coder:free" },
  { id: "gpt-oss", model: "openai/gpt-oss-120b:free" }
] as const;
export const DEMO_JUDGE_MODEL = "qwen/qwen3-coder:free";

/** `.fusionkit/fusion.json` written into the demo repo. */
export const DEMO_FUSION_CONFIG = {
  version: "fusionkit.fusion.v3",
  tool: "codex",
  defaultEnsemble: "default",
  ensembles: {
    default: {
      panel: DEMO_PANEL.map((member) => ({
        id: member.id,
        model: member.model,
        provider: "openrouter",
        keyEnv: "OPENROUTER_API_KEY"
      })),
      judgeModel: DEMO_JUDGE_MODEL,
      synthesizerModel: DEMO_JUDGE_MODEL
    }
  },
  local: false,
  observe: false,
  portless: false,
  reasoning: true,
  reasoningModel: "qwen3",
  subagents: false
} as const;

/**
 * Egress allow-list for session sandboxes. The visitor gets a real shell, so
 * the firewall keeps the VM from being used as a general egress box. OpenRouter
 * serves the panel; PyPI hosts stay reachable in case the warmed uv cache needs
 * a top-up.
 */
export const DEMO_NETWORK_ALLOW = [
  "openrouter.ai",
  "pypi.org",
  "files.pythonhosted.org"
] as const;

/** PTY start-frame parameters the client uses after connecting. */
export const DEMO_PTY_START = {
  command: DEMO_SHELL_PATH,
  args: [] as string[],
  cwd: DEMO_REPO_DIR,
  env: ["TERM=xterm-256color", "COLORTERM=truecolor", "LANG=C.UTF-8"]
} as const;
