#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_DIR="${ROOT_DIR}/matter-cursor-mcp"

if [ -f "${MCP_DIR}/dist/index.js" ]; then
  echo "matter-cursor-mcp already built at ${MCP_DIR}"
  exit 0
fi

# Remove a partial/failed checkout so we can recover cleanly.
if [ -e "${MCP_DIR}" ] && [ ! -f "${MCP_DIR}/package.json" ]; then
  rm -rf "${MCP_DIR}"
fi

if [ ! -e "${MCP_DIR}" ]; then
  # Prefer a sibling checkout from multi-repo cloud environments.
  for candidate in \
    "${ROOT_DIR}/../matter-cursor-mcp" \
    "/agent/repos/matter-cursor-mcp"
  do
    if [ -f "${candidate}/package.json" ]; then
      echo "Linking existing matter-cursor-mcp checkout at ${candidate}"
      ln -s "$(cd "${candidate}" && pwd)" "${MCP_DIR}"
      break
    fi
  done
fi

if [ ! -e "${MCP_DIR}" ]; then
  # matter-cursor-mcp is private; unauthenticated git clone fails with
  # "Repository not found". Use gh (cloud agents have GitHub auth).
  if command -v gh >/dev/null 2>&1; then
    echo "Cloning matter-cursor-mcp with gh auth"
    gh repo clone velum-labs/matter-cursor-mcp "${MCP_DIR}" -- --depth 1
  else
    echo "Cloning matter-cursor-mcp with git"
    git clone --depth 1 https://github.com/velum-labs/matter-cursor-mcp.git "${MCP_DIR}"
  fi
fi

(
  cd "${MCP_DIR}"
  if [ ! -f dist/index.js ]; then
    npm install
    npm run build
  fi
)

echo "matter-cursor-mcp ready at ${MCP_DIR}/dist/index.js"
