# RouteKit telemetry inventory

RouteKit product telemetry is disabled by default, requires explicit opt-in,
and is force-disabled by `DO_NOT_TRACK`.

## Product events

### `cli.command`

Allowed field names are owned by `@routekit/telemetry-core`:

- `command`
- `cli_version`
- `os`
- `arch`
- `node_major`
- `duration_bucket`
- `exit_kind`
- `is_ci`

## Never collected

- prompts, responses, source code, trajectories, or tool arguments/output
- file names, workspace paths, repository URLs, or user names
- API keys, OAuth access/refresh tokens, authorization headers, or ingress tokens
- provider response bodies or account credential blobs
- raw exception messages that may contain provider content

## Separate surfaces

FusionKit session telemetry has its own event schema and is not RouteKit CLI
telemetry. Hyperkit maintainer/lab OTLP is experiment infrastructure and is not
RouteKit product telemetry.

## Review procedure

1. Compare this inventory with `CLI_COMMAND_TELEMETRY_FIELDS`.
2. Run telemetry allow-list and end-to-end tests.
3. Verify no event is emitted without consent and `DO_NOT_TRACK` wins.
4. Inspect a sanitized event payload.
5. Record reviewer, date, source SHA, and test links in L08.

Review status: **Pending CTO review for the first public RouteKit release.**
