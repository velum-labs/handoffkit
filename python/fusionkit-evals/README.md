# fusionkit-evals

Evaluation and Pareto analysis helpers for FusionKit.

This package owns the canonical `fusionkit-bench` Typer app, benchmark runners,
tiny fixtures, public-benchmark tooling, prompt tuning, score analysis, and the
FusionKit HyperKit plugin. It depends on `fusionkit-core`, not the internal
`fusionkit` sidecar distribution.

Most users should start with `@fusionkit/cli`; install evaluation extras only when running benchmarks.

```sh
uv run --package fusionkit-evals fusionkit-bench --help
```

Docs: https://fusionkit.velum-labs.com
Repository: https://github.com/velum-labs/handoffkit
