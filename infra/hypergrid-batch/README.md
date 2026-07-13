# hypergrid-batch

Fargate Spot AWS Batch deploy for hypergrid sweeps. `deploy.py` provisions everything hyperkit's `aws-batch` backend needs to run LiveCodeBench sweeps in the cloud with no instance management: an ECR repository and runner image (`docker/hyperkit-runner/Dockerfile`), an S3 bucket with a `runs/` result lake and an `lcb-store/` problem store (runners fetch problems lazily via `HYPERKIT_LCB_S3_URI`), a Secrets Manager secret for `OPENROUTER_API_KEY` (read from this process's environment at create time only, never printed), IAM execution/job roles (optionally under a permissions boundary), and a managed FARGATE_SPOT compute environment, queue, and job definition (2 vCPU / 4 GB default, 3 retry attempts, 1 h timeout).

The script is idempotent — it reuses existing resources by name — and finishes by printing the three env vars the hyperkit backend consumes: `HYPERKIT_AWS_BUCKET`, `HYPERKIT_AWS_BATCH_JOB_QUEUE`, and `HYPERKIT_AWS_BATCH_JOB_DEFINITION`.

## Usage

```sh
uv run --with boto3 python infra/hypergrid-batch/deploy.py \
  [--iam-permissions-boundary-arn ARN] [--skip-image] [--skip-store-upload]
```

For the full production-oriented Terraform stack (EC2 Spot Batch, Grafana, controller), see [../hyperkit/README.md](../hyperkit/README.md).
