"""Deploy the hypergrid observability stack (Prometheus + Grafana) to EC2.

Single small instance, docker-compose managed, independent of any local
process. Grafana is exposed only through Tailscale Serve. Prometheus access
(OTLP ingest + query API) goes through a basic-auth nginx proxy and is
reachable over the tailnet or from explicitly approved private VPC producers.
Neither service has public application ingress.

Secret handling -- this process never holds any secret value:
- The Prometheus password is generated directly into SSM Parameter Store as a
  SecureString (``/hypergrid-obs/prom-password``) the first time it is needed,
  written by AWS on the service side.
- The INSTANCE fetches it at boot through its IAM instance profile and builds
  the nginx htpasswd hash locally; the deploy bundle carries no credential
  material at all.
- The Grafana admin password is generated on the instance and never leaves it
  (anonymous Viewer is the intended access path).
- The Tailscale auth key is read by the instance from
  ``/hypergrid-obs/tailscale-auth-key`` and never enters this process, the
  deployment bundle, user-data, or Terraform state.

Consumers (the sweep's OTLP env) read the password themselves:

  aws ssm get-parameter --name /hypergrid-obs/prom-password \
    --with-decryption --query Parameter.Value --output text

Idempotent: an existing instance tagged Name=hypergrid-obs is reused.

Usage: uv run --with boto3 python infra/hypergrid-obs/deploy.py
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import io
import ipaddress
import json
import re
import shutil
import sys
import tarfile
import tempfile
import time
from pathlib import Path

import boto3

HERE = Path(__file__).resolve().parent
GRAFANA_SRC = HERE.parent / "hyperkit" / "grafana"
TAG_NAME = "hypergrid-obs"
INSTANCE_TYPE = "t3.small"
SSM_PROM_PARAM = "/hypergrid-obs/prom-password"
SSM_TAILSCALE_PARAM = "/hypergrid-obs/tailscale-auth-key"
TAILSCALE_HOSTNAME = "hypergrid-obs"
DEPLOYMENT_VERSION = "tailnet-v1"

USER_DATA = """#!/bin/bash
set -euo pipefail
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 curl openssl unzip
curl -fsSL https://tailscale.com/install.sh | sh
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
# nginx worker processes must be able to read the one-way password hash.
chmod 0644 htpasswd
printf 'GF_SECURITY_ADMIN_PASSWORD=%s\\n' "$(openssl rand -base64 18)" > grafana.env
docker compose up --build -d
tailscale_auth_key="$(
  aws ssm get-parameter --region {region} --name {tailscale_ssm_name} \
    --with-decryption --query Parameter.Value --output text
)"
tailscale up \
  --auth-key="$tailscale_auth_key" \
  --hostname={tailscale_hostname} \
  --accept-routes=false
unset tailscale_auth_key
tailscale serve --bg http://127.0.0.1:3000
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
        ssm.get_parameter(Name=SSM_PROM_PARAM)
        return
    except ssm.exceptions.ParameterNotFound:
        pass
    import secrets as _secrets

    ssm.put_parameter(
        Name=SSM_PROM_PARAM,
        Value=_secrets.token_urlsafe(18),
        Type="SecureString",
        Overwrite=False,
    )


def _ensure_instance_profile(
    iam,
    account: str,
    region: str,
    tailscale_ssm_name: str,
    permissions_boundary_arn: str | None,
) -> str:
    """IAM role + instance profile allowing only the required SSM reads."""

    role_name = f"{TAG_NAME}-role"
    profile_name = f"{TAG_NAME}-profile"
    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": ["ssm:GetParameter"],
                "Resource": [
                    f"arn:aws:ssm:{region}:{account}:parameter{SSM_PROM_PARAM}",
                    f"arn:aws:ssm:{region}:{account}:parameter{tailscale_ssm_name}",
                ],
            }
        ],
    }
    create_role_options = {
        "RoleName": role_name,
        "AssumeRolePolicyDocument": json.dumps(TRUST_POLICY),
        "Tags": [{"Key": "project", "Value": "hypergrid-hillclimb"}],
    }
    if permissions_boundary_arn:
        create_role_options["PermissionsBoundary"] = permissions_boundary_arn
    with contextlib.suppress(iam.exceptions.EntityAlreadyExistsException):
        iam.create_role(**create_role_options)
    iam.put_role_policy(
        RoleName=role_name,
        PolicyName="read-observability-secrets",
        PolicyDocument=json.dumps(policy),
    )
    with contextlib.suppress(iam.exceptions.EntityAlreadyExistsException):
        iam.create_instance_profile(InstanceProfileName=profile_name)
    attached = iam.get_instance_profile(InstanceProfileName=profile_name)["InstanceProfile"][
        "Roles"
    ]
    if not any(role["RoleName"] == role_name for role in attached):
        iam.add_role_to_instance_profile(InstanceProfileName=profile_name, RoleName=role_name)
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


