"""The provider's endpoints, as DRF views (see the package docstring for why).

Consent (``/api/oauth/authorize``) is the JSON step the SvelteKit
``/oauth/authorize`` page calls; the page itself is a follow-up. Its GET
never writes (it evaluates the request and says what the page must do); its
POST records the consent and mints the code. The binding between the two is
``request_id``: a signed digest of the exact parameters the GET evaluated,
tied to the user, so a POST can only finalize a request this user's session
was shown, with exactly those parameters (the epic's "CSRF plus the request
id"). DRF's session authentication enforces CSRF on the POST.

Token, revocation and introspection are RFC-shaped form endpoints delegated
to django-oauth-toolkit's ``OAuthLibMixin``; they carry no session
authentication at all (``authentication_classes = []``) because their
credential is the client's, and a stray session cookie must not turn a
browser client's token request into a CSRF refusal.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import logging
from urllib.parse import unquote_plus

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core import signing
from django.http import HttpRequest, HttpResponse, QueryDict
from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from oauth2_provider.exceptions import FatalClientError, OAuthToolkitError
from oauth2_provider.views.mixins import OAuthLibMixin
from oauthlib.common import add_params_to_uri
from rest_framework import exceptions, status
from rest_framework.parsers import FormParser, JSONParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from dj.apps.identity.auth_context import current_auth_context
from dj.apps.ktauth.epoch import account_epoch_for
from dj.apps.ktauth.signing import AuthorityUnavailable
from dj.free2z.throttling import (
    OIDC_AUTHORIZE_THROTTLES,
    OIDC_TOKEN_THROTTLES,
    POLLING_THROTTLES,
)

from . import consent, redirects
from .authentication import OAuth2JWTAuthentication, _bearer_token, verify_bearer
from .keys import SigningKeysUnavailable, get_keyring
from .models import AppAuthorization, F2ZApplication
from .scopes import (
    ACR_MFA,
    ACR_VALUES_SUPPORTED,
    ALL_SCOPES,
    AUD_ID,
    SCOPE_AI_INVOKE,
    SCOPE_OPENID,
    scope_list,
)
from .serializers import (
    AuthorizeResponseSerializer,
    ConsentDecisionSerializer,
    GrantCapUpdateSerializer,
    GrantSerializer,
    InternalEpochSerializer,
    IntrospectRequestSerializer,
    IntrospectResponseSerializer,
    OAuthErrorSerializer,
    RevokeRequestSerializer,
    TokenRequestSerializer,
    TokenResponseSerializer,
    UserInfoSerializer,
)
from .tokens import InvalidAccessToken, is_jwt
from .validators import userinfo_claims

logger = logging.getLogger(__name__)

#The authorization request parameters the consent step reads (spec §9.2).
#Anything else on the query string is ignored, never echoed.
AUTHORIZATION_PARAMETERS = (
    "response_type", "client_id", "redirect_uri", "scope", "state",
    "code_challenge", "code_challenge_method", "nonce", "prompt", "max_age",
    "acr_values", "login_hint", "ui_locales", "response_mode",
    "f2z_login_ticket", "f2z_spend_cap", "f2z_spend_period",
)
#Not OAuth parameters: the platform's own, never forwarded to oauthlib.
_PLATFORM_PARAMETERS = frozenset({
    "f2z_login_ticket", consent.SPEND_CAP_HINT_PARAMETER, consent.SPEND_PERIOD_HINT_PARAMETER,
})
#Not an OAuth parameter: the platform's own, carried by the consent page
#across a sign-in (see `_login_ticket`). Never forwarded to oauthlib.
LOGIN_TICKET_PARAMETER = "f2z_login_ticket"
_OPAQUE_AUTHORIZATION_PARAMETERS = frozenset({"state", "nonce"})
_IGNORABLE_NUL_PARAMETERS = frozenset({
    "login_hint", "ui_locales", LOGIN_TICKET_PARAMETER,
})
#Requirements whose whitespace-only value is malformed, not absent:
#stripping it to "" would drop it and turn a refusal into an approval
#without the freshness check the client asked for. Kept raw, so
#`_validate` refuses it exactly as it did before normalization existed.
_BLANK_IS_MALFORMED_PARAMETERS = frozenset({"max_age", "response_mode"})
_LOGIN_TICKET_SALT = "dj.apps.oidc.authorize.login-ticket"
_LOGIN_TICKET_DESCRIPTION = (
    "Not an OAuth parameter: the `login_ticket` of an earlier `login` answer, "
    "carried back after the sign-in it asked for. A sign-in at or after the "
    "ticket's time satisfies `prompt=login` and `max_age` (including "
    "`max_age=0`). An invalid or expired ticket is ignored, never an error."
)
_SPEND_CAP_HINT_DESCRIPTION = (
    "Not an OAuth parameter: the app's SUGGESTED spend cap for "
    "`ai:invoke`, a whole number of 2Z from 1. The consent screen may "
    "pre-select it, but only its AMOUNT is ever clamped: a capped "
    "registration default, and the user's capped last grant for the app, "
    "each fix the period and bound the amount. A hint for another period "
    "than either is ignored (a period change is a raise: it starts a fresh "
    "spend window), so an applied hint never exceeds the registration's "
    "default nor needs a fresh sign-in. It is never recorded by "
    "itself: only the cap the user confirms in the consent POST's own "
    "`spend_cap_2z` / `cap_period` is. A silent (`approve`) authorization "
    "ignores it; send `prompt=consent` to ask the user again. A malformed "
    "value is ignored, never an error."
)
_SPEND_PERIOD_HINT_DESCRIPTION = (
    "Not an OAuth parameter: the period of `f2z_spend_cap` -- "
    "`day`, `week`, `month` or `total` (never resets). Ignored without "
    "`f2z_spend_cap`; an unknown value makes the whole hint ignored. "
    "Absent, the hint keeps the period the screen would have pre-selected. "
    "Never rewritten: a period the registration's default or the user's "
    "capped grant does not have makes the hint ignored."
)
_PARAMETER_DESCRIPTIONS = {
    "f2z_login_ticket": _LOGIN_TICKET_DESCRIPTION,
    "f2z_spend_cap": _SPEND_CAP_HINT_DESCRIPTION,
    "f2z_spend_period": _SPEND_PERIOD_HINT_DESCRIPTION,
}
#A `request_id` binds a POST to a GET for this long. Longer than the
#60-second code lifetime because it covers the time the user spends
#reading the consent screen.
AUTHORIZATION_REQUEST_MAX_AGE_SECONDS = 600
_REQUEST_ID_SALT = "dj.apps.oidc.authorize"
#Spec §9.2: `state` MUST carry at least 128 bits of entropy. Entropy is not
#measurable; 22 characters is the shortest base64url encoding of 128 bits,
#so anything shorter cannot satisfy the rule.
STATE_MIN_LENGTH = 22
PROMPT_VALUES = frozenset({"none", "login", "consent", "select_account"})


# --------------------------------------------------------------------------
# Shared pieces
# --------------------------------------------------------------------------
def _params(source) -> dict:
    """The recognised authorization parameters, canonicalized for echoing.

    ``AuthorizationRequestSerializer`` strips surrounding whitespace from
    ordinary echoed values and refuses NUL characters. Normalize before the
    GET signs/echoes them, so the POST serializer cannot change the signed
    request between evaluation and decision. ``state`` and ``nonce`` are
    opaque protocol values and must round-trip byte-for-byte. Malformed
    security parameters retain their NUL until validation rejects the
    request; only optional hints whose contract says "ignore" are dropped.
    The spend-cap hints have their own parser below.
    """
    out = {}
    for name in AUTHORIZATION_PARAMETERS:
        value = source.get(name)
        if value is None:
            continue
        value = str(value)
        is_spend_hint = name in {
            consent.SPEND_CAP_HINT_PARAMETER,
            consent.SPEND_PERIOD_HINT_PARAMETER,
        }
        if "\x00" in value and name in _IGNORABLE_NUL_PARAMETERS:
            # These parameters are optional hints. A malformed value is
            # ignored by contract, and must not be echoed into a POST whose
            # serializer would reject it.
            continue
        if not is_spend_hint and name not in _OPAQUE_AUTHORIZATION_PARAMETERS:
            stripped = value.strip()
            if stripped or name not in _BLANK_IS_MALFORMED_PARAMETERS:
                value = stripped
        if value != "":
            out[name] = value
    if consent.parse_spend_cap_hint(out) is None:
        # An unusable spend-cap hint is dropped HERE, before it is signed
        # into a request_id or echoed back: "ignored" must mean exactly as if
        # it had never been sent, or a value the POST's serializer refuses
        # (a NUL, say) would strand the user on a screen whose Allow and
        # Deny both fail (codex review, ).
        out.pop(consent.SPEND_CAP_HINT_PARAMETER, None)
        out.pop(consent.SPEND_PERIOD_HINT_PARAMETER, None)
    return out


def _params_digest(params: dict) -> str:
    canonical = json.dumps(params, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def _synthetic_authorization_request(params: dict, user=None) -> HttpRequest:
    """A GET ``HttpRequest`` carrying ``params`` as its query string.

    django-oauth-toolkit reads the authorization request off the request's
    full path, so both the consent GET (which really is that request) and the
    consent POST (which carries the same parameters in its body) are
    validated by handing the library one synthetic request built from the
    parameters alone -- never from the live request's own query string on
    the POST, so nothing in a URL can dictate what the POST writes.
    """
    query = QueryDict(mutable=True)
    for key, value in params.items():
        if key in _PLATFORM_PARAMETERS:
            continue
        query[key] = value
    synthetic = HttpRequest()
    synthetic.method = "GET"
    synthetic.path = synthetic.path_info = "/api/oauth/authorize"
    synthetic.META = {
        "REQUEST_METHOD": "GET",
        "QUERY_STRING": query.urlencode(),
        "SERVER_NAME": "oidc.local",
        "SERVER_PORT": "443",
        "wsgi.url_scheme": "https",
    }
    synthetic.GET = query
    synthetic.user = user
    return synthetic


def _error_redirect(redirect_uri: str, error: str, description: str, state) -> str:
    """An RFC 6749 §4.1.2.1 error response, with ``iss`` (RFC 9207)."""
    params = [("error", error)]
    if description:
        params.append(("error_description", description))
    if state:
        params.append(("state", state))
    params.append(("iss", settings.OIDC_ISSUER))
    return add_params_to_uri(redirect_uri, params)


def _fatal(error: str, description: str) -> Response:
    """No redirect: the client or its redirect URI could not be trusted."""
    return Response(
        {"error": error, "error_description": description},
        status=status.HTTP_400_BAD_REQUEST,
    )


def _session_auth_context(request):
    """The consenting credential's AuthContext, or ``None``.

    ``None`` means "the platform does not know when this session
    authenticated": ``max_age``, ``prompt=login`` and ``acr_values`` then
    fail closed (spec §10), and tokens carry no ``auth_time``. Every login
    path records one (``dj.apps.identity.auth_context``, ).
    """
    return current_auth_context(request)


def _ticket_binding(params: dict) -> str:
    """What a login ticket is bound to: the request, minus ``prompt``.

    ``prompt`` is left out because the page drops ``prompt=login`` on the
    way back from the sign-in it asked for; the ticket itself is left out
    because it is not part of the request.
    """
    return _params_digest({
        k: v for k, v in params.items()
        if k not in ("prompt", LOGIN_TICKET_PARAMETER)
    })


def _login_ticket(params: dict) -> str:
    """A signed "a sign-in was asked for at time T" for this request.

    The page carries it back after the sign-in. An authentication whose
    ``auth_time`` is at or after T is then fresh enough for ``prompt=login``
    and for any ``max_age`` -- including ``max_age=0``, which no
    authentication can satisfy by age alone, because some time always
    passes between signing in and the page asking again.
    """
    return signing.dumps(
        {"h": _ticket_binding(params), "t": timezone.now().timestamp()},
        salt=_LOGIN_TICKET_SALT, compress=True,
    )


def _login_ticket_time(params: dict):
    """T from a valid ticket bound to this request, else ``None``.

    Anything else -- absent, forged, expired, minted for another request --
    is ignored, never an error: without it the gate simply judges by age,
    which is the behaviour before tickets existed.
    """
    ticket = params.get(LOGIN_TICKET_PARAMETER)
    if not ticket:
        return None
    try:
        payload = signing.loads(
            ticket, salt=_LOGIN_TICKET_SALT,
            max_age=AUTHORIZATION_REQUEST_MAX_AGE_SECONDS,
        )
    except signing.BadSignature:
        return None
    if not isinstance(payload, dict):
        return None
    if not hmac.compare_digest(str(payload.get("h", "")), _ticket_binding(params)):
        return None
    issued = payload.get("t")
    if isinstance(issued, bool) or not isinstance(issued, (int, float)):
        return None
    return float(issued)


def _step_up_response(exc: consent.StepUpRequired) -> Response:
    """RFC 9470: ``401`` with the challenge the SDK knows how to answer."""
    response = Response(
        {"code": exc.code, "detail": str(exc), "max_age": exc.max_age},
        status=status.HTTP_401_UNAUTHORIZED,
    )
    response["WWW-Authenticate"] = (
        'Bearer error="insufficient_user_authentication", '
        f'error_description="{exc}", max_age="{exc.max_age}"'
    )
    return response


class _Evaluated:
    """What the consent step knows about a request once it validated it."""

    __slots__ = ("application", "kind", "scopes", "credentials", "prompt", "params")

    def __init__(self, application, kind, scopes, credentials, prompt, params):
        self.application = application
        self.kind = kind
        self.scopes = scopes
        self.credentials = credentials
        self.prompt = prompt
        self.params = params


# --------------------------------------------------------------------------
# Consent
# --------------------------------------------------------------------------
class AuthorizeView(OAuthLibMixin, APIView):
    """The consent step (spec §5, §9.2, §9.3). See the module docstring."""

    permission_classes = [AllowAny]
    throttle_classes = OIDC_AUTHORIZE_THROTTLES
    parser_classes = [JSONParser, FormParser]

    # ---------------------------------------------------------- validation
    def _validate(self, params: dict):
        """Returns an ``_Evaluated`` or a ``Response`` to send instead."""
        synthetic = _synthetic_authorization_request(params)
        try:
            scopes, credentials = self.validate_authorization_request(synthetic)
        except FatalClientError as error:
            oauth_error = error.oauthlib_error
            return _fatal(oauth_error.error, oauth_error.description or "")
        except OAuthToolkitError as error:
            oauth_error = error.oauthlib_error
            redirect_uri = getattr(oauth_error, "redirect_uri", None) or params.get("redirect_uri")
            if not redirect_uri:
                return _fatal(oauth_error.error, oauth_error.description or "")
            return Response({
                "action": "redirect",
                "redirect_to": _error_redirect(
                    redirect_uri, oauth_error.error, oauth_error.description or "",
                    params.get("state"),
                ),
            })

        redirect_uri = credentials["redirect_uri"]
        state = params.get("state")

        def refuse(error, description):
            return Response({
                "action": "redirect",
                "redirect_to": _error_redirect(redirect_uri, error, description, state),
            })

        if any("\x00" in value for value in params.values()):
            return refuse("invalid_request", "authorization parameters must not contain NUL characters")

        # The contract's rules on top of oauthlib's (spec §9.2).
        if params.get("response_type") != "code":
            return refuse("unsupported_response_type", "only response_type=code is supported")
        if params.get("response_mode", "query") != "query":
            return refuse("invalid_request", "only response_mode=query is supported")
        if not state or len(state) < STATE_MIN_LENGTH:
            return refuse("invalid_request", "state is required and must carry at least 128 bits of entropy")
        if params.get("code_challenge_method") != "S256" or not params.get("code_challenge"):
            return refuse("invalid_request", "PKCE with code_challenge_method=S256 is required")
        if SCOPE_OPENID in scopes and not params.get("nonce"):
            return refuse("invalid_request", "nonce is required when scope contains openid")
        prompt = set(params.get("prompt", "").split())
        if prompt - PROMPT_VALUES:
            return refuse("invalid_request", "unknown prompt value")
        if "none" in prompt and len(prompt) > 1:
            return refuse("invalid_request", "prompt=none cannot be combined with other values")
        if "max_age" in params:
            if not params["max_age"].isdigit():
                return refuse("invalid_request", "max_age must be a non-negative integer")
        acr_values = set(params.get("acr_values", "").split())
        if acr_values - set(ACR_VALUES_SUPPORTED):
            return refuse("invalid_request", "unsupported acr_values")

        try:
            kind = redirects.classify(redirect_uri)
        except redirects.RedirectURIError as exc:
            return _fatal("invalid_request", f"redirect_uri: {exc}")
        application = F2ZApplication.objects.select_related("user").filter(
            client_id=credentials["client_id"],
        ).first()
        if application is None:
            return Response(
                {"code": "application_unavailable", "detail": "this app is no longer available"},
                status=status.HTTP_409_CONFLICT,
            )
        if application.frozen:
            return refuse("access_denied", "this app is frozen")

        clean_credentials = {
            "client_id": credentials["client_id"],
            "redirect_uri": redirect_uri,
            "response_type": credentials.get("response_type"),
            "state": state,
            "code_challenge": params["code_challenge"],
            "code_challenge_method": "S256",
        }
        if params.get("nonce"):
            clean_credentials["nonce"] = params["nonce"]
        return _Evaluated(application, kind, list(scopes), clean_credentials, prompt, params)

    @staticmethod
    def _terms(application) -> dict:
        """The terms the GET showed (or silently approved on): what the
        POST must still be consenting to. A markup that rose in between is
        a different price, and `record_consent` would otherwise record it
        unseen (codex adversarial review, round 2)."""
        return {"markup_bps": application.effective_markup_bps}

    def _request_id(self, user, params: dict, application) -> str:
        return signing.dumps(
            {"h": _params_digest({**params, "__terms": self._terms(application)}), "u": user.pk},
            salt=_REQUEST_ID_SALT, compress=True,
        )

    def _check_request_id(self, request_id: str, user, params: dict, application) -> bool:
        try:
            payload = signing.loads(
                request_id, salt=_REQUEST_ID_SALT,
                max_age=AUTHORIZATION_REQUEST_MAX_AGE_SECONDS,
            )
        except signing.BadSignature:
            return False
        expected = _params_digest({**params, "__terms": self._terms(application)})
        return (
            isinstance(payload, dict)
            and payload.get("u") == user.pk
            and hmac.compare_digest(str(payload.get("h", "")), expected)
        )

    def _authentication_gate(self, request, evaluated: _Evaluated, context):
        """Spec §10 / §9.2: ``prompt=login``, ``max_age`` and ``acr_values``.

        Returns a ``Response`` when the page must sign the user in (again),
        else ``None``. Fails closed when the session has no recorded
        authentication context.
        """
        params, prompt = evaluated.params, evaluated.prompt
        wants_recent = "login" in prompt or "max_age" in params
        wants_acr = set(params.get("acr_values", "").split())
        if not (wants_recent or wants_acr):
            return None
        redirect_uri, state = evaluated.credentials["redirect_uri"], params.get("state")

        def needs_login(reason):
            if "none" in prompt:
                return Response({
                    "action": "redirect",
                    "redirect_to": _error_redirect(redirect_uri, "login_required", reason, state),
                })
            return Response({
                "action": "login", "reason": reason,
                "login_ticket": _login_ticket(params),
            })

        if context is None:
            return needs_login("the session's authentication time is unknown")
        # A sign-in completed after this request asked for one (the page
        # carries the ticket back) satisfies prompt=login and max_age: it is
        # exactly the authentication the relying party asked for.
        # acr_values is still judged below; a ticket proves when, not how.
        ticket_time = _login_ticket_time(params)
        signed_in_since = (
            ticket_time is not None and context.auth_time.timestamp() >= ticket_time
        )
        if "login" in prompt and not signed_in_since:
            # Re-authentication is asked for; the page signs the user in and
            # repeats the request WITHOUT prompt=login, carrying the ticket.
            return needs_login("prompt=login")
        if "max_age" in params and not signed_in_since:
            age = (timezone.now() - context.auth_time).total_seconds()
            if age > int(params["max_age"]):
                return needs_login("max_age")
        if ACR_MFA in wants_acr and context.acr != ACR_MFA:
            return needs_login("acr_values")
        return None

    # ---------------------------------------------------------------- GET
    @extend_schema(
        operation_id="oidc_authorize_evaluate",
        summary="Evaluate an authorization request (the consent step, read-only)",
        parameters=[
            OpenApiParameter(name, str, OpenApiParameter.QUERY,
                             required=name in ("response_type", "client_id", "redirect_uri",
                                               "scope", "state", "code_challenge",
                                               "code_challenge_method"),
                             description=_PARAMETER_DESCRIPTIONS.get(name, ""))
            for name in AUTHORIZATION_PARAMETERS
        ],
        responses={
            200: AuthorizeResponseSerializer,
            400: OAuthErrorSerializer,
            409: OpenApiResponse(description="The app is no longer available."),
        },
    )
    def get(self, request):
        """Answer what the consent page must do for this request.

        Writes nothing. `action` is `login`, `consent`, `approve` or
        `redirect`; see the response schema.
        """
        params = _params(request.query_params)
        evaluated = self._validate(params)
        if isinstance(evaluated, Response):
            return evaluated
        prompt = evaluated.prompt
        redirect_uri = evaluated.credentials["redirect_uri"]
        state = params.get("state")

        if not request.user.is_authenticated:
            if "none" in prompt:
                return Response({
                    "action": "redirect",
                    "redirect_to": _error_redirect(
                        redirect_uri, "login_required", "no session", state,
                    ),
                })
            return Response({
                "action": "login", "reason": "login_required",
                "login_ticket": _login_ticket(params),
            })

        context = _session_auth_context(request)
        gate = self._authentication_gate(request, evaluated, context)
        if gate is not None:
            return gate

        requirement = consent.consent_requirement(
            request.user, evaluated.application, evaluated.scopes, evaluated.kind, prompt,
        )
        request_id = self._request_id(request.user, params, evaluated.application)
        if not requirement.required:
            return Response({
                "action": "approve",
                "request_id": request_id,
                "authorization_request": params,
            })
        if "none" in prompt:
            return Response({
                "action": "redirect",
                "redirect_to": _error_redirect(
                    redirect_uri, requirement.prompt_none_error,
                    "user interaction is required", state,
                ),
            })
        application = evaluated.application
        existing = requirement.existing
        cap_required = SCOPE_AI_INVOKE in evaluated.scopes
        # The cap baseline is the user's LAST grant for the app, revoked or
        # live: revoking leaves the ledger spend window in place, so
        # record_consent judges a raise against it, and the screen must
        # pre-select the same cap or "keep my current limit" after a step-up
        # refusal would re-submit the app's default and be refused again
        # (codex review, round 2). A last grant that never made an AI
        # spending decision (no ai:invoke, no cap) is no baseline at all: it
        # stores "no cap" only because identity needs none, and pre-selecting
        # that would grant uncapped AI on one Allow, skipping the "no limit"
        # confirmation the app's default would have required ( review).
        last = existing or AppAuthorization.objects.filter(
            user_id=request.user.pk, application_id=application.pk,
        ).first()
        baseline = consent.spending_baseline(last)
        # The request's hint  moves only this PRE-SELECTION, clamped
        # so it is never a raise over the baseline nor outside the
        # registration's default. The POST never reads it: what is recorded
        # is the body's own cap.
        pre_cap, pre_period, pre_source = consent.preselection(
            application, baseline, consent.parse_spend_cap_hint(params),
        )
        descriptions = settings.OAUTH2_PROVIDER.get("SCOPES", {})
        return Response({
            "action": "consent",
            "request_id": request_id,
            "authorization_request": params,
            "consent": {
                "application": {
                    "client_id": application.client_id,
                    "name": application.name,
                    "developer": application.user.username if application.user_id else None,
                    "logo_url": application.logo_url,
                    "privacy_url": application.privacy_url,
                    "terms_url": application.terms_url,
                    "first_party": application.first_party,
                    "child_directed": application.child_directed,
                    "markup_bps": application.effective_markup_bps,
                    "markup_approval": application.markup_approval,
                },
                "scopes": evaluated.scopes,
                "scope_descriptions": {s: descriptions.get(s, s) for s in evaluated.scopes},
                "already_granted": existing.scope_list if existing is not None else [],
                "cap_required": cap_required,
                "spend_cap": {"spend_cap_2z": pre_cap, "cap_period": pre_period},
                "spend_cap_source": pre_source,
                "current_spend_cap": (
                    {"spend_cap_2z": baseline.spend_cap_2z, "cap_period": baseline.cap_period}
                    if baseline is not None else None
                ),
                "is_raise_step_up_required": baseline is not None,
            },
        })

    # --------------------------------------------------------------- POST
    @extend_schema(
        operation_id="oidc_authorize_decide",
        summary="Record the user's decision and mint the authorization code",
        request=ConsentDecisionSerializer,
        responses={
            200: AuthorizeResponseSerializer,
            400: OAuthErrorSerializer,
            401: OpenApiResponse(description="Not signed in, or a spend-cap raise "
                                             "needs a recent authentication (RFC 9470)."),
            409: OpenApiResponse(description="The consenting account or app is no longer available."),
        },
    )
    def post(self, request):
        if not request.user.is_authenticated:
            raise exceptions.NotAuthenticated()
        serializer = ConsentDecisionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        params = _params(data["authorization_request"])
        # The binding is checked BEFORE validation, on the registration the
        # request names, so a POST that was never shown to this user does no
        # further work and gets no redirect.
        application = F2ZApplication.objects.filter(client_id=params.get("client_id")).first()
        if application is None:
            return Response(
                {"code": "application_unavailable", "detail": "this app is no longer available"},
                status=status.HTTP_409_CONFLICT,
            )
        if not self._check_request_id(
            data["request_id"], request.user, params, application,
        ):
            return _fatal(
                "invalid_request",
                "request_id does not match this request, its terms have changed, "
                "or it has expired; evaluate the request again",
            )
        evaluated = self._validate(params)
        if isinstance(evaluated, Response):
            return evaluated
        redirect_uri = evaluated.credentials["redirect_uri"]
        state = params.get("state")
        user = request.user

        if not data["allow"]:
            return Response({
                "action": "redirect",
                "redirect_to": _error_redirect(redirect_uri, "access_denied", "the user declined", state),
            })

        context = _session_auth_context(request)
        gate = self._authentication_gate(request, evaluated, context)
        if gate is not None:
            return gate

        granted = scope_list(data.get("scope") or evaluated.scopes)
        if not granted or not set(granted) <= set(evaluated.scopes):
            return _fatal("invalid_scope", "granted scopes must be a non-empty subset of the request")

        requirement = consent.consent_requirement(
            user, evaluated.application, granted, evaluated.kind, evaluated.prompt,
        )
        if requirement.required:
            if "none" in evaluated.prompt:
                return Response({
                    "action": "redirect",
                    "redirect_to": _error_redirect(
                        redirect_uri, requirement.prompt_none_error,
                        "user interaction is required", state,
                    ),
                })
            existing = requirement.existing
            cap_chosen = "spend_cap_2z" in request.data
            had_ai_consent = existing is not None and SCOPE_AI_INVOKE in existing.scope_list
            if SCOPE_AI_INVOKE in granted and not had_ai_consent and not cap_chosen:
                # The first AI permission needs its own explicit spend decision,
                # including upgrades from an identity-only grant. An
                # explicit null is a choice ("no cap"); an absent key is
                # not, and would otherwise default to whatever the page
                # forgot to send.
                return _fatal(
                    "invalid_request",
                    "spend_cap_2z is required when consenting to ai:invoke "
                    "(null means no cap)",
                )
            # Omitted cap fields keep the LAST grant's cap, revoked or live
            # (the same baseline the GET pre-selects and record_consent
            # judges a raise against): an identity-only reconnect after a
            # revoke must not fall back to the app's default and be refused
            # as a raise over the revoked cap (codex review, round 3).
            last = existing or AppAuthorization.objects.filter(
                user_id=user.pk, application_id=evaluated.application.pk,
            ).first()
            if cap_chosen:
                spend_cap_2z = data.get("spend_cap_2z")
            elif last is not None:
                spend_cap_2z = last.spend_cap_2z
            else:
                spend_cap_2z, _ = consent.preselected_cap(evaluated.application, None)
            cap_period = data.get("cap_period") or (
                last.cap_period if last
                else consent.preselected_cap(evaluated.application, None)[1]
            )
            try:
                consent.record_consent(
                    user, evaluated.application, granted,
                    spend_cap_2z=spend_cap_2z, cap_period=cap_period,
                    recent_auth_time=context.auth_time if context is not None else None,
                )
            except consent.StepUpRequired as exc:
                return _step_up_response(exc)
            except consent.ConsentError as exc:
                if exc.code in {"account_unavailable", "application_unavailable"}:
                    return Response(
                        {"code": exc.code, "detail": str(exc)},
                        status=status.HTTP_409_CONFLICT,
                    )
                return _fatal(exc.code, str(exc))

        credentials = dict(evaluated.credentials)
        credentials["f2z_auth_context"] = (
            {"auth_time": context.auth_time, "acr": context.acr, "amr": list(context.amr)}
            if context is not None else {}
        )
        synthetic = _synthetic_authorization_request(params, user=user)
        try:
            uri, headers, body, response_status = self.create_authorization_response(
                request=synthetic, scopes=" ".join(granted),
                credentials=credentials, allow=True,
            )
        except FatalClientError as error:
            oauth_error = error.oauthlib_error
            return _fatal(oauth_error.error, oauth_error.description or "")
        except OAuthToolkitError as error:
            oauth_error = error.oauthlib_error
            return Response({
                "action": "redirect",
                "redirect_to": _error_redirect(
                    redirect_uri, oauth_error.error, oauth_error.description or "", state,
                ),
            })
        return Response({"action": "redirect", "redirect_to": uri})


# --------------------------------------------------------------------------
# Token, revocation, introspection (form-encoded, RFC-shaped)
# --------------------------------------------------------------------------
def _oauthlib_response(headers, body, response_status) -> HttpResponse:
    # oauthlib's error responses carry a JSON body but not always a
    # Content-Type header; every body these endpoints produce is JSON.
    response = HttpResponse(content=body or "", status=response_status,
                            content_type="application/json")
    for key, value in headers.items():
        response[key] = value
    return response


class TokenView(OAuthLibMixin, APIView):
    """RFC 6749 §3.2 token endpoint (spec §9.4)."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = OIDC_TOKEN_THROTTLES
    parser_classes = [FormParser]

    @extend_schema(
        operation_id="oidc_token",
        summary="Exchange an authorization code or rotate a refresh token",
        request={"application/x-www-form-urlencoded": TokenRequestSerializer},
        responses={200: TokenResponseSerializer, 400: OAuthErrorSerializer, 401: OAuthErrorSerializer},
    )
    def post(self, request):
        _, headers, body, response_status = self.create_token_response(request._request)
        return _oauthlib_response(headers, body, response_status)


