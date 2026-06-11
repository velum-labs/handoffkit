# Governed agent execution plane spec

Date: 2026-06-11
Status: Draft
Supersedes: [Local-first handoff platform SDK spec](2026-06-11-local-first-handoff-platform-spec.md)

Design note: this document replaces the handoff-platform spec as the current artifact. The predecessor is retained for record. Implementation remains blocked until the run contract, runner contract, and trust architecture below are agreed.

## 1. Positioning decision

This section is a decision, not a description. Every section below follows from it.

- The buyer is the platform or security lead at a company running coding agents from two or more vendors.
- The product is proof and policy at the agent execution boundary: run any vendor's agent on a runtime you control, and prove what it saw, ran, changed, and was given.
- The developer experience must not suck, but it is not the product. There is no developer-love goal. There is a developer-tolerance requirement.
- Continuation, handoff, and parallel fan-out are demos of the primitives, not the product. Vendors own those features inside their own silos and give them away.

Working name: `Warrant`. A warrant authorizes execution under stated conditions; a receipt proves what happened. Those are the two objects this product sells.

Category line:

> The governed execution and provenance plane for AI agents.

Product promise:

> Run any agent on your runtime. Prove what moved, why it moved, who approved it, what saw it, and how to reproduce it.

## 2. Thesis

AI work crosses trust boundaries: developer laptops, vendor clouds, customer VPCs, attested runtimes. That shift is permanent. On-device models escalating to attested cloud is now the consumer default,[^pcc] AI-capable endpoints are the majority of new hardware, and local models are good enough to do real agent work before escalation becomes necessary.

But moving work across boundaries is not a product. The vendors already ship it, in both directions, for free, inside their silos:

- Cursor: prepend `&` to push a local session to a cloud agent; self-hosted workers execute in customer infrastructure.[^cursor-self-hosted]
- Claude Code: web sessions on vendor VMs, `--teleport` to pull a cloud session into the local terminal with full history, Remote Control to steer a local session from a phone.[^claude-remote]
- Codex: `codex cloud exec` to start remote work, `codex cloud apply` to bring diffs back, `--attempts N` for native parallel fan-out.[^codex-cloud]

What no vendor ships, and structurally cannot ship, is the cross-vendor answer to what those agents did. Anthropic will not audit Codex. Cursor will not govern Claude Code. Meanwhile organizations run several agent vendors at once, agent-related security incidents are reported by a large majority of adopting organizations, and only a small minority of agent fleets have full security approval.[^gravitee] Auditors have started asking for agent-scope evidence.

The unowned layer is therefore not coordination. It is governed execution and provenance:

1. Execution: vendor agent harnesses, wrapped as-is, running on runtimes the customer controls.
2. Policy: what each run may see, do, spend, and emit, decided before execution and enforced during it.
3. Provenance: a signed, verifiable record of what actually happened, portable across vendors and runtimes.

## 3. Product invariant

Every run must answer five questions:

1. What moved?
2. Why did it move?
3. Who or what approved it?
4. Which runtime, model, tools, data, and secrets saw it?
5. How can the user resume, inspect, revoke, or reproduce it?

If the platform cannot answer those questions from a signed receipt, on one screen, without trusting the runtime that executed the work, it is just remote execution with branding.

## 4. Design principles

- Receipts over orchestration. The durable value is the proof, not the movement.
- Wrap, do not rebuild. Lab CLIs receive the labs' RL investment; run them unmodified inside governed sessions rather than reimplementing harnesses.
- Neutrality is the moat. Anything a single vendor can ship inside its silo is ceded territory.
- Fail closed. If policy, attestation, or capture cannot be satisfied, pause and ask. Never fall back to a weaker path silently.
- Verifiable without trust. Receipts must be checkable offline, against published schemas and keys, without asking the control plane or the runtime to vouch for itself.
- Honest tiers. A normal cloud VM is not private compute. Mock attestation is labeled mock. Claims never exceed measurement.
- Typed descriptors over magic strings in SDK surfaces; strings are for provider-native IDs, human text, wire tags, and CLI aliases.
- `dryRun` is a security feature. "What would move?" must be answerable without moving anything.
- Open protocol, proprietary plane. The contract and receipt schemas are published and versioned for standardization; the control plane, policy engine, and integrations are the business.