def _instance_deployment_version(instance: dict) -> str | None:
    return next(
        (
            tag["Value"]
            for tag in instance.get("Tags", [])
            if tag.get("Key") == "hypergrid-obs-deployment"
        ),
        None,
    )


def _app_ingress_permissions(
    producer_cidrs: list[str], producer_security_groups: list[str]
) -> list[dict]:
    permissions: list[dict] = []
    private_ipv4 = tuple(
        ipaddress.ip_network(cidr) for cidr in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
    )
    for cidr in producer_cidrs:
        network = ipaddress.ip_network(cidr, strict=False)
        private = (
            any(network.subnet_of(candidate) for candidate in private_ipv4)
            if network.version == 4
            else network.is_private
        )
        if not private:
            raise ValueError("producer CIDRs must be private VPC networks")
        permission: dict = {
            "IpProtocol": "tcp",
            "FromPort": 9090,
            "ToPort": 9090,
        }
        if network.version == 4:
            permission["IpRanges"] = [
                {"CidrIp": str(network), "Description": "Private Prometheus producer"}
            ]
        else:
            permission["Ipv6Ranges"] = [
                {
                    "CidrIpv6": str(network),
                    "Description": "Private Prometheus producer",
                }
            ]
        permissions.append(permission)
    for group_id in producer_security_groups:
        permissions.append(
            {
                "IpProtocol": "tcp",
                "FromPort": 9090,
                "ToPort": 9090,
                "UserIdGroupPairs": [
                    {
                        "GroupId": group_id,
                        "Description": "Private Prometheus producer",
                    }
                ],
            }
        )
    return permissions


def _reconcile_app_ingress(
    ec2,
    group: dict,
    producer_cidrs: list[str],
    producer_security_groups: list[str],
) -> None:
    """Remove application ingress and add only explicit private producers."""

    group_id = group["GroupId"]

    def exposes_app_port(permission: dict) -> bool:
        protocol = permission.get("IpProtocol")
        if protocol == "-1":
            return True
        if protocol != "tcp":
            return False
        start = permission.get("FromPort", 0)
        end = permission.get("ToPort", 65535)
        return any(start <= port <= end for port in (80, 9090))

    stale = [
        permission for permission in group.get("IpPermissions", []) if exposes_app_port(permission)
    ]
    if stale:
        ec2.revoke_security_group_ingress(GroupId=group_id, IpPermissions=stale)

    desired = _app_ingress_permissions(producer_cidrs, producer_security_groups)
    if desired:
        ec2.authorize_security_group_ingress(GroupId=group_id, IpPermissions=desired)


def _security_group(
    ec2,
    vpc_id: str,
    producer_cidrs: list[str],
    producer_security_groups: list[str],
) -> str:
    groups = ec2.describe_security_groups(
        Filters=[
            {"Name": "group-name", "Values": [TAG_NAME]},
            {"Name": "vpc-id", "Values": [vpc_id]},
        ]
    )["SecurityGroups"]
    if groups:
        group = groups[0]
    else:
        group_id = ec2.create_security_group(
            GroupName=TAG_NAME,
            Description="Tailnet-only hypergrid observability",
            VpcId=vpc_id,
        )["GroupId"]
        group = {"GroupId": group_id, "IpPermissions": []}
    _reconcile_app_ingress(ec2, group, producer_cidrs, producer_security_groups)
    return group["GroupId"]


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--vpc-id",
        help="VPC for the observability host (defaults to the default VPC)",
    )
    parser.add_argument(
        "--subnet-id",
        help="Subnet for the observability host (must belong to --vpc-id)",
    )
    parser.add_argument(
        "--producer-cidr",
        action="append",
        default=[],
        help="Private CIDR allowed to send/query Prometheus; repeatable",
    )
    parser.add_argument(
        "--producer-security-group",
        action="append",
        default=[],
        help="VPC security group allowed to reach Prometheus; repeatable",
    )
    parser.add_argument(
        "--tailscale-auth-parameter",
        default=SSM_TAILSCALE_PARAM,
        help="SSM SecureString containing a tagged, reusable, ephemeral Tailscale auth key",
    )
    parser.add_argument(
        "--tailscale-hostname",
        default=TAILSCALE_HOSTNAME,
        help="MagicDNS hostname assigned to the observability node",
    )
    parser.add_argument(
        "--tailscale-dns-suffix",
        help="Tailnet DNS suffix for the HTTPS URL, for example tail1234.ts.net",
    )
    parser.add_argument(
        "--iam-permissions-boundary-arn",
        help="Permissions boundary required when creating the EC2 instance role",
    )
    args = parser.parse_args()
    if re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", args.tailscale_hostname) is None:
        parser.error("--tailscale-hostname must be a valid single DNS label")
    if (
        args.tailscale_dns_suffix
        and re.fullmatch(r"[a-z0-9.-]+", args.tailscale_dns_suffix) is None
    ):
        parser.error("--tailscale-dns-suffix must be a valid DNS suffix")
    if re.fullmatch(r"/[A-Za-z0-9_.\-/]+", args.tailscale_auth_parameter) is None:
        parser.error("--tailscale-auth-parameter must be a valid SSM parameter name")
    return args


