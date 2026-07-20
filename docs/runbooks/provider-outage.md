# Provider outage runbook

## Detection

Trigger on elevated provider 429/5xx/network errors, exhausted subscription
pools, authentication failures across healthy credentials, missing catalogs, or
material latency/stream truncation.

Separate provider outage from local credential/config failure before changing
routes.

## Immediate actions

1. Name an incident owner and timestamp the first confirmed failure.
2. Check provider status and RouteKit provider/account status.
3. Reduce the active provider set to known-good routes.
4. Preserve namespaced routing: do not silently move a subscription request to
   a paid API-key provider.
5. Allow only configured bounded failover. A persistent transient 429 may try
   one alternate eligible subscription account.
6. Mark affected L05 rows degraded/Advanced if the outage invalidates a public
   Supported claim.

## Evidence

- provider and namespaced model
- status/health output without credentials
- model-call IDs, error classes, retry-after metadata, and quota snapshots
- compatibility-matrix case and exact client version
- provider status/advisory link

## Recovery

1. Probe catalog/auth with the least expensive non-content request available.
2. Run one sanitized deterministic request per affected protocol door.
3. Verify streaming, tools, cancellation, reasoning controls, and attribution.
4. Re-enable traffic gradually and monitor quota/error rates.
5. Confirm no unexpected paid-provider calls occurred during the outage.

## Communication

State the affected provider/routes, user-visible symptoms, whether bounded
failover is available, billing implications, workaround, and next update time.
Do not describe failover as unlimited capacity.

## Closure

- Provider recovery independently confirmed
- RouteKit deterministic and live checks pass
- No-silent-paid-fallback evidence reviewed
- L05 labels/evidence restored or revised
- Incident timeline and provider response linked from L08
