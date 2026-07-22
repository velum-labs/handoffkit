# RouteKit end-to-end verification matrix

Run the credential-free matrix:

```bash
pnpm test:e2e:matrix
```

It exercises the five launch provider classes (`openai`, `anthropic`,
`openrouter`, `codex`, and `claude-code`) through the OpenAI Chat, Anthropic
Messages, and Responses HTTP boundaries. It also launches every installed coding-agent CLI through the real
`routekit` command in a tmux PTY. Each CLI case selects a non-default
namespaced model, types a deterministic prompt, waits for a response, and
checks the model that reached the gateway. Claude Code and Codex additionally
execute a simulator-scripted safe shell tool call. The existing subscription
pool suite covers eligible-account selection, proactive quota switching,
quota failover, transient throttling, and all-members-unavailable exhaustion.
The `native-pickers` case also verifies that Claude Code sees `claude-code/*`
as bare Claude names, Codex sees `codex/*` as bare Codex names, duplicate
namespaced entries are absent from those pickers, and the global OpenAI catalog
remains namespaced.

The deterministic `anthropic-thinking` case routes both buffered and
pathologically chunked streaming Messages requests through the canonical
`claude-code` provider backend. It asserts exact adaptive controls, signed
assistant-history replay, `signature_delta`, `redacted_thinking`, and separation
of thinking from answer text.

The deterministic `dynamic-reasoning-capabilities` case verifies that ordered
opaque effort IDs and config provenance survive model discovery, that a
supported value reaches OpenRouter egress, and that an unavailable value is
rejected with `400` before provider transport.

Transactional account activation has a separate process-interruption record:
[RouteKit transactional account activation evidence](routekit-account-activation-evidence.md).
It covers an actual child `SIGKILL`, daemon startup recovery, injected
connector failure, idempotent replay, and transaction-journal redaction without
copying provider credentials into artifacts.

## Live, billed mode

Live calls are disabled unless explicitly authorized:

```bash
ROUTEKIT_LIVE_E2E=1 pnpm test:e2e:matrix
```

Live mode first reruns the deterministic matrix, then starts RouteKit with
`.routekit/router.yaml`. Failure to discover any configured provider is a
failure. An installed CLI that cannot complete is also a failure; a missing
optional CLI is an explicit skip. Prompts and HTTP output limits are kept
small. The default hard budget is 48 provider requests, including extra agent
turns such as a tool result or OpenCode title generation.

Live mode repeats the native-picker assertions for configured Claude Code and
Codex providers. Catalog checks do not issue model-generation requests and
therefore add zero billed calls.

When `claude-code` and the `pool` door are selected, live mode also loads the
real enrolled account set, injects a quota response for the first selected
member, and asserts that the second member succeeds and becomes active. The
fault and success response are local, so this failover case consumes no model
quota and writes cooldown state only under the temporary matrix directory.

Useful filters:

```bash
pnpm test:e2e:matrix -- --provider openrouter,codex
pnpm test:e2e:matrix -- --door openai-chat,claude
ROUTEKIT_LIVE_E2E=1 pnpm test:e2e:matrix -- \
  --provider claude-code --door pool --max-live-calls 1
ROUTEKIT_LIVE_E2E=1 pnpm test:e2e:matrix -- \
  --model openrouter=openrouter/openai/gpt-4.1-nano \
  --timeout-ms 180000 --max-live-calls 20
```

The equivalent environment filters are `ROUTEKIT_E2E_PROVIDER`,
`ROUTEKIT_E2E_DOOR`, `ROUTEKIT_E2E_TIMEOUT_MS`, and
`ROUTEKIT_E2E_MAX_LIVE_CALLS`.

## Artifacts and interpretation

Each run writes a timestamped `report.json` and sanitized PTY transcripts under
`.artifacts/routekit-e2e/`. This directory is ignored by Git. The report has
exact pass/fail/skip counts, per-case duration and billed-call counts, and the
total number of live model requests observed at the local counting proxy. Every
result has a stable `caseId` and the applicable L05 `routeIds`; cases for
not-offered doors such as OpenCode deliberately have an empty `routeIds` list.
The report also records the exact Git revision and whether its worktree was
dirty.
PTY cases isolate RouteKit and XDG runtime state and disable CLI auto-updaters
so test runs cannot rewrite user-level executable links.

- `pass`: the boundary or real CLI completed and routed the requested model.
- `fail`: a configured provider, installed door, response, model-selection, or
  safe-tool assertion regressed.
- `skip`: an optional CLI binary was not installed, with the reason recorded.

Provider credentials are never copied into artifacts. Review the report before
using a wider filter or increasing the call budget.

After a reviewed run, promote its sanitized results into the durable report:

```bash
node scripts/generate-routekit-l06-evidence.mjs \
  --matrix-report .artifacts/routekit-e2e/<run>/report.json \
  --revision <full-tested-sha> \
  --manual-records <reviewed-manual-records.json>
```

The command rejects dirty, incomplete, stale-mapping, count-inconsistent, or
identity-forged reports and credential-shaped content, then regenerates
`docs/routekit-l06-evidence.{json,md}`. Cases absent from a filtered run and
manual records not supplied with that promotion revert to `pending`; prior
passes and revision-specific client, provider, and credential metadata are
never carried to a new revision. Manual-record files must name the same full
`testedRevision` as the matrix report plus an ISO `evidenceDate`. CI reruns the
generator with `--check`, so a mapping change or hand-edited report fails
closed. Promotion never changes a row to `qualified` unless the reviewed source
also records passing evidence, exact versions, and outcomes for every required
dimension.
