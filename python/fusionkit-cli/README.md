# fusionkit-sidecar (PyPI package `fusionkit`)

PyPI `fusionkit` contains the internal synthesis sidecar driven by the npm
`@fusionkit/cli` front door.

The Python package installs only `fusionkit-sidecar`; it deliberately does not
install a `fusionkit` binary. The user-facing `fusionkit` command belongs to
the Node package. The Node CLI provisions the sidecar automatically.

Maintainer benchmark commands are published separately as `fusionkit-bench`
by `fusionkit-evals`.

Docs: https://fusionkit.velum-labs.com
Repository: https://github.com/velum-labs/handoffkit
