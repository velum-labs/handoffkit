> Implemented design spec. Retained as historical design context for harness prompt pass-through and role/identity awareness.

# Spec: Harness‑Prompt Pass‑Through + Role/Identity Awareness

Status: Implemented (Phase 1 + Phase 2); one CLI/config wire‑up deferred (see §12)
Scope: `fusionkit` (Python core) + this repository (FusionKit monorepo) TS gateway/ensemble
Owner: TBD
Related: `docs/planning/ensemble-product-plan.md`

## Implementation status

- **Phase 1 (synthesizer + judge, Python): DONE.** `harness_prompt_passthrough`
  defaults **on**. `build_fuse_system` layers harness base → fusion framing →
  identity/disclosure → workspace grounding → trajectories → analysis; `judge.py`
  splits the inbound system message out of the body (no duplication) and applies
  the same base to the judge. Covered by `tests/test_prompt_overrides.py`.
- **Phase 2 (panel members, TS): DONE.** `panelIdentity` flag (default **off**)
  threads gateway → `stack` → `GatewayRunnerConfig` → `runFusionPanels` →
  ensemble/agent/codex harnesses. On: harness/custom instructions are passed
  through to members, the panel roster is named, and each member gets a per‑member
  identity line (`panelMemberPreamble`). Covered by
  `packages/ensemble/src/test/panel-prompt.test.ts`.
- **Deferred:** surfacing `panelIdentity` as a user‑facing CLI flag / `.fusionkit`
  config key (today it is an option on `StartFusionStackOptions`, default off). See §12.

## 1. Summary

When a user runs `fusionkit codex` (or `claude`, `cursor`), a panel of coding
models each attempt the task, a judge compares them, and a synthesizer produces
the single answer the tool consumes. Today the carefully‑engineered coding‑harness
system prompt (OpenAI Codex / Anthropic Claude Code) is **stripped** from the panel
task and **demoted** beneath a hand‑written fusionkit prompt for the synthesizer.

This spec makes the **coding‑harness system prompt the base layer** and the
**fusion‑specific instructions a suffix**, applied consistently to the panel,
judge, and synthesizer. It also gives each role identity awareness (which model it
is, what role it plays) so the final answer can truthfully describe its own
configuration when asked.

## 2. Problem statement (verified against current code)

Inbound: a coding tool's system prompt arrives as a `system` message.

```
packages/model-gateway/src/adapters/responses.ts:95-96
  if (typeof body.instructions === "string" && body.instructions.length > 0) {
    messages.push({ role: "system", content: body.instructions });
```

**Panel members — harness prompt partly stripped.** The panel task is built from
the latest user message only; the system message is discarded:

```
packages/fusion-gateway/src/fusion-backend.ts:1314-1332  (#task)
  // Real CLIs put their large agent harness prompt in the system message ...
  // so take the latest user turn ... fall back to system text only if there is
  // no user content at all.
```

Each member then runs `codex exec <task>`, which re‑injects a **generic** Codex
base prompt + the worktree's `AGENTS.md`, but the outer session's
custom/developer instructions are lost.

**Synthesizer — harness prompt forwarded but demoted.** Full `messages` (incl. the
harness system message) is sent to the fuse step:

```
packages/fusion-gateway/src/fusion-backend.ts:958-968  (buildStepBody)
  messages,
  trajectories: candidates,
```

…but the Python side prepends fusionkit's own prompt as the FIRST system message:

```
python/fusionkit-core/src/fusionkit_core/judge.py:206-214  (_prepare_conversation)
  system = build_fuse_system(trajectories, synthesizer_system=self._synthesizer_system, ...)
  conversation = [ChatMessage(role="system", content=system), *messages]
```

