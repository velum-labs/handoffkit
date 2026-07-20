#!/usr/bin/env bash
# Shared PATH bootstrap for Matter MCP setup/launch scripts.
# shellcheck shell=bash

matter_mcp_export_path() {
  export PATH="${HOME}/.nvm/versions/node/v22.22.2/bin:${HOME}/.local/bin:/usr/local/bin:${PATH}"

  if ! command -v node >/dev/null 2>&1 && [ -d "${HOME}/.nvm/versions/node" ]; then
    local newest
    newest="$(ls -1 "${HOME}/.nvm/versions/node" | sort -V | tail -1 || true)"
    if [ -n "${newest}" ]; then
      export PATH="${HOME}/.nvm/versions/node/${newest}/bin:${PATH}"
    fi
  fi
}

MATTER_MCP_TOKEN_FILE="${HOME}/.config/matter-cursor-mcp/token"

# Persist a valid token (0600, outside the repo) so MCP child processes
# spawned with a filtered environment can still authenticate.
matter_mcp_persist_token() {
  case "${MATTER_API_TOKEN:-}" in
    mat_*)
      mkdir -p "$(dirname "${MATTER_MCP_TOKEN_FILE}")"
      (umask 177 && printf '%s' "${MATTER_API_TOKEN}" > "${MATTER_MCP_TOKEN_FILE}")
      ;;
  esac
}

matter_mcp_load_token() {
  if [ -z "${MATTER_API_TOKEN:-}" ] && [ -r "${MATTER_MCP_TOKEN_FILE}" ]; then
    MATTER_API_TOKEN="$(cat "${MATTER_MCP_TOKEN_FILE}")"
    export MATTER_API_TOKEN
    echo "info: loaded MATTER_API_TOKEN from ${MATTER_MCP_TOKEN_FILE}" >&2
  fi
}

matter_mcp_require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "error: node not found on PATH (needed to build/run matter-cursor-mcp)" >&2
    return 1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo "error: npm not found on PATH (needed to build matter-cursor-mcp)" >&2
    return 1
  fi
}
