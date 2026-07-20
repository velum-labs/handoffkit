#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_DIR="${ROOT_DIR}/matter-cursor-mcp"

if [ -f "${MCP_DIR}/dist/index.js" ]; then
  echo "matter-cursor-mcp already built at ${MCP_DIR}"
  exit 0
fi

if [ ! -d "${MCP_DIR}/.git" ]; then
  git clone --depth 1 https://github.com/velum-labs/matter-cursor-mcp.git "${MCP_DIR}"
fi

(
  cd "${MCP_DIR}"
  npm install
  npm run build
)

echo "matter-cursor-mcp ready at ${MCP_DIR}/dist/index.js"
