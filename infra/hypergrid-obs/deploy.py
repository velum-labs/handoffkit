"""Deploy the hypergrid observability stack (Prometheus + Grafana) to EC2.

Single small instance, docker-compose managed, independent of any local
process. External Prometheus access (OTLP ingest + query API) goes through a
basic-auth nginx proxy; Grafana is public read-only (anonymous Viewer).

Secret handling -- this process never holds any secret value:
- The Prometheus password is generated directly into SSM Parameter Store as a
  SecureString (``/hypergrid-obs/prom-password``) the first time it is needed,
  written by AWS on the service side.
- The INSTANCE fetches it at boot through its IAM instance profile and builds
  the nginx htpasswd hash locally; the deploy bundle carries no credential
  material at all.
- The Grafana admin password is generated on the instance and never leaves it
  (anonymous Viewer is the intended access path).

Consumers (the sweep's OTLP env) read the password themselves:

  aws ssm get-parameter --name /hypergrid-obs/prom-password \
    --with-decryption --query Parameter.Value --output text

Idempotent: an existing instance tagged Name=hypergrid-obs is reused.

Usage: uv run --with boto3 python infra/hypergrid-obs/deploy.py
"""

from __future__ import annotations

import base64
import contextlib
import io
import json
import shutil
import tarfile
import tempfile
import time
from pathlib import Path

import boto3

HERE = Path(__file__).resolve().parent
GRAFANA_SRC = HERE.parent / "hyperkit" / "grafana"
TAG_NAME = "hypergrid-obs"
INSTANCE_TYPE = "t3.small"
SSM_PROM_PASSWORD = "/hypergrid-obs/prom-password"

USER_DATA = """#!/bin/bash
set -euo pipefail
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 curl openssl unzip
# AWS CLI for the SSM fetch (Ubuntu 24.04 has no awscli apt package by default).
snap install aws-cli --classic || apt-get install -y -qq awscli
mkdir -p /opt/obs && cd /opt/obs
curl -fsSL "{bundle_url}" -o bundle.tar.gz
tar xzf bundle.tar.gz
umask 077
aws ssm get-parameter --region {region} --name {ssm_name} --with-decryption \
  --query Parameter.Value --output text \
  | openssl passwd -6 -stdin \
  | sed 's/^/hyperkit:/' > htpasswd
printf 'GF_SECURITY_ADMIN_PASSWORD=%s\\n' "$(openssl rand -base64 18)" > grafana.env
docker compose up --build -d
"""

TRUST_POLICY = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {"Service": "ec2.amazonaws.com"},
            "Action": "sts:AssumeRole",
        }
    ],
}


def _ensure_prom_password(ssm) -> None:
    """Ensure the SecureString exists; the value never enters this process."""

    try:
        ssm.get_parameter(Name=SSM_PROM_PASSWORD)
        return
    except ssm.exceptions.ParameterNotFound:
        pass
    import secrets as _secrets

    ssm.put_parameter(
        Name=SSM_PROM_PASSWORD,
        Value=_secrets.token_urlsafe(18),
        Type="SecureString",
        Overwrite=False,
    )


def _ensure_instance_profile(iam, account: str, region: str) -> str:
    """IAM role + instance profile allowing only the one SSM read."""

    role_name = f"{TAG_NAME}-role"
    profile_name = f"{TAG_NAME}-profile"
    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": ["ssm:GetParameter"],
                "Resource": f"arn:aws:ssm:{region}:{account}:parameter{SSM_PROM_PASSWORD}",
            }
        ],
    }
    with contextlib.suppress(iam.exceptions.EntityAlreadyExistsException):
        iam.create_role(
            RoleName=role_name,
            AssumeRolePolicyDocument=json.dumps(TRUST_POLICY),
            Tags=[{"Key": "project", "Value": "hypergrid-hillclimb"}],
        )
    iam.put_role_policy(
        RoleName=role_name,
        PolicyName="read-prom-password",
        PolicyDocument=json.dumps(policy),
    )
    with contextlib.suppress(iam.exceptions.EntityAlreadyExistsException):
        iam.create_instance_profile(InstanceProfileName=profile_name)
    attached = iam.get_instance_profile(InstanceProfileName=profile_name)[
        "InstanceProfile"
    ]["Roles"]
    if not any(role["RoleName"] == role_name for role in attached):
        iam.add_role_to_instance_profile(
            InstanceProfileName=profile_name, RoleName=role_name
        )
        time.sleep(10)  # instance-profile propagation
    return profile_name


def _build_bundle() -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "obs"
        root.mkdir()
        shutil.copytree(GRAFANA_SRC / "provisioning", root / "grafana" / "provisioning")
        shutil.copytree(GRAFANA_SRC / "dashboards", root / "grafana" / "dashboards")
        shutil.copy(GRAFANA_SRC / "Dockerfile", root / "grafana" / "Dockerfile")
        for name in ("compose.yaml", "prometheus.yml", "datasources.yaml", "nginx.conf"):
            shutil.copy(HERE / name, root / name)
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
            for path in sorted(root.rglob("*")):
                tar.add(path, arcname=str(path.relative_to(root)))
        return buffer.getvalue()


