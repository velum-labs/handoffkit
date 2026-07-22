# RouteKit routes, billing, and provider disclosures

Audience: maintainers reviewing RouteKit's launch support contract. The
user-facing source of truth is
[`/docs/reference/routes-and-billing`](../apps/docs/content/docs/reference/routes-and-billing.mdx).
Keep this mirror aligned when route behavior or qualification evidence changes.

All seven routes remain **Planned Supported until L06 closes**. The 2026-07-22
[real-account report](evidence/routekit-real-account/2026-07-22-dad16c53.md)
records three API-route Pass results and four subscription/client Fail results
at `@routekit/cli` 0.8.0 revision
[`dad16c53`](https://github.com/velum-labs/handoffkit/commit/dad16c53c0e083a51d41df59149a21964d27cc12).
The Fail rows must be rerun with the required accounts and clients before the
public labels can change.

## Shared contract

- A requested namespaced model never falls through to another provider.
  Unknown routes fail; an explicit `defaultModel` applies only when a client
  omits the model.
- API routes have no RouteKit account-pool or cross-provider failover.
- Subscription pools rotate only among eligible accounts of the same kind.
  Exhaustion never switches to an API-key provider.
- FusionKit's separately configured `onRateLimit: fusion` panel expansion is
  not a RouteKit route fallback.
- RouteKit never claims unlimited use. Provider terms, plan limits, fair-use
  controls, quotas, and model availability always apply.

<a id="route-openai-api"></a>

## OpenAI API

- **Credential / owner:** User-owned `OPENAI_API_KEY`; optional explicit
  `OPENAI_BASE_URL`. Inline router-YAML keys are rejected.
- **Billing / egress:** API-key route, separate from the Codex subscription
  route, direct to `api.openai.com` unless the operator overrides the
  destination. OpenAI determines charges; exact attribution remains an L06
  check. No aggregator.
- **Quota / fallback:** Provider errors return to the caller; no account pool
  and no silent cross-provider fallback.
- **Protocol / limitations:** OpenAI Chat Completions, streaming, and tools;
  model-specific reasoning and images depend on OpenAI. No provider-session
  restore.
- **Evidence:** **L06 qualification Pass** for `openai/gpt-5.5`, RouteKit 0.8.0
  / `dad16c53` / 2026-07-22. One real-account request was observed; tools,
  streaming, reasoning, cancellation, failure propagation, and no RouteKit
  fallback passed. Public status stays Planned until L06 closes.

<a id="route-anthropic-api"></a>

## Anthropic API

- **Credential / owner:** User-owned `ANTHROPIC_API_KEY`; optional explicit
  `ANTHROPIC_BASE_URL`. RouteKit does not currently use
  `ANTHROPIC_AUTH_TOKEN` for provider requests.
- **Billing / egress:** API-key route, separate from the Claude Code
  subscription route, direct to `api.anthropic.com` by default. Anthropic
  determines charges; exact attribution remains an L06 check. No aggregator.
- **Quota / fallback:** Provider errors return to the caller; no account pool
  and no silent cross-provider fallback.
- **Protocol / limitations:** Native Messages with streaming, tools, thinking,
  signatures, and redacted-thinking where supported. Cross-dialect translation
  can preserve only shared fields. No provider-session restore.
- **Evidence:** **L06 qualification Pass** for
  `anthropic/claude-sonnet-4-6`, RouteKit 0.8.0 / `dad16c53` / 2026-07-22.
  One real-account request was observed; tools, streaming, reasoning,
  cancellation, failure propagation, and no RouteKit fallback passed. Public
  status stays Planned until L06 closes.

<a id="route-openrouter-api"></a>

## OpenRouter API

- **Credential / owner:** User-owned `OPENROUTER_API_KEY`.
- **Billing / egress:** OpenRouter API-key/credit route, not a native
  subscription route. OpenRouter determines charges and credit usage; exact
  attribution remains an L06 check. **OpenRouter is an aggregator:** RouteKit
  sends request content to `openrouter.ai`, which sends it to an upstream
  provider under OpenRouter routing. A model slug does not guarantee one
  upstream host. RouteKit supplies attribution headers.
- **Quota / fallback:** No RouteKit account pool or silent direct-provider
  switch. OpenRouter's own upstream routing remains governed by the user's
  OpenRouter settings and terms.
- **Protocol / limitations:** OpenAI Chat Completions; tools, streaming, images,
  context, and reasoning depend on OpenRouter and the upstream model. No
  provider-session restore.
- **Evidence:** **L06 qualification Pass** for
  `openrouter/openai/gpt-4o-mini`, RouteKit 0.8.0 / `dad16c53` / 2026-07-22.
  One real-account request was observed; tools, streaming, reasoning,
  cancellation, failure propagation, and no RouteKit fallback passed.
  OpenRouter remains the upstream-routing aggregator. Public status stays
  Planned until L06 closes.

<a id="route-codex-subscription"></a>

## Codex subscription

- **Credential / owner:** User-owned Codex OAuth credential enrolled with
  `accounts login codex` or imported with `accounts add`; stored under
  `~/.routekit/subscriptions/codex/`.
- **Billing / egress:** Uses the enrolled subscription OAuth credential, never
  `OPENAI_API_KEY`, and relays directly to `chatgpt.com/backend-api/codex`.
  The provider determines plan usage and charges; exact attribution remains an
  L06 check. No third-party aggregator.
- **Quota / fallback:** Quota can rotate eligible Codex accounts. Transient
  retry is bounded to one same-account retry and one alternate. Exhaustion is
  explicit and never invokes a paid OpenAI API-key route.
- **Protocol / limitations:** OpenAI Responses with streaming, tools, and
  discovered reasoning efforts. Official client catalog/profile compatibility
  is version-sensitive; setup and restore remain pending L06.
- **Evidence:** **L06 qualification Fail — `account-unavailable`**, RouteKit 0.8.0
  / `dad16c53` / 2026-07-22. The worker had no enrolled Codex account or
  Codex client, so live streaming, billing attribution, setup, and restore were
  not observed. Deterministic tools, reasoning, cancellation, failure
  propagation, and zero API-key fallback passed.

<a id="route-claude-code-subscription"></a>

## Claude Code subscription

- **Credential / owner:** User-owned Claude Code OAuth credential enrolled
  with `accounts login claude-code` or imported with `accounts add`; stored
  under `~/.routekit/subscriptions/claude-code/`.
- **Billing / egress:** Uses the enrolled subscription OAuth credential, never
  `ANTHROPIC_API_KEY`, and relays directly to Anthropic. Anthropic determines
  plan usage and charges; exact attribution remains an L06 check. No
  third-party aggregator.
- **Quota / fallback:** Same-kind eligible-account rotation with bounded
  transient retry. Exhaustion is explicit and never invokes a paid Anthropic
  API-key route.
- **Protocol / limitations:** The native Anthropic Messages relay forwards the
  client's body. The OpenAI-compatible subscription backend inserts the Claude
  Code identity and rewrites other caller `system` and `developer` messages as
  `user` messages. Streaming, tools, and thinking are supported; managed
  restore/recovery parity is pending L06.
- **Evidence:** **L06 qualification Fail — `account-unavailable`**, RouteKit 0.8.0
  / `dad16c53` / 2026-07-22. The worker had no enrolled Claude Code
  account or Claude client, so live streaming, billing attribution, setup, and
  restore were not observed. Deterministic tools, reasoning, cancellation,
  failure propagation, and zero API-key fallback passed.

<a id="route-cursor-ide"></a>

## Cursor IDE custom OpenAI endpoint

- **Credential / owner:** Logged-in Cursor desktop account plus a local gateway
  token; model egress separately uses the selected RouteKit route's credential.
- **Billing / egress:** Expected boundary: custom-endpoint model calls use the
  selected RouteKit route's billing mode, while Cursor-owned services remain
  separate; exact attribution remains an L06 check. Agent requests use the
  local bridge and selected provider. Composer, inline edit, apply,
  autocomplete, authentication, and other Cursor-owned features can contact
  Cursor cloud.
- **Quota / fallback:** Adds no fallback; the selected provider route's rules
  apply. Cursor-cloud errors are not handed off to another RouteKit provider.
- **Protocol / limitations:** Custom OpenAI endpoint for Agent chat/plan.
  Streaming and tools are supported; images and reasoning controls are
  degraded. Other editor features do not use the custom model. Restore remains
  version-specific.
- **Evidence:** **L06 qualification Fail — `manual-evidence-unavailable`**,
  RouteKit 0.8.0 / `dad16c53` / 2026-07-22. This Linux worker had no Cursor
  desktop and could not run Cursorkit's macOS-oriented IDE launcher. No
  authenticated traffic, billing attribution, setup, or restore was observed.

<a id="route-cursor-agent"></a>

## `cursor-agent` custom OpenAI endpoint

- **Credential / owner:** Logged-in `cursor-agent` account plus its local
  endpoint; model egress separately uses the selected RouteKit route's
  credential.
- **Billing / egress:** Expected boundary: endpoint model calls use the
  selected RouteKit route's billing mode, while Cursor-owned services remain
  separate; exact attribution remains an L06 check. Model calls use the local
  Cursorkit bridge; Cursor can still handle authentication, session, and
  product-service traffic.
- **Quota / fallback:** Adds no fallback; the selected provider route's rules
  apply. Cursor upstream errors are not silently expanded to a paid route.
- **Protocol / limitations:** Cursor bridge to OpenAI Chat. Streaming and tools
  are supported; images and reasoning controls are degraded. Session restore
  and compatibility are client-version-specific.
- **Evidence:** **L06 qualification Fail — `client-unavailable`**, RouteKit 0.8.0
  / `dad16c53` / 2026-07-22. `cursor-agent` was not installed, so no
  authenticated traffic, billing attribution, setup, or restore was observed.
  Deterministic bridge-protocol tools, reasoning, cancellation, failure
  propagation, and no RouteKit fallback passed.

## Qualification requirement

The deterministic harness is documented in
[RouteKit end-to-end verification matrix](routekit-e2e-matrix.md). The
[sanitized L06 report](evidence/routekit-real-account/2026-07-22-dad16c53.md)
maps every stable route anchor above to exact RouteKit revision, credential
mode, client/provider version, evidence date, protocol behavior, billing
attribution, failure behavior, and setup/restore results. Four rows are Fail,
so all public labels stay conditional.
