# L05 — Support Matrix

| Field | Value |
|-------|-------|
| Gate | 0 — Lock product |
| Owner | CTO fills technical rows; CEO fills policy column |
| Approver | Both |
| Replaces | A05 Provider and credential policy, A09 Compatibility and support policy |

## Purpose

One table that answers: “What can a user enroll, what will we claim in public,
and what evidence backs each claim?”

## Done when

- [ ] Every intended provider × credential mode has a row
- [ ] Every intended harness × protocol has a row
- [ ] Each row has Technical status, Policy status, Launch label, Evidence link
- [ ] “How a label may change” rules are written
- [ ] Version support / deprecation policy is one short section
- [ ] Both founders signed

## Fill in

### 1. Provider & credential matrix
| Provider | Credential mode | Technical | Policy | Launch label | Evidence | Owner |
|----------|-----------------|-----------|--------|--------------|----------|-------|
| OpenAI | API key | _ | _ | _ | _ | _ |
| OpenAI / Codex | Subscription seat | _ | _ | _ | _ | _ |
| Anthropic | API key | _ | _ | _ | _ | _ |
| Anthropic / Claude | Subscription seat | _ | _ | _ | _ | _ |
| OpenRouter | API key | _ | _ | _ | _ | _ |
| cliproxy | _ | _ | _ | _ | _ | _ |

For each row also note (in Evidence or a linked doc): storage location, refresh,
revocation, billing mode, quota signal, ownership rule.

### 2. Harness & protocol matrix
| Harness | Provider/model | Protocol | Tools | Streaming | Known degradation | Label | Evidence |
|---------|----------------|----------|-------|-----------|-------------------|-------|----------|
| Codex | _ | _ | _ | _ | _ | _ | _ |
| Claude Code | _ | _ | _ | _ | _ | _ | _ |
| Cursor IDE | _ | _ | _ | _ | _ | _ | _ |

### 3. Label change rules
Minimum evidence required to move a row to Supported:

_

Deprecation / unsupported announcement process:

_

### 4. Version support
- Client versions we pin: _
- How we announce breakage: _

## Evidence
Test runs, policy notes, ToS links:

-

## Approval
- Decision: Approved / Changes requested / Rejected
- CTO: _ · Date: _
- CEO: _ · Date: _
