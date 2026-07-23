# CTO agent brief — ENG gap pass (L04 / L05 / L06 / L08)

**For Alen (CTO):** paste this entire document into your agent (Cursor / Claude / etc.)
with Notion + Linear access. The agent should audit Product & Engineering launch
work and **rewrite Linear children + update Notion** as needed. Replacing most
ENG issues is allowed.

---

## Mission

You are Alen Rubilar-Muñoz (CTO)’s agent for **RouteKit Public Launch**.

Your job: figure out what Product & Engineering still needs between **now and
public launch (target 2026-08-31)**, then **make the Notion + Linear systems
match reality**.

You may **cancel and replace most Linear children** under the ENG parents.
Prefer fewer, binary, evidence-backed tasks over preserving the current issue
list.

Do **not** stop at a memo. End state = updated Notion pages + updated Linear
hierarchy.

## Scope (in)

Only these artifacts (Linear project **RouteKit — Product & Engineering**):

| Artifact | Gate | Notion | Linear parent | Repo template |
|----------|------|--------|---------------|---------------|
| L04 Architecture & Threat Model | 0 | https://app.notion.com/p/3a2ce3f8ae0e8149a89df616a5bce6fd | ENG-638 | `ops/launch/artifacts/L04-architecture-threat-model.md` |
| L05 Support Matrix | 0 | https://app.notion.com/p/3a2ce3f8ae0e81b3831ef89c22972f64 | ENG-641 | `ops/launch/artifacts/L05-support-matrix.md` |
| L06 Engineering Acceptance | 1 | https://app.notion.com/p/3a2ce3f8ae0e8114927bc8e8efa5c244 | ENG-642 | `ops/launch/artifacts/L06-engineering-acceptance.md` |
| L08 Release Readiness | 2 | https://app.notion.com/p/3a2ce3f8ae0e8195ab26fc569c8dd686 | ENG-643 | `ops/launch/artifacts/L08-release-readiness.md` |

Also read:

- Launch OS hub: https://app.notion.com/p/3a0ce3f8ae0e81428839cb2111b62428
- RouteKit dossier: https://app.notion.com/p/3a0ce3f8ae0e81aaa6c5deb6145a8b40
- Agent guide: `ops/launch/AGENTS.md`
- Linear initiative: https://linear.app/velum-labs/initiative/routekit-public-launch-ce654d60f6f0
- ENG project: https://linear.app/velum-labs/project/routekit-product-and-engineering-94aa0a0f8906

## Scope (out)

- Do **not** rewrite GTM artifacts L01, L02, L03, L07, L09, L10, L11 unless a
  gap **forces** a one-line note on the dossier (e.g. L01 non-goals must change).
  Leave GTM Linear issues alone.
- Do **not** create a third Linear project for gates.
- Do **not** invent new artifact IDs (no L12, no return to A01–A22).
- Do **not** invent Notion pages for Linear subtasks.
- Do **not** advance `Current gate` on the dossier unless required Gate 0 ENG
  artifacts are truly **Approved** (unlikely on first pass).

## Systems of record

| System | Owns | Does not own |
|--------|------|--------------|
| Notion | Artifact truth, fill-in, evidence links, status → Approved | Day-to-day task status |
| Linear | Parent per L* + Done-when children, assignees, deadlines | Gate sequencing / go-no-go |
| Repo `ops/launch/` | Canonical templates + Done-when definitions | Live filled answers |

## Procedure

### 1. Orient

1. Read `ops/launch/AGENTS.md` and the four templates above.
2. Fetch the four Notion pages and the dossier (`Current gate` = Gate 0 today).
3. List Linear children under ENG-638, ENG-641, ENG-642, ENG-643.
4. Inspect the actual product codebase / CI / release setup enough to judge what
   is already true vs aspirational. Prefer evidence (PRs, tests, configs, docs)
   over issue titles.

### 2. Gap analysis (write this on Notion first)

Create or update a child page under the dossier titled
**ENG gap pass — YYYY-MM-DD** with sections for L04 / L05 / L06 / L08.
For each artifact:

1. **Already true** — bullets + evidence links
2. **Wrong / stale** — current Linear children or Notion text that should die
3. **Missing for launch** — what must exist by Gate N / launch
4. **Cut or defer** — out of launch scope (explicit)
5. **Proposed Done-when / children** — final checklist (binary yes/no items)

Rules for proposed children:

- One child = one Done-when checkbox
- Binary and testable; no vague “improve X”
- Prefer 5–12 children per parent; merge fluff
- Gate 0 first (L04, L05). L06/L08 can be planned now but labeled `gate-1` /
  `gate-2`

### 3. Update Notion artifact pages

For each of L04–L08:

1. Align body with the repo template structure (sections + Done-when).
2. Fill what is already known; leave blanks only where work remains.
3. Tick Done-when boxes that are **actually** done; leave others unchecked.
4. Put evidence URLs in the Evidence property and/or page body.
5. Set Status honestly:
   - **Not started** — almost empty
   - **Draft** — actively filling
   - **In review** — CTO believes content is ready for founder review
   - **Approved** — only if Alen (and required co-approver) would actually sign today
6. Keep the `Linear issue` URL pointing at the **parent**.
7. Refresh any “Linear work” section to list the **new** children (after step 4).

### 4. Rewrite Linear children

For each ENG parent:

1. **Cancel** obsolete children (do not leave wrong Backlog items).
2. **Create** new children under the same parent:
   - Team: Engineering
   - Project: RouteKit — Product & Engineering
   - Assignee: Alen (or the right eng owner)
   - Labels: `gate-0` / `gate-1` / `gate-2` to match the parent artifact gate
   - Description: link the Notion page; one sentence on what “done” means;
     “when done: tick Notion Done-when, then mark this Done”
3. Keep the **parent** issues (ENG-638 / 641 / 642 / 643). Update parent
   description to: owner, Notion URL, repo template path, purpose,
   “children are the Done-when checklist”, gate.
4. Parent status: Backlog / In Progress / In Review to match Notion; do **not**
   mark parent Done until Notion is **Approved** and all children Done.
5. If a parent title/purpose is wrong vs the template, fix the description;
   only rename if clearly wrong.

### 5. Cross-check

Before finishing:

- [ ] Every remaining ENG child maps 1:1 to a Notion Done-when on L04–L08
- [ ] No canceled Launch Program & Gates work was revived
- [ ] No GTM parents/children were rewritten
- [ ] Gap page exists on the dossier summarizing what changed
- [ ] L04/L05 reflect Gate 0 honestly (current gate)

## Decision rights

- You **may** replace ENG Linear children wholesale.
- You **may** edit L04–L08 Notion content and statuses up through **In review**.
- You **may** mark items Done only with evidence.
- You **should not** mark artifacts **Approved** unless Alen would sign today.
- If launch scope must shrink (e.g. drop a client), write it on L01’s Notion page
  as a proposed non-goal / kill note and flag it for CEO — do not silently
  change GTM Linear.

## Definition of done for this agent run

1. ENG gap page on the dossier is filled.
2. L04–L08 Notion pages match templates + current truth.
3. Linear ENG children under the four parents match the new Done-when lists.
4. Short summary on the gap page: what was canceled, what was added, biggest
   risks to 2026-08-31.

## Paste-starter for Alen

Copy this whole file into your agent, then add:

> You have Notion + Linear access. Start now. Prefer acting over asking. If a
> tool is missing, do everything else and list the blockers at the end.
