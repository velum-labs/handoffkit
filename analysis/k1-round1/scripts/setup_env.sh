#!/usr/bin/env bash
# Session setup for k=1 round-1 (Cursor Cloud VM).
#
# Docker is installed but dockerd is NOT a persisted service on this VM: it
# must be restarted every session (AGENTS.md). This script is idempotent.
set -euo pipefail

export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$HOME/.local/bin:$PATH"

# --- Docker (Firecracker DinD workarounds; see AGENTS.md) -------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "docker not installed — install docker-ce, docker-compose-plugin," >&2
  echo "fuse-overlayfs, iptables from the docker apt repo first." >&2
  exit 1
fi

if ! sudo test -f /etc/docker/daemon.json || ! rg -q 'fuse-overlayfs' /etc/docker/daemon.json; then
  printf '{\n  "storage-driver": "fuse-overlayfs",\n  "features": { "containerd-snapshotter": false }\n}\n' |
    sudo tee /etc/docker/daemon.json >/dev/null
fi
sudo update-alternatives --set iptables /usr/sbin/iptables-legacy >/dev/null
sudo update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy >/dev/null

if ! docker info >/dev/null 2>&1; then
  echo "starting dockerd..."
  (sudo dockerd >/tmp/dockerd.log 2>&1 &)
  for _ in $(seq 1 30); do
    sudo docker info >/dev/null 2>&1 && break
    sleep 1
  done
  sudo chmod 666 /var/run/docker.sock
fi
docker info --format 'docker ok: {{.ServerVersion}} / {{.Driver}}'

# --- Harness + keys ----------------------------------------------------------
command -v tb >/dev/null 2>&1 || uv tool install terminal-bench
tb --help >/dev/null
echo "tb ok: $(uv tool list | rg terminal-bench || true)"

: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY must be set (panel + solo baselines)}"
echo "keys ok"