def _require_tailscale_parameter(ssm, name: str) -> None:
    """Fail closed without decrypting or returning the auth key."""

    try:
        parameter = ssm.get_parameter(Name=name)["Parameter"]
    except ssm.exceptions.ParameterNotFound as exc:
        raise RuntimeError(f"required Tailscale auth-key parameter is missing: {name}") from exc
    if parameter.get("Type") != "SecureString":
        raise RuntimeError(f"Tailscale auth-key parameter must be SecureString: {name}")


def main() -> int:
    args = _parse_args()
    tailscale_dns_name = (
        f"{args.tailscale_hostname}.{args.tailscale_dns_suffix}"
        if args.tailscale_dns_suffix
        else args.tailscale_hostname
    )
    session = boto3.Session()
    ssm = session.client("ssm")
    ec2 = session.client("ec2")
    s3 = session.client("s3")
    iam = session.client("iam")
    account = session.client("sts").get_caller_identity()["Account"]
    region = session.region_name or "us-east-1"

    _require_tailscale_parameter(ssm, args.tailscale_auth_parameter)
    existing = _existing_instance(ec2)
    if existing:
        if _instance_deployment_version(existing) != DEPLOYMENT_VERSION:
            raise RuntimeError(
                f"existing instance {existing['InstanceId']} predates the "
                "tailnet-only bootstrap; replace it before redeploying"
            )
        group_id = _security_group(
            ec2,
            existing["VpcId"],
            args.producer_cidr,
            args.producer_security_group,
        )
        attached_groups = {group["GroupId"] for group in existing.get("SecurityGroups", [])}
        if group_id not in attached_groups:
            raise RuntimeError(
                f"existing instance {existing['InstanceId']} is not attached "
                f"to the reconciled security group {group_id}"
            )
        print(f"reusing instance {existing['InstanceId']}")
        print(
            f"grafana: https://{tailscale_dns_name}/  "
            f"prometheus: http://{tailscale_dns_name}:9090 (user hyperkit)"
        )
        if args.producer_cidr or args.producer_security_group:
            print(f"private Prometheus: http://{existing['PrivateIpAddress']}:9090")
        return 0

    _ensure_prom_password(ssm)
    profile_name = _ensure_instance_profile(
        iam,
        account,
        region,
        args.tailscale_auth_parameter,
        args.iam_permissions_boundary_arn,
    )

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
    if args.vpc_id:
        vpc_id = args.vpc_id
    elif args.subnet_id:
        subnet = ec2.describe_subnets(SubnetIds=[args.subnet_id])["Subnets"][0]
        vpc_id = subnet["VpcId"]
    else:
        vpc_id = ec2.describe_vpcs(Filters=[{"Name": "isDefault", "Values": ["true"]}])["Vpcs"][0][
            "VpcId"
        ]
    if args.subnet_id and args.vpc_id:
        subnet = ec2.describe_subnets(SubnetIds=[args.subnet_id])["Subnets"][0]
        if subnet["VpcId"] != vpc_id:
            raise ValueError("--subnet-id must belong to --vpc-id")
    group_id = _security_group(
        ec2,
        vpc_id,
        args.producer_cidr,
        args.producer_security_group,
    )

    run_options = dict(
        ImageId=ami,
        InstanceType=INSTANCE_TYPE,
        MinCount=1,
        MaxCount=1,
        SecurityGroupIds=[group_id],
        IamInstanceProfile={"Name": profile_name},
        UserData=base64.b64encode(
            USER_DATA.format(
                bundle_url=bundle_url,
                region=region,
                ssm_name=SSM_PROM_PARAM,
                tailscale_ssm_name=args.tailscale_auth_parameter,
                tailscale_hostname=args.tailscale_hostname,
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
                    {"Key": "hypergrid-obs-deployment", "Value": DEPLOYMENT_VERSION},
                ],
            }
        ],
        MetadataOptions={"HttpTokens": "required"},
    )
    if args.subnet_id:
        run_options["SubnetId"] = args.subnet_id
    instance = ec2.run_instances(**run_options)["Instances"][0]
    instance_id = instance["InstanceId"]
    print(f"launched {instance_id}; waiting for bootstrap ...")
    ec2.get_waiter("instance_running").wait(InstanceIds=[instance_id])
    print(f"instance {instance_id} is running")
    print(f"grafana: https://{tailscale_dns_name}/  (tailnet anonymous viewer)")
    print(
        f"prometheus: http://{tailscale_dns_name}:9090 "
        "-- basic auth user 'hyperkit'; "
        f"credential is the SSM SecureString {SSM_PROM_PARAM}"
    )
    if args.producer_cidr or args.producer_security_group:
        print(f"private Prometheus: http://{instance['PrivateIpAddress']}:9090")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2) from None