## 5. Non-goals and ceded ground

Non-goals carried forward:

- Not a new agent framework or harness.
- Not a sandbox provider. E2B, Modal, Daytona, Vercel Sandbox, local Docker, and customer VPCs sit below.
- Not a generic workflow engine.
- Not magic live migration. Process, container, and microVM snapshots are out of scope entirely for v1, including as accelerators.

Ground explicitly ceded (this is new, and deliberate):

- Intra-vendor continuation UX. Cursor, Claude Code, and Codex own one-gesture handoff inside their products. We do not compete there.
- Parallel-attempt orchestration UX. Conductor and `codex --attempts` own it, and it is free.
- Model routing and escalation. OpenRouter, LiteLLM, and gateway products own it.
- Developer-ergonomics SDK as the wedge. The wedge is the runner plus the receipt.

Hard boundaries:

- Warrant owns the run contract, policy decision, secret release, receipt, and verification tooling.
- Vendors own harness behavior, model inference, and their own UX.
- Sandbox and infra providers own isolation, filesystems, and machine lifecycle.

## 6. Execution models

The predecessor spec's central ambiguity was whose loop runs. This spec resolves it.

### 6.1 Adapter-owned runs (supported, primary)

The unit of execution is a vendor agent harness (Claude Code, Codex, Cursor CLI, or a custom CLI) launched by Warrant inside a governed session. Warrant owns the session boundary: workspace materialization, environment, secret injection, network policy, event capture, and teardown.

Properties:

- Full durability: the run belongs to the plane, not to any laptop or terminal.
- Full provenance: every command, file change, network grant, and secret release is captured at the session boundary, not by trusting the harness.
- Vendor-upgrade-proof: when the lab improves its CLI, the governed session picks it up unchanged.

### 6.2 App-owned loops (supported, limited, honestly labeled)

An application that owns its own model loop (for example a custom `generateText` agent) may use Warrant for remote tool execution: tool calls are dispatched to a governed runner session and return with receipts.

Properties and limits, stated plainly:

- No durability claim. The loop lives in the app's process; if that process dies, the run dies. Warrant preserves the receipts and the workspace state, not the loop.
- No mid-generation continuation. There is no `handoff-needed` stream event. The predecessor spec admitted mid-stream handoff is a UX illusion and then built its flagship example on it; this spec does not.

Any capability described in this document applies to adapter-owned runs unless explicitly marked as available to app-owned loops.

## 7. Core objects

### 7.1 Vocabulary

One run-state vocabulary, used everywhere (API, CLI, receipts, docs):

```ts
type RunStatus =
  | "created"        // contract exists, not yet claimed
  | "claimed"        // a runner accepted the contract
  | "provisioning"   // workspace and environment are being materialized
  | "running"        // harness is executing
  | "awaiting_approval" // blocked on a human or admin decision
  | "completed"
  | "failed"
  | "cancelled";
```

Error semantics, decided once: hard policy denial is a typed error (`PolicyDeniedError`) at contract creation or claim time; runtime decisions that a human can unblock surface as `awaiting_approval` plus an event. No API returns a `"denied"` status.

### 7.2 Run contract

The signed object that authorizes a run. Nothing executes without one.

```ts
type RunContract = {
  version: "warrant.contract.v1";
  runId: string;
  issuedAt: string;
  issuer: KeyRef;            // org identity that signed this contract
  requestedBy: ActorRef;     // human or service principal
  approvedBy?: ActorRef[];   // present when policy required consent
  agent: AgentSpec;          // e.g. { kind: "claude-code", version: ">=2.1" }
  task: TaskSpec;            // prompt/issue/command; human-authored text
  runner: RunnerSelector;    // pool, locality, capability requirements
  workspace: WorkspaceManifest;
  policy: PolicyRef;         // content-addressed policy snapshot
  secrets: SecretClaim[];    // names and scopes only; never values
  network: NetworkPolicy;    // deny-by-default egress with allowlist
  budget: { maxSpendUsd?: number; maxDurationMin?: number };
  disclosure: DisclosureMode;
  expiresAt: string;
  signatures: Signature[];
};
```

