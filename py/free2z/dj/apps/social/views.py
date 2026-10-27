"""
Multi-provider social login ("ZUULI Social Login v1") — knox-native.

Modeled 1:1 on ``dj.apps.zauth``. Two-step OAuth2 authorization-code + PKCE:

  1. GET  /api/auth/social/{provider}/start?redirect_uri=…
         -> {authorize_url, state}
     Mobile providers return to an owned HTTPS relay, which atomically consumes
     their authorization state and redirects to ZUULI's one fixed app URI.
  2. POST /api/auth/social/{provider}/  {code, state, redirect_uri, otp_token?}
         -> knox token (dual-mode: login-or-create, or ASSOCIATE to the
            authenticated Creator with a 409 if the identity is linked
            elsewhere — exactly like ``ZcashLoginView``).

Plus:
  GET    /api/auth/social/            -> list caller's linked identities (auth)
  DELETE /api/auth/social/{p}/{uid}/  -> unlink own identity (auth)
  GET    /api/auth/social/providers/  -> which providers are configured (public)
  GET    /api/auth/social/mobile/providers/ -> mobile rollout readiness (public)

BOOT-SAFETY: no provider SDK or secret is imported/read at load time.
An unconfigured provider yields 503 — never a 500, never a boot failure.
"""
import logging
import hashlib
import re
import secrets
import time
from urllib.parse import urlencode, urlparse

from django.conf import settings
from django.db import OperationalError, transaction
from django.http import HttpResponse

from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework import status


from dj.apps.g12f.models import Creator
from dj.apps.tuzis.welcome import identity_welcome_key, welcome_new_account
from dj.apps.identity.auth_context import (
    require_recent_auth, RecentAuthenticationRequired, record_existing_session_reauth,
)
from dj.apps.identity.auth_context import INHERIT, federated, record_login
from dj.apps.identity.methods import (
    LAST_SIGNIN_METHOD_DETAIL,
    can_remove,
    method_of,
    signin_survives,
)
from dj.apps.ktauth.credentials import (
    STALE_IDENTITY_DETAIL,
    identity_can_authenticate,
    issue_bearer_token,
)
from dj.apps.ktauth.epoch import (
    EVENT_SOCIAL_IDENTITY_UNLINKED,
    bump_account_epoch,
)
from dj.apps.otp.utils import (
    INVALID_OTP_TOKEN_MESSAGE,
    claim_totp_attempt,
    clear_totp_attempt,
    check_user_totp,
    has_active_totp,
)
from dj.apps.g12f.usernames import is_forbidden_username
from dj.free2z.throttling import (
    OAUTH_COMPLETION_THROTTLES,
    OAUTH_STATE_THROTTLES,
)

from .models import SocialIdentity
from .state import store_state, get_state, pop_state
from .clients import (
    get_provider,
    generate_state,
    generate_pkce_pair,
    pkce_challenge,
    configured_providers,
    configured_mobile_providers,
    mobile_provider_redirect_uri,
    ZUULI_MOBILE_PKCE_PROVIDERS,
    ZUULI_MOBILE_RELAY_HOSTS as ZUULI_MOBILE_RELAY_HOSTS,
    ZUULI_MOBILE_RELAY_PATH,
    ProviderError,
)

logger = logging.getLogger(__name__)

ZUULI_MOBILE_REDIRECT_URI = "cash.free2z.zuuli://oauth/callback"
_DESKTOP_LOOPBACK_PATH = re.compile(r"^/[0-9a-f]{32}$")
_PKCE_CHALLENGE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_PKCE_VERIFIER = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")
_PROVIDER_ERROR = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
_OAUTH_STATE = re.compile(r"^[\x21-\x7e]{16,512}$")
_MOBILE_RELAY_PATH = ZUULI_MOBILE_RELAY_PATH
_MAX_CODE_BYTES = 4096
_MOBILE_COMPLETION_TTL_SECONDS = 300
_CLOCK_SKEW_SECONDS = 5
SOCIAL_MFA_ATTEMPT_LIMIT = 5
SOCIAL_MFA_ATTEMPT_TTL_SECONDS = 300


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _social_mfa(creator, otp_token):
    """``(failure response or None, second factor or None)``.

    The second element is ``"otp"`` only when a code was verified and burned
    here, which is what the new token's AuthContext records.
    """
    if not has_active_totp(creator):
        return None, None

    attempt = claim_totp_attempt(
        "social",
        creator.pk,
        SOCIAL_MFA_ATTEMPT_TTL_SECONDS,
    )
    if attempt is None:
        return Response(
            {"detail": "Social login is temporarily unavailable."},
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        ), None
    if attempt > SOCIAL_MFA_ATTEMPT_LIMIT:
        return Response(
            {"detail": "Too many social login attempts. Start again."},
            status=status.HTTP_429_TOO_MANY_REQUESTS,
        ), None
    gate = check_user_totp(creator, otp_token)
    if not gate.passed:
        failure_status = (
            status.HTTP_429_TOO_MANY_REQUESTS
            if attempt == SOCIAL_MFA_ATTEMPT_LIMIT
            else status.HTTP_400_BAD_REQUEST
        )
        return Response(
            {"detail": INVALID_OTP_TOKEN_MESSAGE},
            status=failure_status,
        ), None
    return None, gate.second_factor


def _allowed_origins() -> set:
    origins = set(getattr(settings, "SOCIAL_REDIRECT_URI_ALLOWLIST", []) or [])
    origins.update(getattr(settings, "CORS_ORIGIN_WHITELIST", []) or [])
    return origins


