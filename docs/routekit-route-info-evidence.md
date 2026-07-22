# RouteKit route explanation evidence

Date: 2026-07-22  
Issue: [ENG-678](https://linear.app/velum-labs/issue/ENG-678/expose-and-verify-routekit-route-and-billing-information)  
Pull request: pending  
Implementation revision tested: pending

## Result

Pending verification. The acceptance target is a secret-free
`routekit models info <provider/model>` contract covering provider, native
model, account class, billing mode, default status, capabilities, and reasoning
metadata, with structured unknown-model rejection.

## Automated evidence

The focused gateway, daemon, and CLI tests exercise the production catalog,
control protocol, and both JSON and human command renderers. The CLI fixture
injects a known API credential and asserts that neither stdout nor stderr
contains it.

The credential-free RouteKit matrix remains the broad protocol regression. In
live mode, its `route-info` case records `live-route-info.json` for one
discovered model from every configured provider. This is a catalog/control
check and makes zero model-generation calls. Billed real-account qualification
remains owned by ENG-679.

## Verification

The following commands will be recorded after the implementation revision is
committed:

```text
pnpm check
pnpm build
pnpm test
pnpm test:e2e:matrix
```

Manual process evidence will run both human and `--json` model inspection
against an isolated local fixture daemon. Only sanitized output will be
retained.
