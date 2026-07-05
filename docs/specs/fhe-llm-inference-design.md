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
is anchored to a published result (see [References](#16-references)).

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

## 10. Performance model (two independent methods)

Two estimates that fail differently: (a) **anchored** — scale published
system measurements through our optimization stack; (b) **first
principles** — count operations and bytes from hardware limits. Their
agreement window is the design target.

### 10a. Anchored (top-down)

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

Single GPU: topology B ~1.5–3s/effective token (decode loses the modest
multi-GPU scaling; Sylph decode scales only 31s → 18s from 1 → 8 GPUs);
topology A ~1–2s (bootstrap term removed, refresh RTTs added, 2–4× from
smaller parameters). Caveats: Sylph/Cerium gains overlap; ENSI's 8× was CPU
at 3B; ct-ct attention grows with private context.

### 10b. First principles (bottom-up)

**The atom.** GPU FHE is memory-bandwidth-bound; the unit of account is the
**key-switch** (every rotation and relinearization). At N=2^16, avg level
ℓ≈15 limbs (topology A leveled-only): limb-poly = 0.5MB, ciphertext ≈ 15MB;
one hybrid key-switch (dnum=3) streams ~85–130MB (ciphertext + key
material) → **~25–60µs at ~5TB/s effective** (B200-class). Ciphertext
additions (all a ternary linear layer is) move ~30MB with no keys: ~5–10µs,
and fuse — rounding error.

**Counts per layer, per speculative block of k=8 positions** (8×4096 =
32,768 values = full slot occupancy of one ciphertext — blocks are a
*slot-filling* mechanism, not just a step-count trick):

| Component | Key-switches | Notes |
|---|---|---|
| QKV+O+FFN matmuls | ~30–60 | ternary column-packed = additions; only log-tree reductions rotate |
| Attention ct-ct (GQA, few hundred cached tokens) | ~50–100 | BSGS CC-MM; grows with private context |
| Sigmoid attn + 2 norms (deg-8 polys, Goldschmidt) | ~25–40 | Paterson–Stockmeyer |
| **Per layer** | **~120–200** | |

Forward pass: 32 layers × ~150 + LM head (128k vocab, ternary) ≈ **~5,500
key-switches per block** → 0.15–0.35s compute. Topology-A refreshes: depth
~10–14 levels/layer (nonlinearities only) → ~20–30 sequential refresh
points × ~2–3ms (one ~4MB low-level ciphertext each way, intra-region) →
~0.05–0.1s. Block yields ~5–6 effective tokens (70% acceptance) →
**~40–90ms per effective token** if everything composes perfectly.

**Physics floor**: mandatory key-material streaming, a few thousand
key-switches × ~100MB ≈ hundreds of GB per block → **~5–10ms per effective
token** on current memory systems. (Plaintext 8B decode moves ~2GB/token ≈
0.4ms — the residual FHE tax is key material: ~50–100× more bytes per
useful op.)

### 10c. Reconciliation and target

| Method | Per effective token (8B, 1 GPU) |
|---|---|
| Anchored (10a) | ~1–2s |
| First principles (10b), perfect composition | ~0.04–0.09s |
| Physics floor | ~0.005–0.01s |

Real systems land 3–10× above their first-principles model (engineering
tax: slot under-occupancy, fusion gaps, scheduling bubbles — cf. plaintext
megakernels reaching 78% of bandwidth as a headline result). **Converged
design target: ~0.15–1s per effective token (8B, single GPU); 4B ~2–3×
cheaper.** Cost: single-GPU unit ~$2–8/hr → sub-cent to ~$0.01 per token.
Overhead vs plaintext: ~10^2–10^4× depending on execution quality.

### 10d. Design lessons from the bottom-up model

1. **Slot occupancy is the master variable.** Fill slots (speculative
   blocks, multi-token heads, same-key session batching) for near-linear
   gains; batch-1 decode wastes 7/8 of every op at k=1.
2. **Ternary's real gift is level-freedom, not multiplication-freedom.**
   Deleted levels shrink every key-switch (cost scales with limb count) and
   halve refresh counts — a compounding, quasi-quadratic effect.
3. **Topology-A refresh round trips are noise** (~0.1s/block intra-region);
   the leveled-only bet is safer than the anchored estimate suggested.
4. **Key-material bandwidth is the endgame.** At the floor the machine is a
   key-streaming engine — which is why Grafting (−62% keys), LCR/AKS
   (−12–15% rotation keys), and eventually PIM/near-memory hardware are on
   the optimization map (see `fhe-llm-optimization-map.md`).

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

## 15. Requirements

### 15.1 Server compute (FHE evaluator) — minimum-first

First-principles floors (no SLA assumed). FHE execution is streaming: only
one operation's working set must be resident (~key-switch: ciphertext
15–30MB + one key digit set 50–100MB + temporaries), so **capacity floors
are small and bandwidth is not a requirement — it only divides latency**
(§10b). Resident set for an 8B decode block under topology A: eval keys
1–3GB (leveled-only + Grafting, no bootstrap keys) + activations <1GB +
workspace 2–4GB + encrypted KV 5–20GB for a few-hundred-to-~1k-token
private suffix (MLA + level-trimmed) ≈ **10–30GB VRAM**.

| Floor | Hardware | What it gives |
|---|---|---|
| Functional (no GPU) | 64GB-RAM CPU box, OpenFHE | Full correctness: logic dev, unit tests, precision tooling, CI oracle (ENSI ran its results CPU-only) |
| **Practical minimum (M0–M5 single-tenant)** | **One workstation: 24–32GB consumer GPU (~1–1.8TB/s: used 3090 / 4090 / 5090-class), 128–256GB RAM, 2–4TB NVMe** (~$3–5k owned or ~$0.3–1/hr rented) | Entire program: ~0.75–5s/effective token (8B), ~0.3–2s (2–4B); host RAM/NVMe as KV paging tiers |
| Bandwidth-class serving (optional tier) | RTX PRO 6000 (96GB, ~1.8TB/s) → B200 (192GB, ~8TB/s) | Latency ÷ bandwidth ratio; B200 justified only by multi-thousand-token private-context KV capacity or a latency floor — it is a product tier, not an architectural need |

Selection KPI: **memory bandwidth per dollar** (the machine is a
key-streaming engine; consumer cards often win, cf. Sylph's RTX PRO 6000
results beating Cerium's H100s). Batch-1-per-key does NOT imply a dedicated
GPU per tenant: pooling with session swap (keys/KV cached host-side, ~0.1s
reload over PCIe 5), concurrent multi-tenant streams (legal — ciphertexts
don't interact; fixed-shape execution covers timing side channels), and MIG
slicing all apply. Dedicated whole-card is a compliance/latency product
tier only.

### 15.2 Training compute (model side) — minimum-first

| Task | Minimum hardware | Notes |
|---|---|---|
| M2–M4 target model: fine-tune **open BitNet 2B4T** (already ternary; MIT BF16 master weights) with polynomial activations + sigmoid attention | The same consumer-GPU workstation (optimizer CPU-offload), or one rented 80GB GPU, days-scale | No training rental strictly required before M5 |
| 1–2B draft distillate | Same | |
| M5 target: 4–8B QAT distillation | Burst-rent 2×H100-class or 4×48GB w/ ZeRO offload (~100GB optimizer state is the binding number), days-scale (~$2–5k/cycle) | Not owned hardware; only after M3 precision gate passes |
| Outlier calibration + polynomial-range discovery | Hours on the dev card | Versioned artifacts, re-run per release (§9) |
| M6 pretrain (MLA/sliding-window ternary, SSM backbone) | Cluster-scale (out of v1 budget) | Only if research tracks activate |

### 15.3 Network

| Path | Requirement | Why |
|---|---|---|
| Key agent ↔ server (topology A) | Same region, VPC-peered/private link; **<1ms RTT, ≥10Gbps** | Refresh points are sequential: ~20–30 × ~8MB round trips per block (§10b); WAN kills topology A |
| End-user ↔ server (topology B) | Ordinary WAN; ~10–100MB per speculative block each way | Seed compression + level-drop before transmission (§9 of optimization map); tolerate 50–200ms RTT per *block*, not per token |
| Egress budget | Plan for GB-scale per long session (topology A refresh traffic stays intra-region — near-free) | Cloud egress pricing shapes topology A vs B economics |

### 15.4 Key-side environment

| Component | Requirement |
|---|---|
| Key agent VM (topology A) | Minimum: any 4-vCPU/16GB machine with low RTT to the server (a LAN box suffices in dev; customer-tenancy VM in prod); OpenFHE CPU build; sustains decrypt+flood+re-encrypt at line rate (ms-scale per ciphertext) |
| Confidential variant (A+) | SEV-SNP / TDX / Nitro Enclaves; attestation service; key sealed to enclave; measured boot |
| Key custody | Customer KMS/HSM roots the key; agent holds session keys only; rotation invalidates server-cached bundles |
| End-user device (topology B) | Any Apple Silicon Mac, ≥8GB unified memory (a 1.7B ternary draft is ~0.4GB; MLX at 25–80 tok/s); OpenFHE CPU for crypto ops |

### 15.5 Software stack

- **Server**: Ubuntu 22.04/24.04, CUDA 12–13, GCC ≥11, CMake ≥3.25,
  FIDESlib + its patched OpenFHE (`FIDESLIB_INSTALL_OPENFHE=ON` first
  build), NCCL optional (scale-out only). Cheddar (CUDA ≥11.8, CMake ≥3.24)
  as evaluation backend. CUDA Graphs–capable driver.
- **Model tooling**: PyTorch + HF transformers (BitNet fork noted on the
  model card), lm-evaluation-harness, our shadow-execution simulator
  (plaintext replay with quantization/approximation, §9).
- **Client**: OpenFHE (CPU) cross-compiled for macOS/arm64; MLX for the
  draft model; Swift/CLI wrapper.
- **CI**: GPU runner (same class as dev GPU) for kernel diffs vs the
  OpenFHE CPU oracle; CPU-only runners for oracle/unit tests; nightly
  long-generation precision soak (§9) with golden prompts; noise-budget
  regression gates.

### 15.6 Storage

| Artifact | Size class | Where |
|---|---|---|
| Eval-key bundle per (tenant, model release) | GBs (topology B incl. bootstrap keys); ~40–60% less under topology A + Grafting | Server NVMe, content-addressed cache |
| Ciphertext KV working set | ~0.3TB per 4k private tokens (§11) | GPU HBM → host RAM → NVMe tiers |
| Model artifacts (ternary weights, calibration ranges, polynomial coefficient sets) | ~2–4GB per release | Versioned registry; calibration artifacts are release-gating |
| Telemetry (noise budgets, per-layer error norms) | GB/day-scale in debug; sampled in prod | Feeds §9 CI gates |

### 15.7 People & process

- Minimum team: 1 CUDA/systems engineer, 1 ML engineer (QAT/distillation),
  1 crypto-aware protocol engineer; plus a consulting **cryptographer
  sign-off** on parameter selection, per-refresh flooding, and the CPA^D
  protocol review (M2 gate) — non-negotiable.
- Security process: external review of the key agent before any customer
  deployment; side-channel review (traffic shapes) before GA; incident
  runbook for key rotation.
- Legal/compliance: license verification for FIDESlib before commercial
  use (§6); model-weight licenses (BitNet MIT, Bonsai Apache 2.0) are
  fine-tune-compatible.

### 15.8 Budget envelope (minimum path)

- Capex option: one consumer-GPU workstation (~$3–5k) + one Apple Silicon
  Mac — runs M0 through M5 single-tenant, doubles as CI runner.
- Rental option: ~$0.3–1/hr consumer GPU (~$0.2–1k/mo at 50% duty cycle).
- Training bursts: $0 before M5 (open BitNet 2B4T on the dev card);
  ~$2–5k per 4–8B distillation cycle at M5.
- Cloud storage/egress: <$0.5k/mo until M5.
- Published-result reproduction budget (M1): negligible beyond GPU time —
  all answer-key artifacts are open source (§15.5).
- Bandwidth-class serving hardware (RTX PRO 6000 / B200) enters only as a
  latency/capacity product tier decision at M5, priced per §15.1.

## 16. References

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
