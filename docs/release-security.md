# RouteKit release security

This is the maintainer evidence hub for RouteKit release readiness. The live
approval state belongs to the L08 Notion artifact; this page owns reproducible
repository procedures and links.

## Publish and provenance

- npm publication is defined by
  [`.github/workflows/release-packages.yml`](../.github/workflows/release-packages.yml).
- Package membership and provenance requirements are defined by
  [`release/npm-packages.json`](../release/npm-packages.json) and enforced by
  [`scripts/check-release-publish.mjs`](../scripts/check-release-publish.mjs).
- npm Trusted Publisher records are external settings. Every published
  `@routekit/*` package must name repository `velum-labs/handoffkit` and workflow
  `release-packages.yml`.
- Record the released version, source SHA, workflow URL, package URL, and
  attestation URL in Notion after publication.

Long-lived npm tokens are not an accepted steady state for RouteKit packages.

## Repository security controls

| Control | Repository evidence | External evidence |
| --- | --- | --- |
| CodeQL | GitHub default setup checks on pull requests | Link the successful default-branch run |
| Dependency review | [workflow](../.github/workflows/dependency-review.yml) | Link a successful dependency-changing PR |
| Dependabot | [configuration](../.github/dependabot.yml) | Link current alerts/update PRs |
| Secret scanning | GitHub-hosted setting | Record the enabled setting in Notion |
| Push protection | GitHub-hosted setting | Record the enabled setting in Notion |
| Private vulnerability reporting | [SECURITY.md](../SECURITY.md) | GitHub private reporting must remain enabled |

CI and security workflows use `pull_request`, never `pull_request_target`, and
must not expose secrets to forked code.

## SBOM and licenses

GitHub's dependency graph can export an SPDX SBOM. Before public release,
export a versioned SBOM for the release SHA, generate a third-party license
inventory for the `@routekit/cli` package closure, attach both to the GitHub
Release, and link them from L08. Package-level Apache-2.0 declarations are
validated by `scripts/check-release-publish.mjs`; they are not a substitute for
the third-party inventory.

## Rollback

Follow [Release rollback](release-rollback.md). A rehearsal must produce a
record containing the candidate version, last-known-good version, source SHA,
commands that would move the npm dist-tag, validation results, owner, and date.

## Incident response

- [Credential compromise](runbooks/credential-compromise.md)
- [Bad release](runbooks/bad-release.md)
- [Provider outage](runbooks/provider-outage.md)

## Supported clients

The release candidate must record the exact tested versions of Codex CLI,
Claude Code, Cursor/`cursor-agent`, OpenCode, and CLIProxyAPI. “Latest” is not a
support contract. Minimum and tested versions belong in L08 and release notes;
CLIProxyAPI is currently pinned in source.

## Telemetry review

RouteKit product telemetry is opt-in. The allowed CLI-command fields are owned
by `@routekit/telemetry-core`: command, CLI version, OS, architecture, Node
major, duration bucket, exit kind, and CI flag. Prompts, source code, paths,
credentials, OAuth tokens, and provider response bodies are prohibited.
`DO_NOT_TRACK` must force-disable emission.

FusionKit session telemetry and Hyperkit maintainer/lab OTLP are separate
surfaces and must not be represented as RouteKit product telemetry.

## Release evidence checklist

- [ ] Required CI and dependency review pass on the release SHA
- [ ] CodeQL, secret scanning, push protection, and private reporting verified
- [ ] npm Trusted Publisher settings verified
- [ ] Public package and provenance attestation verified
- [ ] Versioned SBOM and license inventory attached
- [ ] Rollback rehearsal completed
- [ ] Three incident runbooks reviewed
- [ ] Supported client versions recorded
- [ ] Telemetry inventory reviewed
- [ ] L08 evidence links and approval completed
