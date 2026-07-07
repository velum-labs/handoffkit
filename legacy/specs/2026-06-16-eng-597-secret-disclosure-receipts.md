# ENG-597 secret and disclosure receipt contract

Date: 2026-06-16
Status: Draft

Design note: this document closes MF-62. The goal is not to make secrets
invisible to the runtime; approved secrets are intentionally released into the
session environment. The goal is to prove what was requested, denied, released,
and disclosed without storing raw secret values in contracts, events, receipts,
artifacts, or model-fusion metadata.

## Rules

- Raw secret values never appear in run contracts, event chains, receipts,
  model-fusion records, logs, diffs, JSONL export, or UI summaries.
- Receipt evidence remains event-derived and names-only:
  `secret.released` events become `receipt.secretsReleased`.
- The verifier compares secret release name, scope, and timestamp between the
  event chain and receipt.
- Runner artifacts are redacted before blob upload with deterministic
  placeholders like `[REDACTED:SECRET_NAME]`.
- Richer joins live under `metadata.disclosures`; do not add speculative
  top-level fields to strict model-fusion v1 records.

## Metadata disclosure join

Use this shape under existing model-fusion `metadata` fields:

```json
{
  "metadata": {
    "disclosures": [
      {
        "candidate_id": "candidate_a",
        "tool_call_id": "tool_call_readme",
        "plan_id": "tool_plan_readme",
        "execution_id": "tool_exec_readme",
        "run_id": "run_secret_disclosure",
        "content_hash": "sha256:...",
        "data_class": "session-log",
        "direction": "out",
        "policy_id": "policy_readonly",
        "environment_id": "env_local",
        "secret_names": ["API_TOKEN"],
        "injected_env_names": ["API_TOKEN"],
        "redaction_status": "redacted"
      }
    ]
  }
}
```

## Denied, released, and no-secret states

- Denied secret: policy rejects the request before a contract is issued. There
  is no `secret.released` event and no receipt residue.
- Released secret: the plane records `secret.released` with name/scope/time,
  and the runner receipt must match exactly. Artifacts are redacted before
  upload.
- No-secret run: `receipt.secretsReleased` is empty, no `secret.released` event
  appears, and receipt story/rendering reports no secrets.

## Compatibility

Stable:

- `RunEvent.secret.released`
- `Receipt.secretsReleased`
- `Receipt.boundaryDisclosures`
- `ReceiptBundle` offline verification
- strict model-fusion records with nested `metadata.disclosures`

Deferred schema candidates:

- first-class disclosure records on model-fusion tool records
- explicit secret denial event variants
- external-write disclosure event variants
- artifact retention/deletion proof events

Add these only when a design partner or auditor needs them as top-level,
schema-versioned proof.
