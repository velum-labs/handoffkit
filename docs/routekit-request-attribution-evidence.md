# RouteKit request attribution evidence

Date: 2026-07-22
Issue: [ENG-681](https://linear.app/velum-labs/issue/ENG-681/close-routekit-request-attribution-gap)
Pull request: [#163](https://github.com/velum-labs/handoffkit/pull/163)
Implementation revision tested: `6551fb65`

## Result

Pass. Every completed RouteKit model request receives an
`x-routekit-model-call-id` correlation header. The singleton daemon retains a
bounded, expiry-limited attribution record that the operator can inspect with
`routekit calls inspect <call-id>` in human or JSON mode. The result identifies
the effective and provider-native models, provider, opaque process-local
subscription seat when applicable, billing mode, attempts/retries/account failovers,
usage, estimated cost or explicit unknown state, status, and timing.

The inspection projection excludes credentials, authorization/request headers,
account labels/IDs, account source paths, prompts, response text, raw provider errors, and unrelated
metadata. Records remain in memory across router hot-swaps and intentionally do
not survive daemon restarts.

## Sanitized end-to-end run

The RouteKit CLI process test starts the real singleton daemon against a local
fixture provider, sends an authenticated OpenAI Chat request, reads its
`x-routekit-model-call-id`, and invokes both inspection modes:

```text
routekit calls inspect model_call_<redacted>
routekit calls inspect model_call_<redacted> --json
```

The assertions verify the call ID join, `openai/mock-model` effective model,
`mock-model` native model, `openai` provider, `api_key` billing mode, zero
retries, explicit unknown usage/cost state, and absence of the fixture API key.
The daemon integration test completes a request while a router generation is
being replaced, then proves the same call remains inspectable through the
control protocol.

No billed provider request was needed for this capability proof. ENG-679 owns
the separate sanitized real-account qualification matrix.

## Retry and redaction coverage

- Subscription pool tests force a same-seat retry followed by an alternate
  seat and assert opaque, stable-within-process seat references.
- Compound-operation tests prove successful tool-loop steps are not mislabeled
  as retries or seat failovers.
- Failed model selection and embeddings tests prove their correlation IDs remain
  inspectable.
- Provenance tests inject a credential-shaped secret into a thrown upstream
  error and assert the record contains only the safe normalized failure.
- Call-store tests inject credential and source-path fields into internal
  metadata and assert the public projection drops them.
- Control protocol tests reject a missing `callId`.
- Model-fusion protocol tests validate and reject malformed nested attribution
  metadata without
  changing the top-level `model-call-record.v1` schema.
- Capacity and TTL tests prove deterministic eviction of stale call records.

## Repository verification

```text
Focused attribution build  PASS (23/23 tasks)
Focused attribution tests  PASS (29/29 tasks)
pnpm check                PASS
pnpm build                PASS (38/38 tasks)
pnpm test                 PASS (73/73 workspace tasks; 20/20 root tests)
```
