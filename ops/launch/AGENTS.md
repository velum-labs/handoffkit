# Launch OS — agent / operator guide

Notion Launch OS is the runtime UI. This directory is the **canonical definition**
of launch artifacts: what exists, what merges into what, and what “done” means.

## Artifact model (v2)

We keep **10 artifacts** (down from 22). Each artifact is one Notion page the
owner fills by answering the prompts. A gate closes only when every required
artifact for that gate is **Approved**.

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

Templates live in `ops/launch/artifacts/LNN-*.md`. Copy the body into the Notion
artifact page when instantiating a launch.

## Rules

1. **One page = one decision unit.** If two owners must fill different halves on
   different timelines, keep them separate; otherwise merge.
2. **Done when is binary.** Every checkbox must be answerable yes/no without
   inventing new scope.
3. **Linear issues produce artifacts.** Closing a Linear issue is not enough —
   the Notion page must be Draft → In review → Approved.
4. **Do not invent new artifact IDs mid-launch.** Propose a blueprint change
   after the launch retro instead.
