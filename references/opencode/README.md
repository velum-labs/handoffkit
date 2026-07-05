# opencode reference sources (tracked via trackcn)

Read-only reference copies of [sst/opencode](https://github.com/sst/opencode) source, tracked with
[trackcn](https://github.com/jacobparis/trackcn) (see `references/trackcn.json`). Not part of
any build, workspace, or lint scope — study material for how a production coding agent handles
panel-style model quirks, agentic loops, and failure modes.

Update with `npx trackcn pull` (set `GITHUB_TOKEN` to avoid rate limits).

| Directory | Upstream | Why it's here |
| --- | --- | --- |
| `session/` | `packages/opencode/src/session` | Agentic step loop: doom-loop detection (`processor.ts`, threshold 3 identical tool calls), abort plumbing (`llm.ts`), max-step wind-down (`prompt.ts`), retry/backoff (`retry.ts`), per-model prompts (`prompt/*.txt`) |
| `provider/` | `packages/opencode/src/provider` | Per-model request transforms (`transform.ts`): qwen/kimi temperature & top_p tuning, reasoning-effort mapping |
| `llm/` | `packages/llm/src` | Provider/protocol abstraction: OpenAI-compatible chat framing, tool schema handling, provider errors |
| `tool/` | `packages/opencode/src/tool` | First-class file tools (`write`, `edit`, `apply_patch`) and structured invalid-args feedback (`invalid.ts`) — why their models never write files through a shell |
