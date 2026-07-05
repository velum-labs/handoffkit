# FHE LLM Inference — System Design Spec

Status: draft v1 (design consolidation, pre-prototype)
Date: 2026-07-05

Goal: serve a language model such that **the server never sees the client's
data** — prompts, activations, or outputs — using fully homomorphic
encryption (FHE), with hardware-accelerated evaluation on NVIDIA GPUs and an
Apple Silicon client. No Concrete ML dependency; the stack is built on
open-source CKKS libraries plus our own model/runtime co-design.

This spec consolidates a literature review (mid-2026 state of the art) and a
series of design discussions into a single reference. Every performance claim
is anchored to a published result (see [References](#13-references)).

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
even against a malicious server; *correctness* does not). Client device is
trusted. All ciphertexts for one session are under a single client key.

Key security references: CKKS IND-CPA^D key-recovery attacks (Li–Micciancio,
Eurocrypt '21) and the noise-flooding countermeasure (Li et al. '22) — the
client-side sampling loop in §8 is exactly the interaction pattern these
attacks target, so flooding is **mandatory, not optional**. Speculative
decoding acceptance patterns leak input-dependent information via packet
sizes (SECRETS-style attacks); we pad to fixed block sizes.

## 3. Architecture overview

```
┌──────────────────────────┐          ┌───────────────────────────────────┐
│  CLIENT (Apple Silicon)  │          │  SERVER (NVIDIA GPU node)         │
│                          │          │                                   │
│  keygen / encrypt /      │  1 round │  plaintext ternary weights        │
│  decrypt (CPU, cheap)    │  per     │  CKKS evaluator (GPU)             │
│                          │  spec    │   - mult-free ternary PCMM        │
│  draft model (MLX,       │  block   │   - fused bootstrap kernels       │
│  plaintext, 1–2B)  ──────┼─────────►│   - CUDA-graph / megakernel exec  │
│                          │          │   - paged ciphertext KV           │
│  sampling over decrypted │◄─────────┼─  encrypted logits / verification │
│  logits (noise-flooded)  │          │   results                         │
└──────────────────────────┘          └───────────────────────────────────┘
```

- **Client**: generates keys, encrypts the private prompt suffix, runs the
  plaintext draft model on its own data, samples from decrypted logits,
  decrypts final output. All cheap (ms-scale) — Apple Silicon is the client
  and dev platform, not the FHE evaluator.
- **Server**: holds plaintext model weights and the client's *evaluation
  keys* (public material: rotation, relinearization, bootstrapping keys).
  Evaluates the forward pass over ciphertexts on GPU.
- **Communication**: non-interactive per speculative block (one round trip
  per verified block of k draft tokens, not per token).

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
- **Bootstrapping**: placed by the compiler (Orion-style automatic
  placement as the target; hand-placed inside RMSNorm initially).
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
5. **Multi-GPU**: communication placed at minimum-modulus points in the
   circuit (Sylph/Cerium co-design of partitioning and placement).
6. **Paged ciphertext memory**: vLLM/PagedAttention translated to ciphertext
   KV blocks (2–3 orders of magnitude larger than plaintext KV); paging
   across GPU/host memory with the level-aware twist that cached KV is held
   at low modulus (the CKKS analog of KV-cache quantization) and refreshed
   on touch.
7. **Prefill/decode disaggregation**: prefill is wide-matmul-heavy, decode is
   bootstrap-heavy; different kernel mixes, potentially different GPU pools
   (DistServe/Splitwise pattern).

Hardware target: 4–8× B200-class or RTX-PRO-6000-class per tenant. The
crypto backend stays swappable (compiler-IR boundary) to keep the FHE-ASIC
option open (CraterLake/ARK/Cinnamon lineage; Fabric, Optalysys).

## 7. Client

- **Platform**: Apple Silicon (macOS/iOS). Unified memory and Metal are
  attractive on paper for FHE, but no production Metal CKKS library exists;
  the client role needs none of it. CPU-side encrypt/decrypt/keygen via
  OpenFHE (interoperable with FIDESlib server-side).
- **Draft model**: 1–2B ternary distillate of the served model, running
  plaintext under MLX at 25–80+ tok/s on-device. The client owns its data,
  so local drafting leaks nothing.
- **Sampling**: server returns encrypted logits (or verification results);
  client decrypts **with noise flooding**, samples locally, re-encrypts the
  chosen token. Replaces expensive encrypted argmax (NEXUS) with one round
  trip per speculative block.
- **Key logistics**: evaluation/rotation/bootstrapping keys are GB-scale and
  packing-scheme-specific. Design: content-addressed key bundles uploaded
  once per (client, model-release) pair, cached server-side; key rotation
  invalidates the bundle. Cold-start cost is a first-class UX metric.

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

Estimates for the 8B target, single 4×B200-class node:

- Realistic: **1–2s per effective token**; prefill 6–8s (128 encrypted
  tokens); 4k public + 128 private context ~20–25s.
- Optimistic (full composition + sigmoid-attention depth savings):
  **0.5–1s**.
- Speed-of-light floor (bootstrap-only, ~2/layer × 32 layers × 7.5ms):
  **~0.5s/token** per sequential step.
- 4B model: roughly 2–3× cheaper → **2–5 effective tok/s** plausible.

Cost: ~$25–40/hr node → **$0.005–0.04 per token** depending on acceptance
rates. Overhead vs plaintext: ~10^3–10^4×.

Known non-composabilities (why the realistic band is wide): Sylph and Cerium
optimizations overlap; ENSI's 8× was measured at 3B on CPU without real
bootstrapping; ct-ct attention grows with *private* context; deeper models
may need higher-precision (slower) bootstraps.

## 11. What deliberately does NOT transfer

Data-dependent optimizations break under FHE obliviousness. Explicitly out:
MoE routing (dense models only), early exit / adaptive depth, activation
sparsity, KV eviction (H2O-style), retrieval-based drafting server-side.
Cross-user SIMD batching is cryptographically impossible under single-key
CKKS — serving economics are per-tenant, batch-1 per key (multi-key FHE
rejected for v1 on cost and CPA^D-interaction grounds).

## 12. Risk register

| # | Risk | Severity | Mitigation / gate |
|---|---|---|---|
| 1 | **Local-inference squeeze**: served model not better than what clients run locally | Existential | Gate 0: proprietary 4–8B model must beat best local open-weights on target evals |
| 2 | **Integrity**: FHE proves nothing about what the server ran | High (commercial) | Spot-checks, optional redundancy; track verifiable-FHE literature |
| 3 | **Test-time-compute trend**: reasoning models multiply token counts against our per-token cost | High (strategic) | Target non-reasoning distillates; watch latent-reasoning research |
| 4 | **Precision drift** over long generations | High (technical) | §9 subsystem; measurable on GPT-2-scale prototype before scale-up |
| 5 | Per-tenant batch-1 economics | Medium | Price as dedicated capacity; buyers (regulated/sovereign) often require it anyway |
| 6 | CPA^D decryption-oracle in decode loop | Medium (must not ship wrong) | Mandatory noise flooding, ciphertext hygiene, protocol review |
| 7 | Side channels: output length, timing, speculation patterns | Medium | Fixed-shape execution, block padding, length quantization |
| 8 | Model treadmill: co-designed model freezes; recalibration per release | Medium (ops) | Versioned calibration pipeline is a deliverable, not an afterthought |
| 9 | Key logistics UX (GB-scale eval keys) | Medium | §7 key-bundle design; cold-start metric |
| 10 | TEE competition (H100 CC at ~5–10% overhead) | Market | Position on "no hardware-vendor trust"; regulatory angle (ciphertext processing under GDPR/HIPAA) |
| 11 | FHE ASICs obsolete GPU stack | Low/opportunity | Swappable crypto backend behind compiler IR |
| 12 | Debuggability / talent scarcity | Medium | Shadow execution + noise telemetry tooling from day one |

## 13. Milestones

- **M0 — Bench harness**: FIDESlib on target GPU; measure encrypted 768-dim
  matvec + bootstrap; validate the §10 cost model. OpenFHE CPU oracle in CI.
- **M1 — Encrypted GPT-2 reproduction**: replicate EncryptedLLM
  (open-source OpenFHE-GPU fork + modified HF GPT-2) on our stack; flush out
  packing/bootstrap/precision infrastructure against a published answer key.
- **M2 — Ternary block**: ENSI-style mult-free PCMM + sigmoid attention +
  RMSNorm-embedded bootstrap for one transformer block on FIDESlib. ENSI's
  public code (`sugarhh/ENSI`) uses OpenFHE (CPU) plus a bootstrapping-capable
  Phantom fork for GPU matmuls; the gap we close is end-to-end GPU execution
  with bootstrapping. Microbenchmarks vs M1.
- **M3 — Small ternary model end-to-end**: 1–2B ternary distillate encrypted
  end-to-end; §9 long-generation precision soak; first honest tok/s number.
- **M4 — Decode pipeline**: client draft (MLX) + padded speculative
  verification + noise-flooded client sampling; measure effective tok/s.
- **M5 — Scale + serve**: 4–8B model, multi-GPU, heterogeneous prompts,
  paged ciphertext KV, CUDA-graph runtime; per-tenant serving MVP.
- **M6 (research tracks, parallel)**: FHE megakernel; MLA/sliding-window
  ternary architecture pretrain/distill; structured-pruning circuit skipping.

## 14. References

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

Security: Li–Micciancio IND-CPA^D (eprint 2020/1533) · noise-flooding
countermeasure (eprint 2022/816) · OpenFHE CKKS security notes.
