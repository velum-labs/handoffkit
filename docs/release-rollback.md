# Release rollback

Use this procedure when a RouteKit package is bad, compromised, or incompatible.
Rollback limits exposure; it does not erase an immutable published artifact.

## Preconditions

- Identify the bad version, source SHA, workflow run, and affected packages.
- Identify the last-known-good version and verify its provenance.
- Freeze additional releases until an incident owner is named.
- Preserve logs and release metadata before changing tags or dist-tags.

## npm rollback

1. Confirm the last-known-good package installs in a clean directory.
2. Move the `latest` dist-tag back only after verification:

   ```bash
   npm dist-tag add @routekit/cli@<last-good> latest
   npm dist-tag ls @routekit/cli
   ```

3. Deprecate the bad version with an actionable message:

   ```bash
   npm deprecate @routekit/cli@<bad-version> "Use <last-good>; see <advisory-url>"
   ```

4. Do not rely on unpublish. Follow npm's time-window and dependency-safety
   policy; prefer deprecation plus a fixed patch.
5. Repeat for every affected package in the release closure.

## GitHub and source recovery

1. Mark the bad GitHub Release as a prerelease or update its warning text.
2. Do not move or delete the signed release tag. Preserve provenance.
3. Revert the bad change on `main` through a reviewed pull request.
4. Run the release plan and publish a patch from the repaired commit.
5. Verify the new package provenance, clean installation, CLI shape, and
   supported-client matrix.

## PyPI sidecar packages

If the incident affects FusionKit's internal Python sidecar, yank the bad PyPI
version, retain it for reproducibility, restore the last-known-good npm-sidecar
pin, and publish a coordinated patch. RouteKit-only incidents do not require a
PyPI action.

## Validation

- `pnpm check`
- `pnpm build`
- `node scripts/check-ootb-cli.mjs`
- `pnpm test`
- clean-install `@routekit/cli@<last-good>` and the repaired version
- verify model catalog, provider configuration, and no-silent-paid-fallback
- verify npm provenance for the repaired version

## Communication

State the affected versions, impact, workaround, fixed version, and whether
credentials or prompts may have been exposed. Security-impacting incidents use
GitHub Security Advisories and the credential-compromise runbook.

## Rehearsal evidence

Record without changing public dist-tags:

| Field | Value |
| --- | --- |
| Date / owner | |
| Candidate bad version | |
| Last-known-good version | |
| Source SHA | |
| Dry-run commands | |
| Clean-install result | |
| CI URL | |
| Provenance result | |
| Communication draft | |

Protected tag/ruleset configuration is a GitHub setting. L08 must link evidence
that release-tag patterns are protected and this rehearsal was completed.
