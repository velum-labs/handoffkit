# CLI reference

The `warrant` CLI is implemented in `packages/cli`. Build the workspace before
using local package binaries:

```sh
pnpm build
warrant --help
```

## Common workflows

Initialize local state:

```sh
warrant init
```

Start services:

```sh
warrant plane start
warrant runner start
```

Request and inspect runs:

```sh
warrant run --agent mock "write a short plan"
warrant runs
warrant receipt <run-id>
warrant verify <run-id>
warrant pull <run-id>
```

Manage secrets:

```sh
warrant secrets set ANTHROPIC_API_KEY sk-ant-...
warrant run --agent claude-code --secret ANTHROPIC_API_KEY \
  --allow-host api.anthropic.com "run the requested coding task"
```

Use handoff continuation from the CLI:

```sh
warrant handoff --agent claude-code --pool eng-prod "apply the current plan"
```

Open the control panel token helper:

```sh
warrant ui
```

## Command groups

| Group | Purpose | Source |
| --- | --- | --- |
| `init` | Create local config, keys, and encrypted secret state. | `packages/cli/src/commands/init.ts` |
| `plane` | Start and administer the control plane. | `packages/cli/src/commands/plane.ts` |
| `runner` | Start a runner and connect it to the plane. | `packages/cli/src/commands/runner.ts` |
| `run`, `handoff`, `pull` | Request governed work, continue local work remotely, and retrieve results. | `packages/cli/src/commands/run.ts` |
| `runs`, `receipt`, `verify`, `approve`, `cancel`, `export` | Inspect lifecycle state, approvals, receipts, audit data, and terminal actions. | `packages/cli/src/commands/lifecycle.ts` |
| `secrets` | Store and release secrets through the brokered secret path. | `packages/cli/src/commands/secrets.ts` |
| `local` | Local model and gateway helpers. | `packages/cli/src/commands/local.ts` |
| `ensemble`, `fusion` | Model-fusion runners, records, gateway, and quickstart flows. | `packages/cli/src/commands/ensemble.ts`, `packages/cli/src/commands/fusion.ts` |

## Configuration

Most commands accept a plane URL or read it from local config. The default local
plane binds to loopback; Docker compose exposes the plane on `7172`. See
`packages/cli/src/config.ts` for exact paths, defaults, and key storage.