A runner refuses any contract whose signature, policy hash, workspace hashes, or expiry do not verify. `dryRun` renders a contract and its full disclosure report without issuing it.

### 7.3 Receipt

The signed record of what happened. The receipt is the product.

```ts
type Receipt = {
  version: "warrant.receipt.v1";
  runId: string;
  contractHash: string;
  runner: RunnerIdentity;     // enrolled identity + attestation tier
  startedAt: string;
  endedAt: string;
  status: Extract<RunStatus, "completed" | "failed" | "cancelled">;
  events: EventChainRef;      // hash-chained event log (see 7.4)
  workspaceIn: { baseRef: string; manifestHash: string };
  workspaceOut: { diffHash: string; artifactHashes: string[] };
  secretsReleased: SecretReleaseRecord[]; // name, scope, time; never values
  networkAccessed: NetworkAccessRecord[]; // host-level, from session boundary
  modelsUsed: ModelUsageRecord[];         // provider, model id, token counts where observable
  boundaryDisclosures: DisclosureRecord[]; // what content crossed which boundary, by hash and class
  costUsd?: number;
  signatures: Signature[];    // runner-signed; countersigned by control plane
};
```

`warrant verify <receipt>` validates signatures, the event hash chain, and content hashes offline.

### 7.4 Event chain

Append-only, hash-chained events captured at the session boundary. One taxonomy, covering the full lifecycle including failures and consent:

```ts
type RunEvent =
  | { type: "run.created" }
  | { type: "run.claimed"; runner: RunnerIdentity }
  | { type: "workspace.materialized"; manifestHash: string }
  | { type: "policy.evaluated"; decision: "allow" | "ask"; reason: string }
  | { type: "consent.requested"; requirement: string }
  | { type: "consent.granted"; actor: ActorRef }
  | { type: "secret.released"; name: string; scope: string }
  | { type: "command.executed"; argvHash: string; exitCode: number }
  | { type: "file.changed"; pathHash: string; contentHash: string }
  | { type: "network.connected"; host: string; decision: "allowed" | "blocked" }
  | { type: "model.called"; provider: string; model: string }
  | { type: "boundary.crossed"; direction: "out" | "in"; contentHash: string; dataClass: string }
  | { type: "artifact.created"; kind: ArtifactKind; hash: string }
  | { type: "checkpoint.created"; checkpointId: string; tier: CheckpointTier }
  | { type: "run.completed" }
  | { type: "run.failed"; failure: FailureClass }
  | { type: "run.cancelled"; actor: ActorRef };
```

Every event embeds the hash of its predecessor. Redaction happens before storage, not only before display; redacted fields are marked, never silently dropped.

### 7.5 Workspace manifest and checkpoints

Capture rules are explicit, not implied by `workspace: "."`:

- Default capture: git-tracked files at a recorded base ref, plus staged and unstaged diffs.
- Untracked files: excluded unless allowlisted by path pattern in the manifest.
- Always denied: `.env*`, key material patterns, and org-configured deny patterns. Denials are recorded in the manifest so the absence is provable.
- Non-git workspaces: explicit file allowlist only.
- Everything captured is content-addressed; the manifest lists every hash.

Checkpoint tiers, reduced from the predecessor's five to two:

```ts
type CheckpointTier = "semantic" | "workspace";
```

`semantic` is transcript plus task state as exposed by the harness (lossy by nature, labeled as such). `workspace` adds the manifest, diff, and artifacts. Process, container, and microVM snapshots are removed from the spec.

### 7.6 Workspace divergence

The most common real failure mode, previously unaddressed: the developer keeps editing locally after a run starts.

