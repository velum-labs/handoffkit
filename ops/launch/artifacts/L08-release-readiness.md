# L08 — Release Readiness

| Field | Value |
|-------|-------|
| Gate | 2 — Public beta readiness |
| Owner | CTO |
| Approver | CEO (reads residual risk summary) |
| Replaces | A14 Security and release dossier |

## Purpose

Prove we can publish, roll back, and respond to incidents before strangers
install us.

## Done when

- [ ] npm trusted publishing (OIDC) configured — no long-lived npm tokens
- [ ] Provenance attestation verified on a dry-run or real publish
- [ ] Protected release tags + tested rollback procedure documented
- [ ] CodeQL, secret scanning, dependency review, Dependabot enabled
- [ ] SBOM + license inventory generated and linked
- [ ] `SECURITY.md` + private vulnerability reporting live
- [ ] Runbooks exist for: credential compromise, bad release, provider outage
- [ ] Supported client versions pinned
- [ ] Telemetry inventory reviewed (opt-in, no prompts/credentials)
- [ ] CTO signed

## Fill in

### 1. Publish & provenance
| Item | Status | Evidence |
|------|--------|----------|
| OIDC trusted publishing | _ | _ |
| Provenance attestation | _ | _ |
| Rollback procedure tested | _ | _ |

### 2. Repo security controls
| Control | On? | Evidence |
|---------|-----|----------|
| CodeQL | _ | _ |
| Secret scanning | _ | _ |
| Dependency review | _ | _ |
| Dependabot | _ | _ |
| Private vuln reporting | _ | _ |

### 3. Runbooks (link or paste)
- Credential compromise: _
- Bad release: _
- Provider outage: _

### 4. Client version matrix
| Client | Min version | Tested version | Notes |
|--------|-------------|----------------|-------|
| _ | _ | _ | _ |

### 5. Telemetry / privacy
- What we collect if opted in: _
- What we never collect: _
- Privacy review date: _

## Evidence
Workflow URLs, publish logs, SBOM files:

-

## Approval
- Decision: Approved / Changes requested / Rejected
- CTO: _ · Date: _
- CEO (risk read): _ · Date: _
