# Hyperkit AWS platform

This directory is a production-oriented Terraform scaffold for running Hyperkit
shards on AWS Batch Spot capacity while keeping metrics and Grafana available
on an always-on ECS Fargate service and continuously aggregating completed
hypergrid cells with a separate Fargate controller.

## Architecture

- `network`: one VPC with public and private subnets in two availability zones,
  one NAT gateway per AZ by default, a no-ingress Batch security group, and
  no-ingress controller security group, plus security-group-to-security-group
  rules for Grafana and OTLP.
- `storage`: a private, encrypted, versioned S3 artifact lake and a Glue
  `shard_results` table over `runs/<sweep_id>/results/*.json`. Partition
  projection avoids Glue partition crawlers; Athena queries must constrain
  `sweep_id`.
- `registry`: immutable, scan-on-push ECR repositories for the runner,
  controller, and provisioned Grafana image, with untagged and image-count
  lifecycle rules.
- `secrets`: empty Secrets Manager containers plus separate Batch job and EC2
  instance roles. Terraform never creates a secret version or accepts a secret
  value.
- `batch`: a scale-to-zero managed EC2 Spot compute environment, memory-rich
  `r7i`/`m7i` choices, a 500 GiB or larger encrypted gp3 root/cache volume, a
  queue, and a privileged runner definition with the host Docker socket.
- `observability`: Amazon Managed Service for Prometheus (AMP), an Athena
  workgroup, X-Ray trace export, and a Grafana + ADOT task on Fargate behind a
  CIDR-restricted public ALB. Cloud Map gives runners a private OTLP endpoint.
- `controller`: an encrypted SQS queue and DLQ fed by S3 result notifications,
  plus a one-task-by-default Fargate service on the observability ECS cluster.
  It reads run artifacts through a least-privilege task role and sends OTLP to
  ADOT over the VPC.

The root also creates a monthly AWS Cost Budget. It intentionally does not
configure a Terraform backend; use the organization's encrypted, locked remote
state backend rather than committing local state.

## Prerequisites

- Terraform 1.6 or newer
- AWS CLI credentials able to manage VPC, IAM, Batch, ECS, ECR, AMP, Athena,
  Glue, S3, SQS, Secrets Manager, CloudWatch, X-Ray, ALB, Service Discovery,
  and Budgets resources
- Docker with BuildKit
- An ACM certificate in the selected region for production HTTPS
- Trusted office or VPN egress CIDRs for Grafana

Copy and edit the example:

```sh
cd infra/hyperkit
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform fmt -recursive
terraform validate
terraform plan -out=tfplan
```

Review IAM and all replacement actions before applying. The example certificate
ARN and documentation-only CIDR must be replaced.

## Bootstrap images and secrets

ECR repositories and empty secret containers must exist before images are
pushed and secret values are populated. The initial targeted apply is a
bootstrap only; use normal full plans thereafter:

```sh
terraform apply -target=module.registry -target=module.secrets

REGISTRY="$(terraform output -raw runner_repository_url | cut -d/ -f1)"
aws ecr get-login-password --region "$(aws configure get region)" \
  | docker login --username AWS --password-stdin "$REGISTRY"

TAG="$(git rev-parse --short=12 HEAD)"
RUNNER_REPO="$(terraform output -raw runner_repository_url)"
CONTROLLER_REPO="$(terraform output -raw controller_repository_url)"
GRAFANA_REPO="$(terraform output -raw grafana_repository_url)"

docker build -f ../../docker/hyperkit-runner/Dockerfile \
  -t "$RUNNER_REPO:$TAG" ../..
docker push "$RUNNER_REPO:$TAG"

docker build -f ../../docker/hyperkit-controller/Dockerfile \
  -t "$CONTROLLER_REPO:$TAG" ../..
docker push "$CONTROLLER_REPO:$TAG"

docker build -f grafana/Dockerfile -t "$GRAFANA_REPO:$TAG" grafana
docker push "$GRAFANA_REPO:$TAG"
```

Set `runner_image_tag`, `controller_image_tag`, and `grafana_image_tag` to that
immutable tag. ECR rejects reusing a tag by design.

Populate each secret outside Terraform. Prefer a protected temporary file or
stdin so the value does not enter shell history:

```sh
aws secretsmanager put-secret-value \
  --secret-id hyperkit/production/grafana-admin-password \
  --secret-string file:///secure/path/grafana-admin-password
aws secretsmanager put-secret-value \
  --secret-id hyperkit/production/openai-api-key \
  --secret-string file:///secure/path/openai-api-key
```

