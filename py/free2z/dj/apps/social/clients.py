"""
Lazy, per-provider OAuth2 (authorization-code + PKCE S256) clients for social
login: X (Twitter), Google, GitHub.

CRITICAL boot-safety (the  lesson): importing this module must NOT read any
secret or import any provider SDK at module scope. Every provider's credentials
are read LAZILY from Django settings -- which default to "" when the env var is
unset -- only when a request actually exercises that provider. A provider whose
client id/secret is blank is "not configured": the views return 503 (never 500,
never a boot failure), and the URLconf imports cleanly with ZERO env vars set.

Each client can:
  * ``is_configured()``            -> bool (both id and secret present)
  * ``build_authorize_url(...)``   -> the provider's consent URL (PKCE S256)
  * ``login(code, verifier, uri)`` -> {"uid", "handle", "avatar_url"}

``login`` performs code -> access-token -> identity in one call. ``uid`` is the
provider's STABLE id (X numeric id / Google ``sub`` / GitHub id), never the
handle.
"""
import base64
import hashlib
import secrets as _secrets
from urllib.parse import urlencode, urlparse

import requests
from django.conf import settings

# Providers this app knows about. A provider being listed here does NOT mean it
# is configured -- see ``is_configured()``.
PROVIDER_KEYS = ("x", "google", "github")
ZUULI_MOBILE_PKCE_PROVIDERS = frozenset({"x", "google"})
ZUULI_MOBILE_RELAY_HOSTS = frozenset({
    "free2z.cash",
    "stage.free2z.cash",
    "test.free2z.cash",
    "new.free2z.cash",
})
ZUULI_MOBILE_RELAY_PATH = "/api/auth/social/mobile/callback"

_HTTP_TIMEOUT = 15


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def generate_state() -> str:
    return _secrets.token_urlsafe(24)


def pkce_challenge(verifier: str) -> str:
    """Derive an RFC 7636 S256 challenge from an ASCII verifier."""
    return _b64url(hashlib.sha256(verifier.encode("ascii")).digest())


def generate_pkce_pair() -> tuple[str, str]:
    """Return ``(verifier, challenge)`` for PKCE method S256 (RFC 7636)."""
    verifier = _b64url(_secrets.token_bytes(32))
    return verifier, pkce_challenge(verifier)


class ProviderError(Exception):
    """A provider-side failure (bad code, token/userinfo error, outage)."""


class BaseProvider:
    key = ""
    # PKCE is universal here; GitHub OAuth *apps* ignore the challenge params
    # harmlessly, so we simply don't send them for GitHub (supports_pkce=False)
    # while still using the single-use ``state`` store for CSRF protection.
    supports_pkce = True
    authorize_endpoint = ""
    token_endpoint = ""
    scope = ""
    # settings attribute names for the credentials (read lazily).
    client_id_setting = ""
    client_secret_setting = ""

    def client_id(self) -> str:
        return getattr(settings, self.client_id_setting, "") or ""

    def client_secret(self) -> str:
        return getattr(settings, self.client_secret_setting, "") or ""

    def is_configured(self) -> bool:
        return bool(self.client_id() and self.client_secret())

    def build_authorize_url(
        self, redirect_uri: str, state: str, code_challenge: str,
    ) -> str:
        params = {
            "response_type": "code",
            "client_id": self.client_id(),
            "redirect_uri": redirect_uri,
            "scope": self.scope,
            "state": state,
        }
        if self.supports_pkce:
            params["code_challenge"] = code_challenge
            params["code_challenge_method"] = "S256"
        params.update(self.extra_authorize_params())
        return f"{self.authorize_endpoint}?{urlencode(params)}"

    def extra_authorize_params(self) -> dict:
        return {}

    def login(self, code: str, code_verifier: str, redirect_uri: str) -> dict:
        raise NotImplementedError


class XProvider(BaseProvider):
    key = "x"
    supports_pkce = True
    scope = "tweet.read users.read"
    authorize_endpoint = "https://twitter.com/i/oauth2/authorize"
    # X reuses the existing OAuth2 twitter credentials.
    client_id_setting = "TWITTER_CLIENT_ID"
    client_secret_setting = "TWITTER_CLIENT_SECRET"

    def login(self, code: str, code_verifier: str, redirect_uri: str) -> dict:
        # Reuse the existing reusable OAuth2 client. Imported lazily so this
        # module (and the URLconf) never pulls it in at load time.
        from twatter.v2.client import TwitterClient

        cli = TwitterClient(
            self.client_id(), self.client_secret(), redirect_uri,
        )
        try:
            cli.exchange_code_for_token(code, code_verifier)
            me = cli.get_me()
        except Exception as exc:  # noqa: BLE001 - normalize to ProviderError
            raise ProviderError(str(exc)) from exc
        uid = str(me.get("id") or "")
        if not uid:
            raise ProviderError("X returned no user id")
        return {
            "uid": uid,
            "handle": me.get("username") or me.get("name") or "",
            "avatar_url": me.get("profile_image_url") or "",
        }


