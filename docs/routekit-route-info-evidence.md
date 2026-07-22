# RouteKit route explanation evidence

Date: 2026-07-22
Issue: [ENG-678](https://linear.app/velum-labs/issue/ENG-678/expose-and-verify-routekit-route-and-billing-information)
Pull request: [#161](https://github.com/velum-labs/handoffkit/pull/161)
Implementation revision tested: `5039e8c9`

## Result

Pass. RouteKit now exposes a secret-free
`routekit models info <provider/model>` contract covering provider, native
model, account class, billing mode, default status, capabilities, and reasoning
metadata, with structured unknown-model rejection. Both JSON and human output
were exercised against an isolated local provider and daemon; the injected API
credential was absent from stdout and stderr.

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

```text
pnpm check             PASS
pnpm build             PASS
pnpm test              PASS
pnpm test:e2e:matrix   PASS (13 pass, 0 fail, 12 optional-tool skips, billed=0)
```

The manual process check returned `openai/demo-model`, native model
`demo-model`, account class `api-key`, billing mode `metered-api`, default
`true` / `yes`, discovered streaming/tool capabilities, and provider reasoning
metadata in both renderers. The fixture credential
`demo-secret-should-not-leak` was checked against the captured output and was
absent. No provider generation request or billed call was made.
