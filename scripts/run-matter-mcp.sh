#!/usr/bin/env bash
# Launcher for Cursor MCP. Ensures Node is on PATH and dist/index.js exists,
# then execs the Matter MCP server. Used by .cursor/mcp.json.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib-matter-mcp-path.sh
source "${ROOT_DIR}/scripts/lib-matter-mcp-path.sh"
matter_mcp_export_path
matter_mcp_require_node

DIST="${ROOT_DIR}/matter-cursor-mcp/dist/index.js"

if [ ! -f "${DIST}" ]; then
  echo "matter-cursor-mcp dist missing; running setup-matter-mcp.sh" >&2
  bash "${ROOT_DIR}/scripts/setup-matter-mcp.sh"
fi

if [ ! -f "${DIST}" ]; then
  echo "error: Matter MCP server not found at ${DIST}" >&2
  exit 1
fi

if [ -z "${MATTER_API_TOKEN:-}" ]; then
  echo "warning: MATTER_API_TOKEN is unset; Matter tools will return configuration_error" >&2
fi

exec node "${DIST}"
