# velum-labs/mlx-lm fork patch series

The structured-decoding server hooks live in the
[velum-labs/mlx-lm](https://github.com/velum-labs/mlx-lm) fork as the
`structured-0.31.3` branch: upstream tag `v0.31.3` plus the patch series in
this directory (currently one commit, ~65 lines in `mlx_lm/server.py` and a
`+structured` version marker).

This directory exists because the automation that produced the series did
not have push access to the fork. Once the branch is pushed, this directory
can be deleted — the fork is then the source of truth and
`MLX_LM_STRUCTURED_PIN` in `packages/adapter-ai-sdk/src/mlx-env.ts` resolves.

## Publishing the branch

```sh
git clone git@github.com:velum-labs/mlx-lm.git && cd mlx-lm
git remote add upstream https://github.com/ml-explore/mlx-lm.git
git fetch upstream tag v0.31.3
git checkout -b structured-0.31.3 v0.31.3
git am <handoffkit>/python/mlx-lm-structured/fork/*.patch
git push -u origin structured-0.31.3
```

After pushing, consider tightening `MLX_LM_STRUCTURED_PIN` from the branch
ref to the commit SHA (`git rev-parse structured-0.31.3`) so provisioned
environments are exactly reproducible.

## Adopting a newer upstream mlx-lm

Branch `structured-<tag>` from the new tag, `git am` (or cherry-pick) the
series, resolve drift in `mlx_lm/server.py` (the hooks touch request
parsing, `LogitsProcessorArguments`, and `_make_logits_processors`), run
`tests/test_fork_server.py` from this package against the result, and update
the pin.
