# RouteKit Claude Code setup and recovery evidence

- Date: 2026-07-22
- Issue: [ENG-682](https://linear.app/velum-labs/issue/ENG-682/restore-claude-enrollment-and-recovery-parity)
- Pull request: [#162](https://github.com/velum-labs/handoffkit/pull/162)
- Implementation revision tested: [`4e5a45b9`](https://github.com/velum-labs/handoffkit/commit/4e5a45b927715d220f5362e79146761f7413252e)

## Result

Pass for the credential-free setup and recovery qualification covered by
ENG-682. Claude Code now has the same RouteKit lifecycle surface as Codex:

- `routekit claude install` writes the supported Claude Code
  `~/.claude/settings.json` `env` keys and owner metadata with private,
  atomic writes.
- Updating the integration preserves unrelated settings. Uninstall restores
  the byte-exact original file when it is untouched, or removes only unchanged
  RouteKit values when the user edited other settings after installation.
  Process-owned locking, hash-guarded transaction recovery, and a real child
  `SIGKILL` test cover concurrent and interrupted settings writes.
- Managed settings follow `CLAUDE_CONFIG_DIR`, do not force
  `ANTHROPIC_MODEL`, reject unsafe file types, and never reuse the local daemon
  token for an overridden gateway.
- `accounts login claude-code` captures OAuth in an isolated temporary
  `CLAUDE_CONFIG_DIR`, then the daemon atomically enrolls the credential and
  activates `claude-code`.
- Failed and interrupted activation restores credential, provider config, and
  revision state. The Claude fixture receives the same actual-`SIGKILL`
  journal recovery proof as Codex.
- Removing a non-final Claude account keeps its provider active. Removing the
  final account atomically removes the provider and matching default route;
  router failure restores the credential, config, and revisions. Removing the
  only configured subscription leaves a healthy empty catalog without
  inventing an API provider or requiring another credential.

The billed, exact-version real-account matrix remains [ENG-679](https://linear.app/velum-labs/issue/ENG-679/run-and-record-the-routekit-real-account-matrix), not part of this credential-free recovery proof.

## Automated evidence

The focused commands were run from the repository root:

```sh
pnpm exec turbo run build --filter=@routekit/tool-claude...
pnpm --filter @routekit/tool-claude test

pnpm exec turbo run build --filter=@routekit/cli...
pnpm --filter @routekit/cli test

pnpm exec turbo run build --filter=@routekit/daemon...
pnpm --filter @routekit/daemon test
```

Results:

- Claude tool package: 32/32 tests passed.
- RouteKit CLI: 57/57 tests passed.
- RouteKit daemon: 16/16 tests passed, including account-transaction and
  managed-settings child-process `SIGKILL` cases.

The tests use temporary home/config directories and fixture OAuth values.
They make no billed provider calls and assert that journal, status, doctor,
and control responses contain no credential values.

Repository verification also passed:

```text
pnpm check  PASS
pnpm build  PASS
pnpm test   PASS (73 workspace tasks; 20 root tests)
```

The built public CLI was additionally run with a temporary `HOME` and Claude
configuration directory. `claude install` returned `installed`, a second run
returned `updated`, `claude uninstall` returned `removed`, and the original
settings file was restored byte-for-byte. No provider completion was requested.
The Claude Code binary itself is not installed on this worker, so its exact
client version and a live session remain part of ENG-679 rather than this
credential-free lifecycle check.

## Stable test anchors

- Managed settings restore:
  `packages/tool-claude/src/test/install.test.ts` —
  `Claude managed install updates and restores the exact original settings`.
- Isolated login:
  `packages/routekit-cli/src/test/accounts-command.test.ts` —
  `managed Claude login uses isolated state and rejects failures and duplicate labels`.
- Actual interruption:
  `packages/routekit-daemon/src/test/account-transaction.test.ts` —
  `SIGKILL after Claude account/config writes is rolled back from the prepared journal`.
- Startup recovery:
  `packages/routekit-daemon/src/test/daemon.test.ts` —
  `daemon recovers interrupted Claude activation before loading config or starting routers`.
- Removal and rollback:
  `packages/routekit-daemon/src/test/daemon.test.ts` —
  `native provider stays enabled until its last account is removed` and
  `failed last native account removal restores credential and config`.

## Remaining qualification boundary

This evidence closes the managed setup/restore and interruption-recovery gap.
It does not claim a live Claude subscription result, billing attribution, or
unlimited use. Those claims remain gated by the L06 real-account matrix and
the route disclosures.
