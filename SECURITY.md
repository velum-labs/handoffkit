# Security policy

## Supported versions

RouteKit and FusionKit ship as the npm `@routekit/*` foundation and
`@fusionkit/*` product packages. FusionKit also provisions the internal PyPI
sidecar packages. Security fixes land on `main` first and are released for the
latest minor line, currently `0.8.x`.

## Reporting a vulnerability

Report security issues privately through GitHub Security Advisories for this repository. Do not open public issues for vulnerabilities, secrets, or supply-chain concerns.

Include:

- affected package, file, or workflow
- reproduction steps
- impact and affected versions
- suggested fix, if known

## Scope

In scope:

- the `routekit` and `fusionkit` CLIs and their harness launchers
- the Node RouteKit/Fusion gateways, provider egress, session store, cost
  metering, and rate-limit handoff path
- the internal Python synthesis sidecar, fusion engine, and native run APIs

The legacy governance stack (`plane`, `runner`, `sdk`, `handoff`, `adapter-compute`, and session backends) is maintained on a best-effort basis while it remains in this repository, but it is not part of the FusionKit product surface.

## Data handling

FusionKit stores durable harness sessions locally under `~/.fusionkit/sessions` unless `FUSIONKIT_SESSIONS_DIR` overrides the location. Session turn logs include the full prompt/message array and candidate trajectories for each turn so `fusionkit sessions` and resume flows can inspect them.

FusionKit and RouteKit product telemetry is off by default and requires explicit
opt-in; `DO_NOT_TRACK` force-disables it. RouteKit reads provider credentials
from the environment names referenced by router config. Credentials are not
passed to the Python sidecar or persisted by the Fusion session store; committed
config stores only environment-variable names.

See [Privacy and data handling](docs/privacy.md) for local retention, provider egress, OpenRouter disclosure, and rate-limit failover behavior.

## Supply-chain posture

- npm and GitHub Actions dependencies are exact-pinned against the allowlist enforced by `scripts/check-repo.mjs`.
- `.npmrc` enables `engine-strict`, `ignore-scripts`, store-integrity verification, exact saves, and a minimum release age for new packages.
- Lockfiles are committed and CI installs with frozen lockfiles.
- npm publishing uses provenance, and PyPI publishing uses trusted publishing.
