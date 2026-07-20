---
matter_bundle_id: ctx_0123456789abcdef0123456789abcdef
matter_sources:
  - item_id: itm_FAKEAgentMemory001
    item_updated_at: "2026-07-18T10:00:00Z"
    url: "https://example.com/agent-memory"
    markdown_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    annotation_ids:
      - ann_FAKEHighlight001
      - ann_FAKEHighlight002
  - item_id: itm_FAKEArchitecture002
    item_updated_at: "2026-07-17T09:30:00Z"
    url: "https://example.com/retrieval-architecture"
    markdown_sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
    annotation_ids:
      - ann_FAKEHighlight003
---

# Matter Research Report: Persistent agent memory

## Research question

Should the `agent-platform` repository add persistent user memory for long-running agent workflows?

## Executive conclusion (labeled as inference)

Inference: persistent memory is worth prototyping only behind an explicit user-controlled scope boundary. The strongest evidence supports durable task context and user-approved preferences, while the risks are stale assumptions, privacy leakage, and prompt-injection contamination from untrusted sources.

## Repository state

The repository currently keeps task context in process-local state and durable artifacts in Git. There is no shared memory store, no explicit retention policy, and no user interface for inspecting or deleting remembered facts.

## Source evidence

- `itm_FAKEAgentMemory001` argues that agent memory is most useful when it is scoped to concrete recurring tasks and includes provenance for every remembered fact.
- `itm_FAKEArchitecture002` describes a retrieval pipeline that ranks stored evidence by freshness and explicit user annotation rather than by opaque model summaries.

## User annotations

- `ann_FAKEHighlight001`: highlighted source text says that memory entries should keep original source references.
- `ann_FAKEHighlight002`: user note says, "This maps to our need for inspectable repository decisions."
- `ann_FAKEHighlight003`: user note says, "Avoid silent global memory; repo-level scope is safer."

## Counterevidence

The sources also warn that broad, automatic memory can reinforce outdated assumptions. None of the sampled sources proves that a vector database is necessary for the first version.

## Implications

The repository should prefer a small, auditable memory interface over an always-on autonomous memory layer. Any remembered fact needs provenance, freshness metadata, and a deletion path.

## Options

1. Do nothing and continue relying on Git artifacts only.
2. Add a repository-scoped memory file with explicit user approval.
3. Add a service-backed memory index with retrieval and lifecycle controls.

## Recommendation

Start with option 2. It preserves user control, keeps review in Git, and leaves room for a service-backed index if the workflow proves valuable.

## Proposed implementation plan

1. Define a repository-scoped memory schema with provenance, timestamps, and source links.
2. Add commands for listing, adding, and deleting memory records.
3. Require explicit user confirmation before writing new memory.
4. Add tests for retention, deletion, and prompt-injection boundaries.

## Open questions

- What kinds of facts should be eligible for memory?
- How should stale entries be detected and retired?
- Should memory be synchronized across repositories or remain local?

## Provenance

This report was drafted from Matter bundle `ctx_0123456789abcdef0123456789abcdef`. Source text, user annotation notes, and repository inference are separated above. All Matter IDs are fake examples for this template.
