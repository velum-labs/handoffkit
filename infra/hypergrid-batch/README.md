# hypergrid-batch

Fargate Spot AWS Batch deploy for hypergrid sweeps. `deploy.py` provisions everything hyperkit's `aws-batch` backend needs to run LiveCodeBench sweeps in the cloud with no instance management: an immutable, commit-tagged ECR runner image pinned by digest in the Batch definition (`docker/hyperkit-runner/Dockerfile`), a versioned S3 bucket with a `runs/` result lake and an `lcb-store/` problem store (runners fetch problems lazily via `HYPERKIT_LCB_S3_URI`), a Secrets Manager secret for `OPENROUTER_API_KEY` (read from this process's environment at create time only, never printed), IAM execution/job roles (optionally under a permissions boundary), and a managed FARGATE_SPOT compute environment, queue, and job definition (2 vCPU / 4 GB default, 3 retry attempts, 1 h timeout).

The script refuses a dirty Git worktree, builds the image itself from the current commit, and is idempotent by commit tag. It finishes by printing the Batch environment variables; preserve `HYPERKIT_RUNNER_IMAGE_DIGEST` while planning and applying so the lock, shard IDs, manifests, and runner all bind to the same image.

## Usage

```sh
uv run --with boto3 python infra/hypergrid-batch/deploy.py \
  [--iam-permissions-boundary-arn ARN] [--skip-image] [--skip-store-upload]
```

For the full production-oriented Terraform stack (EC2 Spot Batch, Grafana, controller), see [../hyperkit/README.md](../hyperkit/README.md).
