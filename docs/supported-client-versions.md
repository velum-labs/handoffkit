# Supported RouteKit client versions

This matrix is a release qualification record, not a claim that every future
client version is compatible. Update it from sanitized L06/RouteKit matrix
evidence before each public release.

| Client | Minimum supported | Tested version | Launch status | Evidence |
| --- | --- | --- | --- | --- |
| Codex CLI | TBD | TBD | Candidate Supported | Record `codex --version` in release qualification |
| Claude Code | TBD | TBD | Candidate Supported | Record `claude --version` in release qualification |
| Cursor / `cursor-agent` | TBD | TBD | Candidate Advanced | Distinguish IDE and agent-binary evidence |
| OpenCode | TBD | TBD | Candidate Advanced | Record `opencode --version` in release qualification |
| CLIProxyAPI | 7.2.72 | 7.2.72 | Advanced/local-only | `CLIPROXY_PINNED_VERSION` in `@routekit/accounts` |

## Qualification requirements

For each Supported row:

1. Capture the exact binary version and source SHA.
2. Run setup/restore plus the relevant protocol, streaming, tool, reasoning,
   cancellation, and failure cases.
3. Store the sanitized matrix report and CI/manual result in L06.
4. Link the result from L05 and L08.
5. Record known degradation and the oldest passing version.

“Latest” and an unpinned global CI install do not satisfy this policy.

## Deprecation

When a client update breaks compatibility, move the row to Advanced or Not
offered, document the last-known-good version, publish a workaround, and update
this matrix before restoring Supported status.
