# Security policy

## Supported versions

FusionKit ships as the npm `@fusionkit/cli` front door and the PyPI `fusionkit` engine. Security fixes land on `main` first and are released for the latest minor line of both packages, currently `0.8.x`.

## Reporting a vulnerability

Report security issues privately through GitHub Security Advisories for this repository. Do not open public issues for vulnerabilities, secrets, or supply-chain concerns.

Include:

- affected package, file, or workflow
- reproduction steps
- impact and affected versions
- suggested fix, if known

## Scope

In scope:

- the `fusionkit` CLI and its harness launchers
- the model gateway, session store, cost metering, and rate-limit handoff path
- the Python router, fusion engine, and raw `fusionkit serve` endpoint

The legacy governance stack (`plane`, `runner`, `sdk`, `handoff`, `adapter-compute`, and session backends) is maintained on a best-effort basis while it remains in this repository, but it is not part of the FusionKit product surface.

## Data handling

FusionKit stores durable harness sessions locally under `~/.fusionkit/sessions` unless `FUSIONKIT_SESSIONS_DIR` overrides the location. Session turn logs include the full prompt/message array and candidate trajectories for each turn so `fusionkit sessions` and resume flows can inspect them.

FusionKit does not include product telemetry or phone-home analytics. Provider credentials are read from environment variables or local `.env` files at runtime and are not persisted by the session store; committed config stores only environment variable names for keys.

See [Privacy and data handling](docs/privacy.md) for local retention, provider egress, OpenRouter disclosure, and rate-limit failover behavior.

## Supply-chain posture

- npm and GitHub Actions dependencies are exact-pinned against the allowlist enforced by `scripts/check-repo.mjs`.
- `.npmrc` enables `engine-strict`, `ignore-scripts`, store-integrity verification, exact saves, and a minimum release age for new packages.
- Lockfiles are committed and CI installs with frozen lockfiles.
- npm publishing uses provenance, and PyPI publishing uses trusted publishing.
