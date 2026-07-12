"""Deploy the hypergrid observability stack (Prometheus + Grafana) to EC2.

Single small instance, docker-compose managed, independent of any local
process. Prometheus OTLP ingest and query API are behind basic auth; Grafana
is public read-only (anonymous Viewer) with a random admin password.

Idempotent: an existing instance tagged Name=hypergrid-obs is reused.
Secrets are written to ~/.hypergrid-obs.env (never committed).

Usage: uv run --with boto3,bcrypt python infra/hypergrid-obs/deploy.py
"""

from __future__ import annotations

import base64
import io
import secrets
import shutil
import tarfile
import tempfile
import time
from pathlib import Path

import bcrypt
import boto3

HERE = Path(__file__).resolve().parent
GRAFANA_SRC = HERE.parent / "hyperkit" / "grafana"
TAG_NAME = "hypergrid-obs"
INSTANCE_TYPE = "t3.small"
ENV_FILE = Path.home() / ".hypergrid-obs.env"

USER_DATA = """#!/bin/bash
set -euo pipefail
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 curl
mkdir -p /opt/obs && cd /opt/obs
curl -fsSL "{bundle_url}" -o bundle.tar.gz
tar xzf bundle.tar.gz
docker compose up --build -d
"""


def _load_or_create_secrets() -> dict[str, str]:
    if ENV_FILE.exists():
        pairs = dict(
            line.split("=", 1)
            for line in ENV_FILE.read_text().splitlines()
            if "=" in line
        )
        if {"GRAFANA_ADMIN_PASSWORD", "PROM_PASSWORD"} <= set(pairs):
            return pairs
    pairs = {
        "GRAFANA_ADMIN_PASSWORD": secrets.token_urlsafe(18),
        "PROM_PASSWORD": secrets.token_urlsafe(18),
    }
    ENV_FILE.write_text("".join(f"{k}={v}\n" for k, v in pairs.items()))
    ENV_FILE.chmod(0o600)
    return pairs


def _build_bundle(secrets_map: dict[str, str]) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "obs"
        root.mkdir()
        shutil.copytree(GRAFANA_SRC / "provisioning", root / "grafana" / "provisioning")
        shutil.copytree(GRAFANA_SRC / "dashboards", root / "grafana" / "dashboards")
        shutil.copy(GRAFANA_SRC / "Dockerfile", root / "grafana" / "Dockerfile")
        shutil.copy(HERE / "compose.yaml", root / "compose.yaml")
        shutil.copy(HERE / "prometheus.yml", root / "prometheus.yml")
        shutil.copy(HERE / "datasources.yaml", root / "datasources.yaml")
        hashed = bcrypt.hashpw(secrets_map["PROM_PASSWORD"].encode(), bcrypt.gensalt()).decode()
        (root / "web.yml").write_text(f"basic_auth_users:\n  hyperkit: {hashed}\n")
        (root / ".env").write_text(
            f"GRAFANA_ADMIN_PASSWORD={secrets_map['GRAFANA_ADMIN_PASSWORD']}\n"
            f"PROM_PASSWORD={secrets_map['PROM_PASSWORD']}\n"
        )
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
    secrets_map = _load_or_create_secrets()
    session = boto3.Session()
    ec2 = session.client("ec2")
    s3 = session.client("s3")
    sts = session.client("sts")
    account = sts.get_caller_identity()["Account"]
    region = session.region_name or "us-east-1"

    existing = _existing_instance(ec2)
    if existing:
        ip = existing.get("PublicIpAddress", "")
        print(f"reusing instance {existing['InstanceId']} at {ip}")
        print(f"grafana: http://{ip}/  prometheus: http://{ip}:9090 (user hyperkit)")
        return 0

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
    s3.put_object(Bucket=bucket, Key="bundle.tar.gz", Body=_build_bundle(secrets_map))
    bundle_url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": "bundle.tar.gz"},
        ExpiresIn=3600,
    )

    ssm = session.client("ssm")
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
        UserData=base64.b64encode(
            USER_DATA.format(bundle_url=bundle_url).encode()
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
    for _ in range(30):
        described = ec2.describe_instances(InstanceIds=[instance_id])
        info = described["Reservations"][0]["Instances"][0]
        ip = info.get("PublicIpAddress")
        if ip:
            break
        time.sleep(5)
    print(f"instance {instance_id} at {ip}")
    print(f"grafana: http://{ip}/  (anonymous viewer; admin password in {ENV_FILE})")
    print(f"prometheus OTLP: http://{ip}:9090/api/v1/otlp (basic auth, user hyperkit)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