class RevokeView(OAuthLibMixin, APIView):
    """RFC 7009 revocation (spec §9.5): a refresh token revokes its family;
    an access token is `unsupported_token_type`."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = OIDC_TOKEN_THROTTLES
    parser_classes = [FormParser]

    @extend_schema(
        operation_id="oidc_revoke",
        summary="Revoke a refresh token and its family",
        request={"application/x-www-form-urlencoded": RevokeRequestSerializer},
        responses={200: OpenApiResponse(description="Revoked (or never valid)."),
                   400: OAuthErrorSerializer, 401: OAuthErrorSerializer},
    )
    def post(self, request):
        if is_jwt(str(request.data.get("token", ""))):
            # Spec §9.5: access tokens are stateless JWTs and cannot be
            # revoked individually. A 200 would let a client believe a
            # compromised token is dead; the remedy is revoking the grant.
            return Response(
                {"error": "unsupported_token_type",
                 "error_description": "access tokens cannot be revoked; revoke the grant"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        _, headers, body, response_status = self.create_revocation_response(request._request)
        return _oauthlib_response(headers, body, response_status)


def _basic_client_credentials(request):
    """``client_id, client_secret`` from ``Authorization: Basic``, or ``None``.

    Client authentication for introspection (RFC 7662 §2.1, spec §9.7:
    confidential clients, ``client_secret_basic``). The header names the
    caller; nothing from it is stored.
    """
    header = request.headers.get("Authorization", "")
    parts = header.split(" ", 1)
    if len(parts) != 2 or parts[0] != "Basic":
        return None
    try:
        decoded = base64.b64decode(parts[1].strip(), validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None
    if ":" not in decoded:
        return None
    client_id, secret = decoded.split(":", 1)
    return unquote_plus(client_id), unquote_plus(secret)


def _introspection(raw_token: str) -> dict:
    """RFC 7662 §2.2 for an ES256 access token; ``{"active": false}`` for
    anything that is not one of ours right now."""
    try:
        user, row, claims = verify_bearer(raw_token, audience=AUD_ID)
    except InvalidAccessToken:
        return {"active": False}
    return {
        "active": True,
        "scope": claims["scope"],
        "client_id": claims["client_id"],
        "sub": claims["sub"],
        "exp": claims["exp"],
        "iat": claims["iat"],
        "aud": claims["aud"],
        "aep": claims["aep"],
        "agen": claims["agen"],
        "token_type": "Bearer",
    }


class IntrospectView(APIView):
    """RFC 7662 introspection (spec §9.7), confidential clients only."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = OIDC_TOKEN_THROTTLES
    parser_classes = [FormParser]

    @extend_schema(
        operation_id="oidc_introspect",
        summary="Introspect an access token (confidential clients, client_secret_basic)",
        parameters=[
            OpenApiParameter(
                name="Authorization", type=str, location=OpenApiParameter.HEADER,
                required=True,
                description=(
                    "RFC 7662 §2.1 client authentication: `Basic "
                    "base64(client_id:client_secret)` of a CONFIDENTIAL client. "
                    "Missing, malformed, unknown, public or wrong-secret: 401 "
                    "`invalid_client` with `WWW-Authenticate: Basic`. Nothing "
                    "from the header is stored."
                ),
            ),
        ],
        request={"application/x-www-form-urlencoded": IntrospectRequestSerializer},
        responses={200: IntrospectResponseSerializer, 400: OAuthErrorSerializer,
                   401: OAuthErrorSerializer},
    )
    def post(self, request):
        credentials = _basic_client_credentials(request)
        client = None
        if credentials is not None:
            client_id, secret = credentials
            client = F2ZApplication.objects.filter(
                client_id=client_id, client_type=F2ZApplication.CLIENT_CONFIDENTIAL,
            ).first()
            if client is not None and not _secret_matches(secret, client.client_secret):
                client = None
        if client is None or client.frozen:
            response = Response({"error": "invalid_client"}, status=status.HTTP_401_UNAUTHORIZED)
            response["WWW-Authenticate"] = 'Basic realm="f2z-oauth"'
            return response
        token = request.data.get("token")
        if not token:
            return Response(
                {"error": "invalid_request", "error_description": "token is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        response = Response(_introspection(str(token)))
        response["Cache-Control"] = "no-store"
        return response


def _secret_matches(presented: str, stored: str) -> bool:
    from django.contrib.auth.hashers import check_password, identify_hasher
    from django.utils.crypto import constant_time_compare

    if not stored:
        return False
    try:
        identify_hasher(stored)
    except ValueError:
        return constant_time_compare(presented, stored)
    return check_password(presented, stored)


# --------------------------------------------------------------------------
# Userinfo, discovery, JWKS
# --------------------------------------------------------------------------
class UserInfoView(APIView):
    """OpenID Connect Core §5.3 (spec §9.6). Bearer access token with
    `openid`; returns the claims the granted scopes allow."""

    authentication_classes = [OAuth2JWTAuthentication]
    permission_classes = [IsAuthenticated]
    required_scopes = [SCOPE_OPENID]
    oauth_audience = AUD_ID

    @extend_schema(operation_id="oidc_userinfo", summary="Claims about the signed-in user",
                   responses={200: UserInfoSerializer})
    def get(self, request):
        return self._respond(request)

    @extend_schema(operation_id="oidc_userinfo_post", summary="Claims about the signed-in user",
                   request=None, responses={200: UserInfoSerializer})
    def post(self, request):
        return self._respond(request)

    def _respond(self, request):
        response = Response(userinfo_claims(request.user, request.auth.scopes))
        response["Cache-Control"] = "no-store"
        return response


def discovery_document(issuer: str) -> dict:
    """OpenID Provider Metadata (spec §9.1)."""
    return {
        "issuer": issuer,
        "authorization_endpoint": f"{issuer}/oauth/authorize",
        "token_endpoint": f"{issuer}/api/oauth/token",
        "userinfo_endpoint": f"{issuer}/api/oauth/userinfo",
        "jwks_uri": f"{issuer}/api/oauth/jwks",
        "revocation_endpoint": f"{issuer}/api/oauth/revoke",
        "introspection_endpoint": f"{issuer}/api/oauth/introspect",
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "subject_types_supported": ["public"],
        "id_token_signing_alg_values_supported": ["RS256"],
        "token_endpoint_auth_methods_supported": ["none", "client_secret_basic", "client_secret_post"],
        "code_challenge_methods_supported": ["S256"],
        "scopes_supported": list(ALL_SCOPES),
        "claims_supported": [
            "sub", "iss", "aud", "exp", "iat", "auth_time", "nonce", "acr", "amr",
            "preferred_username", "name", "picture", "email", "email_verified",
        ],
        "acr_values_supported": list(ACR_VALUES_SUPPORTED),
        "prompt_values_supported": ["none", "login", "consent"],
        "authorization_response_iss_parameter_supported": True,
        "revocation_endpoint_auth_methods_supported": ["none", "client_secret_basic"],
        "introspection_endpoint_auth_methods_supported": ["client_secret_basic"],
        "claims_parameter_supported": False,
        "request_parameter_supported": False,
        "request_uri_parameter_supported": False,
    }


class DiscoveryView(APIView):
    """`/.well-known/openid-configuration`."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = POLLING_THROTTLES

    @extend_schema(operation_id="oidc_discovery", summary="OpenID Provider Metadata",
                   responses={200: OpenApiResponse(description="OpenID Provider Metadata")})
    def get(self, request):
        response = Response(discovery_document(settings.OIDC_ISSUER))
        response["Access-Control-Allow-Origin"] = "*"
        response["Cache-Control"] = "public, max-age=3600"
        return response


class RootDiscoveryView(DiscoveryView):
    """The same document at the site root, where OpenID Connect Discovery
    1.0 puts it.

    Excluded from `f2z.yaml` on purpose: it is byte-identical to
    `/api/oauth/.well-known/openid-configuration`, which IS in the spec, and
    a path outside `/api/` would make drf-spectacular re-derive every
    operation id and tag in the document (the auto-detected common prefix
    would shrink from `/api/` to `/`), renaming the whole generated client
    for a duplicate route.
    """

    @extend_schema(exclude=True)
    def get(self, request):
        return super().get(request)


class JwksView(APIView):
    """The JSON Web Key Set: the active ES256 and RS256 keys and their
    retired predecessors, each with a `kid` (spec §6.1, §7)."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = POLLING_THROTTLES

    @extend_schema(operation_id="oidc_jwks", summary="JSON Web Key Set",
                   responses={200: OpenApiResponse(description="RFC 7517 JWK Set"),
                              503: OpenApiResponse(description="No signing key is configured.")})
    def get(self, request):
        try:
            jwks = get_keyring().public_jwks()
        except SigningKeysUnavailable as exc:
            logger.error("oidc: JWKS unavailable: %s", exc)
            return Response({"detail": "signing keys unavailable"},
                            status=status.HTTP_503_SERVICE_UNAVAILABLE)
        response = Response(jwks)
        response["Access-Control-Allow-Origin"] = "*"
        # Resource servers refresh on an unknown kid (spec §6.1), so an hour
        # of caching costs nothing on a rotation and saves a fetch per pod.
        response["Cache-Control"] = "public, max-age=3600"
        return response


# --------------------------------------------------------------------------
# Grants (the account's app list) and the internal epoch endpoint
# --------------------------------------------------------------------------
def _grant_payload(authorization: AppAuthorization) -> dict:
    application = authorization.application
    return {
        "client_id": application.client_id,
        "application_id": application.pk,
        "name": application.name,
        "developer": application.user.username if application.user_id else None,
        "scope": authorization.scope_list,
        "spend_cap_2z": authorization.spend_cap_2z,
        "cap_period": authorization.cap_period,
        "markup_bps": authorization.markup_bps,
        "generation": authorization.generation,
        "consented_at": authorization.consented_at,
    }


class GrantListView(APIView):
    """The signed-in account's live grants (`/account/apps`, spec §5)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(operation_id="oidc_grants_list", summary="Apps the account has authorized",
                   responses={200: GrantSerializer(many=True)})
    def get(self, request):
        grants = (
            AppAuthorization.objects.live()
            .filter(user=request.user)
            .select_related("application", "application__user")
            .order_by("-consented_at")
        )
        return Response([_grant_payload(g) for g in grants])


class GrantCapView(APIView):
    """A live grant's spend cap, set from `/account/apps` (spec §5, ).

    ``PUT`` on its own sub-resource rather than a ``PATCH`` of the grant: the
    cap never fails open, so both fields are required and "no cap" is an
    explicit null. A PATCH body is optional-by-contract (drf-spectacular
    marks every field of a PATCH request optional), and a generated client
    that believes it may omit the cap is the bug this rule exists to stop.
    """

    permission_classes = [IsAuthenticated]
    parser_classes = [JSONParser]

    @extend_schema(
        operation_id="oidc_grant_cap_update",
        summary="Set an authorized app's spending limit",
        description="Replaces the grant's cap; both fields are required and "
                    "`spend_cap_2z: null` means no limit. Lowering the limit applies at once. Raising it (a higher "
                    "amount, a different period, or no limit) needs a sign-in "
                    "within the last 5 minutes and otherwise answers 401 "
                    "`insufficient_user_authentication` (RFC 9470) without "
                    "changing anything. Any period change is a raise, even to a "
                    "longer period or a smaller amount: spend is counted per "
                    "window and a new period starts an empty one.",
        request=GrantCapUpdateSerializer,
        responses={
            200: GrantSerializer,
            400: OpenApiResponse(description="Invalid cap, or the grant does not "
                                             "include ai:invoke (`cap_not_applicable`)."),
            401: OpenApiResponse(description="Not signed in, or a raise needs a "
                                             "recent authentication (RFC 9470)."),
            404: OpenApiResponse(description="No live grant for this app."),
        },
    )
    def put(self, request, application_id):
        serializer = GrantCapUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        application = F2ZApplication.objects.filter(pk=application_id).first()
        if application is None:
            raise exceptions.NotFound("no such grant")
        context = _session_auth_context(request)
        try:
            authorization = consent.update_grant_cap(
                request.user, application,
                spend_cap_2z=data["spend_cap_2z"], cap_period=data["cap_period"],
                recent_auth_time=context.auth_time if context is not None else None,
            )
        except consent.StepUpRequired as exc:
            return _step_up_response(exc)
        except consent.ConsentError as exc:
            return Response({"code": exc.code, "detail": str(exc)},
                            status=status.HTTP_400_BAD_REQUEST)
        if authorization is None:
            raise exceptions.NotFound("no such grant")
        authorization.application = application
        return Response(_grant_payload(authorization))


class GrantRevokeView(APIView):
    """Revoke a grant: `agen` moves and every token of the grant dies."""

    permission_classes = [IsAuthenticated]

    @extend_schema(operation_id="oidc_grant_revoke", summary="Revoke an app's authorization",
                   responses={204: OpenApiResponse(description="Revoked."),
                              404: OpenApiResponse(description="No such grant.")})
    def delete(self, request, application_id):
        application = F2ZApplication.objects.filter(pk=application_id).first()
        revoked = None
        if application is not None:
            revoked = consent.revoke_authorization(request.user, application)
        if revoked is None:
            raise exceptions.NotFound("no such grant")
        return Response(status=status.HTTP_204_NO_CONTENT)


class InternalEpochView(APIView):
    """For resource servers (the AI gateway) that miss the Redis publication:
    the account's current epoch and its live grants' generations, read from
    the rows. Shared-secret bearer; 503 while unconfigured.

    Contract for the gateway: `agen` lists LIVE grants only. A `client_id`
    absent from it means the grant is revoked (or never existed) -- refuse
    the token; absence is an answer, not a miss. A 404 means the subject
    does not exist: refuse too. Only a 503 (or no answer) is "unknown", and
    the spec's fail-closed rule applies to that.
    """

    authentication_classes = []
    permission_classes = [AllowAny]

    @extend_schema(operation_id="oidc_internal_epoch",
                   summary="Current account epoch and grant generations (internal)",
                   responses={200: InternalEpochSerializer,
                              401: OpenApiResponse(description="Bad or missing internal token."),
                              404: OpenApiResponse(description="Unknown subject."),
                              503: OpenApiResponse(description="Endpoint not configured, or the epoch is unusable.")})
    def get(self, request, subject):
        expected = getattr(settings, "OIDC_INTERNAL_API_TOKEN", "") or ""
        if not expected:
            return Response({"detail": "internal epoch endpoint is not configured"},
                            status=status.HTTP_503_SERVICE_UNAVAILABLE)
        presented = _bearer_token(request)
        if presented is None or not hmac.compare_digest(presented, expected):
            response = Response({"detail": "unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
            response["WWW-Authenticate"] = 'Bearer realm="f2z-internal"'
            return response
        user = get_user_model()._default_manager.filter(public_id=subject).only("pk").first()
        if user is None:
            raise exceptions.NotFound("unknown subject")
        try:
            epoch = account_epoch_for(user.pk)
        except AuthorityUnavailable:
            return Response({"detail": "account epoch unavailable"},
                            status=status.HTTP_503_SERVICE_UNAVAILABLE)
        generations = dict(
            AppAuthorization.objects.live()
            .filter(user_id=user.pk)
            .values_list("application__client_id", "generation")
        )
        response = Response({"sub": subject, "aep": epoch, "agen": generations})
        response["Cache-Control"] = "no-store"
        return response
