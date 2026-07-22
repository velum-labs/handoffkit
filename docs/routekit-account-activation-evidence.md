# RouteKit transactional account activation evidence

Date: 2026-07-22  
Issue: [ENG-637](https://linear.app/velum-labs/issue/ENG-637/make-routekit-account-enrollment-and-config-activation-transactional)  
Pull request: [#155](https://github.com/velum-labs/handoffkit/pull/155)  
Implementation revision tested: `fc9c996f`

## Result

Pass. Enrollment/activation uses one daemon mutation, a prepared operation
restores its exact prior local account/config/revision state after failure or
process interruption, committed replays do not advance revisions, and recovery
metadata contains no credential values.

## Interruption run

The following sanitized commands were run from the repository root after the
workspace build:

```sh
node --test --test-name-pattern='SIGKILL' \
  packages/routekit-daemon/dist/test/account-transaction.test.js

node --test --test-name-pattern='daemon recovers interrupted activation' \
  packages/routekit-daemon/dist/test/daemon.test.js
```

Both commands passed. The first command starts a child process, prepares the
rollback vault, writes a new native account and provider config, and sends the
child `SIGKILL`. Recovery removed the new account and restored the exact prior
config. The second command starts the real singleton daemon over an interrupted
prepared transaction and verifies recovery happens before config load,
sidecar/router startup, status, and doctor.

No real subscription credentials were available in this worker, so the manual
interruption used private temporary fixture state and made no provider network
calls. The process interruption and daemon recovery paths are the production
paths; only OAuth capture was fixture-backed.

## Connector/failure matrix

The non-native connector cases below are retained internal regression coverage,
not first-launch qualification or a public support contract.

- Native Codex and Claude Code: actual `SIGKILL` after account/config writes;
  prior state restored. Claude's managed setup/removal and last-account
  recovery proof is recorded in
  [the ENG-682 evidence](routekit-claude-recovery-evidence.md).
- Native Claude/Codex capture: official CLI profiles remain isolated and do not
  write daemon-owned state before the combined mutation.
- Gemini: existing CLIProxy account remains healthy through daemon-owned
  sidecar restart/recovery coverage.
- Kimi: injected failure after credential write removes the new auth file,
  preserves both revisions, and leaves no transaction directory.
- Grok: combined enrollment/activation commits; a fresh retry is a no-op with
  unchanged account/config revisions.
- Journal redaction: the metadata manifest is asserted not to contain token
  field names or fixture token values; responses/status/doctor are also
  sanitized.

## Repository verification

```text
pnpm check  PASS
pnpm build  PASS
pnpm test   PASS (73 workspace tasks; 20 root tests)
```

Focused RouteKit build and account/control/daemon/CLI tests also passed.
