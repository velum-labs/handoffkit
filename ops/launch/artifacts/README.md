# Artifact register (v2)

| ID | File | Gate | Owner role | Replaces |
|----|------|------|------------|----------|
| L01 | L01-launch-contract.md | 0 | Shared | A01, A10 |
| L02 | L02-customer-messaging.md | 0 | CEO | A02, A03 |
| L03 | L03-brand-license-commercial.md | 0 | CEO | A04, A06 |
| L04 | L04-architecture-threat-model.md | 0 | CTO | A07, A08 |
| L05 | L05-support-matrix.md | 0 | CTO | A05, A09 |
| L06 | L06-engineering-acceptance.md | 1 | CTO | A11 |
| L07 | L07-alpha-results.md | 1 | CEO | A12, A13 |
| L08 | L08-release-readiness.md | 2 | CTO | A14 |
| L09 | L09-public-product-pack.md | 2 | CEO | A15, A16 |
| L10 | L10-launch-day-pack.md | 3 | Shared | A17, A18, A19 |
| L11 | L11-post-launch-review.md | Post | Shared | A20, A21, A22 |

## How an owner uses these

1. Open the matching Notion Launch Artifact page (or create it from this file).
2. Paste the markdown body.
3. Work the **Done when** checkboxes — that list is the job.
4. Attach evidence links.
5. Move status: Not started → Draft → In review → Approved.

## Notion migration

Done for RouteKit Public Launch (2026-07-19):

- L01–L11 created and linked to the RouteKit launch dossier.
- A01–A22 removed from the Launch Artifacts database (moved under a disposable
  folder for one-click Delete — Notion MCP cannot trash pages).
- Gate 0 Linear issues (OPS-66, OPS-64, OPS-68, ENG-638, ENG-641) link to L01–L05.
- Do not keep superseded artifact rows; delete obsolete pages instead.
