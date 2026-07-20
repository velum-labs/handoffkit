#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib-matter-mcp-path.sh
source "${ROOT_DIR}/scripts/lib-matter-mcp-path.sh"
matter_mcp_export_path

MCP_DIR="${ROOT_DIR}/matter-cursor-mcp"

if [ -f "${MCP_DIR}/dist/index.js" ]; then
  echo "matter-cursor-mcp already built at ${MCP_DIR}"
  exit 0
fi

# Remove a partial/failed checkout so we can recover cleanly.
if [ -e "${MCP_DIR}" ] && [ ! -f "${MCP_DIR}/package.json" ]; then
  echo "Removing incomplete matter-cursor-mcp checkout at ${MCP_DIR}"
  rm -rf "${MCP_DIR}"
fi

if [ ! -e "${MCP_DIR}" ]; then
  # Prefer the vendored copy (works on single-repo environments whose GitHub
  # token cannot see the private matter-cursor-mcp repo), then a sibling
  # checkout from multi-repo cloud environments.
  for candidate in \
    "${ROOT_DIR}/vendor/matter-cursor-mcp" \
    "${ROOT_DIR}/../matter-cursor-mcp" \
    "/agent/repos/matter-cursor-mcp" \
    "/workspace/matter-cursor-mcp"
  do
    # Do not treat our own target directory as a candidate.
    if [ "${candidate}" = "${MCP_DIR}" ]; then
      continue
    fi
    if [ -f "${candidate}/package.json" ]; then
      echo "Linking existing matter-cursor-mcp checkout at ${candidate}"
      ln -s "$(cd "${candidate}" && pwd)" "${MCP_DIR}"
      break
    fi
  done
fi

if [ ! -e "${MCP_DIR}" ]; then
  # matter-cursor-mcp is private; unauthenticated git clone fails with
  # "Repository not found". Prefer gh (cloud agents have GitHub auth).
  if command -v gh >/dev/null 2>&1; then
    echo "Cloning matter-cursor-mcp with gh auth"
    gh repo clone velum-labs/matter-cursor-mcp "${MCP_DIR}" -- --depth 1
  else
    echo "Cloning matter-cursor-mcp with git"
    git clone --depth 1 https://github.com/velum-labs/matter-cursor-mcp.git "${MCP_DIR}"
  fi
fi

if [ ! -f "${MCP_DIR}/package.json" ]; then
  echo "error: matter-cursor-mcp checkout missing package.json at ${MCP_DIR}" >&2
  exit 1
fi

matter_mcp_require_node

(
  cd "${MCP_DIR}"
  if [ ! -f dist/index.js ]; then
    npm install
    npm run build
  fi
)

if [ ! -f "${MCP_DIR}/dist/index.js" ]; then
  echo "error: build did not produce ${MCP_DIR}/dist/index.js" >&2
  exit 1
fi

echo "matter-cursor-mcp ready at ${MCP_DIR}/dist/index.js"
