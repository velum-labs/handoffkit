# Launch OS — agent / operator guide

Notion Launch OS is the runtime UI. This directory is the **canonical definition**
of launch artifacts: what exists, what “done” means, and how Linear relates.

## Systems of record

| System | Owns | Does not own |
|--------|------|--------------|
| **Notion** | Launch dossier, Current gate, L01–L11 artifacts + approvals, decisions, playbooks | Day-to-day task status |
| **Linear** | Work items that produce artifacts (assignees, deadlines) | Gate sequencing / go-no-go |

A gate advances only when required Notion artifacts for that gate are **Approved**.
Closing a Linear issue is not enough.

## Linear shape (RouteKit)

Initiative: **RouteKit Public Launch**

| Project | Lead | Team | Typical artifacts |
|---------|------|------|-------------------|
| Product & Engineering | CTO | Engineering (`ENG-*`) | L04, L05, L06, L08 (+ shared L09–L11) |
| GTM & Customer | CEO | Operations (`OPS-*`) | L01, L02, L03, L07 (+ shared L09–L10) |

There is **no** Launch Program & Gates project. Founders track gates on the Notion
launch dossier (`Current gate` + artifact approvals).

Gate 0 issues (open today):

| Artifact | Issue | Project |
|----------|-------|---------|
| L01 | OPS-66 | GTM & Customer |
| L02 | OPS-64 | GTM & Customer |
| L03 | OPS-68 | GTM & Customer |
| L04 | ENG-638 | Product & Engineering |
| L05 | ENG-641 | Product & Engineering |

L06–L11 Notion pages exist; create Linear issues for them when entering those gates.

## Artifact model (v2)

**11 artifacts** (down from 22). Each is one Notion page. Templates live in
`ops/launch/artifacts/LNN-*.md`.

| ID | Name | Gate | Owner | Merges old IDs |
|----|------|------|-------|----------------|
| L01 | Launch Contract | 0 | Shared | A01, A10 |
| L02 | Customer & Messaging | 0 | CEO | A02, A03 |
| L03 | Brand, License & Commercial | 0 | CEO | A04, A06 |
| L04 | Architecture & Threat Model | 0 | CTO | A07, A08 |
| L05 | Support Matrix | 0 | CTO | A05, A09 |
| L06 | Engineering Acceptance | 1 | CTO | A11 |
| L07 | Alpha Results | 1 | CEO | A12, A13 |
| L08 | Release Readiness | 2 | CTO | A14 |
| L09 | Public Product Pack | 2 | CEO | A15, A16 |
| L10 | Launch Day Pack | 3 | Shared | A17, A18, A19 |
| L11 | Post-Launch Review | Post | Shared | A20, A21, A22 |

For a new launch: create Notion artifact rows linked to the launch, seed bodies
from these templates, and open Linear issues that link to those pages. Delete
obsolete artifact pages; do not keep “superseded” rows.

## Rules

1. **One page = one decision unit.** If two owners must fill different halves on
   different timelines, keep them separate; otherwise merge.
2. **Done when is binary.** Every checkbox must be answerable yes/no without
   inventing new scope.
3. **Linear issues produce artifacts.** Notion status must reach **Approved**.
4. **Do not invent new artifact IDs mid-launch.** Propose a blueprint change
   after the launch retro instead.
5. **Gates live in Notion.** Do not recreate a third Linear project for gate
   sequencing unless the founders explicitly ask for it.
