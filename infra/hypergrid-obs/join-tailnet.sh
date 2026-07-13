#!/usr/bin/env bash
# Join this machine to the velum tailnet for hypergrid observability access.
#
# Reproducible for agent sandboxes (Cursor cloud VMs, CI, velum-mini):
# - installs tailscale if absent;
# - Firecracker sandboxes have no kernel TUN driver, so tailscaled falls back
#   to userspace networking with local proxies. In that mode, tailnet access
#   goes THROUGH the proxies:
#     curl:            --proxy socks5h://localhost:1055
#     python/requests/OTLP exporters:  HTTPS_PROXY=http://localhost:1056
#   (with a real /dev/net/tun, access is direct and no proxy is needed);
# - the auth key comes from SSM: prefers /hypergrid-obs/agent-auth-key
#   (tag:hyperkit-agent; create it for agent enrollments) and falls back to
#   /hypergrid-obs/tailscale-auth-key (the observability node tag);
# - keys are ephemeral: nodes vanish shortly after the sandbox dies.
#
# ACL prerequisite (tailnet admin): the agent nodes' tag must be granted
# access to tag:hyperkit-observability on tcp/443 (Grafana) and tcp/9090
# (Prometheus API + OTLP ingest). Without that grant the join still succeeds
# but the obs node is invisible to agents.
#
# Usage: infra/hypergrid-obs/join-tailnet.sh [hostname-suffix]
set -euo pipefail

SUFFIX="${1:-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
HOSTNAME_TS="cursor-agent-${SUFFIX}"

if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

if [ ! -e /dev/net/tun ]; then
  sudo mkdir -p /dev/net
  sudo mknod /dev/net/tun c 10 200 2>/dev/null || true
fi

if ! pgrep -x tailscaled >/dev/null 2>&1; then
  if grep -q tun /proc/misc 2>/dev/null; then
    sudo nohup tailscaled >/tmp/tailscaled.log 2>&1 &
  else
    echo "no kernel TUN driver: starting userspace tailscaled" \
      "(socks5 localhost:1055, http proxy localhost:1056)"
    sudo nohup tailscaled \
      --tun=userspace-networking \
      --socks5-server=localhost:1055 \
      --outbound-http-proxy-listen=localhost:1056 \
      >/tmp/tailscaled.log 2>&1 &
  fi
  sleep 3
fi

fetch_param() {
  uv run --with boto3 python - "$1" <<'EOF'
import sys
import boto3
ssm = boto3.client("ssm")
try:
    print(ssm.get_parameter(Name=sys.argv[1], WithDecryption=True)["Parameter"]["Value"])
except ssm.exceptions.ParameterNotFound:
    pass
EOF
}

KEY="$(fetch_param /hypergrid-obs/agent-auth-key)"
if [ -z "$KEY" ]; then
  KEY="$(fetch_param /hypergrid-obs/tailscale-auth-key)"
fi
if [ -z "$KEY" ]; then
  echo "no tailscale auth key in SSM (/hypergrid-obs/agent-auth-key or" \
    "/hypergrid-obs/tailscale-auth-key)" >&2
  exit 1
fi

sudo tailscale up --auth-key="$KEY" --hostname="$HOSTNAME_TS" --accept-dns=true
unset KEY

echo
sudo tailscale status | head -5
echo
if sudo tailscale status | grep -q hypergrid-obs; then
  echo "obs node visible. Grafana: https://hypergrid-obs.<tailnet>.ts.net/"
else
  echo "WARNING: hypergrid-obs is not visible from this node — the tailnet"
  echo "ACL likely lacks a grant from this node's tag to"
  echo "tag:hyperkit-observability (tcp/443, tcp/9090). Ask the tailnet admin."
fi
