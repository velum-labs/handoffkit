# L06 — Engineering Acceptance

| Field | Value |
|-------|-------|
| Gate | 1 — Private alpha |
| Owner | CTO |
| Approver | CEO (reads exit summary only) |
| Replaces | A11 Engineering acceptance dossier |

## Purpose

Prove each alpha capability works with evidence — not intention.

## Done when

- [ ] Every capability row below has: acceptance criteria, PR/commit, automated
      test, real-account or manual result, Pass/Fail
- [ ] Zero open Fail rows without an explicit waiver in L01 / a Decision note
- [ ] Secret-redaction tests pass
- [ ] Compatibility matrix rows in L05 that claim Supported have matching evidence here
- [ ] CTO signed

## Fill in

For each capability, copy this block:

### Capability: _
- Acceptance criteria: _
- Implementation (PR/commit): _
- Automated test: _
- Manual / real-account test: _
- Result: Pass / Fail
- Known limitation: _
- Follow-up owner: _

Required capability list (edit if L01 changes scope):

1. Daemon lifecycle (`start` / `stop` / `status`, crash recovery)
2. Unified catalog (API + seats + cliproxy)
3. Request attribution (model, seat, billing mode, retries, cost estimate)
4. `usage` + `route explain`
5. Sticky routing + failover
6. No silent paid fallback
7. Codex setup + restore
8. Claude Code setup + restore
9. Credential removal + uninstall restore
10. Protocols: streaming, tools, cancel, failure behavior
11. Secret redaction
12. Generated compatibility matrix feed into L05

## Evidence
CI runs, manual test logs, recordings:

-

## Approval
- Decision: Approved / Changes requested / Rejected
- CTO: _ · Date: _
- Waivers (if any): _