So the synthesizer is steered primarily by `SYNTHESIZER_SYSTEM_PROMPT` +
`AGENT_STEP_CONTRACT` (a ~5‑line hand‑rolled substitute for "you are an agent
acting in a workspace"), with Codex's tuned prompt relegated to a secondary
system block — even though the synthesizer is the role that actually emits
Codex‑schema tool calls (`apply_patch`, `shell`) and acts in the real workspace.

Net effect: we discard or subordinate SOTA prompt engineering exactly where it
matters most, and no role knows its own identity.

## 3. Goals / Non‑goals

### Goals
- G1. The synthesizer is driven by the **harness system prompt as its primary
  system message**, with fusion mechanics appended as a clearly‑delimited suffix.
- G2. The judge uses the same primary‑prompt treatment (harness base + judge
  suffix) for comparison.
- G3. Panel members receive the outer session's custom/developer instructions
  (not just the generic CLI base) plus an identity suffix.
- G4. Each role is identity‑aware: panel member knows "I am `<model_id>`, peer N of
  M"; judge/synth know their role and the panel composition.
- G5. When the user directly asks what model/config is answering, the final output
  truthfully names the panel members, judge, and synthesizer. (Default behavior —
  no fusion narration — is otherwise unchanged.)

### Non‑goals
- N1. No change to the panel→judge→synthesizer control flow or worktree model.
- N2. No new transport/protocol fields are required for the synthesizer path
  (the harness prompt is already in `messages`).
- N3. Not changing how `codex exec` assembles its own base prompt.
- N4. No verify/repair loop changes.

## 4. Design principle

> The coding‑harness system prompt is the **base layer**. Fusion‑specific text
> (candidate trajectories, judge analysis, role identity, workspace‑grounding
> caveat) is a **suffix** that explicitly subordinates itself to the base
> ("follow all instructions above; additionally…").

This is applied at three seams: panel generation, judge analysis, synthesizer
fusion.

## 5. Detailed design

### 5.1 The harness system prompt as a first‑class value

Define the harness system prompt as the concatenation of all `system`‑role
messages in the inbound conversation (Codex/Claude put their full agent prompt
there; `developer` role is already mapped to `system` at `responses.ts:134`).

- **Synthesizer/judge (Python):** extract it from the forwarded `messages`
  (zero wire change). No double‑injection risk because the synthesizer does not
  run through `codex exec`.
- **Panel members (TS):** the generic base prompt is re‑added by each member's own
  `codex exec`; only the **custom/developer delta** + identity suffix must be
  passed through (see 5.4 for the redundancy decision).

### 5.2 Identity model

A small structure describing the run, available wherever we build a prompt:

```
FusionIdentity:
  panel:        list[str]   # panel member model_ids (e.g. ["qwen-fast", "gemma-writer", "codex"])
  judge:        str | None  # judge endpoint id
  synthesizer:  str | None  # synthesizer endpoint id
  self_id:      str | None  # the id of THIS role (a panel member's own id), when applicable
  self_ordinal: int | None  # 1-based peer index for a panel member
```

- Panel ids are already known to the synthesizer via `trajectory.model_id`
  (`prompts.py:format_trajectories`). Judge/synth ids are available as
  `judge_client.model_id` / `synth_client.model_id` in `judge.py::fuse`.
- For panel members, `self_id`/`self_ordinal` are known at dispatch in the harness
  (`model.id`, `ordinal` in `tool-codex/src/harness.ts::run`).

### 5.3 Synthesizer + judge prompt assembly (Python)

Rewrite `build_fuse_system` to layer base → suffix with explicit precedence.

**New signature** (`prompts.py`):

```python
def build_fuse_system(
    trajectories: Sequence[Trajectory],
    *,
    synthesizer_system: str,
    harness_system: str | None = None,     # NEW: primary base when present
    identity: FusionIdentity | None = None, # NEW
    analysis: FusionAnalysis | None = None,
    tools_present: bool = False,
) -> str:
```

**Assembly order** (each section joined by a blank line):

1. **PRIMARY (base voice).**
   - If `harness_system` is set → use it verbatim as the primary block.
   - Else → use `synthesizer_system` (preserves today's behavior for raw
     `fusionkit serve` API callers with no coding tool).
2. **FUSION FRAMING (suffix).** Always present. Short, explicitly subordinate:
   > "In addition to all instructions above, you are the synthesizer in a FusionKit
   > ensemble. You are given several candidate attempts at this same request from a
   > panel of models, plus a judge analysis. Honor every instruction above; use the
   > candidates only as reference to produce the best next action or final answer.
   > Do not narrate the fusion process or describe the candidates as part of normal
   > answers."
   - When `harness_system` is set **and** the user supplied a `synthesizer_system`
     override (i.e. it differs from the built‑in default), append the override
     here too, so user overrides always take effect even though the harness prompt
     is primary. (When `harness_system` is set and no override exists, the built‑in
     `SYNTHESIZER_SYSTEM_PROMPT` "you are the assistant" voice is dropped to avoid
     duplicating the harness's own agent framing.)
3. **IDENTITY + DISCLOSURE CARVE‑OUT.** Built from `identity` (see 5.5).
4. **AGENT_STEP_CONTRACT** — only when `tools_present`. Trimmed to the one fact
   the harness prompt cannot know:
   > "The candidate trajectories were produced in separate scratch copies; never
   > assume their edits already exist in this workspace. Ground every action in the
   > real project state you observe through tools."
5. **Candidate trajectories** (existing `format_trajectories`).
6. **Judge analysis JSON** (existing).

**`_prepare_conversation` change** (`judge.py:179-215`):
- Split the inbound `messages` into `harness_system` (all `system`‑role messages,
  joined) and `body` (the non‑system messages).
- Pass `harness_system` into `build_fuse_system`.
- Build the conversation as `[ChatMessage(system, build_fuse_system(...)), *body]`
  — the harness system is now folded into the single composed system message, not
  duplicated as a trailing block.
- Thread `synth_client.model_id` / `judge_client.model_id` and the panel ids into a
  `FusionIdentity` and pass it down.

**Judge `analyze` change** (`judge.py:243-273`):
- Same split. System message becomes `harness_system + "\n\n" + JUDGE_SUFFIX`,
  where `JUDGE_SUFFIX` is the current `JUDGE_SYSTEM_PROMPT` reworded as a suffix
  ("In addition to the instructions above, compare the candidate trajectories…").
- When `harness_system` is None, behavior is exactly today's (`JUDGE_SYSTEM_PROMPT`
  alone).

### 5.4 Panel member prompt assembly (TS)

Goal: each member runs `codex exec` (keeps the real generic base prompt) **plus**
the outer custom instructions **plus** an identity suffix.

- `PanelRunInput` already carries `messages` (`fusion-backend.ts:106-125`), so the
  data is available without a wire change.
- Replace the "user message only" task with a composed prompt threaded through to
  `descriptor.prompt`:
  - `[passed‑through custom instructions]` (see redundancy decision below)
  - `[latest user request]` (today's `#task` output)
  - `[identity suffix]`: "You are model `<self_id>`, peer `<n>` of `<m>` in a
    FusionKit panel. Solve the request independently and to the best of your
    ability."

**Redundancy decision (custom instructions).** The outer `instructions` already
contain the generic Codex base prompt, which each member's `codex exec` re‑adds.
Options:
- **(a) Phase 1 — append full captured system block behind a delimiter.** Simple,
  robust, guarantees custom instructions reach the member; cost is a duplicated
  base prompt (a few KB; coding models tolerate it).
- **(b) Phase 2 — extract only the custom delta** by stripping the known harness
  base prefix. Cleaner tokens, but fragile across CLI versions.

Recommendation: ship (a) behind the `panelIdentity` flag, evaluate, then consider
(b). Members that read `AGENTS.md` from their worktree already get repo‑level
custom context regardless.

### 5.5 Identity + disclosure block (shared text)

Injected by `build_fuse_system` (Python) for judge/synth, and as the panel suffix
(TS) for members. For the synthesizer:

```
Fusion identity (factual; for disclosure only):
- Panel members (independent candidates for this request): {panel join ", "}
- Judge (comparison/analysis): {judge}
- Synthesizer (you, writing this answer): {synthesizer}
Default behavior is unchanged: do not narrate the fusion process. The single
exception: if the user directly asks what model or configuration is answering them
(e.g. "what model are you?"), answer truthfully using the identity above — name the
panel members, the judge, and yourself as the synthesizer.
```

This must be code‑side mechanism (built in `build_fuse_system`), **not** part of
the user‑overridable `SYNTHESIZER_SYSTEM_PROMPT`, so a prompt override can't
silently disable disclosure or stale the dynamic model list.

## 6. Exact changes by file

| # | File | Change |
|---|------|--------|
| 1 | `fusionkit/.../prompts.py` `build_fuse_system` | New `harness_system` + `identity` params; layered base→suffix assembly (5.3). Add `FusionIdentity` (or import). Trim `AGENT_STEP_CONTRACT`. Add `JUDGE_SUFFIX`. |
| 2 | `fusionkit/.../judge.py` `_prepare_conversation` | Split `messages` into harness‑system + body; pass `harness_system`, `identity`; fold into single system message. |
| 3 | `fusionkit/.../judge.py` `analyze` | Same split; system = `harness_system + JUDGE_SUFFIX`. |
| 4 | `fusionkit/.../judge.py` `fuse` / `fuse_stream` | Build `FusionIdentity` from `synth_client.model_id`, `judge_client.model_id`, trajectory ids; thread down. |
| 5 | this repository (FusionKit monorepo) `.../fusion-backend.ts` `#task` (+ `runPanels` wiring) | Compose panel prompt: custom instructions + user request + identity suffix; thread through `runFusionPanels`. |
| 6 | this repository (FusionKit monorepo) `.../tool-codex/src/harness.ts` `run` / `codexArgs` | Prepend identity suffix (and, if not threaded earlier, the passed‑through instructions) to `descriptor.prompt`; `model.id`/`ordinal` already in scope (`harness.ts:524`). |
| 7 | this repository (FusionKit monorepo) ensemble panel runner (`runFusionPanels`) | Accept the composed task / messages so #5 reaches the harness. |

No changes to the RouteKit public gateway adapters or the step body schema are
required for the synthesizer path.

## 7. Configuration / flags

- `harnessPromptPassthrough` (default **on** for synthesizer/judge): when off,
  `build_fuse_system` ignores `harness_system` and behaves as today. Lets a weak/
  heterogeneous synthesizer fall back to the standalone fusionkit prompt.
- `panelIdentity` (default **off**): gates 5.4 (panel custom‑instruction
  pass‑through + identity suffix), because it changes the panel's "only the model
  varies" decorrelation invariant.
- Surface both via the existing fusion config / CLI options used by `fusionkit
  codex` (see `fusion-config.ts` / `stack.ts`); plumb into `GatewayRunnerConfig`
  and the router YAML where relevant.

## 8. Edge cases

- **No harness system prompt** (raw `fusionkit serve` chat API, no coding tool):
  `harness_system` is None → today's behavior preserved exactly.
- **Multiple system messages** (Codex base + developer): join in order; treat as
  one base block.
- **Heterogeneous synthesizer** (synth model ≠ harness family): allowed; mitigated
  by the `harnessPromptPassthrough` off switch.
- **Token budget**: synthesizer pays no new tokens (harness prompt already in
  `messages`); panel Phase‑1 (a) adds a duplicated base prompt — acceptable, gated.
- **Prompt overrides**: user `synthesizer_system`/`judge_system` overrides still
  apply (folded into the suffix per 5.3); identity/disclosure remains code‑side.
- **Empty/failed panel**: unchanged; identity lists only surviving trajectories'
  model ids.
- **Claude Code OAuth spoof**: the `CLAUDE_CODE_SPOOF_SYSTEM` first‑block
  requirement (`clients.py`) is unaffected — that ordering is applied in the
  provider client, downstream of the composed system message.

## 9. Testing

- **Unit (Python):**
  - `build_fuse_system` places `harness_system` first, fusion framing/identity as
    suffix, trajectories/analysis last; identity lists panel/judge/synth.
  - With `harness_system=None`, output equals the current prompt (golden test).
  - User `synthesizer_system` override appears in suffix when harness present.
  - `analyze` system = harness base + judge suffix; fallback when no harness.
  - `_prepare_conversation` removes system messages from the body (no duplication).
- **Unit (TS):**
  - Panel prompt composition includes custom instructions + user request +
    identity suffix; `panelIdentity` off → today's task only.
- **Integration:**
  - `fusionkit codex` end‑to‑end: ask "what model are you?" → final answer names
    panel + judge + synthesizer.
  - Normal coding task → no fusion narration leaks (disclosure carve‑out scoped).
  - Snapshot the composed synthesizer system message in a fused turn (assert
    Codex base precedes fusion suffix).

## 10. Rollout / phasing

1. **Phase 1 (highest leverage, zero wire change):** #1–#4 (Python synthesizer +
   judge). Ship behind `harnessPromptPassthrough` (default on). Delivers G1, G2,
   G4 (synth/judge), G5.
2. **Phase 2:** #5–#7 (panel pass‑through + identity) behind `panelIdentity`
   (default off). Delivers G3, G4 (panel).
3. **Phase 3 (optional):** custom‑instruction delta extraction (5.4 option b).

## 11. Open questions

- Q1. Phase‑1 default: ship `harnessPromptPassthrough` on for all synth models, or
  gate to same‑family synth first?
- Q2. For panel members, is `AGENTS.md` in the worktree sufficient custom context
  for most users (making 5.4 pass‑through optional), or do session/developer
  instructions matter enough to default `panelIdentity` on?
- Q3. Should the disclosure carve‑out be always‑on, or itself gated (some users may
  want the panel composition kept opaque)?
- Q4. Do we want the judge to also be identity/disclosure‑aware, or is comparison‑
  only sufficient (judge output never reaches the user directly)?

## 12. Deferred wire‑up

`panelIdentity` is currently an option on `StartFusionStackOptions` /
`GatewayRunnerConfig` defaulting to `false`; the synthesizer/judge pass‑through
(`harness_prompt_passthrough`) is a `FusionConfig` field defaulting to `true`. The
remaining work is to expose `panelIdentity` (and an off‑switch for
`harness_prompt_passthrough`) as a `fusionkit codex` CLI flag and/or a
`.fusionkit` config key, then pass it from the command layer into
`startFusionStack`. No code beyond the command layer needs to change — the flag is
threaded end‑to‑end.