- Every contract records the local base ref and dirty-state hash at creation.
- `warrant pull` performs a three-way comparison: base, run output, current local state. Clean applies are applied; conflicts are surfaced as conflicts, never auto-resolved.
- If local state diverged from the recorded base, the pull warns before touching anything and offers a branch-based apply as the safe default.
- Two runs writing the same logical workspace require explicit isolation (separate branches); the plane enforces a single authoritative writer per branch per run.

## 8. Architecture

### 8.1 Plane split

- Control plane: identity, contracts, policy, approvals, receipt countersignature and storage, dashboards, integrations. Hosted by Warrant or self-hosted.
- Runners: outbound-only processes in the customer's infrastructure (or Warrant-managed cloud for teams that want it) that claim contracts, materialize workspaces, run harnesses inside isolated sessions, and emit signed events.

Runner contract:

- Starts with `warrant runner start --pool <name>` on a single machine, or via a Kubernetes operator for fleets.
- Connects outbound over mutually authenticated TLS. No inbound ports, VPN, or firewall changes.
- Claims contracts with short-lived, nonce-bound claim tokens scoped to one run.
- Executes the agent harness in an isolated session (container or microVM, provider-pluggable) with deny-by-default egress.
- Streams hash-chained events; uploads content-addressed artifacts; signs the receipt.
- Source code, build artifacts, and tool execution stay inside the customer boundary. Anything that leaves is a recorded `boundary.crossed` event. The audit model never claims "code never leaves" unless the receipts prove what crossed.

### 8.2 Deployment modes

1. Warrant-hosted control plane, Warrant-hosted runners.
2. Warrant-hosted control plane, customer self-hosted runners. (Primary v1 mode.)
3. Customer self-hosted control plane and runners.
4. Mode 2 or 3 with attested runners (see section 14).

### 8.3 Trust architecture

The predecessor said "signed" without saying by whom. This section is normative.

Keys and identities:

- Org root: created at onboarding, held in the control plane KMS (modes 1–2) or customer KMS (mode 3). Signs policy snapshots and contract-issuing keys.
- Contract issuer: control-plane service key, certified by the org root. Signs run contracts.
- Approver identities: humans approve via the org's IdP; approvals are recorded as signed assertions referencing the IdP subject.
- Runner identity: generated on the runner at enrollment. Enrollment requires a one-time admin-issued token; the public key is registered, the private key never leaves the runner. Signs events and receipts.
- Verification: `warrant verify` ships with the published schema and resolves keys from the org's published key manifest, so receipts are verifiable offline and remain verifiable if the control plane is unavailable or distrusted.

Tokens:

- Claim tokens: short-lived, nonce-bound, single-run, bound to a runner pool. Possession authorizes claiming exactly one contract.
- No token contains secret values. Secret release is a separate, logged exchange (section 11).

Verifier ownership:

- Modes 1–2: Warrant operates the receipt countersigner and (when attestation is enabled) the attestation verifier.
- Mode 3: the customer operates both; Warrant publishes the reference verifier.

### 8.4 Performance budgets

Budgets are spec requirements because the kill criteria depend on them:

- Contract creation including workspace capture: p50 under 5 seconds, p95 under 20 seconds on a 100k-file repository.
- `dryRun` disclosure report: under 10 seconds.
- Claim-to-harness-start on a warm runner: under 60 seconds.
- Receipt verification offline: under 1 second.
- Contract size excluding artifacts: under 10 MB.

## 9. Policy and disclosure

Policy is evaluated at contract creation (fail closed before anything moves) and enforced at the session boundary during execution.

```ts
type Policy = {
  version: "warrant.policy.v1";
  runners: { allowPools: string[]; requireLocality?: Locality[] };
  agents: { allow: AgentKind[]; versionConstraints?: Record<string, string> };
  models?: { allowProviders?: string[]; denyProviders?: string[] };
  dataClasses: DataClassRule[];
  network: { defaultDeny: boolean; allowHosts: string[] };
  secrets: { releasable: SecretScopeRule[] };
  budget: { maxSpendUsd: number; maxDurationMin: number };
  consent: ConsentRule[];     // which actions require a human, and which humans
  retention: RetentionPolicy;
  attestation?: { requireTier: AttestationTier; forDataClasses: string[] };
};
```