`runner_managed_secret_environment` and
`controller_managed_secret_environment` map environment names to containers
this stack creates. Their `*_external_secret_environment` counterparts map
environment names to existing secret ARNs. Task definitions contain only ARNs;
the ECS agent resolves values at start. `secret_names` creates additional
runner-readable empty containers without injecting them as environment
variables.

Run a fresh full plan after bootstrap:

```sh
terraform plan -out=tfplan
terraform apply tfplan
```

The Grafana ECS service cannot become healthy until its image exists and the
admin-password secret has a current version. The controller service also needs
its image before the full apply, and the runner image must exist before jobs
are submitted.

## Submit jobs and reserve memory

The default job reserves 2 vCPU and 8192 MiB. AWS Batch uses both reservations
to select an instance and avoid scheduling more reserved memory than that host
can provide. Override both per submitted shard when the workload is larger:

```sh
aws batch submit-job \
  --job-name hyperkit-shard \
  --job-queue "$(terraform output -raw batch_job_queue_name)" \
  --job-definition "$(terraform output -raw batch_job_definition_arn)" \
  --container-overrides '{"resourceRequirements":[{"type":"VCPU","value":"8"},{"type":"MEMORY","value":"65536"}]}'
```

Reserve the peak memory of the runner **plus every sibling container** it will
start. Because sibling Docker containers are launched through the host daemon,
their usage is not reliably charged to the runner container's cgroup. The
reservation protects fleet placement only when it reflects that total; set
explicit `--memory` limits on sibling `docker run` calls as a second guard.
Undersized reservations can still cause host OOM termination.

Spot host termination retries up to three attempts through `evaluateOnExit`.
Application errors exit immediately. Checkpoints in S3 must make attempts
idempotent.

The host socket grants host-equivalent privileges. The worker security group has
no ingress, the fleet is dedicated to this queue, IMDSv2 is required, disks are
encrypted and deleted with instances, and no untrusted tenant should share the
compute environment.

## Live controller and resumability

Each successful object creation under `runs/` with a `.json` suffix sends an
event to the encrypted controller SQS queue. S3 notification filters cannot
express the variable `runs/<sweep_id>/results/` middle segment, so the
controller rejects unrelated JSON keys and optionally restricts work with
`controller_sweep_id`. The Fargate task receives:

- `HYPERKIT_S3_BUCKET` and `HYPERKIT_S3_PREFIX`
- optional `HYPERKIT_SWEEP_ID`
- `HYPERKIT_SQS_QUEUE_URL`
- `HYPERKIT_POLL_INTERVAL`
- `OTEL_EXPORTER_OTLP_ENDPOINT`

The queue provides durable wake-ups while periodic S3 polling reconciles source
of truth after restarts, deployment gaps, duplicate deliveries, or missed
notifications. Keep writes idempotent: S3 notifications and SQS are
at-least-once. A message returned five times moves to the encrypted DLQ for
inspection rather than blocking newer cells. The controller task role can only
list and read the configured run prefix and consume the primary queue; it
cannot mutate artifacts or purge the queue.

The default `controller_desired_count = 1` keeps one aggregator alive off the
Spot fleet. Set it to zero for a planned pause without deleting queue state.
After publishing a controller image and applying its immutable tag, deploy and
wait with:

```sh
aws ecs update-service \
  --cluster "$(terraform output -raw observability_ecs_cluster_name)" \
  --service "$(terraform output -raw controller_ecs_service_name)" \
  --force-new-deployment
aws ecs wait services-stable \
  --cluster "$(terraform output -raw observability_ecs_cluster_name)" \
  --services "$(terraform output -raw controller_ecs_service_name)"
aws logs tail "/aws/hyperkit/${PROJECT_NAME:-hyperkit}-${ENVIRONMENT:-production}/controller" \
  --follow
```

Controller metrics and traces use the private ADOT HTTP endpoint and flow to AMP
and X-Ray. Container stdout/stderr goes to its dedicated CloudWatch log group.
CloudWatch also exposes the native SQS queue age, visible-message count, receive
count, and DLQ depth; use those signals to detect aggregation lag and poison
messages. The queue URL and ARN are available as
`controller_results_queue_url` and `controller_results_queue_arn`.

## Observability

The custom Grafana image installs the Athena and X-Ray plugins and bakes in:

- `Sweep Live`: completed/error shard counts, latency, and resolution rate.
- `Fleet`: shard throughput/outcomes and ADOT receive/export health.
- `Fusion Internal`: fusion-versus-solo resolution, outcomes, latency, and cost.

