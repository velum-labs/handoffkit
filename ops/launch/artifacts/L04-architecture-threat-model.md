# L04 — Architecture & Threat Model

| Field | Value |
|-------|-------|
| Gate | 0 — Lock product |
| Owner | CTO |
| Approver | CEO (reads for scope honesty); CTO signs |
| Replaces | A07 Architecture and data-flow, A08 Threat model |

## Purpose

Show how the system works end-to-end (including credentials) and what we
accept as residual risk before alpha users touch it.

## Done when

- [ ] System context diagram exists (CLI, daemon, providers, clients)
- [ ] Request path described for Chat Completions, Responses, and Messages
- [ ] Credential path described per enrolled provider / seat type
- [ ] Every storage location for secrets, config, and logs is listed
- [ ] Route selection + failover + “no silent paid fallback” rules written
- [ ] Top ≥5 threats listed with mitigations
- [ ] Accepted residual risks listed with owner
- [ ] Security tests planned for alpha (L06 will execute them)
- [ ] FusionKit boundary is one short section (what this binary does not do)

## Fill in

### 1. System context
Paste or link a diagram. Components must include: CLI, local gateway/daemon,
config store, credential store, each provider type, each coding harness.

Link: _

### 2. Lifecycle
How `start` / `stop` / `status` / crash recovery work:

_

### 3. Request paths
| Protocol | Entry path | Notes |
|----------|------------|-------|
| Chat Completions | _ | _ |
| Responses | _ | _ |
| Messages | _ | _ |

### 4. Credential paths
| Provider / seat | How enrolled | Where stored | Refresh / revoke |
|-----------------|--------------|--------------|------------------|
| _ | _ | _ | _ |

### 5. Routing & billing attribution
- Sticky routing: _
- Throttle wait vs failover: _
- How we prevent silent subscription → paid API fallback: _
- What every request log must record: _

### 6. Threat model
| # | Threat | Asset | Mitigation | Residual? |
|---|--------|-------|------------|-----------|
| 1 | _ | _ | _ | Y/N |
| 2 | _ | _ | _ | Y/N |
| 3 | _ | _ | _ | Y/N |
| 4 | _ | _ | _ | Y/N |
| 5 | _ | _ | _ | Y/N |

Cover at least: credential theft, local port exposure, logging/telemetry leaks,
supply-chain / release, malicious dependency.

### 7. Accepted residual risks
| Risk | Why accepted | Owner | Review trigger |
|------|--------------|-------|----------------|
| _ | _ | _ | _ |

### 8. FusionKit boundary
_

## Evidence
Diagrams, ADRs, prior threat notes, related PRs:

-

## Approval
- Decision: Approved / Changes requested / Rejected
- CTO: _ · Date: _
- CEO (scope read): _ · Date: _