Disclosure modes, carried forward and bound to the contract:

```ts
type DisclosureMode =
  | "none"            // nothing leaves the runner boundary but the receipt
  | "metadata-only"   // status, hashes, costs
  | "redacted"        // logs/diffs pass a redaction pipeline before crossing
  | "minimal-context" // only declared artifact kinds cross
  | "full";           // everything crosses; recorded as such
```

Every actual crossing is a `boundary.crossed` event regardless of mode, so the receipt proves the mode was honored.

## 10. Secrets

- Contracts carry secret names and scopes, never values.
- Values are released by the secret broker directly to the enrolled runner over the authenticated channel, only after policy passes (and attestation, where required), per run, with short validity.
- Injection is into the session environment or files, never into prompts, manifests, contracts, logs, or receipts.
- Every release is a signed `secret.released` event.
- Brokered sources: org store (v1), customer secret managers via plugins (later).

## 11. Failure taxonomy and idempotency

Failure classes (unchanged in substance from the predecessor, now matched one-to-one with `run.failed` events):

```ts
type FailureClass =
  | "policy_denied"
  | "consent_timeout"
  | "capability_mismatch"
  | "attestation_failed"
  | "secret_release_denied"
  | "capture_failed"
  | "transfer_failed"
  | "session_failed"
  | "side_effect_conflict"
  | "budget_exceeded";
```

Every failure carries: stable code, human-readable explanation, last valid checkpoint, whether retry is safe, and whether consent can unblock it.

Idempotency discipline:

- Every externally visible action gets an idempotency key recorded in the event chain.
- External writes require approval, a dry-run phase, or a provider idempotency guarantee.
- Retries replay reads freely and never replay writes without checking recorded side-effect receipts.
- If the plane cannot prove whether an external write happened, it surfaces `side_effect_conflict` rather than retrying silently.

## 12. Threat model

Defend against:

- Accidental secret leakage via prompts, logs, diffs, artifacts, or manifests.
- A malicious or compromised agent CLI attempting exfiltration from inside the session (the harness is untrusted; enforcement lives at the session boundary: egress deny-by-default, secret scoping, boundary events).
- A malicious or compromised runner host (bounded, not eliminated: runner signs what it reports; attestation tiers narrow the gap; receipts record the tier honestly).
- Stale or replayed contracts and claim tokens (expiry, nonces, single-use).
- Confused-deputy secret release (release bound to contract hash plus runner identity plus policy decision).
- Receipt and ledger tampering (hash chains, runner signature plus control-plane countersignature, offline verification).
- Policy downgrade between dry-run and execution (contracts embed the content-addressed policy snapshot).
- Runner impersonation (enrollment ceremony, registered keys, pool binding).
- Unbounded spend or runaway sessions (budget ceilings enforced at the boundary).

Minimum v1 controls: signed contracts, nonce-bound claim tokens, content hashes everywhere, per-run scoped credentials, secret-name-only manifests, deny-by-default egress, budget ceilings, an event for every policy and secret decision, redaction before storage.

## 13. Confidential tier

One section, honest labels, carried forward from the predecessor's strongest material:

Tiers:

- `standard`: TLS, IAM, provider controls.
- `zdr`: provider zero-data-retention contract.
- `cpu-tee`: SEV-SNP, TDX, Nitro Enclaves or equivalent, with measured launch and remote attestation.
- `cpu-gpu-tee`: CPU TEE plus GPU confidential computing.

Rules:

- v1 ships mock attestation, labeled `mock` in every receipt and screen. No production privacy claim is made until measurement and key release are real.
- A receipt's `runner.attestationTier` never exceeds what was verified.
- Real TEE integration (Trustee/KBS-style verification and policy-bound key release) is roadmap, not v1.

Hard truth, retained verbatim in spirit: a normal cloud VM with encryption at rest is not private compute, and a TEE without a clear measurement and key-release story is not enough for the strongest claim. Label tiers honestly.

## 14. Developer surface

CLI-first. The CLI is the product surface; the SDK is a thin client over the same API.

