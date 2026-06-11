# Security policy

## Supported versions

This repository is design-stage and private. There are no released versions yet.

## Reporting a vulnerability

Report security issues privately through GitHub Security Advisories for this repository. Do not open public issues for vulnerabilities, secrets, or supply-chain concerns.

Include:

- affected file or workflow
- reproduction steps
- impact
- suggested fix, if known

## Supply-chain posture

- pnpm is pinned through `packageManager` and Corepack.
- CI installs with `pnpm install --frozen-lockfile`.
- install scripts are disabled by default via `.npmrc`.
- dependency and GitHub Actions updates are tracked by Dependabot.
- implementation is intentionally blocked until the design is agreed.
