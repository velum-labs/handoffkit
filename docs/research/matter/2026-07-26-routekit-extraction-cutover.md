# RouteKit extraction cutover (handoffkit)

- Date: 2026-07-26
- Matter MCP: unavailable in this cloud-agent catalog (`matter_*` tools not registered). Proceeded from the explicit cutover task instructions.
- Decision: Remove in-repo `@velum-labs/routekit*` package sources from handoffkit; consume published npm packages at `0.10.1`. Keep FusionKit (`@fusionkit/*`) publishing and composition here.
- Implementation: commit `16c891a9` on branch `cursor/routekit-extraction-f394`.
