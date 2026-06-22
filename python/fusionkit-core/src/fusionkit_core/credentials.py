"""Read-only access to the OAuth credentials the Claude Code and Codex CLIs
store on this machine.

FusionKit never runs an OAuth login, never refreshes, and never writes these
files back. The ``claude`` / ``codex`` CLI remains the single owner of the token
lifecycle; we only read the current access token at request time and forward it
with the right headers. If the token is expired we fail with a clear "re-login"
message rather than attempting a refresh (refreshing here would rotate the
refresh token and silently log the CLI out).

Because the token is resolved per request (the long-running ``fusionkit serve``
builds its clients once at startup), a small in-process TTL cache avoids
re-reading the file / spawning ``security`` on every call while still picking up
CLI refreshes promptly.
"""
from __future__ import annotations

import base64
import binascii
import getpass
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, assert_never

from fusionkit_core.config import ModelEndpoint, SubscriptionAuthMode

CLAUDE_CODE_KEYCHAIN_SERVICE = "Claude Code-credentials"
DEFAULT_CLAUDE_CREDENTIALS_PATH = "~/.claude/.credentials.json"
DEFAULT_CODEX_CREDENTIALS_PATH = "~/.codex/auth.json"

# Re-read the underlying store at most this often, and always re-read once the
# cached token is within this skew of its expiry, so CLI refreshes are picked up
# quickly without hammering the filesystem / Keychain.
_CACHE_TTL_S = 30.0
_EXPIRY_SKEW_S = 60.0


class SubscriptionAuthError(RuntimeError):
    """Raised when a subscription credential cannot be read or has expired."""


@dataclass(frozen=True)
class SubscriptionToken:
    """A subscription access token resolved from a local CLI credential store."""

    token: str
    expires_at: float | None = None
    account_id: str | None = None

    def is_expired(self, *, skew_s: float = 0.0) -> bool:
        if self.expires_at is None:
            return False
        return time.time() >= (self.expires_at - skew_s)


# (mode, resolved_path) -> (fetched_at, token)
_CACHE: dict[tuple[str, str], tuple[float, SubscriptionToken]] = {}


def _decode_jwt_claims(token: str) -> dict[str, Any]:
    """Best-effort decode of a JWT payload (no signature verification)."""
    parts = token.split(".")
    if len(parts) < 2:
        return {}
    payload = parts[1]
    padding = "=" * (-len(payload) % 4)
    try:
        decoded = base64.urlsafe_b64decode(payload + padding)
    except (binascii.Error, ValueError):
        return {}
    try:
        claims = json.loads(decoded)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {}
    return claims if isinstance(claims, dict) else {}


def _codex_account_id_from_claims(claims: dict[str, Any]) -> str | None:
    auth = claims.get("https://api.openai.com/auth")
    if isinstance(auth, dict):
        account_id = auth.get("chatgpt_account_id")
        if isinstance(account_id, str) and account_id:
            return account_id
    organizations = claims.get("organizations")
    if isinstance(organizations, list) and organizations:
        first = organizations[0]
        if isinstance(first, dict) and isinstance(first.get("id"), str):
            return first["id"]
    return None


def _read_claude_credentials_blob(path: Path) -> dict[str, Any]:
    if path.exists():
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise SubscriptionAuthError(
                f"Could not read Claude Code credentials at {path}: {exc}"
            ) from exc
        if isinstance(data, dict):
            return data
    if sys.platform == "darwin":
        blob = _read_macos_keychain(CLAUDE_CODE_KEYCHAIN_SERVICE)
        if blob is not None:
            try:
                data = json.loads(blob)
            except json.JSONDecodeError as exc:
                raise SubscriptionAuthError(
                    "Could not parse Claude Code credentials from the macOS Keychain."
                ) from exc
            if isinstance(data, dict):
                return data
    raise SubscriptionAuthError(
        "No Claude Code credentials found. Run `claude` and sign in with your "
        "Claude Pro/Max subscription first "
        f"(looked at {path} and the macOS Keychain)."
    )


