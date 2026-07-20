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

# Diagnose common token problems without ever printing the value.
if [ -z "${MATTER_API_TOKEN:-}" ]; then
  echo "warning: MATTER_API_TOKEN is unset; Matter tools will return configuration_error" >&2
else
  # Strip accidental surrounding quotes and whitespace/newlines from pasted
  # secret values; the Matter server requires a bare mat_... token.
  cleaned="${MATTER_API_TOKEN}"
  cleaned="${cleaned#"${cleaned%%[![:space:]]*}"}"
  cleaned="${cleaned%"${cleaned##*[![:space:]]}"}"
  cleaned="${cleaned%\"}"; cleaned="${cleaned#\"}"
  cleaned="${cleaned%\'}"; cleaned="${cleaned#\'}"
  cleaned="${cleaned#MATTER_API_TOKEN=}"
  if [ "${cleaned}" != "${MATTER_API_TOKEN}" ]; then
    echo "warning: MATTER_API_TOKEN contained surrounding quotes/whitespace; sanitized for this launch (fix the stored secret value)" >&2
    export MATTER_API_TOKEN="${cleaned}"
  fi
  case "${MATTER_API_TOKEN}" in
    mat_*) ;;
    *)
      echo "warning: MATTER_API_TOKEN is set (length ${#MATTER_API_TOKEN}) but does not start with 'mat_'; Matter will report configuration_error. Re-save the secret with the bare token value." >&2
      ;;
  esac
fi

exec node "${DIST}"
