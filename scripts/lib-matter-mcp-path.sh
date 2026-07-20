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