def _existing_instance(ec2) -> dict | None:
    response = ec2.describe_instances(
        Filters=[
            {"Name": "tag:Name", "Values": [TAG_NAME]},
            {"Name": "instance-state-name", "Values": ["pending", "running"]},
        ]
    )
    for reservation in response["Reservations"]:
        for instance in reservation["Instances"]:
            return instance
    return None


def _security_group(ec2, vpc_id: str) -> str:
    groups = ec2.describe_security_groups(
        Filters=[
            {"Name": "group-name", "Values": [TAG_NAME]},
            {"Name": "vpc-id", "Values": [vpc_id]},
        ]
    )["SecurityGroups"]
    if groups:
        return groups[0]["GroupId"]
    group_id = ec2.create_security_group(
        GroupName=TAG_NAME,
        Description="hypergrid observability: grafana viewer + basic-auth prometheus",
        VpcId=vpc_id,
    )["GroupId"]
    ec2.authorize_security_group_ingress(
        GroupId=group_id,
        IpPermissions=[
            {
                "IpProtocol": "tcp",
                "FromPort": port,
                "ToPort": port,
                "IpRanges": [{"CidrIp": "0.0.0.0/0"}],
            }
            for port in (80, 9090)
        ],
    )
    return group_id


def main() -> int:
    session = boto3.Session()
    ssm = session.client("ssm")
    ec2 = session.client("ec2")
    s3 = session.client("s3")
    iam = session.client("iam")
    account = session.client("sts").get_caller_identity()["Account"]
    region = session.region_name or "us-east-1"

    existing = _existing_instance(ec2)
    if existing:
        ip = existing.get("PublicIpAddress", "")
        print(f"reusing instance {existing['InstanceId']} at {ip}")
        print(f"grafana: http://{ip}/  prometheus: http://{ip}:9090 (user hyperkit)")
        return 0

    _ensure_prom_password(ssm)
    profile_name = _ensure_instance_profile(iam, account, region)

    bucket = f"hypergrid-obs-{account}-{region}"
    try:
        if region == "us-east-1":
            s3.create_bucket(Bucket=bucket)
        else:  # pragma: no cover - region-specific API shape
            s3.create_bucket(
                Bucket=bucket,
                CreateBucketConfiguration={"LocationConstraint": region},
            )
    except s3.exceptions.BucketAlreadyOwnedByYou:
        pass
    s3.put_object(Bucket=bucket, Key="bundle.tar.gz", Body=_build_bundle())
    bundle_url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": "bundle.tar.gz"},
        ExpiresIn=3600,
    )

    ami = ssm.get_parameter(
        Name="/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
    )["Parameter"]["Value"]
    vpc_id = ec2.describe_vpcs(Filters=[{"Name": "isDefault", "Values": ["true"]}])[
        "Vpcs"
    ][0]["VpcId"]
    group_id = _security_group(ec2, vpc_id)

    instance = ec2.run_instances(
        ImageId=ami,
        InstanceType=INSTANCE_TYPE,
        MinCount=1,
        MaxCount=1,
        SecurityGroupIds=[group_id],
        IamInstanceProfile={"Name": profile_name},
        UserData=base64.b64encode(
            USER_DATA.format(
                bundle_url=bundle_url, region=region, ssm_name=SSM_PROM_PASSWORD
            ).encode()
        ).decode(),
        BlockDeviceMappings=[
            {
                "DeviceName": "/dev/sda1",
                "Ebs": {"VolumeSize": 30, "VolumeType": "gp3", "DeleteOnTermination": True},
            }
        ],
        TagSpecifications=[
            {
                "ResourceType": "instance",
                "Tags": [
                    {"Key": "Name", "Value": TAG_NAME},
                    {"Key": "project", "Value": "hypergrid-hillclimb"},
                ],
            }
        ],
        MetadataOptions={"HttpTokens": "required"},
    )["Instances"][0]
    instance_id = instance["InstanceId"]
    print(f"launched {instance_id}; waiting for public IP ...")
    ec2.get_waiter("instance_running").wait(InstanceIds=[instance_id])
    ip = None
    for _ in range(30):
        described = ec2.describe_instances(InstanceIds=[instance_id])
        info = described["Reservations"][0]["Instances"][0]
        ip = info.get("PublicIpAddress")
        if ip:
            break
        time.sleep(5)
    print(f"instance {instance_id} at {ip}")
    print(f"grafana: http://{ip}/  (anonymous viewer)")
    print(
        "prometheus OTLP ingest at :9090/api/v1/otlp -- basic auth user 'hyperkit', "
        f"credential is the SSM SecureString {SSM_PROM_PASSWORD}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
