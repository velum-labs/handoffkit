# L09 — Public Product Pack

| Field | Value |
|-------|-------|
| Gate | 2 — Public beta readiness |
| Owner | CEO (assets); CTO signs demo acceptance |
| Approver | Both |
| Replaces | A15 Product trust and documentation pack, A16 Canonical demo |

## Purpose

Ship the public surface and prove the canonical story works on a clean machine.

## Done when

- [ ] Every asset in the register has a canonical URL + last verified date
- [ ] Canonical demo script executed end-to-end on a clean machine
- [ ] Demo recording linked
- [ ] Demo proves: install → two routes → failover → no unapproved paid fallback
- [ ] Claims on the landing page match L01 / L02 / L05
- [ ] Both founders signed

## Fill in

### 1. Asset register
| Asset | URL | Owner | Last verified |
|-------|-----|-------|---------------|
| Landing page | _ | CEO | _ |
| README | _ | _ | _ |
| Quickstart | _ | _ | _ |
| Demo recording (60–90s) | _ | _ | _ |
| Compatibility matrix (public) | _ | _ | _ |
| Security / privacy explanation | _ | _ | _ |
| Pricing / OSS boundary | _ | _ | _ |
| Migration from `fusionkit proxy` | _ | _ | _ |
| Comparison (direct / LiteLLM / CLIProxyAPI) | _ | _ | _ |
| FAQ | _ | _ | _ |
| Changelog | _ | _ | _ |
| Roadmap | _ | _ | _ |
| Support policy | _ | _ | _ |
| Troubleshooting | _ | _ | _ |

### 2. Canonical demo script (execute in order)
1. Install on a clean machine
2. Add two eligible routes
3. Launch a supported harness
4. Fail or exhaust the first route
5. Continue on the second route
6. Show which route served the request and why
7. Prove no unapproved paid fallback

### 3. Demo acceptance record
- Environment / versions: _
- Credentials / billing modes used: _
- Recording URL: _
- Raw logs / traces: _
- Expected vs actual: _
- Time to first value: _
- Failover latency: _
- Redaction check: Pass / Fail
- Result: Pass / Fail

## Evidence
URLs, recording, logs:

-

## Approval
- Decision: Approved / Changes requested / Rejected
- CEO: _ · Date: _
- CTO (demo): _ · Date: _