```sh
# enroll a runner in customer infrastructure (one time)
warrant runner start --pool eng-prod

# run a vendor agent under governance
warrant run --agent claude-code --runner pool:eng-prod \
  "fix the flaky auth test and run the suite"

# see exactly what would cross the boundary, without moving anything
warrant run --agent codex --runner pool:eng-prod --dry-run "migrate billing tests"

# watch, approve, pull
warrant watch <run-id>
warrant approve <run-id>
warrant pull <run-id>

# the receipt is the product
warrant receipt <run-id>          # one screen: the five questions
warrant verify <receipt-file>     # offline cryptographic verification
warrant export --jsonl --since 30d
```

Minimal SDK shape (adapter-owned runs):

```ts
import { warrant, pools, agents } from "@warrant/sdk";

const w = warrant(); // resolves org config; no ambient magic beyond explicit config file

const run = await w.run({
  agent: agents.claudeCode(),
  runner: pools.named("eng-prod"),
  task: "fix the flaky auth test and run the suite",
  dryRun: false
});

for await (const event of run.events()) {
  // RunEvent union; exhaustive switch recommended
}

const receipt = await run.receipt();
await run.pull();
```

App-owned loops get exactly one capability, named for what it is:

```ts
const tools = w.remoteTools({ runner: pools.named("eng-prod"), tools: { shell, fs } });
// tool calls execute in a governed session and return receipts;
// no durability claim attaches to the caller's loop
```

The continuation demo, built from the same primitives and nothing else:

```sh
# start work locally with any agent, then continue it under governance
warrant continue --from-session claude-code:latest --runner pool:eng-prod
# capture: transcript (semantic tier) + workspace manifest
# output: a new governed run plus a receipt for what crossed
```

Design rule replacing the predecessor's 30-second-API rule: if a security reviewer cannot verify a receipt without trusting us, the design is wrong. Developer ergonomics get fixed after that bar is met.

## 15. Protocol artifacts

The following schemas are protocol, intended for open publication and eventual foundation governance, and will be extracted to a standalone versioned document before v1:

- `warrant.contract.v1`
- `warrant.receipt.v1`
- `warrant.event.v1` (the event union and hash-chain rules)
- `warrant.manifest.v1` (workspace capture)
- `warrant.policy.v1`

Versioning rules: schemas are append-only within a major version; verifiers must reject unknown major versions and ignore unknown optional fields; every object carries its version string; hashes are computed over canonical JSON (RFC 8785).

The strategic intent is explicit: publish the contract and receipt formats openly, drive them toward neutral governance, and monetize the control plane, policy engine, and enterprise integrations. A proprietary envelope format is a melting asset; an authored standard is a moat.

## 16. MVP

### 16.1 Validation gate (precedes all build work)

Interview 15–20 platform/security leads at companies with 200–2,000 engineers using two or more agent vendors. Three questions:

1. What happens when an agent run needs to outlive the laptop?
2. When does work need to come back local mid-run?
3. Has security blocked or constrained an agent rollout, and what unblocked it?

Kill condition: if question 3 does not surface as a current, budgeted problem with design-partner commitments within one quarter of outreach, stop. Do not proceed to build.

### 16.2 Build scope (after the gate)

- Control plane: contracts, policy evaluation, approvals, receipt countersignature, JSONL export.
- One runner: single-machine, outbound-only, container-isolated sessions, deny-by-default egress.
- Two agent adapters: Claude Code and Codex, wrapped as-is.
- Workspace capture per section 7.5; divergence-safe `pull`.
- Secret broker with org store.
- `dryRun`, `receipt`, `verify`, `export`.
- Mock attestation, labeled.

Not in MVP: Kubernetes operator, parallel fan-out, review scorecards, model routing, GitHub/Slack apps, dashboards beyond a minimal run list, real TEEs, app-owned-loop remote tools.

### 16.3 Demo flows

1. Governed run: `warrant run --agent claude-code` against a private repo on a customer runner; show the one-screen receipt answering the five questions; verify it offline.
2. Dry run: show exactly which files, prompts, secrets (names), hosts, and costs a run would involve; move nothing.
3. Policy denial and consent: a run requesting a production secret is blocked, an admin approves from the CLI, the receipt shows the full decision chain.

