from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[3]
DEPLOY_PATH = ROOT / "infra" / "hypergrid-obs" / "deploy.py"
COMPOSE_PATH = ROOT / "infra" / "hypergrid-obs" / "compose.yaml"
OBSERVABILITY_TF = ROOT / "infra" / "hyperkit" / "modules" / "observability" / "main.tf"
NETWORK_TF = ROOT / "infra" / "hyperkit" / "modules" / "network" / "main.tf"


def _load_deploy() -> ModuleType:
    spec = importlib.util.spec_from_file_location("hypergrid_obs_deploy", DEPLOY_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


deploy = _load_deploy()


class FakeEc2:
    def __init__(self) -> None:
        self.revoked: list[dict[str, Any]] = []
        self.authorized: list[dict[str, Any]] = []

    def revoke_security_group_ingress(self, **kwargs: Any) -> None:
        self.revoked.append(kwargs)

    def authorize_security_group_ingress(self, **kwargs: Any) -> None:
        self.authorized.append(kwargs)


class ParameterNotFound(Exception):
    pass


class FakeSsm:
    class exceptions:
        ParameterNotFound = ParameterNotFound

    def __init__(self, parameter: dict[str, str] | None) -> None:
        self.parameter = parameter

    def get_parameter(self, **_: Any) -> dict[str, dict[str, str]]:
        if self.parameter is None:
            raise ParameterNotFound
        return {"Parameter": self.parameter}


class EntityAlreadyExistsException(Exception):
    pass


class NoSuchEntityException(Exception):
    pass


class FakeIam:
    class exceptions:
        EntityAlreadyExistsException = EntityAlreadyExistsException
        NoSuchEntityException = NoSuchEntityException

    def __init__(self, *, role_exists: bool = False) -> None:
        self.created_role: dict[str, Any] | None = None
        self.role_exists = role_exists
        self.put_policy_calls = 0

    def get_role(self, **_: Any) -> dict[str, Any]:
        if not self.role_exists:
            raise NoSuchEntityException
        return {"Role": {"RoleName": "hypergrid-obs-role"}}

    def create_role(self, **kwargs: Any) -> None:
        self.created_role = kwargs

    def put_role_policy(self, **_: Any) -> None:
        self.put_policy_calls += 1

    def create_instance_profile(self, **_: Any) -> None:
        pass

    def get_instance_profile(self, **_: Any) -> dict[str, Any]:
        return {"InstanceProfile": {"Roles": [{"RoleName": "hypergrid-obs-role"}]}}


def test_lightweight_grafana_is_loopback_only_and_tailscale_served() -> None:
    compose = COMPOSE_PATH.read_text()

    assert '"127.0.0.1:3000:3000"' in compose
    assert '"80:3000"' not in compose
    assert "tailscale serve --bg http://127.0.0.1:3000" in deploy.USER_DATA
    assert "tskey-" not in deploy.USER_DATA
    assert "{tailscale_ssm_name}" in deploy.USER_DATA
    assert "chmod 0644 htpasswd" in deploy.USER_DATA


def test_app_ingress_rejects_non_private_cidrs() -> None:
    for cidr in ("0.0.0.0/0", "8.8.8.0/24", "::/0"):
        with pytest.raises(ValueError, match="private VPC networks"):
            deploy._app_ingress_permissions([cidr], [])


def test_app_ingress_replaces_public_rules_with_private_producers() -> None:
    ec2 = FakeEc2()
    group = {
        "GroupId": "sg-observability",
        "IpPermissions": [
            {
                "IpProtocol": "tcp",
                "FromPort": 80,
                "ToPort": 80,
                "IpRanges": [{"CidrIp": "0.0.0.0/0"}],
            },
            {
                "IpProtocol": "tcp",
                "FromPort": 9090,
                "ToPort": 9090,
                "IpRanges": [{"CidrIp": "0.0.0.0/0"}],
            },
            {
                "IpProtocol": "tcp",
                "FromPort": 22,
                "ToPort": 22,
                "IpRanges": [{"CidrIp": "10.0.0.0/8"}],
            },
        ],
    }

    deploy._reconcile_app_ingress(ec2, group, ["10.42.0.0/16"], ["sg-batch"])

    revoked = ec2.revoked[0]["IpPermissions"]
    assert {permission["FromPort"] for permission in revoked} == {80, 9090}
    authorized = ec2.authorized[0]["IpPermissions"]
    assert authorized[0]["IpRanges"][0]["CidrIp"] == "10.42.0.0/16"
    assert authorized[1]["UserIdGroupPairs"][0]["GroupId"] == "sg-batch"
    assert "0.0.0.0/0" not in str(authorized)


def test_tailscale_parameter_is_required_and_must_be_secure() -> None:
    with pytest.raises(RuntimeError, match="parameter is missing"):
        deploy._require_tailscale_parameter(FakeSsm(None), "/tailscale/key")
    with pytest.raises(RuntimeError, match="must be SecureString"):
        deploy._require_tailscale_parameter(FakeSsm({"Type": "String"}), "/tailscale/key")

    deploy._require_tailscale_parameter(FakeSsm({"Type": "SecureString"}), "/tailscale/key")


def test_instance_role_applies_required_permissions_boundary() -> None:
    iam = FakeIam()
    boundary = "arn:aws:iam::123456789012:policy/required-boundary"

    deploy._ensure_instance_profile(iam, "123456789012", "us-east-1", "/tailscale/key", boundary)

    assert iam.created_role is not None
    assert iam.created_role["PermissionsBoundary"] == boundary


def test_existing_instance_role_requires_no_iam_mutation() -> None:
    iam = FakeIam(role_exists=True)

    deploy._ensure_instance_profile(
        iam,
        "123456789012",
        "us-east-1",
        "/tailscale/key",
        "arn:aws:iam::123456789012:policy/required-boundary",
    )

    assert iam.created_role is None
    assert iam.put_policy_calls == 0


def test_legacy_instance_is_not_treated_as_tailnet_secured() -> None:
    assert deploy._instance_deployment_version({"Tags": []}) is None
    assert (
        deploy._instance_deployment_version(
            {
                "Tags": [
                    {
                        "Key": "hypergrid-obs-deployment",
                        "Value": deploy.DEPLOYMENT_VERSION,
                    }
                ]
            }
        )
        == deploy.DEPLOYMENT_VERSION
    )


def test_production_grafana_uses_internal_alb_and_tailnet_connector() -> None:
    observability = OBSERVABILITY_TF.read_text()
    network = NETWORK_TF.read_text()

    assert "internal                   = true" in observability
    assert "subnets                    = var.private_subnet_ids" in observability
    assert "tailscale serve --bg http://${aws_lb.grafana.dns_name}:80" in observability
    assert (
        "referenced_security_group_id = aws_security_group.tailscale_connector.id" in observability
    )
    assert "associate_public_ip_address = true" in observability
    assert (
        'resource "aws_vpc_security_group_ingress_rule" "tailscale_connector"' not in observability
    )
    assert "grafana_allowed_cidrs" not in network
    assert "0.0.0.0/0" not in str(
        [line for line in observability.splitlines() if "grafana_from_tailnet" in line]
    )
