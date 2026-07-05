# Third-party reference snapshots

`references/` contains read-only vendored study snapshots. These files are not part of any build, workspace, or lint scope; they are retained for implementation research and comparison only.

## Upstreams

| Local path | Upstream | Pinned source | License |
| --- | --- | --- | --- |
| `references/opencode/` | `sst/opencode` | `https://github.com/sst/opencode/tree/3adfb970bf071419599ca016ebd2b08361fa28e9` | MIT |
| `references/t3code/` | `pingdotgg/t3code` | `https://github.com/pingdotgg/t3code/tree/7b9eef7ac29f9d4819c6411dfb1c5f04fef50264/apps/server/src/provider` | MIT |

The upstream license texts are copied into `references/opencode/LICENSE` and `references/t3code/LICENSE`.

## Local redactions

`references/t3code/provider/Layers/CursorProvider.test.ts` is patched locally to replace a personal email fixture with `user@example.com`.

## Refresh

Refresh snapshots with `npx trackcn pull` using `references/trackcn.json` as the tracked source manifest.
