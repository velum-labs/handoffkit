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

# Cloud Agents Runtime Secrets are present on the exec-daemon, but MCP child
# processes are sometimes spawned with a filtered environment that drops
# MATTER_API_TOKEN. Walk ancestor /proc/<pid>/environ to recover it without
# ever printing the value.
matter_mcp_inherit_token_from_ancestors() {
  if [ -n "${MATTER_API_TOKEN:-}" ]; then
    return 0
  fi
  local pid="${PPID:-}"
  local hops=0
  while [ -n "${pid}" ] && [ "${pid}" != "0" ] && [ "${pid}" != "1" ] && [ "${hops}" -lt 12 ]; do
    if [ -r "/proc/${pid}/environ" ]; then
      local line
      line="$(tr '\0' '\n' < "/proc/${pid}/environ" | grep -m1 '^MATTER_API_TOKEN=' || true)"
      if [ -n "${line}" ]; then
        export MATTER_API_TOKEN="${line#MATTER_API_TOKEN=}"
        echo "warning: MATTER_API_TOKEN was missing in MCP child env; inherited from ancestor pid ${pid}" >&2
        return 0
      fi
    fi
    if [ ! -r "/proc/${pid}/status" ]; then
      break
    fi
    pid="$(awk '/^PPid:/{print $2}' "/proc/${pid}/status")"
    hops=$((hops + 1))
  done
  return 0
}

matter_mcp_inherit_token_from_ancestors

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