class GoogleProvider(BaseProvider):
    key = "google"
    supports_pkce = True
    scope = "openid email profile"
    authorize_endpoint = "https://accounts.google.com/o/oauth2/v2/auth"
    token_endpoint = "https://oauth2.googleapis.com/token"
    userinfo_endpoint = "https://openidconnect.googleapis.com/v1/userinfo"
    client_id_setting = "GOOGLE_CLIENT_ID"
    client_secret_setting = "GOOGLE_CLIENT_SECRET"

    def extra_authorize_params(self) -> dict:
        # Online access only -- we never store a refresh token.
        return {"access_type": "online", "prompt": "select_account"}

    def login(self, code: str, code_verifier: str, redirect_uri: str) -> dict:
        data = {
            "code": code,
            "client_id": self.client_id(),
            "client_secret": self.client_secret(),
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
            "code_verifier": code_verifier,
        }
        try:
            tok = requests.post(
                self.token_endpoint, data=data, timeout=_HTTP_TIMEOUT,
                headers={"Accept": "application/json"},
            )
            if tok.status_code != 200:
                raise ProviderError(tok.text)
            access_token = tok.json().get("access_token")
            if not access_token:
                raise ProviderError("Google returned no access_token")
            info = requests.get(
                self.userinfo_endpoint,
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=_HTTP_TIMEOUT,
            )
            if info.status_code != 200:
                raise ProviderError(info.text)
            profile = info.json()
        except ProviderError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ProviderError(str(exc)) from exc
        uid = str(profile.get("sub") or "")
        if not uid:
            raise ProviderError("Google returned no sub")
        return {
            "uid": uid,
            "handle": (
                profile.get("email")
                or profile.get("name")
                or profile.get("preferred_username")
                or ""
            ),
            "avatar_url": profile.get("picture") or "",
        }


class GitHubProvider(BaseProvider):
    key = "github"
    # GitHub OAuth apps do not support PKCE; the single-use ``state`` store is
    # the CSRF protection. We still generate/store a verifier for uniformity.
    supports_pkce = False
    scope = "read:user"
    authorize_endpoint = "https://github.com/login/oauth/authorize"
    token_endpoint = "https://github.com/login/oauth/access_token"
    user_endpoint = "https://api.github.com/user"
    client_id_setting = "GITHUB_CLIENT_ID"
    client_secret_setting = "GITHUB_CLIENT_SECRET"

    def login(self, code: str, code_verifier: str, redirect_uri: str) -> dict:
        data = {
            "client_id": self.client_id(),
            "client_secret": self.client_secret(),
            "code": code,
            "redirect_uri": redirect_uri,
        }
        try:
            tok = requests.post(
                self.token_endpoint, data=data, timeout=_HTTP_TIMEOUT,
                headers={"Accept": "application/json"},
            )
            if tok.status_code != 200:
                raise ProviderError(tok.text)
            access_token = tok.json().get("access_token")
            if not access_token:
                raise ProviderError("GitHub returned no access_token")
            user = requests.get(
                self.user_endpoint,
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Accept": "application/vnd.github+json",
                },
                timeout=_HTTP_TIMEOUT,
            )
            if user.status_code != 200:
                raise ProviderError(user.text)
            profile = user.json()
        except ProviderError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ProviderError(str(exc)) from exc
        uid = str(profile.get("id") or "")
        if not uid:
            raise ProviderError("GitHub returned no id")
        return {
            "uid": uid,
            "handle": profile.get("login") or profile.get("name") or "",
            "avatar_url": profile.get("avatar_url") or "",
        }


_REGISTRY = {
    "x": XProvider,
    "google": GoogleProvider,
    "github": GitHubProvider,
}


def get_provider(key: str) -> BaseProvider | None:
    """Return a provider instance for ``key``, or None if unknown."""
    cls = _REGISTRY.get(key)
    return cls() if cls else None


def configured_providers() -> dict:
    """
    {provider_key: is_configured_bool} for every known provider. Reads only
    presence of credentials -- NEVER returns any secret value.
    """
    return {key: get_provider(key).is_configured() for key in PROVIDER_KEYS}


def mobile_provider_redirect_uri() -> str | None:
    """Return the operator-controlled HTTPS relay URI, or fail closed."""
    raw_uri = getattr(settings, "ZUULI_MOBILE_OAUTH_PROVIDER_REDIRECT_URI", "")
    if not isinstance(raw_uri, str):
        return None
    uri = raw_uri.strip()
    try:
        parsed = urlparse(uri)
        port = parsed.port
    except (AttributeError, ValueError):
        return None
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.hostname not in ZUULI_MOBILE_RELAY_HOSTS
        or parsed.username
        or parsed.password
        or parsed.params
        or parsed.query
        or parsed.fragment
        or parsed.path != ZUULI_MOBILE_RELAY_PATH
        or port is not None
    ):
        return None
    return uri


def configured_mobile_providers(
    *, enforce_rollout_gate: bool = True,
) -> dict[str, bool]:
    """Provider readiness for native apps, optionally including its gate."""
    enabled = (
        getattr(settings, "ZUULI_SOCIAL_AUTH_ENABLED", False) is True
        if enforce_rollout_gate
        else True
    )
    relay_ready = mobile_provider_redirect_uri() is not None
    configured = configured_providers()
    return {
        key: bool(
            enabled
            and relay_ready
            and key in ZUULI_MOBILE_PKCE_PROVIDERS
            and ok
        )
        for key, ok in configured.items()
    }