def _read_macos_keychain(service: str) -> str | None:
    try:
        result = subprocess.run(
            [
                "security",
                "find-generic-password",
                "-s",
                service,
                "-a",
                getpass.getuser(),
                "-w",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None
    if result.returncode != 0:
        return None
    output = result.stdout.strip()
    return output or None


def load_claude_code_credentials(path: str | None = None) -> SubscriptionToken:
    """Read the Claude Code OAuth access token (read-only, no refresh)."""
    resolved = Path(os.path.expanduser(path or DEFAULT_CLAUDE_CREDENTIALS_PATH))
    blob = _read_claude_credentials_blob(resolved)
    oauth = blob.get("claudeAiOauth")
    if not isinstance(oauth, dict):
        raise SubscriptionAuthError(
            "Claude Code credentials are missing the 'claudeAiOauth' block; "
            "run `claude` to re-authenticate."
        )
    access_token = oauth.get("accessToken")
    if not isinstance(access_token, str) or not access_token:
        raise SubscriptionAuthError(
            "Claude Code credentials have no access token; run `claude` to re-authenticate."
        )
    expires_at: float | None = None
    raw_expires = oauth.get("expiresAt")
    if isinstance(raw_expires, (int, float)):
        # Claude Code stores expiry as milliseconds since epoch.
        expires_at = float(raw_expires) / 1000.0
    return SubscriptionToken(token=access_token, expires_at=expires_at)


def load_codex_credentials(path: str | None = None) -> SubscriptionToken:
    """Read the Codex (ChatGPT) OAuth access token (read-only, no refresh)."""
    resolved = Path(os.path.expanduser(path or DEFAULT_CODEX_CREDENTIALS_PATH))
    if not resolved.exists():
        raise SubscriptionAuthError(
            "No Codex credentials found. Run `codex login` and sign in with your "
            f"ChatGPT subscription first (looked at {resolved})."
        )
    try:
        data = json.loads(resolved.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise SubscriptionAuthError(
            f"Could not read Codex credentials at {resolved}: {exc}"
        ) from exc
    tokens = data.get("tokens") if isinstance(data, dict) else None
    if not isinstance(tokens, dict):
        raise SubscriptionAuthError(
            "Codex credentials are missing the 'tokens' block; run `codex login`."
        )
    access_token = tokens.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        raise SubscriptionAuthError(
            "Codex credentials have no access token; run `codex login`."
        )
    claims = _decode_jwt_claims(access_token)
    account_id = tokens.get("account_id")
    if not isinstance(account_id, str) or not account_id:
        account_id = _codex_account_id_from_claims(claims)
    expires_at: float | None = None
    exp = claims.get("exp")
    if isinstance(exp, (int, float)):
        expires_at = float(exp)
    return SubscriptionToken(token=access_token, expires_at=expires_at, account_id=account_id)


def _token_env_credential(env_var: str) -> SubscriptionToken:
    value = os.environ.get(env_var)
    if not value:
        raise SubscriptionAuthError(
            f"Subscription token env var {env_var!r} is unset or empty."
        )
    claims = _decode_jwt_claims(value)
    expires_at = float(claims["exp"]) if isinstance(claims.get("exp"), (int, float)) else None
    return SubscriptionToken(
        token=value,
        expires_at=expires_at,
        account_id=_codex_account_id_from_claims(claims),
    )


def _load_for_mode(mode: SubscriptionAuthMode, path: str | None) -> SubscriptionToken:
    match mode:
        case "claude-code":
            return load_claude_code_credentials(path)
        case "codex":
            return load_codex_credentials(path)
        case "api_key":
            raise SubscriptionAuthError(
                "resolve_credential() called for an api_key endpoint; use resolve_api_key()."
            )
        case _ as unreachable:
            assert_never(unreachable)


def _login_hint(mode: SubscriptionAuthMode) -> str:
    if mode == "claude-code":
        return "run `claude` to re-authenticate your Claude subscription"
    return "run `codex login` to re-authenticate your ChatGPT subscription"


def resolve_credential(endpoint: ModelEndpoint) -> SubscriptionToken:
    """Resolve the current subscription token for an endpoint (per request).

    Reads the CLI credential store read-only, with a short TTL cache, and raises
    :class:`SubscriptionAuthError` (with a re-login hint) if the token is expired.
    """
    auth = endpoint.auth
    mode = auth.mode
    if auth.token_env:
        token = _token_env_credential(auth.token_env)
        _ensure_fresh(token, mode)
        return token

    cache_key = (mode, auth.credentials_path or "")
    now = time.time()
    cached = _CACHE.get(cache_key)
    if cached is not None:
        fetched_at, token = cached
        fresh_enough = (now - fetched_at) < _CACHE_TTL_S
        not_near_expiry = not token.is_expired(skew_s=_EXPIRY_SKEW_S)
        if fresh_enough and not_near_expiry:
            return token

    token = _load_for_mode(mode, auth.credentials_path)
    _ensure_fresh(token, mode)
    _CACHE[cache_key] = (now, token)
    return token


def _ensure_fresh(token: SubscriptionToken, mode: SubscriptionAuthMode) -> None:
    if token.is_expired():
        raise SubscriptionAuthError(
            f"Subscription token expired; {_login_hint(mode)}."
        )


def clear_credential_cache() -> None:
    """Drop all cached subscription tokens (used by tests)."""
    _CACHE.clear()


@dataclass(frozen=True)
class SubscriptionStatus:
    """Non-sensitive snapshot of a subscription login (for `auth status`)."""

    mode: SubscriptionAuthMode
    available: bool
    expired: bool = False
    expires_at: float | None = None
    account_id: str | None = None
    source: str | None = None
    detail: str = ""

    @property
    def hours_to_expiry(self) -> float | None:
        if self.expires_at is None:
            return None
        return (self.expires_at - time.time()) / 3600.0


def _claude_credentials_source(path: str | None) -> str | None:
    resolved = Path(os.path.expanduser(path or DEFAULT_CLAUDE_CREDENTIALS_PATH))
    if resolved.exists():
        return str(resolved)
    if sys.platform == "darwin" and _read_macos_keychain(CLAUDE_CODE_KEYCHAIN_SERVICE):
        return "macOS Keychain"
    return None


def subscription_status(
    mode: SubscriptionAuthMode, path: str | None = None
) -> SubscriptionStatus:
    """Report whether a subscription login is present, without raising.

    Reads the CLI credential store read-only and never returns or prints the
    token itself. An expired login is reported as ``available=True, expired=True``
    so callers can prompt the user to re-run the CLI.
    """
    if mode == "api_key":
        return SubscriptionStatus(mode=mode, available=False, detail="not a subscription mode")
    source = _claude_credentials_source(path) if mode == "claude-code" else None
    try:
        token = _load_for_mode(mode, path)
    except SubscriptionAuthError as exc:
        return SubscriptionStatus(mode=mode, available=False, detail=str(exc))
    expired = token.is_expired()
    detail = _login_hint(mode) if expired else "logged in"
    if mode == "codex":
        source = os.path.expanduser(path or DEFAULT_CODEX_CREDENTIALS_PATH)
    return SubscriptionStatus(
        mode=mode,
        available=True,
        expired=expired,
        expires_at=token.expires_at,
        account_id=token.account_id,
        source=source,
        detail=detail,
    )


__all__ = [
    "SubscriptionAuthError",
    "SubscriptionStatus",
    "SubscriptionToken",
    "clear_credential_cache",
    "load_claude_code_credentials",
    "load_codex_credentials",
    "resolve_credential",
    "subscription_status",
]
