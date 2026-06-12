# Pending patch for velum-labs/mlx-lm

All structured-decoding code now lives in the
[velum-labs/mlx-lm](https://github.com/velum-labs/mlx-lm) fork (branch
`structured-0.31.3`); this repo only pins it. The patch here is the next
commit for that branch — it moves the constraint machinery into the fork as
`mlx_lm.structured` with a `[structured]` extra, making the fork fully
self-contained (the previously published commit on the branch only added the
server hooks and expected a separate `mlx-lm-structured` package, which has
been removed from this repo).

The automation that produced it has no push access to the fork. To publish:

```sh
git clone git@github.com:velum-labs/mlx-lm.git && cd mlx-lm
git checkout structured-0.31.3
git am <handoffkit>/patches/mlx-lm/*.patch
git push origin structured-0.31.3
```

Then delete this directory, and consider tightening `MLX_LM_STRUCTURED_PIN`
in `packages/adapter-ai-sdk/src/mlx-env.ts` from the branch ref to
`git rev-parse structured-0.31.3` for exact reproducibility.

Until the patch is pushed, `mlxServer({ structured: true })` provisions the
hooks-only revision of the branch, which warns about — and cannot enforce —
structured output without the (now removed) companion package.
