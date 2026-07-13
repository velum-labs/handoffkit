# hyperkit-controller image

Container image for the hyperkit cloud controller (`python -m hyperkit.cloud.controller`), the always-on Fargate aggregator that consumes S3 result notifications from the encrypted SQS queue and continuously aggregates completed hypergrid cells. The image is `python:3.12-slim-bookworm` with `uv`-installed `python/hyperkit[aws]`, running as a non-root user.

Build it from the repository root and push it to the controller ECR repository created by the Terraform stack:

```sh
docker build -f docker/hyperkit-controller/Dockerfile -t "$CONTROLLER_REPO:$TAG" .
docker push "$CONTROLLER_REPO:$TAG"
```

See [../../infra/hyperkit/README.md](../../infra/hyperkit/README.md) for the full bootstrap sequence, the environment variables the controller task receives, and deployment/rollout commands.
