# Tailnet-only hypergrid observability

This lightweight stack runs Grafana and Prometheus on one EC2 instance for
Hyperkit benchmark runs:

- Grafana is bound to host loopback and exposed through Tailscale Serve HTTPS.
- Prometheus keeps basic authentication and is reachable on port 9090 over the
  tailnet.
- Optional AWS producers may reach Prometheus over a VPC-private CIDR or
  security-group rule.
- The EC2 security group has no public application ingress. Tailscale connects
  outbound through its coordination/DERP path, so no public WireGuard port is
  required.

## Prerequisites

Create a tagged, reusable, ephemeral Tailscale auth key for a tag such as
`tag:hyperkit-observability`. Store it outside this repository as the SSM
SecureString `/hypergrid-obs/tailscale-auth-key`. Provision the value through
your normal secret-management workflow or a protected temporary
`--cli-input-json` file; do not put it directly in shell history.
Tailscale auth keys expire; rotate this SecureString before its key expiry so
future instance replacements can enroll.

Tailnet policy should grant only intended users access to the tagged node on:

- TCP 443 for Grafana
- TCP 9090 for the authenticated Prometheus API and OTLP receiver

The deployment checks that the parameter exists and is a `SecureString` before
creating any infrastructure. The instance role can read only that parameter
and `/hypergrid-obs/prom-password`.

## Deploy

For local benchmark producers that are already on the tailnet:

```sh
uv run --with boto3 python infra/hypergrid-obs/deploy.py \
  --iam-permissions-boundary-arn \
    arn:aws:iam::052777341990:policy/cursor-agent-boundary \
  --tailscale-dns-suffix tail1234.ts.net
```

To also permit AWS Batch/Fargate producers over private VPC networking:

```sh
uv run --with boto3 python infra/hypergrid-obs/deploy.py \
  --vpc-id vpc-0123456789abcdef0 \
  --subnet-id subnet-0123456789abcdef0 \
  --producer-security-group sg-0123456789abcdef0 \
  --tailscale-dns-suffix tail1234.ts.net
```

`--producer-cidr` is also available for a private routed network. The deployer
rejects public IPv4 space, `0.0.0.0/0`, and `::/0`.

Use the reported MagicDNS URL for Grafana. Configure benchmark telemetry with
the reported Prometheus URL and the password from
`/hypergrid-obs/prom-password`; do not print or persist that value in the
repository.

Homebrew `tailscaled` on macOS may create `/etc/resolver/search.tailscale`
without a nameserver, which breaks normal MagicDNS lookup even though tailnet
connectivity works. The per-domain workaround is:

```sh
sudo sh -c 'printf "nameserver 100.100.100.100\n" > /etc/resolver/ts.net'
sudo dscacheutil -flushcache
sudo killall -HUP mDNSResponder
```
