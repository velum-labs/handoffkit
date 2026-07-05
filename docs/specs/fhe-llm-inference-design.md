# FHE LLM Inference — System Design Spec

Status: draft v2 (adds deployment topologies with client-aided refresh,
single-GPU-first runtime, context-scaling strategy)
Date: 2026-07-05

Goal: serve a language model such that **the model provider never sees the
client's data** — prompts, activations, or outputs — using fully homomorphic
encryption (FHE), with hardware-accelerated evaluation on NVIDIA GPUs. The
key-holding client role runs on end-user devices (Apple Silicon) or as a
small agent in the customer's own cloud tenancy. No Concrete ML dependency;
the stack is built on open-source CKKS libraries plus our own model/runtime
co-design.

This spec consolidates a literature review (mid-2026 state of the art) and a
series of design discussions into a single reference. Every performance claim
is anchored to a published result (see [References](#15-references)).

---

## 1. Product thesis

FHE is the only deployment technology that protects **both parties at once**:
the client's data never leaves encryption, and the provider's proprietary
weights never leave the server. Local inference gives the client privacy but
requires open weights; TEEs give speed but require trusting the hardware
vendor, cloud, and hypervisor.

Therefore the product only makes sense when **the served model is meaningfully
better than the best open-weights model the client can run locally**. This is
the first go/no-go gate (see [Risks](#12-risk-register)): a proprietary
ternary-class model in the 4–8B range must beat local open alternatives on the
target workloads, or there is no reason for this system to exist.

Target workloads (accepting seconds-per-token latency):

- Private document summarization / analysis (legal, medical, financial)
- Encrypted-suffix RAG: long public context + short sensitive query
- High-sensitivity Q&A where a 30–90s round trip for a few hundred tokens is
  acceptable

Non-goals (v1): real-time chat, token-heavy reasoning models (long CoT),
multi-tenant SIMD batching across different clients' keys, encrypted
fine-tuning.

## 2. Threat model

| Property | Guarantee | Mechanism |
|---|---|---|
| Prompt/activation/output confidentiality | Cryptographic (RLWE hardness, post-quantum) | RNS-CKKS; secret key never leaves client |
| Weight confidentiality | Weights stay server-side in plaintext | Architectural (client never receives weights) |
| Server honesty (integrity) | **Not guaranteed by FHE** | Mitigations: spot-check known queries, optional redundant execution; verifiable FHE tracked as future work |
| Decryption-oracle resistance (IND-CPA^D) | Required — client decrypts server-produced ciphertexts in the decode loop | Noise flooding at decryption sized to worst-case noise; ciphertext hygiene; fixed protocol shapes |
| Side channels | Partial | Fixed-shape execution; pad speculative-verification blocks to constant size; pad/quantize output length and timing |
| Metadata (who/when/how often) | Out of scope | Standard transport privacy if needed |

Assumptions: semi-honest server for confidentiality (confidentiality holds
even against a malicious server; *correctness* does not). The key-holding
trust domain (end-user device, or the customer's own cloud tenancy per §3.1)
is trusted — note this is the same trust domain that already holds the
customer's plaintext data, so FHE removes the model provider from the trust
equation without adding anyone new. All ciphertexts for one session are
under a single client key.

**The masking rule (governs all hybrid offload)**: any operation routed
through the client key mid-computation must commute with a mask the server
can apply and remove. Noise refresh (identity function) masks perfectly with
an additive mask → safely offloadable. Shift-invariant ops (softmax) mask
imperfectly → leak model internals (attention patterns); avoid.
General nonlinearities don't mask → offload only via true 2PC (out of scope
v1). Every client-side decryption — sampling *and* refresh — is a
decryption-oracle interaction and MUST apply noise flooding, and the refresh
protocol carries transcript MACs so a malicious server cannot use the key
agent as an oracle on crafted ciphertexts.

Key security references: CKKS IND-CPA^D key-recovery attacks (Li–Micciancio,
Eurocrypt '21) and the noise-flooding countermeasure (Li et al. '22) — the
client-side sampling loop in §8 is exactly the interaction pattern these
attacks target, so flooding is **mandatory, not optional**. Speculative
decoding acceptance patterns leak input-dependent information via packet
sizes (SECRETS-style attacks); we pad to fixed block sizes.

## 3. Architecture overview

```
┌──────────────────────────┐          ┌───────────────────────────────────┐
│  KEY SIDE (customer      │          │  SERVER (model provider,          │
│  trust domain)           │          │  single NVIDIA GPU per tenant)    │
│                          │          │                                   │
│  keygen / encrypt /      │  1 round │  plaintext ternary weights        │
│  decrypt (CPU, cheap)    │  per     │  CKKS evaluator (GPU)             │
│                          │  spec    │   - mult-free ternary PCMM        │
│  draft model (plaintext, │  block   │   - leveled-only circuit (A) or   │
│  1–2B)             ──────┼─────────►│     fused bootstrap kernels (B)   │
│                          │          │   - CUDA-graph / megakernel exec  │
│  sampling over decrypted │◄─────────┼─  encrypted logits / verification │
│  logits (noise-flooded)  │          │   results                         │
│                          │          │                                   │
│  masked refresh agent    │◄────────►│  refresh points (topology A only, │
│  (topology A only)       │ LAN-class│  masked ciphertexts, MAC'd)       │
└──────────────────────────┘          └───────────────────────────────────┘
```

The compute is deliberately asymmetric: the server carries >99% of the load
(the full encrypted forward pass); the key side performs only ms-scale
encrypt/decrypt operations plus optional plaintext drafting. The key side's
unique capability is holding the secret key — decryption is the one
operation infinitely cheaper there, and §3.1 exploits it.

### 3.1 Deployment topologies (trust ladder)

| Tier | Key holder | Refresh strategy | Trust required |
|---|---|---|---|
| **A (default)** | Key agent VM in the **customer's own cloud tenancy**, same region as server, VPC-peered (<1ms RTT, 10–100Gbps) | **Masked client-aided refresh**: server sends Enc(x+r), agent decrypts (noise-flooded), re-encrypts fresh, server subtracts r. Server runs **leveled-only** (no bootstrapping circuit) | Customer's own cloud account — the same tenancy that already stores their plaintext data. Model provider still excluded cryptographically |
| **A+ (hardened)** | Same, inside a confidential VM (SEV-SNP/TDX/Nitro), attested, key sealed | Same as A | Defense-in-depth vs cloud insiders. TCB is the tiny auditable agent (decrypt/flood/mask/sample only) — not the model, not CUDA. Bifrost-style trust, smaller TCB |
| **B (zero key in cloud)** | End-user device only (Apple Silicon, WAN) | Server-side **GPU bootstrapping**; WAN round trips only at speculative-block boundaries, where a piggybacked refresh can reset precision drift (cheap only for small carried state — favors fixed-state architectures, §14) | No key material in any cloud. Highest purity, higher server cost |
| **C (output custody)** | Threshold-split key across two tenancies/providers | Threshold decryption for **final outputs only** (per-refresh threshold use is research-grade: smudging noise vs precision, see CPA^D threshold literature) | No single operator can decrypt outputs |

Topology A is the recommended default: it deletes the server's largest cost
(bootstrapping: 65–80% of runtime), permits smaller CKKS parameters (no
bootstrap depth → smaller ring/modulus → every op cheaper and working set
smaller), structurally eliminates precision drift (every refresh is a clean
re-encryption), and removes GB-scale bootstrapping keys from key logistics.
Cost: refresh round trips (~10–30ms per refresh point at LAN-class
networking; dead over WAN — hence topology B for WAN clients). Open
question gating A (first item of the M2 crypto review): per-refresh noise
flooding consumes budget — the flooding-vs-level-savings analysis must
close before A is committed as default.

- **Key side**: generates keys, encrypts the private prompt suffix, runs the
  plaintext draft model on its own data, samples from decrypted logits,
  decrypts final output, and (topology A) services masked refreshes.
- **Server**: holds plaintext model weights and the client's *evaluation
  keys* (public material: rotation/relinearization keys; bootstrapping keys
  only in topology B). Evaluates the forward pass over ciphertexts on GPU.
- **Communication**: one round trip per speculative block of k draft tokens
  (plus refresh exchanges in topology A). All traffic fixed-shape/padded.

## 4. Model design (co-designed with the crypto)

The model meets the cryptography halfway. Baseline architecture: a
**fully ternary decoder-only transformer** (BitNet b1.58 / Ternary Bonsai
class), 4–8B parameters, distilled from a stronger teacher.

| Design choice | Rationale | Source |
|---|---|---|
| Ternary weights {-1, 0, +1}, group-wise FP16 scales | Plaintext-ciphertext matmuls become signed additions: **no homomorphic multiplications and no level consumption** in linear layers → bootstrap count roughly halves; ~8× matmul speedup demonstrated | ENSI (BitNet-3B + CKKS); lineage: TAPAS, FHE-DiNN, REDsec |
| Sigmoid attention (or Power-Softmax variant) | Removes exp + division from attention; retraining-free variant demonstrated | ENSI; Power-Softmax; Powerformer |
| GELU → `x·sigmoid(1.702x)` low-degree polynomial; RMSNorm inverse-sqrt via Goldschmidt iteration | Standard HE-friendly substitutions; fine-tune/distill to absorb approximation error | Power-Softmax; THOR; NEXUS |
| Bootstrapping embedded in RMSNorm | Refresh ciphertexts where the circuit already touches every element; ENSI reduced bootstraps to ~1% of ops | ENSI |
| GQA or MLA (latent KV compression) | KV cache is *ciphertexts*; fewer/compressed KV heads shrink the ct-ct attention cost and ciphertext memory — the one cost ternary weights do not fix | plaintext-serving transfer (unclaimed in FHE literature) |
| Sliding-window attention on most layers | Bounds ct-ct attention and ciphertext KV memory to a constant in context length | plaintext transfer |
| Static structured pruning | Zero weight blocks are *skipped circuits* (weights are plaintext); ternary models are already 25–50% zeros | TAPAS insight, unexploited in modern CKKS systems |
| Outlier suppression without retraining: token prepending + orthogonal rotations | Smaller activation ranges → lower-degree polynomial approximations → fewer levels/bootstraps | Sylph |
| Dense (no MoE), no early exit, no dynamic sparsity | FHE circuits cannot branch on encrypted data; only static/structural optimizations survive | design principle |

Also required: a **multi-token prediction head** (Medusa/EAGLE-style, static
architecture) to raise speculative acceptance, and a **distillation-aligned
draft model** (1–2B, same tokenizer) shipped to clients for local drafting.

## 5. Cryptographic layer

- **Scheme**: RNS-CKKS. Ring degree N = 2^16 (2^15 slots), ~128-bit security,
  hybrid key-switching. Parameters finalized after the level-budget audit of
  the final model circuit.
- **Packing**: MOAI-style *consistent packing flow* — column packing for
  PCMM (rotation-free with ternary column sums), diagonal packing where
  ct-ct ops require it, formats chosen so no conversions are needed between
  modules; format conversions that remain are fused into bootstrapping
  (Sylph technique).
- **Linear layers**: ENSI multiplication-free PCMM. Each output column is a
  signed sum of encrypted input columns selected by the ternary plaintext
  weights; group scale factors fold into the plaintext encoding for free.
  Level consumption: 0.
- **Attention**: ct-ct QK^T and scores·V use THOR/MOAI baby-step–giant-step
  CC-MM. This is the component that grows with private context — bounded by
  sliding windows + MLA (§4).
- **Nonlinearities**: per §4 substitutions; polynomial ranges set by the
  outlier-calibration pass and re-validated per model release.
- **Ciphertext refresh**: topology A replaces bootstrapping with masked
  client-aided refresh at fixed circuit points (the RMSNorm sites);
  topology B uses GPU bootstrapping placed by the compiler (Orion-style
  automatic placement as the target; hand-placed inside RMSNorm initially).
  The circuit is authored once with abstract "refresh" nodes; the backend
  lowers them to either mechanism.
- **Heterogeneous prompts** (Sylph): public context processed in plaintext,
  private suffix under encryption, joined by a bootstrapping-frugal
  PC-attention with a shallow, low-memory PCMM. This is the single biggest
  deployment-economics lever: 4k-token public context + 128 encrypted tokens
  runs in ~64s prefill on 8×RTX PRO 6000 in the published system.

## 6. Server runtime

Base library: **FIDESlib** (public repo, full GPU CKKS incl. bootstrapping,
OpenFHE-interoperable client side, multi-GPU via NCCL as of v2.1.2; verify
license terms before commercial use). **Cheddar** (MIT, 32-bit RNS) is the
tracked alternative — its 32-bit design is also the natural basis for a
future Metal port (confirm bootstrap is in the open release). **DESILO FHE**
(proprietary but freely pip-installable, GPU CKKS with bootstrapping) is a
fallback evaluation option. **OpenFHE (CPU)** is the permanent correctness
oracle; every GPU kernel diffs against it in CI.

Runtime techniques, in adoption order:

1. **Kernel fusion** (table stakes): rescale/ModDown/HMult fused into NTT
   kernels (FIDESlib already ships these), dot-product fusion, limb-batching
   to amortize launch overhead.
2. **CUDA Graphs end-to-end**: FHE circuits are static and branchless — the
   entire forward pass is one pre-built graph per (model, context-shape)
   pair, built offline and reused (Cerium/Theodosian pattern).
3. **Memory-hierarchy scheduling**: L2-aware multi-polynomial batching and
   complementary pipelining of DRAM-bound with L2-bound kernels (Theodosian).
4. **Megakernel (research track)**: Hazy-style persistent-interpreter kernel
   executing a precomputed FHE instruction schedule per SM, overlapping NTT
   compute with key-switching key loads across op boundaries. FHE is a
   *better* megakernel target than plaintext inference (perfectly static
   schedule, no dynamic batching); unpublished territory we can own.
5. **Paged ciphertext memory**: vLLM/PagedAttention translated to ciphertext
   KV blocks (2–3 orders of magnitude larger than plaintext KV); paging
   across GPU/host memory with the level-aware twist that cached KV is held
   at low modulus (the CKKS analog of KV-cache quantization) and refreshed
   on touch.
6. **Prefill/decode disaggregation**: prefill is wide-matmul-heavy, decode is
   refresh-bound; different kernel mixes and scheduling
   (DistServe/Splitwise pattern).
7. **Multi-GPU (optional scale-out, not a core dependency)**: demoted from
   the v1 requirement. Rationale: ternary weights delete the plaintext
   weight-encoding footprint that forced model sharding in Sylph/Cerium
   (signed-addition PCMM stores no weight polynomials), and decode scales
   poorly across GPUs anyway (Sylph: 31s → 18s from 1 → 8 GPUs, 1.7× on 8×
   hardware, bootstrap-bound). Reinstate only for: low-latency
   fully-encrypted long prefill, wide PC-attention over very long public
   contexts, encrypted-KV memory capacity beyond one card (§11), or >8B
   models. FIDESlib's NCCL support keeps this behind the library boundary.

Hardware target: **one** B200-class or RTX-PRO-6000-class GPU per tenant
(96–192GB). Single-GPU-first compounds with per-tenant batch-1 economics: a
1-GPU serving unit at ~$2–8/hr instead of a 4–8 GPU node. The crypto backend
stays swappable (compiler-IR boundary) to keep the FHE-ASIC option open
(CraterLake/ARK/Cinnamon lineage; Fabric, Optalysys).

## 7. Key side (client / key agent)

- **Key agent (topology A/A+)**: a deliberately minimal, auditable service —
  decrypt, noise-flood, mask-respond, re-encrypt, sample. No model logic, no
  business logic. Ships as a hardened VM image (plus confidential-VM variant
  with attestation) deployed into the customer's tenancy. The agent is a
  first-class deliverable of this project, not integration glue.
- **End-user platform (topology B)**: Apple Silicon (macOS/iOS). Unified
  memory and Metal are attractive on paper for FHE, but no production Metal
  CKKS library exists; the key-side role needs none of it. CPU-side
  encrypt/decrypt/keygen via OpenFHE (interoperable with FIDESlib
  server-side).
- **Draft model**: 1–2B ternary distillate of the served model, running
  plaintext (MLX on-device at 25–80+ tok/s, or on the key-agent VM). The
  customer owns its data, so local drafting leaks nothing.
- **Sampling**: server returns encrypted logits (or verification results);
  key side decrypts **with noise flooding**, samples locally, re-encrypts
  the chosen token. Replaces expensive encrypted argmax (NEXUS) with one
  round trip per speculative block.
- **Key logistics**: evaluation/rotation keys are large and packing-scheme-
  specific; topology A drops the bootstrapping keys (the largest bundle
  component). Design: content-addressed key bundles uploaded once per
  (client, model-release) pair, cached server-side; key rotation invalidates
  the bundle. Cold-start cost is a first-class UX metric.

## 8. Decoding pipeline

Per generated block (speculative decoding, POST-style adapted to our threat
model):

1. Client's local draft model proposes k tokens (plaintext, on-device).
2. Client encrypts the k candidates; sends one verification request.
3. Server runs **one batched forward pass** verifying all k positions —
   under FHE this costs barely more than one decode step, because SIMD slots
   and bootstraps amortize across positions (Sylph: 128-token prefill ≈ one
   decode step in wall time).
4. Server returns encrypted per-position logits; block padded to constant
   size regardless of acceptance.
5. Client decrypts (noise-flooded), runs speculative-sampling acceptance
   locally, appends accepted tokens, loops.

Published speedup for the secure-inference variant: 2.1–6.0× (POST, ICML
'25), improved further by distillation alignment between draft and target,
and by the multi-token head (§4).

Prefill uses the heterogeneous public/private prompt path (§5) whenever the
context has a public component.

## 9. Precision engineering (first-class subsystem)

CKKS is approximate; autoregressive generation feeds approximation error
back through 30+ layers for hundreds of steps, and no published system
reports perplexity-vs-generation-length under FHE. We treat precision as a
tested, telemetered property:

- **Shadow execution**: every encrypted run can be replayed in plaintext
  with simulated quantization/approximation; per-layer error norms logged.
- **Noise telemetry**: level/scale/noise-budget tracking per ciphertext in
  debug builds; CI gates on error bounds for golden prompts.
- **Long-generation soak tests**: perplexity and task-accuracy curves vs
  output length (target: no measurable drift at 512 generated tokens).
- Ternary activation distributions are unusually spiky; the outlier
  calibration pass (§4) is re-run per model release, and its ranges are
  versioned artifacts.

## 10. Performance model (napkin math, anchored)

Anchors: Sylph Llama-3-8B decode 12s/token (4×B200), prefill 20–26s for 128
encrypted tokens; Cerium bootstrap 7.5ms (B200); MOAI bootstrap share ~80%
pre-optimization; ENSI ternary matmul ~8×, bootstraps → ~1% of ops.

Decomposition of a 12s decode step (assumed: 65% bootstrap / 25% linear /
10% nonlinear+glue), with technique effects applied to the component each
actually touches:

| Technique | Effect | Result |
|---|---|---|
| Ternary PCMM (linear term) | ~8× on weight matmuls | 3.0s → ~0.4s |
| Level-free linears (bootstrap count) | ~2× fewer bootstraps | 7.8s → ~3.9s |
| Cerium-grade bootstrap kernels | 1.5–2× on bootstrap wall time | 3.9s → ~2.2s |
| CUDA-graph/megakernel runtime | 1.2–1.5× on nonlinear + glue | 1.2s → ~0.8s |
| **Subtotal (per sequential step)** | | **~3.4s/token** |
| Speculative decoding (client draft) | 2–4× on sequential step count | **~1–2s/token effective** |

Estimates for the 8B target:

- 4×B200 node (reference): realistic **1–2s per effective token**; prefill
  6–8s (128 encrypted tokens); 4k public + 128 private context ~20–25s.
  Optimistic (full composition + sigmoid-attention depth savings):
  **0.5–1s**.
- **Single GPU, topology B** (GPU bootstrapping): decode loses the modest
  multi-GPU scaling → **~1.5–3s per effective token**; prefill ~30–60s for
  128 encrypted tokens (prefill is what parallelizes, so it takes the hit).
- **Single GPU, topology A** (leveled-only + LAN-class refresh agent):
  removes the bootstrap term, adds ~0.5–2s/token of refresh round trips,
  and shrinks all remaining ops 2–4× via smaller parameters → **~1–2s per
  effective token on one GPU**, competitive with the 4-GPU topology-B
  estimate. Contingent on the flooding-per-refresh analysis (§3.1).
- Speed-of-light floor (refresh-only, ~2/layer × 32 layers × 7.5ms GPU
  bootstrap): **~0.5s/token** per sequential step.
- 4B model: roughly 2–3× cheaper → **2–5 effective tok/s** plausible.

Cost: single-GPU unit ~$2–8/hr → **sub-cent to ~$0.01 per token**; 4×B200
reference node ~$25–40/hr → $0.005–0.04. Overhead vs plaintext:
~10^3–10^4×.

Known non-composabilities (why the realistic band is wide): Sylph and Cerium
optimizations overlap; ENSI's 8× was measured at 3B on CPU without real
bootstrapping; ct-ct attention grows with *private* context; deeper models
may need higher-precision (slower) bootstraps.

## 11. Context scaling

Long context under FHE hits two distinct walls, with different escapes:

- **Wall 1 — quadratic ct-ct prefill**: attention over *encrypted* tokens.
  Calibration: 128 fully-encrypted tokens ≈ 20s prefill (Sylph, 8 GPUs);
  fully-encrypted 4k is ~1,000× more attention work. Fully-encrypted long
  context is off the table on any hardware roadmap.
- **Wall 2 — ciphertext KV memory**: ~8MB per trimmed-level ciphertext →
  roughly 0.3TB at 4k encrypted tokens (32 layers), ~2TB at 32k, ~8TB+ at
  128k. A single GPU holds a few thousand encrypted tokens of KV; host
  paging buys low tens of thousands.

Escape ladder, by leverage:

1. **Heterogeneous prompts** (§5): encrypted queries over *plaintext* KV
   (PC-attention) are linear in public length with normal-tensor storage.
   Long-mostly-public contexts (RAG corpora, codebases) scale to ~32k–128k
   public tokens in minutes; this is a first-class product feature.
2. **Client-side curation**: the key side owns the plaintext — it runs local
   retrieval/summarization (reusing the draft model) and encrypts only
   relevant chunks. Converts 128k-private into 2–8k-private at zero
   cryptographic cost. First-class product feature, not an optimization.
3. **MLA + trimmed-level KV + host paging**: stretches the on-GPU private
   window toward ~16–32k. This is the scenario that reinstates multi-GPU —
   for memory capacity, not compute.
4. **Sliding windows**: bound the ct-ct quadratic term (already in §4).
5. **Fixed-state architectures (SSM/linear attention)**: the strategic
   answer for 100k+ private context — constant-size encrypted state, no KV
   blowup, linear prefill, context-independent decode. Also makes topology
   B's piggybacked per-block refresh cheap (constant state per round trip).
   Open problems: selective gating consumes depth through time
   (bootstrap-per-step or public-decay recurrences, per HSSM), unproven
   CKKS error accumulation over long recurrences, and sigmoid attention's
   length generalization needs validation.

Envelope: long-public + ≤~1k private — practical now; ≤4–8k fully private —
practical single-node; 16–32k private — hard, needs lever 3 + scale-out;
100k+ private — requires the lever-5 architecture bet. Model reality check:
BitNet-class ternary bases currently ship ~4k native context; longer windows
also require long-context adaptation training on our side.

## 12. What deliberately does NOT transfer

Data-dependent optimizations break under FHE obliviousness. Explicitly out:
MoE routing (dense models only), early exit / adaptive depth, activation
sparsity, KV eviction (H2O-style), retrieval-based drafting server-side.
Cross-user SIMD batching is cryptographically impossible under single-key
CKKS — serving economics are per-tenant, batch-1 per key (multi-key FHE
rejected for v1 on cost and CPA^D-interaction grounds).

## 13. Risk register

| # | Risk | Severity | Mitigation / gate |
|---|---|---|---|
| 1 | **Local-inference squeeze**: served model not better than what clients run locally | Existential | Gate 0: proprietary 4–8B model must beat best local open-weights on target evals |
| 2 | **Integrity**: FHE proves nothing about what the server ran | High (commercial) | Spot-checks, optional redundancy; track verifiable-FHE literature |
| 3 | **Test-time-compute trend**: reasoning models multiply token counts against our per-token cost | High (strategic) | Target non-reasoning distillates; watch latent-reasoning research |
| 4 | **Precision drift** over long generations | High (technical) | §9 subsystem; topology A structurally eliminates it (clean refresh); measurable on GPT-2-scale prototype |
| 5 | **Flooding-per-refresh budget** (gates topology A) | High (technical) | First item of M2 crypto review; topology B is the fallback if it doesn't close |
| 6 | Per-tenant batch-1 economics | Medium (improved by single-GPU unit) | Price as dedicated capacity; 1-GPU serving unit at ~$2–8/hr |
| 7 | CPA^D decryption-oracle in decode/refresh loop | Medium (must not ship wrong) | Mandatory noise flooding in the shipped agent, transcript MACs, ciphertext hygiene, protocol review |
| 8 | Side channels: output length, timing, speculation and refresh patterns | Medium | Fixed-shape execution, block padding, length quantization, padded refresh traffic |
| 9 | Key-agent compromise (topology A/A+) | Medium | Blast radius = same tenancy that already holds plaintext data; confidential-VM tier, key rotation, per-session keys, minimal auditable TCB |
| 10 | Model treadmill: co-designed model freezes; recalibration per release | Medium (ops) | Versioned calibration pipeline is a deliverable, not an afterthought |
| 11 | Key logistics UX (large eval keys) | Medium (reduced in topology A: no bootstrap keys) | §7 key-bundle design; cold-start metric |
| 12 | TEE competition (H100 CC at ~5–10% overhead) | Market | Position on "no model-provider trust"; A+ uses a TEE for defense-in-depth without putting the model stack in the TCB; regulatory angle (ciphertext processing under GDPR/HIPAA) |
| 13 | FHE ASICs obsolete GPU stack | Low/opportunity | Swappable crypto backend behind compiler IR |
| 14 | Debuggability / talent scarcity | Medium | Shadow execution + noise telemetry tooling from day one |

## 14. Milestones

- **M0 — Bench harness**: FIDESlib on target GPU; measure encrypted 768-dim
  matvec + bootstrap; validate the §10 cost model. OpenFHE CPU oracle in CI.
- **M1 — Encrypted GPT-2 reproduction**: replicate EncryptedLLM
  (open-source OpenFHE-GPU fork + modified HF GPT-2) on our stack; flush out
  packing/bootstrap/precision infrastructure against a published answer key.
- **M2 — Ternary block**: ENSI-style mult-free PCMM + sigmoid attention +
  RMSNorm-embedded refresh for one transformer block on FIDESlib. ENSI's
  public code (`sugarhh/ENSI`) uses OpenFHE (CPU) plus a bootstrapping-capable
  Phantom fork for GPU matmuls; the gap we close is end-to-end GPU execution
  with refresh. Microbenchmarks vs M1. **M2 crypto review** decides topology
  A vs B as default (flooding-per-refresh analysis, §3.1).
- **M3 — Small ternary model end-to-end**: 1–2B ternary distillate encrypted
  end-to-end on **one GPU**; §9 long-generation precision soak; first honest
  tok/s number.
- **M4 — Decode pipeline**: draft model + padded speculative verification +
  noise-flooded sampling; prototype key agent servicing masked refreshes
  over a LAN-class link; measure effective tok/s for topologies A and B.
- **M5 — Scale + serve**: 4–8B model on a single GPU, heterogeneous prompts,
  paged ciphertext KV, CUDA-graph runtime, hardened key-agent image (A/A+);
  per-tenant serving MVP. Multi-GPU only if a concrete workload demands it
  (§6.7, §11.3).
- **M6 (research tracks, parallel)**: FHE megakernel; MLA/sliding-window
  ternary architecture pretrain/distill; structured-pruning circuit
  skipping; fixed-state (SSM) backbone for 100k+ private context (§11.5).

## 15. References

Pure-FHE transformer systems: NEXUS (NDSS '25, eprint 2024/136) · THOR (CCS
'25, eprint 2024/1881) · MOAI (ICLR '26, eprint 2025/991) · Powerformer (ACL
'25) · EncryptedLLM (ICML '25; code: `leodec/openfhe-gpu-public`) · Cerium
(arXiv 2512.11269) · Sylph (arXiv 2601.18511).

Model co-design: Power-Softmax (arXiv 2410.09457) · ENSI (SRDS '25, arXiv
2509.09424; code: `sugarhh/ENSI`) · BitNet b1.58 (arXiv 2504.12285; MIT
weights incl. BF16 master weights on HuggingFace) · Ternary Bonsai (PrismML,
2026; Apache 2.0 weights, benchmarks vendor-reported) · FHE-DiNN (CRYPTO
'18) · TAPAS (ICML '18) · REDsec (NDSS '23). Note: MOAI's 2.36 min/input GPU
figure is amortized over 256 same-key batched inputs (code:
`dtc2025ag/MOAI`, `dtc2025ag/MOAI_GPU`; NEXUS code: `zju-abclab/NEXUS`,
microbenchmark-level).

Libraries/compilers: FIDESlib (`CAPS-UMU/FIDESlib`, ISPASS '25) · Cheddar
(`scale-snu/cheddar-fhe`, ASPLOS '26) · Phantom · OpenFHE · Orion
(`baahl-nyu/orion`, ASPLOS '25) · Theodosian (arXiv 2512.18345).

Decoding/serving transfers: POST speculative secure decoding (ICML '25,
eprint 2025/2251) · SECRETS side channels (arXiv 2411.01076) · Hazy Research
megakernels (2025) · Mirage Persistent Kernel · HSSM public-decay FHE SSMs
(arXiv 2605.16647).

Security & trust topologies: Li–Micciancio IND-CPA^D (eprint 2020/1533) ·
noise-flooding countermeasure (eprint 2022/816) · CPA^D of threshold
CKKS/smudging-precision tension (CRYPTO '24 workshop line, DOI
10.1007/978-3-031-68382-4_1) · Bifrost TEE–FHE hybrid serving (arXiv
2606.17421; trust-model precedent for topology A+) · OpenFHE CKKS security
notes.