The handoff demo (start local with a vendor CLI, `warrant continue` onto a governed runner, pull back with a receipt) is demo four: it exists to prove the primitives compose, not as the pitch.

### 16.4 Kill criteria

- Setup over ten minutes on a normal TypeScript repo: the wedge is too heavy.
- Receipt cannot answer the five questions on one screen: the trust story is fake.
- Governed run is materially slower or flakier than running the vendor's own cloud product: the product loses.
- Any secret value appears in any contract, prompt, log, manifest, or receipt: the architecture is broken.
- Performance budgets in section 8.4 missed by more than 2x at MVP: rearchitect before adding features.

## 17. V1 requirements

Functional:

1. Run Claude Code and Codex harnesses, unmodified, from signed run contracts on enrolled runners.
2. Outbound-only runner enrollment, claim, and execution with no inbound network requirements.
3. Workspace capture per manifest rules, content-addressed, with provable exclusions.
4. Secret release per policy, injected at runtime, names-only everywhere else, every release logged.
5. Policy evaluation with allow / ask / fail-closed semantics at contract time and boundary enforcement at run time.
6. `dryRun` producing the complete disclosure report without issuing a contract.
7. Signed, hash-chained receipts; offline verification; JSONL export.
8. Divergence-safe pull of results into the originating workspace.

Non-functional:

1. All protocol schemas versioned per section 15.
2. State and artifacts encrypted in transit and at rest; content-addressed and deduplicated.
3. Receipts verifiable without control-plane availability.
4. Performance budgets per section 8.4.
5. No secret values in any persisted or transmitted object other than the broker-to-runner release channel.
6. Deny-by-default network egress enforced and recorded.

## 18. Later

- Kubernetes runner operator and fleet API.
- Cursor CLI and custom-harness adapters; MCP tool manifests.
- GitHub app (PR provenance: link receipts to PRs), Slack approvals, web dashboard.
- Customer secret-manager plugins; SSO/SCIM; policy packs; data residency.
- Real TEE attestation (Trustee/KBS-compatible), signed runner images, measurement transparency log.
- App-owned-loop remote tools.
- Parallel fan-out and review surfaces, if and only if customers pull for them.

## 19. Open questions and defaults until disproven

- Which compliance frame anchors the receipt schema: SOC 2 evidence, EU AI Act logging, or internal security review? Default: SOC 2 evidence first; it is the ask auditors are already making.
- Should the reference runner isolation be containers or microVMs? Default: containers for v1 single-machine mode; microVM support via provider plugin.
- Hosted-runner offering at launch? Default: no; mode 2 (hosted plane, customer runners) is the wedge. Hosted runners only when a design partner demands them.
- Open-source surface? Default: protocol schemas, verifier, and runner open; control plane closed.
- Pricing shape? Default: per-seat control plane plus per-runner fee; decided with design partners, documented in the strategy doc, not here.

## 20. What this spec deliberately keeps from its predecessor

The five-question invariant, fail-closed policy, disclosure modes, failure taxonomy, idempotency and side-effect receipts, dryRun, typed descriptors, persist-events-recompute-views, honest confidentiality tiers, and defaults-until-disproven. Those were the durable assets. The breadth was not.

[^pcc]: Apple Security Research, "Expanding Private Cloud Compute". https://security.apple.com/blog/expanding-pcc/
[^cursor-self-hosted]: Cursor Blog, "Run cloud agents in your own infrastructure". https://cursor.com/blog/self-hosted-cloud-agents
[^claude-remote]: Claude Code Docs, "Continue local sessions from any device with Remote Control". https://code.claude.com/docs/en/remote-control
[^codex-cloud]: OpenAI Developers, "Codex CLI Features: Working with Codex cloud". https://developers.openai.com/codex/cli/features
[^gravitee]: Gravitee, "State of AI Agent Security 2026". https://www.gravitee.io/blog/state-of-ai-agent-security-2026-report-when-adoption-outpaces-control