The provisioned data sources use the Fargate task role:

- **AMP / Prometheus** receives OTLP metrics through ADOT at
  `http://adot.<project>-<environment>.local:4318` and retains live time series.
  The Batch job definition sets this endpoint automatically.
- **CloudWatch** reads native Batch metrics, ECS Container Insights, and
  application log groups.
- **Athena** queries normalized `ShardResult` JSON in S3 through the enforced
  workgroup and Glue schema. Its query results are encrypted into
  `s3://<artifact-bucket>/athena-results/`.
- **X-Ray** receives OTLP traces from ADOT and supplies trace/service-map views.

Dashboard PromQL is limited to the five instruments emitted by
`hyperkit.telemetry` and ADOT's `otelcol_*` self-metrics. The remote-write
translation strategy is pinned so dotted OTel names and counter/unit suffixes
remain stable (`hyperkit.shards.completed` becomes
`hyperkit_shards_completed_total`, for example). Dashboard queries never use
`or vector(0)`, so missing telemetry remains visible instead of looking healthy.

### Local dashboard validation

The local compose stack replaces only the provisioned `amp` datasource with a
seeded, unauthenticated Prometheus instance. The dashboard files and Grafana
image are the production files; AWS provisioning remains unchanged.

```sh
docker compose -f infra/hyperkit/grafana/compose.yaml up --build -d --wait
python3 scripts/validate_hyperkit_dashboards.py
```

Open `http://127.0.0.1:13000` and select the Hyperkit folder. Localhost-only
anonymous Viewer access is enabled for this disposable stack, and every panel
has seeded data.
The validator fails on datasource errors, PromQL errors, unsupported metric
names, missing dashboards, and empty query results. Stop the local stack with:

```sh
docker compose -f infra/hyperkit/grafana/compose.yaml down -v
```

Production Grafana explicitly enables SigV4 and uses the ECS task role for AMP,
CloudWatch, Athena, and X-Ray. After publishing a new Grafana image and applying
Terraform, restart and wait for the observability service with:

```sh
aws ecs update-service \
  --cluster "$(terraform output -raw observability_ecs_cluster_name)" \
  --service "$(terraform output -raw observability_ecs_service_name)" \
  --force-new-deployment
aws ecs wait services-stable \
  --cluster "$(terraform output -raw observability_ecs_cluster_name)" \
  --services "$(terraform output -raw observability_ecs_service_name)"
python3 ../../scripts/validate_hyperkit_dashboards.py \
  --grafana-url "$(terraform output -raw grafana_url)" \
  --password "$GRAFANA_ADMIN_PASSWORD" \
  --allow-empty
```

`--allow-empty` still fails datasource and PromQL errors; it only permits an
idle production workspace with no recent shard samples.

`grafana_allowed_cidrs` defaults to empty, so the ALB has no ingress. Use only
trusted `/32` or VPN ranges. Set `grafana_certificate_arn` for HTTPS; HTTP mode
exists for isolated evaluation only because credentials would otherwise cross
the network in plaintext. Grafana self-signup and anonymous access are disabled.
For broader access, put an identity-aware proxy in front of the ALB rather than
opening `0.0.0.0/0`.

ALB deletion protection is enabled. Disable it deliberately in the resource and
apply that change before destroying the stack.

## Cost controls

The largest always-on charges are two NAT gateways, the ALB, the observability
and controller Fargate tasks, and AMP ingestion/storage. Set
`single_nat_gateway = true` only when accepting a cross-AZ egress dependency.
Batch EC2 and its 500+ GiB gp3 volumes disappear at zero jobs because
`min_vcpus = 0`; Spot instances, EBS, model-provider calls, CloudWatch logs,
X-Ray traces, Athena scans, S3, SQS, ECR, and data transfer remain usage-based
costs. S3 aborts incomplete multipart uploads after seven days and expires
noncurrent versions after the configured retention period.

The budget sends actual and forecast notifications when
`budget_alert_email` is set. AWS Budgets alerts do not stop workloads; enforce
run-level spend ceilings in Hyperkit as well.

## Registry cache policy

No ECR pull-through cache rule is created. Safe setup depends on the chosen
upstream registry, account-level repository-creation templates, and (for some
registries) a Secrets Manager credential ARN. Encoding a default would either
create an unused public mirror or broaden secret access. Add
`aws_ecr_pull_through_cache_rule` in the registry module only after selecting
the upstream namespace and pinning its credential and repository policy.
