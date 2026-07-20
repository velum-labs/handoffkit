# Bad release runbook

## Detection

Trigger this runbook for install failures, broken CLI shape, incompatible
configuration, missing package files, invalid provenance, security regression,
or a release whose supported-client matrix fails.

Record the version, package, source SHA, release workflow, first report, and
customer-visible impact.

## Immediate actions

1. Name an incident owner and freeze additional releases.
2. Warn on the GitHub Release and support channels.
3. Determine whether the issue is functional or security-sensitive. Use a
   private GitHub Security Advisory for the latter.
4. Verify the last-known-good version with a clean install.
5. Follow [Release rollback](../release-rollback.md) to move dist-tags and
   deprecate the bad version without destroying provenance.

## Evidence

- npm/PyPI package metadata and attestation
- workflow run and source SHA
- clean-install output
- failing and passing client versions
- configuration/migration inputs
- SBOM/license artifacts when supply chain is implicated

## Recovery

1. Revert or patch through a reviewed pull request.
2. Run repository checks, build, OOTB CLI smoke, full tests, package smokes, and
   the relevant compatibility matrix.
3. Publish a coordinated patch through trusted publishing.
4. Verify provenance and clean installation from the public registry.
5. Restore the `latest` tag only after release qualification passes.

## Communication

Publish affected versions, symptoms, workaround/last-known-good version, fixed
version, and upgrade instructions. Do not claim deletion of immutable packages.

## Closure

- Bad version deprecated/yanked as applicable
- Last-known-good or fixed version selected by public tags
- Fixed provenance and clean-install evidence linked
- Supported-client matrix updated
- Root cause and prevention documented in release notes and L08