def _mobile_provider_redirect_uri() -> str | None:
    """Compatibility seam for the relay binding used throughout this module."""
    return mobile_provider_redirect_uri()


def _code_digest(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def _valid_state(value: object) -> bool:
    return (
        isinstance(value, str)
        and bool(_OAUTH_STATE.fullmatch(value))
        and '"' not in value
        and "\\" not in value
    )


def _body_string(data, name: str) -> str:
    value = data.get(name)
    return value.strip() if isinstance(value, str) else ""


def _redirect_to_zuuli(params: dict[str, str]) -> HttpResponse:
    # Never derive the scheme, host, path, or destination from the request.
    # Django's HttpResponseRedirect intentionally disallows custom schemes, so
    # set the fixed Location header directly after encoding bounded values.
    response = HttpResponse(status=302)
    response["Location"] = f"{ZUULI_MOBILE_REDIRECT_URI}?{urlencode(params)}"
    response["Cache-Control"] = "no-store"
    response["Pragma"] = "no-cache"
    response["Referrer-Policy"] = "no-referrer"
    response["X-Content-Type-Options"] = "nosniff"
    return response


def _relay_error(detail: str, reason: str) -> Response:
    # The load balancer and nginx deliberately do not log this credential-
    # bearing route. Emit only a bounded reason code—never state, code, URI,
    # verifier, or request data—so production failures remain observable.
    logger.warning("social mobile relay rejected reason=%s", reason)
    response = Response({"detail": detail}, status=status.HTTP_400_BAD_REQUEST)
    response["Cache-Control"] = "no-store"
    response["Pragma"] = "no-cache"
    response["Referrer-Policy"] = "no-referrer"
    response["X-Content-Type-Options"] = "nosniff"
    return response


def is_allowed_redirect_uri(uri: str, provider: str | None = None) -> bool:
    """
    Server-side allowlist for the OAuth ``redirect_uri`` (open-redirect
    guard). The sole private-use URI is ZUULI's canonical mobile callback and
    only PKCE-S256-capable providers may use it. Desktop loopback is a strict
    ephemeral 127.0.0.1 URI with ZUULI's 128-bit path nonce. Web redirects
    remain limited to explicitly configured origins.
    """
    if not uri:
        return False
    if uri == ZUULI_MOBILE_REDIRECT_URI:
        return provider in ZUULI_MOBILE_PKCE_PROVIDERS
    try:
        p = urlparse(uri)
        port = p.port
    except ValueError:
        return False
    if p.scheme not in ("http", "https"):
        return False
    if p.username or p.password or p.fragment:
        return False
    host = (p.hostname or "").lower()
    origin = f"{p.scheme}://{p.netloc}"
    # Explicit operator configuration wins before applying the stricter shape
    # reserved for ZUULI's dynamic desktop listener. This preserves existing
    # 127.0.0.1 web/dev origins without reopening arbitrary loopback ports.
    if origin in _allowed_origins():
        return True
    if p.scheme == "http" and host == "127.0.0.1":
        return bool(
            port is not None
            and 1024 <= port <= 65535
            and not p.params
            and not p.query
            and _DESKTOP_LOOPBACK_PATH.fullmatch(p.path)
        )
    return False


def _handle_base(handle: str) -> str:
    """
    The username base ``username_for_identity`` derives from a provider
    handle: the email local-part, reduced to characters the username
    validator allows. Empty when the handle carries nothing usable -- which
    is exactly when ``username_for_identity`` falls back to
    ``{provider}{uid}``, a name no human ever chose. One definition
    rather than two so the collision pre-check below cannot drift from what
    provisioning would actually attempt first.
    """
    raw = (handle or "").split("@")[0]
    return re.sub(r"[^A-Za-z0-9_.\-]", "", raw)


def handle_clashes_existing_account(handle: str) -> bool:
    """: does this identity's *human-chosen* handle collide with an
    existing account's username, case-insensitively?

    Threat reasoning: a matching handle is NOT proof of ownership. Anyone
    can register ``@alice`` on X; that must not hand them free2z's
    ``alice``, and silently minting a near-miss duplicate such as
    ``alice1`` is how two duplicate pairs reached production. So a match
    means refuse-and-explain -- never attach (attaching is what the
    authenticated association path is for, where ownership is proven by an
    authenticated session), and never provision a shadow account either.
    Only the handle-derived base counts. When the handle is empty/junk the
    base falls back to ``{provider}{uid}``, which nobody claims by choice,
    so provisioning with suffixing stays allowed -- a race collision there
    is incidental, not a hijack. Forbidden application namespaces keep
    today's suffix behaviour too: those are route names, not anyone's
    account.
    """
    # Same 140-char truncation username_for_identity applies, so the name
    # checked here is the first candidate provisioning would try to claim.
    base = _handle_base(handle)[:140]
    if not base:
        return False
    return Creator.objects.filter(username__iexact=base).exists()


def username_for_identity(provider: str, uid: str, handle: str) -> str:
    """
    Deterministic-ish, unique, username-validator-safe handle for a brand new
    social-only account. Derives from the display handle (email local-part or
    login), falling back to ``{provider}{uid}``, with a numeric suffix on
    collision (same discipline as ``zauth.username_for_address``).
    """
    base = _handle_base(handle)
    if not base:
        base = f"{provider}{uid}"
    base = base[:140] or f"{provider}{uid}"
    username = base
    suffix = 0
    while (
        is_forbidden_username(username)
        or Creator.objects.filter(username__iexact=username).exists()
    ):
        suffix += 1
        username = f"{base}{suffix}"
    return username


def _identity_dict(identity: SocialIdentity, account=None) -> dict:
    return {
        "provider": identity.provider,
        "provider_uid": identity.provider_uid,
        "handle": identity.handle,
        "avatar_url": identity.avatar_url,
        "verified_at": (
            identity.verified_at.isoformat() if identity.verified_at else None
        ),
        # Report actual fallback eligibility, not just an epoch mismatch. A
        # passwordless account may have one stale identity that still works;
        # showing that row as needing reconnect contradicted the login policy.
        "needs_reconnect": (
            account is not None
            and not identity_can_authenticate(identity, account)
        ),
    }


# Thin seam so tests can mock the provider code-exchange without any network.
def exchange_identity(provider_key: str, code: str, code_verifier: str,
                      redirect_uri: str) -> dict:
    provider = get_provider(provider_key)
    return provider.login(code, code_verifier, redirect_uri)


# --------------------------------------------------------------------------- #
# Views
# --------------------------------------------------------------------------- #
class SocialStartView(APIView):
    """
    GET /api/auth/social/{provider}/start?redirect_uri=… -> {authorize_url, state}

    Validates the app redirect against the server-side allowlist. Direct flows
    store a backend PKCE verifier; mobile stores only the app's S256 challenge
    and sends the provider to the fixed HTTPS relay. 503 if unconfigured.
    """
    permission_classes = [AllowAny]
    throttle_classes = OAUTH_STATE_THROTTLES

    @extend_schema(
        parameters=[
            OpenApiParameter(
                "redirect_uri", str, required=True,
                description=(
                    "Exact configured web redirect, strict ZUULI desktop "
                    "loopback URI, or cash.free2z.zuuli://oauth/callback."
                ),
            ),
            OpenApiParameter(
                "code_challenge", str, required=False,
                pattern=r"^[A-Za-z0-9_-]{43}$",
                description=(
                    "App-generated RFC 7636 S256 challenge; required only "
                    "for the ZUULI mobile callback and rejected otherwise."
                ),
            ),
        ],
        responses={
            200: inline_serializer(
                name="SocialOAuthStartResponse",
                fields={
                    "authorize_url": serializers.URLField(),
                    "state": serializers.CharField(),
                    "authorization_state": serializers.CharField(required=False),
                    "provider_redirect_uri": serializers.URLField(required=False),
                },
            ),
            400: inline_serializer(
                name="SocialOAuthError",
                fields={"detail": serializers.CharField()},
            ),
            503: inline_serializer(
                name="SocialOAuthUnavailable",
                fields={"detail": serializers.CharField()},
            ),
        },
    )
    def get(self, request, provider):
        prov = get_provider(provider)
        if prov is None:
            return Response(
                {"detail": f"Unknown provider '{provider}'."},
                status=status.HTTP_404_NOT_FOUND,
            )
        if not prov.is_configured():
            return Response(
                {"detail": f"Provider '{provider}' is not configured."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        redirect_values = request.query_params.getlist("redirect_uri")
        challenge_values = request.query_params.getlist("code_challenge")
        if len(redirect_values) != 1 or len(challenge_values) > 1:
            return Response(
                {"detail": "redirect_uri and code_challenge must not repeat."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        redirect_uri = (redirect_values[0] or "").strip()
        if not is_allowed_redirect_uri(redirect_uri, provider):
            return Response(
                {"detail": "redirect_uri is missing or not allowed."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        mobile = redirect_uri == ZUULI_MOBILE_REDIRECT_URI
        if (
            mobile
            and getattr(settings, "ZUULI_SOCIAL_AUTH_ENABLED", False) is not True
        ):
            return Response(
                {"detail": "mobile social OAuth is not enabled."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        supplied_challenge = (
            (challenge_values[0] or "").strip() if challenge_values else ""
        )
        if mobile:
            if not _PKCE_CHALLENGE.fullmatch(supplied_challenge):
                return Response(
                    {"detail": "mobile OAuth requires a valid PKCE S256 challenge."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            verifier, challenge = None, supplied_challenge
        else:
            if supplied_challenge:
                return Response(
                    {"detail": "client PKCE is allowed only for the mobile callback."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            verifier, challenge = generate_pkce_pair()

        if mobile:
            provider_redirect_uri = _mobile_provider_redirect_uri()
            if provider_redirect_uri is None:
                return Response(
                    {"detail": "mobile OAuth relay is not configured safely."},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            # The provider-facing state is consumed by the HTTPS relay. A
            # distinct app state is stored in ZUULI and later gates redemption;
            # duplicate provider callbacks cannot steal or replay it.
            authorization_state = generate_state()
            completion_state = generate_state()
            store_state(authorization_state, {
                "flow": "mobile_authorize",
                "completion_state": completion_state,
                "challenge": challenge,
                "app_redirect_uri": redirect_uri,
                "provider_redirect_uri": provider_redirect_uri,
                "provider": provider,
                "issued_at": int(time.time()),
            })
            authorize_url = prov.build_authorize_url(
                provider_redirect_uri, authorization_state, challenge,
            )
            return Response({
                "authorize_url": authorize_url,
                "state": completion_state,
                "authorization_state": authorization_state,
                "provider_redirect_uri": provider_redirect_uri,
            })

        state = generate_state()
        store_state(state, {
            "flow": "direct",
            "verifier": verifier,
            "redirect_uri": redirect_uri,
            "provider": provider,
        })
        authorize_url = prov.build_authorize_url(redirect_uri, state, challenge)
        return Response({"authorize_url": authorize_url, "state": state})


def relay_rejects_without_state_lookup(request) -> bool:
    """Will the relay 400 this request before it reaches Redis?

    Exactly the handler's first two refusals (shape, then state format), and
    nothing more: anything that passes these goes on to ``pop_state``. The
    completion throttle uses it to stay out of Redis for the same requests --
    see ``OAuthCompletionAnonRateThrottle``.
    ``test_relay_precheck_matches_the_handler`` pins the two together.
    """
    params = request.query_params
    states = params.getlist("state")
    codes = params.getlist("code")
    errors = params.getlist("error")
    return (
        len(states) != 1
        or (len(codes), len(errors)) not in ((1, 0), (0, 1))
        or not _valid_state(states[0])
    )


class ZuuliMobileOAuthRelayView(APIView):
    """Consume one provider callback and relay only to ZUULI's fixed URI."""
    permission_classes = [AllowAny]
    #. Shares the completion bucket with SocialLoginView. This route
    # reaches Django straight from the GCLB (no nginx), which the throttle's
    # identity handles -- a stock anon throttle here would be one global
    # bucket. See `dj.free2z.throttling.direct_gclb_client_ident`.
    throttle_classes = OAUTH_COMPLETION_THROTTLES
    rejects_without_state_lookup = staticmethod(
        relay_rejects_without_state_lookup
    )

    @extend_schema(
        parameters=[
            OpenApiParameter("state", str, required=True),
            OpenApiParameter("code", str, required=False),
            OpenApiParameter("error", str, required=False),
        ],
        responses={
            302: OpenApiResponse(
                description="Redirect to cash.free2z.zuuli://oauth/callback.",
            ),
            400: inline_serializer(
                name="SocialOAuthRelayError",
                fields={"detail": serializers.CharField()},
            ),
        },
        description=(
            "Provider-only callback. Atomically consumes provider state and "
            "redirects only to ZUULI's fixed private-use URI. Callers cannot "
            "supply a destination."
        ),
    )
    def get(self, request):
        states = request.query_params.getlist("state")
        codes = request.query_params.getlist("code")
        errors = request.query_params.getlist("error")
        if (
            len(states) != 1
            or (len(codes), len(errors)) not in ((1, 0), (0, 1))
        ):
            return _relay_error("provider callback is malformed.", "malformed")
        authorization_state = states[0]
        if not _valid_state(authorization_state):
            return _relay_error("provider callback state is invalid.", "state_format")
        stored = pop_state(authorization_state)
        if stored is None or stored.get("flow") != "mobile_authorize":
            return _relay_error(
                "provider callback is missing, expired, or replayed.",
                "state_missing_expired_or_replayed",
            )
        if stored.get("provider_redirect_uri") != _mobile_provider_redirect_uri():
            return _relay_error(
                "provider callback configuration changed.", "config_changed",
            )

        completion_state = stored.get("completion_state") or ""
        app_redirect_uri = stored.get("app_redirect_uri") or ""
        provider = stored.get("provider") or ""
        challenge = stored.get("challenge") or ""
        issued_at = stored.get("issued_at")
        if (
            not _valid_state(completion_state)
            or app_redirect_uri != ZUULI_MOBILE_REDIRECT_URI
            or provider not in ZUULI_MOBILE_PKCE_PROVIDERS
            or not _PKCE_CHALLENGE.fullmatch(challenge)
            or not isinstance(issued_at, int)
            or not -_CLOCK_SKEW_SECONDS <= int(time.time()) - issued_at < 600
        ):
            return _relay_error(
                "provider callback state failed validation.", "state_binding",
            )

        if errors:
            provider_error = errors[0]
            if not _PROVIDER_ERROR.fullmatch(provider_error):
                provider_error = "access_denied"
            return _redirect_to_zuuli({
                "error": provider_error,
                "state": completion_state,
            })

        code = codes[0]
        if not code or len(code.encode("utf-8")) > _MAX_CODE_BYTES:
            return _relay_error(
                "provider callback code is invalid.", "code_format",
            )
        store_state(completion_state, {
            "flow": "mobile_received",
            "provider": provider,
            "app_redirect_uri": app_redirect_uri,
            "provider_redirect_uri": stored["provider_redirect_uri"],
            "challenge": challenge,
            "code_digest": _code_digest(code),
            "issued_at": issued_at,
            "relayed_at": int(time.time()),
        }, ttl_seconds=_MOBILE_COMPLETION_TTL_SECONDS)
        return _redirect_to_zuuli({"code": code, "state": completion_state})


class SocialLoginView(APIView):
    """
    POST /api/auth/social/{provider}/  {code, state, redirect_uri, otp_token?}
    -> knox token.

    Dual-mode (identical to ZcashLoginView):
      * request carries a valid knox token  -> ASSOCIATE (provider, uid) to that
        Creator; 409 if that identity already belongs to a different Creator.
      * otherwise                           -> get-or-create a Creator for the
        identity and log in.
    """
    permission_classes = [AllowAny]
    #anonymous and credential-issuing, so it gets a per-source,
    # fail-closed bucket. An authenticated (associate-mode) caller keeps the
    # global user ceiling, as on every other anon-scoped view.
    throttle_classes = OAUTH_COMPLETION_THROTTLES

    @extend_schema(
        request=inline_serializer(
            name="SocialOAuthLoginRequest",
            fields={
                "code": serializers.CharField(),
                "state": serializers.CharField(),
                "redirect_uri": serializers.CharField(),
                "code_verifier": serializers.CharField(
                    required=False,
                    help_text=(
                        "Original 43-character app PKCE verifier; required "
                        "only for ZUULI mobile completion."
                    ),
                ),
                "otp_token": serializers.CharField(
                    required=False,
                    write_only=True,
                    max_length=10,
                    help_text=(
                        "Current authenticator code for an existing Creator; "
                        "required for association flows too; not required "
                        "for new accounts."
                    ),
                ),
            },
        ),
        responses={
            200: inline_serializer(
                name="SocialOAuthLoginResponse",
                fields={
                    "token": serializers.CharField(),
                    "expiry": serializers.DateTimeField(allow_null=True),
                    "username": serializers.CharField(),
                    "provider": serializers.CharField(),
                    "handle": serializers.CharField(),
                    "created": serializers.BooleanField(),
                    "linked": serializers.BooleanField(),
                },
            ),
            400: inline_serializer(
                name="SocialOAuthLoginError",
                fields={"detail": serializers.CharField()},
            ),
            409: inline_serializer(
                name="SocialOAuthConflict",
                fields={"detail": serializers.CharField()},
            ),
            403: inline_serializer(
                name="SocialOAuthForbidden",
                fields={"detail": serializers.CharField()},
            ),
            503: inline_serializer(
                name="SocialOAuthLoginUnavailable",
                fields={"detail": serializers.CharField()},
            ),
        },
    )
    def post(self, request, provider):
        prov = get_provider(provider)
        if prov is None:
            return Response(
                {"detail": f"Unknown provider '{provider}'."},
                status=status.HTTP_404_NOT_FOUND,
            )
        if not prov.is_configured():
            return Response(
                {"detail": f"Provider '{provider}' is not configured."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        code = _body_string(request.data, "code")
        state = _body_string(request.data, "state")
        redirect_uri = _body_string(request.data, "redirect_uri")
        code_verifier = _body_string(request.data, "code_verifier")
        otp_token = _body_string(request.data, "otp_token")
        if (
            not code
            or len(code.encode("utf-8")) > _MAX_CODE_BYTES
            or not _valid_state(state)
            or not redirect_uri
            or len(redirect_uri) > 2048
        ):
            return Response(
                {"detail": "code, state and redirect_uri are required."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if len(otp_token) > 10:
            return Response(
                {"detail": INVALID_OTP_TOKEN_MESSAGE},
                status=status.HTTP_400_BAD_REQUEST,
            )

        candidate = get_state(state)
        mobile = bool(candidate and candidate.get("flow") == "mobile_received")
        # Direct flows can consume immediately because the verifier is held by
        # this server. Mobile must first validate the app-held verifier: a
        # competing handler for the private-use URI knows code/state but not
        # the verifier and therefore cannot burn the legitimate app's state.
        stored = candidate if mobile else pop_state(state)
        stored_redirect_uri = (
            stored.get("app_redirect_uri") if mobile and stored else
            stored.get("redirect_uri") if stored else None
        )
        if (
            stored is None
            or stored.get("provider") != provider
            or stored_redirect_uri != redirect_uri
            or (not mobile and stored.get("flow") != "direct")
        ):
            return Response(
                {"detail": "state is missing, expired or does not match."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Defense in depth: re-validate the redirect_uri allowlist.
        if not is_allowed_redirect_uri(redirect_uri, provider):
            return Response(
                {"detail": "redirect_uri is not allowed."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if mobile:
            expected_challenge = stored.get("challenge") or ""
            issued_at = stored.get("issued_at")
            relayed_at = stored.get("relayed_at")
            rejection_reason = None
            if stored.get("flow") != "mobile_received":
                rejection_reason = "flow"
            elif stored.get("code_digest") != _code_digest(code):
                rejection_reason = "code_binding"
            elif not isinstance(issued_at, int) or not isinstance(relayed_at, int):
                rejection_reason = "timestamps"
            elif issued_at > relayed_at + _CLOCK_SKEW_SECONDS:
                rejection_reason = "timestamp_order"
            elif not -_CLOCK_SKEW_SECONDS <= (
                int(time.time()) - relayed_at
            ) < _MOBILE_COMPLETION_TTL_SECONDS:
                rejection_reason = "completion_expired"
            elif not _PKCE_VERIFIER.fullmatch(code_verifier):
                rejection_reason = "verifier_format"
            elif not secrets.compare_digest(
                pkce_challenge(code_verifier), expected_challenge,
            ):
                rejection_reason = "verifier_mismatch"
            if rejection_reason is not None:
                logger.warning(
                    "social mobile login rejected provider=%s reason=%s",
                    provider,
                    rejection_reason,
                )
                return Response(
                    {"detail": "PKCE verifier is missing or does not match."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            claimed = pop_state(state)
            if claimed != stored:
                logger.warning(
                    "social mobile login rejected provider=%s reason=state_race",
                    provider,
                )
                return Response(
                    {"detail": "state is missing, expired or replayed."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            exchange_verifier = code_verifier
            exchange_redirect_uri = stored.get("provider_redirect_uri") or ""
            if exchange_redirect_uri != _mobile_provider_redirect_uri():
                logger.warning(
                    "social mobile login rejected provider=%s reason=config_changed",
                    provider,
                )
                return Response(
                    {"detail": "mobile OAuth relay configuration changed."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        else:
            if code_verifier:
                return Response(
                    {"detail": "code_verifier is not valid for this OAuth state."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            exchange_verifier = stored.get("verifier") or ""
            exchange_redirect_uri = redirect_uri

        # (b) exchange code -> access token -> stable identity.
        try:
            identity = exchange_identity(
                provider, code, exchange_verifier, exchange_redirect_uri,
            )
        except ProviderError:
            logger.warning("social: %s code exchange failed", provider)
            return Response(
                {"detail": "Provider authorization failed."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except Exception:  # noqa: BLE001 - never 500 on a provider hiccup
            logger.exception("social: unexpected error exchanging %s", provider)
            return Response(
                {"detail": "Provider authorization failed."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        uid = identity["uid"]
        handle = identity.get("handle") or ""
        avatar_url = identity.get("avatar_url") or ""

        # (c) associate with logged-in account, or get-or-create by identity.
        acting_user = request.user if request.user.is_authenticated else None
        second_factor = None
        if acting_user is not None:
            mfa_error, second_factor = _social_mfa(acting_user, otp_token)
            if mfa_error is not None:
                return mfa_error
            # Serialize identity-set changes with ownership events.  Keep the
            # epoch from ``request.user`` below: it is the authentication
            # snapshot that proved this caller's token.  The lock only makes
            # the association mutation and event-time fallback marking see a
            # deliberate order, rather than allowing a link to commit halfway
            # through the three provider-table reads.
            Creator.objects.select_for_update().get(pk=acting_user.pk)
        # `select_related('creator')` is load-bearing, not a query-count
        # optimisation. It makes "this identity exists" and "the
        # account is at epoch N" ONE statement and therefore ONE snapshot.
        # Read as two statements under READ COMMITTED, an ownership event
        # committing between them yields a token stamped with the NEW epoch --
        # a credential minted for a principal that was just evicted, which
        # authenticates. See `dj.apps.ktauth.credentials`.
        existing = SocialIdentity.objects.select_related("creator").filter(
            provider=provider, provider_uid=uid,
        ).first()

        # The epoch to stamp anything issued by this request with. Taken from
        # the snapshot that validated the credential doing the issuing: for an
        # associate that is `request.user`, loaded by authentication from the
        # same row that proved the caller; for an anonymous login it is the
        # Creator joined to the identity above.
        issuing_epoch = None
        proved_existing_identity = (
            acting_user is not None and existing is not None
            and existing.creator_id == acting_user.pk
            and identity_can_authenticate(existing, acting_user)
        )
        if acting_user is not None:
            issuing_epoch = acting_user.kt_account_epoch
            if existing is not None and existing.creator_id != acting_user.id:
                return Response(
                    {"detail": "This account is linked to another Creator."},
                    status=status.HTTP_409_CONFLICT,
                )
            if existing is None or not identity_can_authenticate(existing, acting_user):
                try:
                    require_recent_auth(request)
                except RecentAuthenticationRequired as exc:
                    return exc.response()
            if existing is None:
                SocialIdentity.objects.create(
                    creator=acting_user,
                    provider=provider,
                    provider_uid=uid,
                    handle=handle,
                    avatar_url=avatar_url,
                    linked_at_epoch=issuing_epoch,
                )
                # Deliberately NOT an ownership-counter event.
                # Linking ADDS a principal; nothing about an assertion minted a
                # moment earlier became illegitimate, and the danger of a
                # hostile link is persistence rather than replay -- which the
                # UNLINK below is what addresses. `dj.apps.ktauth.epoch`'s
                # docstring carries the full asymmetry. ( landed as
                # refuse-not-link: provisioning never merges accounts, so the
                # asymmetry stands unchanged.)
                linked = True
            else:
                # RE-LINKING is how an owner recovers an identity their own
                # ownership event made stale. It is safe because it
                # requires an authenticated session, which after a password
                # change means the NEW password: the attacker whose planted
                # identity this refusal is aimed at cannot reach this branch.
                SocialIdentity.objects.filter(pk=existing.pk).update(
                    linked_at_epoch=issuing_epoch,
                    fallback_rejected_at_epoch=None,
                )
                linked = False
            creator = acting_user
            created = False
        elif existing is not None:
            creator = existing.creator
            if not identity_can_authenticate(existing, creator):
                return Response(
                    {"detail": STALE_IDENTITY_DETAIL},
                    status=status.HTTP_403_FORBIDDEN,
                )
            issuing_epoch = creator.kt_account_epoch
            created = False
            linked = False
        elif handle_clashes_existing_account(handle):
            #, refuse-not-link. The identity is new but its human
            # handle matches an existing account's username. A matching
            # handle proves nothing: an attacker registering @alice on X
            # must not get free2z's alice (so never attach), and must not
            # push a lookalike "alice1" duplicate into existence either.
            # Ownership is proven by an authenticated session -- which is
            # exactly the association branch above; point the person there.
            logger.warning(
                "social provisioning refused: %s handle collides with an "
                "existing Creator username",
                provider,
            )
            return Response(
                {
                    "detail": (
                        "A free2z account with this name already exists. "
                        "Sign in to your existing account and link this "
                        f"{provider} login from your settings instead."
                    ),
                },
                status=status.HTTP_409_CONFLICT,
            )
        else:
            creator = Creator(
                username=username_for_identity(provider, uid, handle),
            )
            # Social-only account: no password login.
            creator.set_unusable_password()
            creator.save()
            issuing_epoch = creator.kt_account_epoch
            SocialIdentity.objects.create(
                creator=creator,
                provider=provider,
                provider_uid=uid,
                handle=handle,
                avatar_url=avatar_url,
                linked_at_epoch=issuing_epoch,
            )
            #the welcome 2Z, in this request's transaction
            # (AtomicMiddleware). Never fails the sign-up.
            # Keyed on the provider identity, not the account: an unlinked
            # identity that provisions a new account gets no second grant.
            welcome_new_account(
                creator, path=f"social:{provider}",
                identity_key=identity_welcome_key(
                    provider, uid),
            )
            created = True
            linked = True

        # An inactive account is refused as soon as the provider identity has
        # resolved it. Pending deletion remains eligible for its keep flow,
        # which is gated below only after any enrolled TOTP is verified.
        if acting_user is None:
            from dj.apps.g12f import account_deletion

            try:
                account_deletion.ensure_account_can_sign_in(creator)
            except account_deletion.InactiveAccount as exc:
                return Response(
                    {"detail": exc.detail},
                    status=status.HTTP_403_FORBIDDEN,
                )

        # Anonymous reuse of an existing Creator must prove the active TOTP
        # factor before the Knox token is minted. Authenticated association
        # was checked before any identity mutation above for the same reason:
        # this endpoint still returns a fresh Knox credential.
        if acting_user is None:
            mfa_error, second_factor = _social_mfa(creator, otp_token)
            if mfa_error is not None:
                return mfa_error

        # A sign-in to an account in its deletion grace period gets a keep
        # token, never a credential (dj.apps.g12f.account_deletion). After
        # the TOTP, so the keep step carries the same proof a token would.
        if acting_user is None:
            try:
                account_deletion.login_gate(
                    creator, methods=[federated(provider)],
                    second_factor=second_factor, credential="knox",
                )
            except account_deletion.DeletionPending as exc:
                clear_totp_attempt("social", creator.pk)
                return account_deletion.deletion_pending_response(exc)
            except account_deletion.InactiveAccount as exc:
                return Response(
                    {"detail": exc.detail},
                    status=status.HTTP_403_FORBIDDEN,
                )

        # (d) issue a knox token, stamped with the epoch read in the same
        # snapshot that validated the identity above, and record how
        # it was earned: the provider round trip, plus the TOTP when
        # one was verified above. An ASSOCIATION is not a sign-in: it proves
        # an identity the caller may have just linked themselves, so its
        # token inherits the calling credential's context instead of a
        # fresh one.
        instance, token = issue_bearer_token(creator, issuing_epoch)
        if acting_user is not None and not proved_existing_identity:
            record_login(
                request, creator,
                methods=INHERIT,
                token=instance,
                account_epoch=issuing_epoch,
            )
        else:
            record_login(
                request, creator,
                methods=[federated(provider)],
                second_factor=second_factor,
                token=instance,
                account_epoch=issuing_epoch,
            )
        if proved_existing_identity:
            record_existing_session_reauth(
                request, creator, methods=[federated(provider)],
                second_factor=second_factor, account_epoch=issuing_epoch,
            )
        clear_totp_attempt("social", creator.pk)

        # (e) response.
        return Response({
            "token": token,
            "expiry": instance.expiry.isoformat() if instance.expiry else None,
            "username": creator.username,
            "provider": provider,
            "handle": handle,
            "created": created,
            "linked": linked,
        })


class SocialIdentityListView(APIView):
    """GET /api/auth/social/ -> the caller's linked social identities."""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        rows = SocialIdentity.objects.filter(creator=request.user)
        return Response([
            _identity_dict(r, request.user) for r in rows
        ])


class _LastSignInMethodLost(Exception):
    """Raised inside the unlink transaction to roll it back."""


_RETRY_DETAIL = (
    "Another change to your sign-in methods is in progress. Try again."
)


def _is_deadlock(exc) -> bool:
    cause = exc.__cause__
    code = getattr(cause, "sqlstate", None) or getattr(cause, "pgcode", None)
    return code == "40P01"


class SocialUnlinkView(APIView):
    """DELETE /api/auth/social/{provider}/{uid}/ -> unlink own identity."""
    permission_classes = [IsAuthenticated]

    @extend_schema(
        responses={
            204: OpenApiResponse(description="The identity was unlinked."),
            404: inline_serializer(
                name="SocialUnlinkNotFound",
                fields={"detail": serializers.CharField()},
            ),
            409: inline_serializer(
                name="SocialUnlinkLastSignInMethod",
                fields={"detail": serializers.CharField()},
            ),
            503: inline_serializer(
                name="SocialUnlinkRetry",
                fields={"detail": serializers.CharField()},
            ),
        },
    )
    def delete(self, request, provider, uid):
        # Explicitly atomic (codex adversarial review). It predates
        # `AtomicMiddleware` wrapping DELETE  and stays so the
        # invariant lives with the code that needs it. Without it the row
        # deletion commits on its own and the counter bump
        # is a second, independent commit -- so a dropped connection between
        # them permanently removes the credential while leaving the epoch
        # unchanged, and an assertion minted before the eviction stays
        # spendable through the action taken to evict it.
        try:
            with transaction.atomic():
                account = Creator.objects.select_for_update().get(
                    pk=request.user.pk,
                )
                # Never remove the account's last way to sign in.
                # `can_remove` is the fast path. It locks the Creator row, so
                # two concurrent unlinks cannot each count the other as the
                # survivor, and the lock is held through the delete and the
                # epoch bump below.
                identity = SocialIdentity.objects.filter(
                    creator=account, provider=provider, provider_uid=uid,
                ).first()
                if identity is None:
                    return Response(
                        {"detail": "No such linked identity."},
                        status=status.HTTP_404_NOT_FOUND,
                    )
                if not can_remove(account, method_of(identity)):
                    return Response(
                        {"detail": LAST_SIGNIN_METHOD_DETAIL},
                        status=status.HTTP_409_CONFLICT,
                    )
                deleted, _ = SocialIdentity.objects.filter(
                    creator=account, provider=provider, provider_uid=uid,
                ).delete()
                if not deleted:
                    return Response(
                        {"detail": "No such linked identity."},
                        status=status.HTTP_404_NOT_FOUND,
                    )
                # An account-ownership event: the owner just evicted
                # a credential that could sign in as them. Only when
                # something was actually removed -- a 404 changed nothing.
                bump_account_epoch(
                    request.user.pk, event=EVENT_SOCIAL_IDENTITY_UNLINKED
                )
                # The authoritative check. The bump itself can change which
                # of the remaining identities may sign in (the passwordless
                # fallback selection, ), so verify the outcome instead
                # of trusting the prediction above. Raising rolls back the
                # delete, the bump and its token revocation together.
                if not signin_survives(request.user):
                    raise _LastSignInMethodLost
        except _LastSignInMethodLost:
            return Response(
                {"detail": LAST_SIGNIN_METHOD_DETAIL},
                status=status.HTTP_409_CONFLICT,
            )
        except OperationalError as exc:
            # The guard locks the Creator row and then identity rows. The
            # legacy Twitter delete and disable paths lock their own row
            # first and the Creator row later, so a concurrent pair can
            # deadlock. Postgres aborts one side and nothing was changed, so
            # say that instead of returning a 500.
            if not _is_deadlock(exc):
                raise
            response = Response(
                {"detail": _RETRY_DETAIL},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
            response["Retry-After"] = "1"
            # A designed, retryable answer, not a server fault. Without this,
            # `django.request` logs every 5xx at ERROR. Log it once here at
            # WARNING instead, the way  handles a designed 409.
            # `_has_been_logged` is the flag Django's own `log_response()`
            # checks before logging a response.
            logger.warning(
                "social unlink for account %s hit a lock-order deadlock; "
                "answered 503 with Retry-After",
                request.user.pk,
            )
            response._has_been_logged = True
            return response
        return Response(status=status.HTTP_204_NO_CONTENT)


class SocialProviderAvailabilitySerializer(serializers.Serializer):
    # Keep this a string rather than a generated enum: clients must fail closed
    # on unknown future providers instead of assuming this list is exhaustive.
    provider = serializers.CharField()
    configured = serializers.BooleanField()
    web_reauthentication = serializers.BooleanField(required=False)


class SocialProviderDiscoverySerializer(serializers.Serializer):
    providers = SocialProviderAvailabilitySerializer(many=True)


class SocialProvidersView(APIView):
    """
    GET /api/auth/social/providers/ -> which providers have credentials, so
    direct desktop/web login can render its available buttons. This established
    contract is independent of the narrower mobile rollout gate. NEVER leaks
    any secret value.
    """
    permission_classes = [AllowAny]

    @extend_schema(responses={200: SocialProviderDiscoverySerializer})
    def get(self, request):
        configured = configured_providers()
        response = Response({
            "providers": [
                {
                    "provider": key, "configured": ok,
                    "web_reauthentication": bool(ok and key in getattr(
                        settings, "SOCIAL_WEB_REAUTH_PROVIDERS", (),
                    )),
                }
                for key, ok in configured.items()
            ],
        })
        response["Cache-Control"] = "no-store"
        return response


class ZuuliMobileSocialProvidersView(APIView):
    """
    GET /api/auth/social/mobile/providers/ -> which providers are ready for
    ZUULI native login. A provider is true only when credentials, the safe
    owned HTTPS relay, PKCE support, and the mobile rollout gate are all ready.
    This endpoint is the native app's launch-UI contract; desktop/web callers
    must use the generic providers endpoint. NEVER leaks any secret value.
    """
    # AllowAny does not disable authentication -- DRF still runs
    # DEFAULT_AUTHENTICATION_CLASSES, and knox raises 401 for an expired or
    # revoked token before get() is ever reached. This is a native client's
    # LAUNCH-TIME discovery call, and a stale stored token is exactly the state
    # in which the app most needs to render a social login button, so a 401
    # here removes the recovery path it exists to offer. Same reasoning, and
    # the same fix, as ZuuliCapabilitiesView (dj/apps/zuuli/views.py).
    authentication_classes = []
    permission_classes = [AllowAny]

    @extend_schema(responses={200: SocialProviderDiscoverySerializer})
    def get(self, request):
        configured = configured_mobile_providers()
        response = Response({
            "providers": [
                {"provider": key, "configured": ok}
                for key, ok in configured.items()
            ],
        })
        response["Cache-Control"] = "no-store"
        return response
