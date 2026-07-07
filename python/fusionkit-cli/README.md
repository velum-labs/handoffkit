# fusionkit (PyPI)

PyPI `fusionkit` is the Python router and fusion engine driven by the npm `@fusionkit/cli` front door.

Both distributions install a `fusionkit` binary: npm owns the user-facing harness orchestration, while `uvx fusionkit` exposes the raw Python engine and maintainer commands. The Node CLI provisions this package automatically for normal users.

Most users should install `@fusionkit/cli` and let it manage the Python engine. Use this package directly for `fusionkit serve -c config.yaml` or Python-side benchmark workflows.

Docs: https://fusionkit.velum-labs.com
Repository: https://github.com/velum-labs/handoffkit
