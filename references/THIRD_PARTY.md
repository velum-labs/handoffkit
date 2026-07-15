# Third-party reference snapshots

`references/` contains read-only vendored study snapshots. These files are not part of any build, workspace, or lint scope; they are retained for implementation research and comparison only.

## Upstreams

| Local path | Upstream | Pinned source | License |
| --- | --- | --- | --- |
| `references/opencode/` | `sst/opencode` | `https://github.com/sst/opencode/tree/3adfb970bf071419599ca016ebd2b08361fa28e9` | MIT |
| `references/t3code/` | `pingdotgg/t3code` | `https://github.com/pingdotgg/t3code/tree/7b9eef7ac29f9d4819c6411dfb1c5f04fef50264/apps/server/src/provider` | MIT |
| `references/cliproxyapi/` | `router-for-me/CLIProxyAPI` | `https://github.com/router-for-me/CLIProxyAPI/tree/6279bb8a4c2835ff6ed99c6b85083b2afbefa681` (= release `v7.2.72`, the version pinned by `routekit accounts cliproxy install`) | MIT |

The upstream license texts are copied into `references/opencode/LICENSE`, `references/t3code/LICENSE`, and `references/cliproxyapi/LICENSE`.

`references/cliproxyapi/` snapshots the source of the CLIProxyAPI sidecar consumed by the `cliproxy` panel provider (see `docs/cliproxy-upstream.md`): `internal/` (executors, translators, auth flows), `sdk/` (the embeddable Go SDK), `cmd/`, `test/`, `docs/`, the `custom-provider` example, and root metadata (`README.md`, `AGENTS.md`, `config.example.yaml`, `go.mod`, `go.sum`, `LICENSE`). Deliberately not vendored: `assets/` (sponsor images), localized READMEs, `.github/`, and Docker files. It is study material for the wire formats, OAuth flows, and rotation behavior our integration relies on — never built or imported.

## Local redactions

`references/t3code/provider/Layers/CursorProvider.test.ts` is patched locally to replace a personal email fixture with `user@example.com`.

`references/cliproxyapi/internal/api/handlers/management/auth_files_upload_test.go` is patched locally to replace a personal email fixture with `user@example.com`.

`references/cliproxyapi/` is also patched locally to replace the upstream Antigravity Google OAuth client id/secret literals with `REDACTED` (in `internal/auth/antigravity/constants.go`, `internal/api/handlers/management/api_tools.go`, and `internal/runtime/executor/antigravity_executor.go`): GitHub push protection flags them, and the snapshot is study material, never built. The real values live in the upstream pinned commit.

## Refresh

Refresh snapshots with `npx trackcn pull` **run from `references/`** — the manifest is `references/trackcn.json` and its tracked paths resolve relative to that directory. Set `GITHUB_TOKEN` to avoid rate limits.
