# FHE LLM Inference — Optimization Map

Status: v1, companion to `fhe-llm-inference-design.md`
Date: 2026-07-05

A layer-by-layer map of every applicable optimization, from lattice
parameters up to serving policy. Each entry: expected gain (anchored to the
cited source where available), maturity, and its status in our design.

Status legend: **core** (in the design spec) · **planned** (roadmapped) ·
**evaluate** (promising, needs measurement) · **watch** (not yet
actionable) · **rejected** (with reason).

---

## 1. Scheme & parameter level (CKKS)

| Technique | What it does / gain | Maturity | Status |
|---|---|---|---|
| Leveled-only operation (topology A) | Removes bootstrap depth from parameters → smaller ring/modulus, every op 2–4× cheaper, smaller keys | Standard practice | **core** (§3.1 of design spec) |
| **Grafting** — decoupled scale factor and modulus (eprint 2024/1014, CCS '25) | Flexible rescaling, optimized RNS packing: 1.92× faster bootstrapping, **62% smaller public keys** | Published + implemented (CryptoLab lineage; Cheddar cites it) | **planned** — directly attacks key-logistics risk |
| 32-bit RNS construction (Cheddar) | Higher GPU arithmetic efficiency; also the natural basis for a Metal port | Open source (MIT) | **evaluate** vs FIDESlib 64-bit |
| Sparse-secret / subring secret encapsulation | Reduces homomorphic-rounding complexity in bootstrap; FIDESlib v2.1.2 ships it | Published + shipped | **planned** (topology B path) |
| Composite/heterogeneous scale factors | Finer scale management → fewer wasted modulus bits per level | Published (with Grafting) | **planned** |
| Ring/format switching fused into refresh points | Sylph: fuse encoding conversions into bootstrapping; supports mixed ring degrees | Published, no open impl | **planned** (M5) |
| Scheme switching CKKS↔TFHE (CHIMERA, PEGASUS, OpenFHE `EvalCKKStoFHEW`) | LUT-based exact nonlinearities (argmax, comparison, sign) without polynomial approx; LOHEN (USENIX Sec '25) chooses per-layer | Published, OpenFHE API exists | **evaluate** — likely unnecessary given client-side sampling, but the escape hatch for any server-side exact comparison |
| Batched bit-CKKS bootstrapping instead of TFHE PBS | CKKS bootstrap amortized over >150 ciphertexts beats CGGI bootstrapping | Published (Eurocrypt '24 line) | **watch** |

## 2. Refresh / bootstrapping

| Technique | What it does / gain | Maturity | Status |
|---|---|---|---|
| Masked client-aided refresh | Deletes server bootstrapping entirely; clean re-encryption resets precision | Protocol-level, needs our impl | **core** (topology A) |
| **High-precision bootstrapping via Discrete-CKKS Integer Cleaning + EvalRound+** (eprint 2025/1786) | Non-iterative **80-bit-precision** bootstrap at N=2^16 with 494 bits of modulus left; 1.64× faster than Meta-BTS. 80-bit precision is exactly what noise flooding for IND-CPA^D needs | Published 2025, Grafting-based impl | **planned** — key input to the M2 flooding-per-refresh analysis; may make topology B flooding-compatible too |
| **Level-conserving rescaling + aggregated key-switching (AKS)** (eprint 2025/1403, PKC '26) | Saves a level in CoeffsToSlots; 20–40% bootstrapping throughput; 12–15% smaller rotation keys | Published | **planned** (topology B path) |
| EvalRound / OverModRaise variants | Lower modulus consumption in CTS/STC | Published | **planned** |
| Bootstrap placement by compiler (Orion) | Automatic placement; we author abstract refresh nodes | Open source | **core** |
| RMSNorm-embedded refresh (ENSI) | Refresh where the circuit already touches all elements; bootstraps → ~1% of ops | Published + code | **core** |
| Scheme-switched bootstrapping (HEAP, ISCA '24) | CKKS bootstrap via parallel TFHE BlindRotates; parallelizes across devices | Published (accelerator context) | **watch** |
| Slim/sparse-slot bootstrapping; slim polynomial evaluation on sparsely packed ciphertexts (Sylph) | Cheaper refresh/eval when few slots are live (softmax auxiliary track) | Published | **planned** (M5) |

## 3. Homomorphic linear algebra

| Technique | What it does / gain | Maturity | Status |
|---|---|---|---|
| Multiplication-free ternary PCMM (ENSI) | Weight matmuls = signed ciphertext additions; 0 level consumption; ~8× | Published + code | **core** |
| Column packing (MOAI) | Rotation-free PCMM; consistent formats across layers eliminate conversions | Published + code | **core** |
| Interleaved batching (MOAI) | Amortizes CC-MM rotations across batched inputs (same key) | Published + code | **planned** (speculative-block positions batch this way) |
| BSGS diagonal CC-MM (THOR/MOAI) | Standard ct-ct matmul for attention | Published + code | **core** |
| Double-hoisting BSGS (Bossuat et al.; Orion uses it) | Reduces rotations + special-modulus divisions in linear transforms | Published, in OpenFHE/Lattigo | **core** |
| **Triple-hoisted BSGS** (arXiv 2605.17222) | Third hoisting layer + delayed ModDown: lower complexity *and* memory vs DH-BSGS | Published 2026 | **evaluate** (M5 kernel work) |
| Rescale-integrated matmul (eprint 2025/429) | Rescaling inside BSGS loop exploits cheaper low-level NTTs; ~(L+N)/L complexity gain | Published | **evaluate** |
| Hoisted rotations (single decompose, many rotations) | Standard rotation batching | In all libraries | **core** |
| Lazy rescaling / lazy relinearization | Defer maintenance ops until forced; fewer NTTs | Standard practice | **core** (compiler pass) |
| Sylph PCMM for PC-attention (single plaintext copy, on-the-fly transform, BSGS) | Low-memory wide plaintext-ciphertext matmul for heterogeneous prompts | Published, no open impl | **planned** (M5) |
| Embedding lookup as one-level linear transform via client-side one-hot + block-diagonal packing (HE-LRM, arXiv 2506.18150) | 77× faster than encrypted-LUT embedding approaches; client computes one-hot before encrypting | Published | **planned** — composes with our client-side embedding stance |
| Static structured pruning as circuit skipping | Zero weight blocks never generate ops (weights plaintext) | Trivial given ternary PCMM | **core** |

## 4. Nonlinearity evaluation

| Technique | What it does / gain | Maturity | Status |
|---|---|---|---|
| Sigmoid attention (retraining-free) | Removes exp+division; ENSI demonstrated under HE | Published + code | **core** |
| Power-Softmax / Powerformer distilled replacements | Self-normalizing power functions; validated to 1.4B params | Published | **evaluate** as alternative to sigmoid attention |
| Minimax (Remez) polynomial approximations + Paterson–Stockmeyer evaluation | Optimal-degree approx, minimal nonscalar mults | Standard | **core** |
| Composite low-degree polynomials for GELU/tanh (THOR; pseudo-sign composites, Powerformer) | Depth-cheap accurate activations | Published | **core** |
| Goldschmidt / adaptive-iteration inverse & rsqrt (THOR) | RMSNorm and any division; 2.64× over prior softmax when needed | Published | **core** |
| Square-and-normalize exp range extension (THOR) | Handles wide softmax input ranges cheaply | Published | **evaluate** (only if softmax retained anywhere) |
| Domain-range control via outlier suppression (token prepending, orthogonal rotations — Sylph) | Lower-degree approximations everywhere | Published, retraining-free | **core** |
| Rotation-free softmax/LayerNorm (MOAI) | Removes 2448 rotations in BERT-base; 22×/151× microbench | Published + code | **core** (adapted to our norms) |
| TFHE LUT via scheme switching for exact sign/argmax | Exact nonpolynomial ops | Published | **evaluate** (escape hatch only) |

## 5. Model architecture & training

| Technique | What it does / gain | Maturity | Status |
|---|---|---|---|
| Fully ternary weights (BitNet/Bonsai class) | Enables §3 mult-free PCMM; 9–10× smaller plaintext weights | Open weights (MIT/Apache) | **core** |
| Distillation into FHE-friendly student | Absorbs polynomial substitutions; the master capability lever | Standard ML | **core** |
| GQA / MLA latent KV compression | Shrinks ciphertext KV (the real memory wall) 4–16× | Standard ML, unclaimed in FHE lit | **core** |
| Sliding-window attention + few global tokens | Bounds ct-ct attention & KV in context length | Standard ML | **core** |
| Multi-token prediction head (Medusa/EAGLE-style) | Raises speculative acceptance; static architecture | Standard ML | **core** |
| Quantization-aware training / activation-range regularization | Tightens polynomial domains; ternary QAT already required | Standard ML | **core** |
| Fixed-state backbone (SSM/linear attention) | Constant encrypted state: the 100k+ private-context answer; also makes per-block WAN refresh cheap | Research (HSSM: public-decay recurrences only) | **planned research** (M6) |
| MoE, early exit, dynamic sparsity, KV eviction | Data-dependent branching — impossible under FHE obliviousness | — | **rejected** |

## 6. GPU kernel & runtime

| Technique | What it does / gain | Maturity | Status |
|---|---|---|---|
| Kernel fusion into (i)NTT (rescale/ModDown/HMult/dot-product fusions — FIDESlib) | Fewer global-memory round trips; shipped in our base library | Open source | **core** |
| Limb batching | Amortizes CPU launch overhead across limbs | Shipped (FIDESlib) | **core** |
| CUDA Graphs end-to-end (Cerium, Theodosian) | FHE circuits are static/branchless: whole forward pass = one prebuilt graph | Published, straightforward | **core** |
| **Tensor-core NTT** (TensorFHE), + CUDA-core concurrency (WarpDrive) | NTT as matrix mults on TCUs; segment fusion for precision | Published | **evaluate** (M5 kernel work) |
| **FP64-TCU offload for BConv/inner product** (Neo, ISCA '25) | A100 TCU FP64 = 2× CUDA-core FP64; Neo beats TensorFHE 3.28× | Published | **evaluate** |
| L2-aware multi-polynomial caching + complementary pipelining (Theodosian) | Pairs DRAM-bound with L2-bound kernels; better effective bandwidth | Published 2025 | **planned** (M5) |
| Automated horizontal+vertical limb-IR fusion (Cerium compiler) | Systematic kernel generation; matches ASICs on GPUs | Published, code not released | **planned** — reimplement over our IR |
| FHE megakernel (persistent interpreter per SM, Hazy/MPK pattern) | Overlap NTT compute with key-switch key loads across op boundaries; unpublished for FHE | Our research bet | **planned research** (M6) |
| On-the-fly twiddle generation (Cheddar EOT) | Cuts twiddle-factor memory traffic in NTT | Published + code | **evaluate** |
| KLSS key-switching variant | Lower compute, but 1.21–1.58× more memory traffic (Neo analysis) — wrong trade for memory-bound GPUs | Published | **rejected** for GPU (revisit on ASIC) |

## 7. Memory & data movement

| Technique | What it does / gain | Maturity | Status |
|---|---|---|---|
| Paged ciphertext KV allocator (PagedAttention translated) | GPU/host/NVMe tiering of ciphertext blocks | Design | **core** (M5) |
| Level-trimmed KV cache ("ciphertext quantization") | Cached KV held at minimal modulus: proportional memory & compute savings | Implicit in Sylph | **core** |
| Weight-plaintext elimination via ternary | No plaintext weight polynomials at all — deletes the TB-scale footprint that forced multi-GPU | Ours (from ENSI PCMM) | **core** |
| Communication placement at minimum-modulus points (Sylph/Cerium) | Multi-GPU traffic only when ciphertexts are smallest | Published | **planned** (only if multi-GPU reinstated) |
| Compact eval-key working set (Grafting −62%; LCR/AKS −12–15% rotation keys; topology A drops bootstrap keys) | Smaller resident key footprint → more room for KV | Published | **planned** |

## 8. Serving & decode pipeline

| Technique | What it does / gain | Maturity | Status |
|---|---|---|---|
| Speculative decoding, client-side draft (POST-adapted) | 2.1–6.0× on sequential steps; verification amortizes in slots | Published (POST, ICML '25) | **core** |
| Batched verification = prefill-shaped work | Exploits FHE's extreme verify-vs-decode asymmetry | Ours | **core** |
| Same-key slot batching (interleaved) | Amortize within one tenant's concurrent requests | Published (MOAI) | **planned** |
| Prefill/decode disaggregation | Different kernel mixes; scheduling policy | Plaintext transfer | **planned** |
| Heterogeneous public/private prompts (Sylph PC-attention) | Long public context in plaintext; linear scaling | Published | **core** |
| Client-side retrieval/curation before encryption | Converts long-private into short-private at zero crypto cost | Ours | **core** |
| Same-key encrypted prompt/prefix caching | Reuse encrypted KV of a session's stable prefix across requests (same key: legal) | Ours, unexplored | **evaluate** — could amortize prefill across a session |
| Fixed-shape execution, padded blocks, quantized output lengths | Side-channel hygiene (SECRETS-class) | Design | **core** |

## 9. Communication & key logistics

| Technique | What it does / gain | Maturity | Status |
|---|---|---|---|
| Seed compression of fresh ciphertexts (send PRG seed for `a`) | Uplink ciphertexts ~halve: λ + N·log q vs 2N·log q | Standard | **core** |
| Modulus-switch / level-drop before transmission | Transmit at minimal modulus; big downlink savings | Standard | **core** |
| ℓ-truncation of low bits (eprint 2024/1921) | Drop noise-level bits pre-transmission | Published | **evaluate** |
| LWE extraction + additive-HE re-encryption of responses (90–99% compression) | Downlink logits shrink dramatically; costs server modular exponentiations | Published (arXiv 2303.09043) | **evaluate** for WAN topology B; likely unneeded intra-region |
| Content-addressed key bundles, cached per (client, model-release) | One-time cold-start; rotation invalidates | Design | **core** |
| Grafting key-size reduction (−62%) | Direct cold-start improvement | Published | **planned** |

## 10. Hardware horizon (watch list)

| Technology | Relevance | Status |
|---|---|---|
| FHE ASICs (CraterLake, ARK, Cinnamon lineage; Fabric, Optalysys) | 10–100× over GPUs if commercialized; Cerium shows GPUs already match CraterLake | **watch**; backend swappable by design |
| PIM / near-memory (Anaheim GPU+PIM HPCA '25, FHENDI 118× over GPU, FHEmem, UPMEM studies) | FHE's element-wise ops are DRAM-bandwidth-bound — PIM attacks the true bottleneck; real-hardware results still constrained (no native 64-bit modmul) | **watch**; 32-bit RNS (Cheddar) would map better to PIM too |
| HBM4 / bandwidth scaling | FHE is bandwidth-bound: generational memory improvements accrue ~directly | passive tailwind |
| Apple Silicon / Metal port (via Cheddar 32-bit design) | Only if a product reason emerges for Mac-resident servers; ZK-Metal precedents show ~2–2.6× over CPU — modest | **watch** |

## 11. Top-10 priority stack (impact × readiness)

1. Ternary mult-free PCMM + column packing (core; M2)
2. Client-aided refresh, leveled-only server — gated on flooding analysis,
   now informed by 80-bit Discrete-CKKS bootstrapping results (M2 review)
3. Speculative decoding with client draft + batched verification (M4)
4. Heterogeneous prompts + client-side curation (M5, product-defining)
5. CUDA Graphs + existing FIDESlib fusions (M0–M1, nearly free)
6. Outlier suppression + minimax approximation pipeline (M2–M3)
7. Grafting + LCR/AKS: bootstrap throughput and key-size wins (M3+)
8. MLA/GQA + sliding windows + level-trimmed paged KV (M3–M5)
9. Tensor-core NTT / FP64-TCU offload (Neo/WarpDrive class; M5)
10. Megakernel + SSM backbone (M6 research bets)

Cross-cutting rule: every optimization must preserve (a) circuit obliviousness,
(b) the masking rule for anything routed through the key, (c) fixed-shape
traffic, and (d) the precision telemetry contract (§9 of the design spec).

## 12. Additional references (beyond design-spec list)

Grafting (eprint 2024/1014, CCS '25) · Discrete-CKKS high-precision
bootstrapping (eprint 2025/1786) · Level-conserving rescaling + AKS (eprint
2025/1403, PKC '26) · Generalized composites bootstrapping (eprint 2025/429)
· Triple-hoisted BSGS (arXiv 2605.17222) · TensorFHE (arXiv 2212.14191) ·
Neo (ISCA '25) · WarpDrive · Theodosian (arXiv 2512.18345) · HEAP
scheme-switched bootstrapping (ISCA '24) · LOHEN layer-wise scheme selection
(USENIX Sec '25) · PEGASUS/CHIMERA scheme switching · FHE ciphertext
compression via additive HE (arXiv 2303.09043) · downlink TFHE compression
(eprint 2024/1921) · HE-LRM embedding packing (arXiv 2506.18150) · PIM line:
Anaheim (HPCA '25), FHENDI (HPCA '25), FHEmem (IEEE TETC '25), HE-PIM (arXiv
2605.12841).
