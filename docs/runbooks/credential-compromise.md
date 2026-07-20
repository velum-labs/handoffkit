# Credential compromise runbook

## Detection

Treat leaked API keys, OAuth refresh/access tokens, gateway ingress tokens,
npm/PyPI credentials, signing identity misuse, or unexpected provider usage as
a credential incident. Record the first signal, affected account/provider,
host, RouteKit version, and source SHA without copying the credential.

## Immediate actions

1. Name an incident owner and open a private GitHub Security Advisory.
2. Stop affected RouteKit/FusionKit processes and isolate the host if compromise
   may extend beyond one credential.
3. Revoke or rotate the provider credential at the provider.
4. Remove affected local enrollment files with `routekit accounts remove`; if
   host compromise is suspected, preserve an encrypted forensic copy first.
5. Rotate RouteKit gateway/account-proxy ingress tokens.
6. For release credentials, disable the publisher, freeze releases, and inspect
   GitHub/npm/PyPI audit history.

Never paste credentials into Linear, Notion, Slack, GitHub issues, logs, or
incident screenshots.

## Scope and evidence

- Inspect `~/.routekit/subscriptions`, `~/.routekit/services`, and
  `~/.routekit/cliproxy` metadata and permissions.
- Identify provider requests, unusual quota/cost, model-call IDs, and release
  events during the exposure window.
- Review telemetry/traces only for allowed metadata; do not broaden collection
  during the incident.
- Record affected versions, users, providers, and whether prompts could have
  reached an unauthorized provider.

## Recovery

1. Re-enroll with a new credential on a clean/trusted host.
2. Verify file modes and that status/doctor output contains no secret values.
3. Run auth, redaction, no-paid-fallback, and provider smoke tests.
4. Restore service with the minimum provider set.
5. Monitor quota/cost and audit events for recurrence.

## Communication

Security-impacting user communication states the exposure window, affected
data/credentials, required user action, fixed version, and contact channel.
Provider-policy issues must not be presented as an unlimited-usage promise.

## Closure

- Revocation/rotation confirmed
- Exposure scope documented
- Clean recovery tests linked
- User/provider communication completed
- Root cause and preventive change merged
- L04/L08 residual risks and evidence updated
