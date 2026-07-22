"""Deploy the hypergrid AWS Batch compute substrate (Fargate Spot).

Everything hyperkit's ``aws-batch`` backend needs to run LiveCodeBench sweeps
in the cloud, with no instance management:

- ECR repository + runner image (``docker/hyperkit-runner/Dockerfile``),
- S3 bucket: ``runs/`` result lake + ``lcb-store/`` problem files (uploaded
  from the local store; runners fetch problems lazily via
  ``HYPERKIT_LCB_S3_URI``),
- Secrets Manager secret for ``OPENROUTER_API_KEY`` (value read from this
  process's environment at create time only; never printed),
- IAM execution/job roles (optionally under a permissions boundary),
- Batch managed FARGATE_SPOT compute environment, queue, and job definition
  (2 vCPU / 4 GB default, 3 retry attempts, 1 h timeout).

Idempotent: reuses existing resources by name. Prints the three env vars the
hyperkit backend consumes.

Usage:
  uv run --with boto3 python infra/hypergrid-batch/deploy.py \
    [--iam-permissions-boundary-arn ARN] [--skip-image] [--skip-store-upload]
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import json
import os
import subprocess
import time
from pathlib import Path

import boto3

NAME = "hypergrid-batch"
REPO_NAME = "hypergrid-runner"
DEFAULT_BOUNDARY = "arn:aws:iam::052777341990:policy/cursor-agent-boundary"
LCB_LOCAL_STORE = Path(
    os.environ.get(
        "HYPERKIT_LCB_DIR", str(Path.home() / ".cache" / "hyperkit" / "livecodebench")
    )
)

ECS_TRUST = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {"Service": "ecs-tasks.amazonaws.com"},
            "Action": "sts:AssumeRole",
        }
    ],
}


def _ensure_role(iam, name: str, policy_doc: dict, *, boundary: str | None,
                 managed_arns: list[str]) -> str:
    options: dict = {
        "RoleName": name,
        "AssumeRolePolicyDocument": json.dumps(ECS_TRUST),
        "Tags": [{"Key": "project", "Value": "hypergrid-hillclimb"}],
    }
    if boundary:
        options["PermissionsBoundary"] = boundary
    with contextlib.suppress(iam.exceptions.EntityAlreadyExistsException):
        iam.create_role(**options)
    for arn in managed_arns:
        iam.attach_role_policy(RoleName=name, PolicyArn=arn)
    if policy_doc.get("Statement"):
        iam.put_role_policy(
            RoleName=name, PolicyName=f"{name}-inline", PolicyDocument=json.dumps(policy_doc)
        )
    return iam.get_role(RoleName=name)["Role"]["Arn"]


def _ensure_secret(sm, name: str, env_var: str) -> str:
    try:
        return sm.describe_secret(SecretId=name)["ARN"]
    except sm.exceptions.ResourceNotFoundException:
        pass
    value = os.environ.get(env_var)
    if not value:
        raise RuntimeError(f"{env_var} must be set to create secret {name}")
    return sm.create_secret(
        Name=name,
        SecretString=value,
        Tags=[{"Key": "project", "Value": "hypergrid-hillclimb"}],
    )["ARN"]


def _ensure_bucket(s3, bucket: str, region: str) -> None:
    try:
        if region == "us-east-1":
            s3.create_bucket(Bucket=bucket)
        else:  # pragma: no cover - region-specific API shape
            s3.create_bucket(
                Bucket=bucket, CreateBucketConfiguration={"LocationConstraint": region}
            )
    except s3.exceptions.BucketAlreadyOwnedByYou:
        pass


def _upload_store(s3, bucket: str) -> int:
    existing: set[str] = set()
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix="lcb-store/"):
        existing.update(obj["Key"] for obj in page.get("Contents", []))
    uploaded = 0
    for path in sorted(LCB_LOCAL_STORE.glob("*.json")):
        key = f"lcb-store/{path.name}"
        if key in existing:
            continue
        s3.upload_file(str(path), bucket, key)
        uploaded += 1
    return uploaded


def _ensure_image(region: str, account: str) -> str:
    ecr = boto3.client("ecr")
    with contextlib.suppress(ecr.exceptions.RepositoryAlreadyExistsException):
        ecr.create_repository(
            repositoryName=REPO_NAME,
            imageScanningConfiguration={"scanOnPush": True},
        )
    registry = f"{account}.dkr.ecr.{region}.amazonaws.com"
    image = f"{registry}/{REPO_NAME}:latest"
    auth = ecr.get_authorization_token()["authorizationData"][0]
    user_pass = base64.b64decode(auth["authorizationToken"]).decode()
    password = user_pass.split(":", 1)[1]
    subprocess.run(
        ["sudo", "docker", "login", "--username", "AWS", "--password-stdin", registry],
        input=password, text=True, check=True, capture_output=True,
    )
    subprocess.run(
        ["sudo", "docker", "tag", "hypergrid-runner:local", image], check=True
    )
    subprocess.run(["sudo", "docker", "push", image], check=True)
    return image


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iam-permissions-boundary-arn", default=DEFAULT_BOUNDARY)
    parser.add_argument("--no-boundary", action="store_true")
    parser.add_argument("--skip-image", action="store_true")
    parser.add_argument("--skip-store-upload", action="store_true")
    parser.add_argument("--max-vcpus", type=int, default=128)
    args = parser.parse_args()
    boundary = None if args.no_boundary else args.iam_permissions_boundary_arn

    session = boto3.Session()
    region = session.region_name or "us-east-1"
    account = session.client("sts").get_caller_identity()["Account"]
    s3 = session.client("s3")
    iam = session.client("iam")
    sm = session.client("secretsmanager")
    ec2 = session.client("ec2")
    batch = session.client("batch")

    bucket = f"{NAME}-{account}-{region}"
    _ensure_bucket(s3, bucket, region)
    if not args.skip_store_upload:
        uploaded = _upload_store(s3, bucket)
        print(f"problem store: uploaded {uploaded} new files to s3://{bucket}/lcb-store/")

    secret_arn = _ensure_secret(sm, f"{NAME}/openrouter-api-key", "OPENROUTER_API_KEY")

    image = (
        f"{account}.dkr.ecr.{region}.amazonaws.com/{REPO_NAME}:latest"
        if args.skip_image
        else _ensure_image(region, account)
    )
    print(f"runner image: {image}")

    exec_role = _ensure_role(
        iam,
        f"{NAME}-exec-role",
        {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Action": ["secretsmanager:GetSecretValue"],
                    "Resource": [secret_arn],
                }
            ],
        },
        boundary=boundary,
        managed_arns=[
            "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
        ],
    )
    job_role = _ensure_role(
        iam,
        f"{NAME}-job-role",
        {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Action": ["s3:GetObject", "s3:PutObject"],
                    "Resource": [f"arn:aws:s3:::{bucket}/*"],
                },
                {
                    "Effect": "Allow",
                    "Action": ["s3:ListBucket"],
                    "Resource": [f"arn:aws:s3:::{bucket}"],
                },
            ],
        },
        boundary=boundary,
        managed_arns=[],
    )
    time.sleep(5)  # IAM propagation before Batch validates the roles

    vpc = ec2.describe_vpcs(Filters=[{"Name": "isDefault", "Values": ["true"]}])["Vpcs"][0]
    subnets = [
        s["SubnetId"]
        for s in ec2.describe_subnets(
            Filters=[{"Name": "vpc-id", "Values": [vpc["VpcId"]]}]
        )["Subnets"]
    ]
    default_sg = ec2.describe_security_groups(
        Filters=[
            {"Name": "vpc-id", "Values": [vpc["VpcId"]]},
            {"Name": "group-name", "Values": ["default"]},
        ]
    )["SecurityGroups"][0]["GroupId"]

    ce_name = f"{NAME}-ce"
    existing_ce = batch.describe_compute_environments(computeEnvironments=[ce_name])[
        "computeEnvironments"
    ]
    if not existing_ce:
        batch.create_compute_environment(
            computeEnvironmentName=ce_name,
            type="MANAGED",
            state="ENABLED",
            computeResources={
                "type": "FARGATE_SPOT",
                "maxvCpus": args.max_vcpus,
                "subnets": subnets,
                "securityGroupIds": [default_sg],
            },
        )
        for _ in range(30):
            ce = batch.describe_compute_environments(computeEnvironments=[ce_name])[
                "computeEnvironments"
            ][0]
            if ce["status"] == "VALID":
                break
            time.sleep(5)

    queue_name = f"{NAME}-queue"
    if not batch.describe_job_queues(jobQueues=[queue_name])["jobQueues"]:
        batch.create_job_queue(
            jobQueueName=queue_name,
            state="ENABLED",
            priority=1,
            computeEnvironmentOrder=[{"order": 1, "computeEnvironment": ce_name}],
        )
        for _ in range(30):
            queue = batch.describe_job_queues(jobQueues=[queue_name])["jobQueues"][0]
            if queue["status"] == "VALID":
                break
            time.sleep(5)

    jobdef = batch.register_job_definition(
        jobDefinitionName=f"{NAME}-runner",
        type="container",
        platformCapabilities=["FARGATE"],
        retryStrategy={"attempts": 3},
        timeout={"attemptDurationSeconds": 3600},
        containerProperties={
            "image": image,
            "executionRoleArn": exec_role,
            "jobRoleArn": job_role,
            "resourceRequirements": [
                {"type": "VCPU", "value": "2"},
                {"type": "MEMORY", "value": "4096"},
            ],
            "fargatePlatformConfiguration": {"platformVersion": "LATEST"},
            "networkConfiguration": {"assignPublicIp": "ENABLED"},
            "environment": [
                {"name": "HYPERKIT_LCB_S3_URI", "value": f"s3://{bucket}/lcb-store"},
                {"name": "HYPERKIT_LCB_DIR", "value": "/tmp/lcb-store"},
                {"name": "HYPERKIT_WORK_ROOT", "value": "/tmp/hyperkit"},
            ],
            "secrets": [
                {"name": "OPENROUTER_API_KEY", "valueFrom": secret_arn},
            ],
        },
    )
    print("job definition:", jobdef["jobDefinitionName"], "rev", jobdef["revision"])
    print()
    print("export these for the hyperkit aws-batch backend:")
    print(f"export HYPERKIT_AWS_BUCKET={bucket}")
    print(f"export HYPERKIT_AWS_BATCH_JOB_QUEUE={queue_name}")
    definition = f"{jobdef['jobDefinitionName']}:{jobdef['revision']}"
    print(f"export HYPERKIT_AWS_BATCH_JOB_DEFINITION={definition}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
