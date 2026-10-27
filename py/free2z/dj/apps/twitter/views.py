"""
https://developer.twitter.com/en/docs/authentication/oauth-2-0/user-access-token
https://chat.openai.com/chat/3a93cea8-b03c-4e15-9f06-71d647014c38
https://developer.twitter.com/en/docs/twitter-api/users/lookup/api-reference/get-users-me
https://developer.twitter.com/en/portal/projects/1610558212494835712/apps/26479761/settings
"""
import json
import logging
import os
import uuid
from urllib.parse import urlencode

from django.http import JsonResponse, HttpResponseBadRequest, HttpResponse
from django.views import View
from django.contrib.auth import login
from django.utils.crypto import get_random_string
from django.shortcuts import redirect, render
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core import signing
from django.db import DatabaseError, transaction
from django.utils.crypto import constant_time_compare
from django.utils import timezone
from django.utils.html import escape

from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework import generics, permissions

from dj.apps.g12f.models import Creator
from dj.apps.g12f.account_deletion import (
    InactiveAccount,
    ensure_account_can_sign_in,
    keep_redirect,
)
from dj.apps.g12f.usernames import is_forbidden_username
from dj.apps.tuzis.welcome import identity_welcome_key, welcome_new_account
from dj.apps.identity.auth_context import require_recent_auth, RecentAuthenticationRequired
from dj.apps.identity.auth_context import federated, record_login
from dj.apps.identity.methods import (
    LAST_SIGNIN_METHOD_DETAIL,
    can_remove,
    method_of,
    signin_survives,
)
from dj.apps.ktauth.credentials import STALE_IDENTITY_DETAIL, identity_can_authenticate
from dj.apps.ktauth.epoch import (
    EVENT_TWITTER_IDENTITY_UNLINKED,
    EVENT_TWITTER_LOGIN_TOGGLED,
    bump_account_epoch,
)
from dj.apps.social.clients import pkce_challenge
from dj.apps.social.views import handle_clashes_existing_account
from dj.apps.otp.utils import (
    INVALID_OTP_TOKEN_MESSAGE,
    claim_totp_attempt,
    clear_totp_attempt,
    has_active_totp,
    check_user_totp,
)
from dj.free2z.throttling import THIRD_PARTY_OAUTH_THROTTLES

from requests_oauthlib import OAuth1Session
from requests.exceptions import RequestException

from twatter.v2.client import get_client
from twatter.v1.client import (
    TWITTER_OAUTH1_PROVIDER_TIMEOUT,
    TwitterOAuthClient,
    twitter_oauth1_provider_deadline,
)

from .models import TwitterProfile

#The legacy X callback's ``amr``. ``twitter``, not ``x``: the
#modern social flow's provider key is its own ``fed:<provider>``, and an
#RP reading ``amr`` can tell the two sign-in paths apart.
AMR_LEGACY_TWITTER = federated("twitter")


class _LastSignInMethodLost(Exception):
    """Roll back an identity removal if no configured sign-in survives."""


logger = logging.getLogger(__name__)

TWITTER_OAUTH1_FAILURE_DETAIL = "Twitter OAuth request failed."
TWITTER_OAUTH1_CALLBACK_RECEIVED = "twitter_oauth1_callback_received"
TWITTER_OAUTH1_CALLBACK_FAILED = "twitter_oauth1_callback_failed"
TWITTER_OAUTH1_REQUEST_TOKEN_FAILED = "twitter_oauth1_request_token_failed"
TWITTER_OAUTH2_CALLBACK_FAILED = "twitter_oauth2_callback_failed"
TWITTER_MFA_PENDING_SESSION_KEY = "twitter_mfa_pending"
TWITTER_MFA_PENDING_TTL_SECONDS = 300
TWITTER_MFA_ATTEMPT_LIMIT = 5

#The OAuth2/PKCE handshake (`state` + `code_verifier`) travels in its own
#signed cookie between `/api/twitter/start` and `/api/twitter/callback`,
#NOT in `request.session`. `AuthorizeView` is unauthenticated, has
#no DRF throttle (it is a plain Django `View`) and no nginx `limit_req`, so
#writing to the session there minted one `django_session` row per
#cookie-less GET -- rows that stayed unexpired for `SESSION_COOKIE_AGE` (14
#days) and that every ownership event on the platform then had to read and
#decode. The cookie gives the callback the same browser binding the session
#did (login-CSRF on the callback still needs a value only the initiating
#browser holds) and costs the database nothing.
TWITTER_OAUTH2_HANDSHAKE_COOKIE = "twitter_oauth2_handshake"
#Restricted to the twitter API prefix so the cookie rides only to the
#callback, never to every request on the site.
TWITTER_OAUTH2_HANDSHAKE_PATH = "/api/twitter/"
#How long the browser may take to come back from X. Enforced twice, on
#purpose: as the cookie's `max_age` (the browser stops sending it) and as
#`signing.loads(max_age=...)` (this server stops honouring it), so a
#replayed cookie a browser was persuaded to keep is still refused.
#
#**Thirty minutes, not ten.** Nothing here measures what a real return trip
#costs, and the failure mode of guessing low is bad and silent: a user who
#signs UP at X from the consent screen, or app-switches for an SMS/TOTP
#code, or gets an account challenge, comes back to a bare
#`400 Invalid request from Twitter` with no retry affordance and no way to
#know why. Ten minutes is inside the range those take. The cost of the wider
#window is bounded and small -- the handshake is not a credential, both
#halves are already public in the authorize URL the browser was sent to, it
#mints no database row, and spending it at a successful callback ends it
#regardless of the clock. Raised by the adversarial review of.
TWITTER_OAUTH2_HANDSHAKE_MAX_AGE = 1800
TWITTER_OAUTH2_HANDSHAKE_SALT = "dj.apps.twitter.oauth2_handshake"

#X's OAuth2 consent endpoint. Deliberately `twitter.com`, not `x.com`: this
#is the host the flow has always used, it is what
#`bin/zuuli-social-oauth-preflight.py` and `dj.apps.social.clients.XProvider`
#both name, and an emergency hotfix is not the place to discover whether the
#registered app treats the two as interchangeable.
TWITTER_OAUTH2_AUTHORIZE_ENDPOINT = "https://twitter.com/i/oauth2/authorize"
#The path the provider redirects back to. One constant so the URL we ask X
#to redirect to and the `redirect_uri` the token exchange later replays
#cannot drift -- X compares them byte for byte and fails the exchange with
#an opaque error when they differ.
TWITTER_OAUTH2_CALLBACK_PATH = "/api/twitter/callback"
#Unchanged from what the browser used to build (and from what the classic
#React client in `ts/react/free2z` still builds). Scope is what the consent
#screen shows and what X has already recorded as granted for every existing
#user of this flow; narrowing it here would force a fresh consent screen on
#them. Widening it would too. So: preserve it exactly.
#(`dj.apps.social.clients.XProvider` asks for a different, narrower scope --
#that is the modern `/api/auth/social/x/` flow and its own registered
#grant. These two must NOT be unified in a hotfix.)
TWITTER_OAUTH2_SCOPE = "users.read follows.read tweet.read"
#Returned when `TWITTER_CLIENT_ID` is blank. 503, never 500 and never a boot
#failure -- the established "not configured" posture, see the module
#docstring of `dj/apps/social/clients.py`.
TWITTER_OAUTH2_NOT_CONFIGURED_DETAIL = "Sign-in with X is not configured."


def twitter_oauth2_callback_url():
    """The one `redirect_uri` for the legacy OAuth2 sign-in flow, or `None`.

    This value has to be identical in three places or the flow dies at X with
    an opaque error: the `redirect_uri` on the authorize URL, the
    `redirect_uri` replayed at the token exchange (`get_twitter_user` below),
    and the URI registered on the X app. It is derived from configuration
    rather than from the request because the authorize URL is built on
    `/api/twitter/start` (served by the main Deployment) while the token
    exchange happens on `/api/twitter/callback` (served by a SEPARATE
    Deployment, `k8s/free2z/oauth-callback-deployment.yaml`) -- two different
    request objects that must agree. BOTH halves call this function:
    the exchange used to replay `request.build_absolute_uri(...)`, which
    agreed with the authorize half only because X redirects to exactly the
    URI it was given, and followed a client-supplied `X-Forwarded-Host` on a
    route the GCLB sends straight to Django without nginx in between.

    **No request-derived fallback.** A blank `CANONICAL_ORIGIN`
    returns `None` and both callers answer 503 "not configured". It used to
    fall back to `request.build_absolute_uri()` -- the  shape that
    `dj.apps.emails.link_origin` refuses by doctrine -- and was unreachable in
    production only because a *different app's* system check
    (`emails.E001`) fails `manage.py check` on a blank value. A code path
    nothing can reach is a code path nothing notices rotting.

    `CANONICAL_ORIGIN` is the per-namespace canonical host from the k8s
    ConfigMap (`https://free2z.cash` in production, `https://stage.free2z.cash`
    on stage), so this yields exactly the URL the classic React client has
    always sent and that is registered with X today. The `DEBUG` branch
    mirrors `get_twitter_user`'s, which pins local development to
    `127.0.0.1:8000` regardless of which dev server the browser is on.
    """
    if settings.DEBUG:
        return "http://127.0.0.1:8000" + TWITTER_OAUTH2_CALLBACK_PATH
    origin = (getattr(settings, "CANONICAL_ORIGIN", "") or "").strip()
    origin = origin.rstrip("/")
    if origin:
        return origin + TWITTER_OAUTH2_CALLBACK_PATH
    return None


#Where "Sign in with X" may return to instead of `/profile`: the Free2Z
#pages an SDK app opens (ts/svelte/free2z/src/lib/sdk-flow.ts). Their sign-in
#has to come back to the request -- the consent screen, the Manage page,
#account deletion -- or an X-only account cannot finish it at all, and
#`/profile` (the dashboard) would leave a commerce-free flow for Credits.
#An allowlist of exact paths, not a general "safe next": this value rides
#an OAuth round trip through x.com, which is exactly the redirect worth
#hijacking, so it only ever names one of these pages on this origin.
X_RETURN_PATHS = frozenset({"/oauth/authorize", "/account/apps", "/account/delete"})

#Bound on the stored path. It is signed into a cookie with the PKCE pair, and
#a browser silently drops a cookie over 4096 bytes (the sign-in would then
#fail at the callback), so the path is printable ASCII -- an encoded URL
#always is -- and short enough that JSON and base64 cannot push it over
#(pinned by a test). A longer one is refused at `/start` with a 400, never
#silently dropped.
X_RETURN_MAX_LENGTH = 2400


_URL_CHARACTERS = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    "-._~:/?#[]@!$&'()*+,;=%"
)


def safe_x_return_path(value):
    """`value` if it is a same-origin path to an `X_RETURN_PATHS` page, else None.

    Refuses anything that could resolve off-origin or past the allowlist:
    scheme-relative `//`, backslashes (browsers read `/\\` as `//`), control
    characters and spaces, percent-encoded separators in the path, and any
    path that is not exactly an allowed page (an optional trailing slash
    aside). The query is kept as given: it is the request the page resumes.
    """
    if not isinstance(value, str) or not value or len(value) > X_RETURN_MAX_LENGTH:
        return None
    if not value.startswith("/") or value.startswith("//") or "\\" in value:
        return None
    # Only characters a URL carries unescaped (RFC 3986 unreserved, reserved
    # and `%`): none of them is expanded by JSON, so the signed cookie's size
    # is bounded by the length check (codex review: 2,400 `"` became 6.5 KB).
    if any(ch not in _URL_CHARACTERS for ch in value):
        return None
    path, _, _query = value.partition("?")
    if "#" in path or "%" in path:
        return None
    if path.rstrip("/") not in X_RETURN_PATHS:
        return None
    return value


def sign_oauth2_handshake(state, code_verifier, return_path=None):
    """The cookie value: a signed, timestamped `{state, code_verifier}`.

    `signing.dumps` authenticates without encrypting, which is fine here and
    would not be for a secret: both values are already in the authorize URL
    the browser is sent to, so the payload is exactly as public as the
    redirect. What the signature buys is that only this server can mint a
    value the callback will honour, and the timestamp bounds its life.
    """
    payload = {'state': state, 'code_verifier': code_verifier}
    return_path = safe_x_return_path(return_path)
    if return_path:
        # Signed with the rest, so only a value `/start` validated comes back.
        payload['next'] = return_path
    return signing.dumps(payload, salt=TWITTER_OAUTH2_HANDSHAKE_SALT)


def read_oauth2_handshake(request):
    """The handshake the initiating browser holds, or `None`.

    `None` for a missing cookie, a bad signature, an expired one, or a payload
    that is not the dict this server wrote. All four are the same answer to
    the callback: nothing binds this request to a flow this browser started.
    """
    raw = request.COOKIES.get(TWITTER_OAUTH2_HANDSHAKE_COOKIE)
    if not raw:
        return None
    try:
        payload = signing.loads(
            raw,
            salt=TWITTER_OAUTH2_HANDSHAKE_SALT,
            max_age=TWITTER_OAUTH2_HANDSHAKE_MAX_AGE,
        )
    except signing.BadSignature:
        return None
    if not isinstance(payload, dict) or not isinstance(
        payload.get('state'), str
    ):
        return None
    return payload


def handshake_return_path(handshake):
    """The page this sign-in returns to: the handshake's `next`, or `/profile`.

    Re-validated on the way out as well as on the way in, so a payload signed
    before an allowlist change can never widen it.
    """
    if isinstance(handshake, dict):
        safe = safe_x_return_path(handshake.get('next'))
        if safe:
            return safe
    return '/profile'


def spend_oauth2_handshake(response):
    """Consume the cookie after a successful provider identity lookup."""
    response.delete_cookie(
        TWITTER_OAUTH2_HANDSHAKE_COOKIE,
        path=TWITTER_OAUTH2_HANDSHAKE_PATH,
        samesite='Lax',
    )
    return response


def _log_oauth_event(
    event,
    correlation_id,
    failure_stage=None,
    level=logging.INFO,
):
    """Emit a bounded event containing no request, provider, or setting data."""
    payload = {"event": event, "correlation_id": correlation_id}
    if failure_stage is not None:
        payload["failure_stage"] = failure_stage
    logger.log(level, json.dumps(
        payload,
        separators=(",", ":"),
        sort_keys=True,
    ))


def _oauth_failure(event, correlation_id, failure_stage):
    _log_oauth_event(
        event,
        correlation_id,
        failure_stage,
        level=logging.ERROR,
    )
    return Response(
        {"detail": TWITTER_OAUTH1_FAILURE_DETAIL},
        status=status.HTTP_502_BAD_GATEWAY,
    )


def _protect_oauth_response(response, correlation_id):
    response["Cache-Control"] = "no-store"
    response.setdefault("Referrer-Policy", "no-referrer")
    response["X-Correlation-ID"] = correlation_id
    return response


def _oauth2_failure_stage(exc):
    """Classify without serializing an exception that may contain secrets."""
    if isinstance(exc, DatabaseError):
        return "application_database"
    if isinstance(exc, RequestException):
        return "provider_request"
    if isinstance(exc, (json.JSONDecodeError, KeyError)):
        return "provider_response"
    return "application"


class OAuthCredentialResponseMixin:
    def initial(self, request, *args, **kwargs):
        self.oauth_correlation_id = uuid.uuid4().hex
        return super().initial(request, *args, **kwargs)

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        return _protect_oauth_response(response, self.oauth_correlation_id)


class OAuthCredentialDjangoResponseMixin:
    """Protect plain Django callback responses, including exception paths."""

    def dispatch(self, request, *args, **kwargs):
        correlation_id = uuid.uuid4().hex
        try:
            response = super().dispatch(request, *args, **kwargs)
        except Exception as exc:
            # Provider error bodies can contain codes or tokens. Do not let an
            # exception reach Django's traceback/error logger.
            _log_oauth_event(
                TWITTER_OAUTH2_CALLBACK_FAILED,
                correlation_id,
                _oauth2_failure_stage(exc),
                level=logging.ERROR,
            )
            response = HttpResponse(
                TWITTER_OAUTH1_FAILURE_DETAIL,
                status=status.HTTP_502_BAD_GATEWAY,
            )
        return _protect_oauth_response(response, correlation_id)


def available_username(base):
    """Suffix a provider handle until it is route-safe and unused."""
    User = get_user_model()
    base = base[:140]
    username = base
    suffix = 0
    while (
        is_forbidden_username(username)
        or User.objects.filter(username__iexact=username).exists()
    ):
        suffix += 1
        username = f"{base}{suffix}"
    return username


class PublicStatusView(generics.RetrieveUpdateAPIView):
    permission_classes = [permissions.IsAuthenticated]
    queryset = TwitterProfile.objects.all()

    def get_object(self):
        obj = TwitterProfile.objects.get(creator=self.request.user)
        self.check_object_permissions(self.request, obj)
        return obj

    def retrieve(self, request, *args, **kwargs):
        instance = self.get_object()
        return Response({
            'is_public': instance.is_public,
            'allow_login': instance.allow_login,
        })

    def update(self, request, *args, **kwargs):
        instance = self.get_object()
        # Turning X login off evicts a principal; turning it back on adds one.
        # Re-enabling requires recent authentication and refreshes the row's
        # ownership stamp so it can be used after a prior disable event.
        try:
            with transaction.atomic():
                account = Creator.objects.select_for_update().get(
                    pk=request.user.pk,
                )
                locked = TwitterProfile.objects.select_for_update().get(
                    pk=instance.pk,
                )
                login_enabled = (
                    not locked.allow_login
                    and bool(request.data.get("allow_login"))
                )
                if login_enabled:
                    try:
                        require_recent_auth(request)
                    except RecentAuthenticationRequired as exc:
                        return exc.response()
                login_revoked = (
                    bool(locked.allow_login)
                    and not bool(request.data.get("allow_login"))
                )
                if login_revoked and not can_remove(
                    account, method_of(locked),
                ):
                    return Response(
                        {"detail": LAST_SIGNIN_METHOD_DETAIL},
                        status=status.HTTP_409_CONFLICT,
                    )
                locked.is_public = request.data.get("is_public")
                locked.allow_login = request.data.get("allow_login")
                if login_enabled:
                    locked.linked_at_epoch = account.kt_account_epoch
                    locked.fallback_rejected_at_epoch = None
                locked.save()
                if login_revoked:
                    bump_account_epoch(
                        locked.creator_id, event=EVENT_TWITTER_LOGIN_TOGGLED
                    )
                    if not signin_survives(account):
                        raise _LastSignInMethodLost
        except _LastSignInMethodLost:
            return Response(
                {"detail": LAST_SIGNIN_METHOD_DETAIL},
                status=status.HTTP_409_CONFLICT,
            )
        instance.is_public = locked.is_public
        instance.allow_login = locked.allow_login
        return Response({
            "is_public": instance.is_public,
            "allow_login": instance.allow_login,
        })


def is_valid_twitter_request(request):
    """The callback's CSRF defence: `state` must match the handshake cookie.

    The cookie is the browser binding. An attacker can obtain a perfectly
    valid `state` of their own by hitting `/start`, so the check is not "is
    this a state we issued" but "is this the state THIS browser was issued",
    and only the initiating browser holds the cookie that says so.
    """
    state = request.GET.get('state')
    handshake = read_oauth2_handshake(request)
    if not isinstance(state, str) or handshake is None:
        return False
    return constant_time_compare(state, handshake['state'])


def get_twitter_user(request, callback_url):
    """Exchange the callback's `code` and return X's view of the user.

    `callback_url` is `twitter_oauth2_callback_url()`, resolved by the caller
    (which answers 503 when it is `None`): the `redirect_uri` replayed here
    must be byte-identical to the one `AuthorizeView` put on the authorize
    URL, so both come from the one function.

    The `code_verifier` is replayed from the handshake cookie exactly as it
    always was, whichever PKCE method the authorize URL named. X recorded the
    method at authorize time and checks the verifier against it, so a
    handshake minted under `plain` before the  deploy and one minted
    under `S256` after it both complete here, and an S256 handshake that
    lands on a not-yet-rolled callback pod completes too. That is why the
    method could change on `/start` alone, without lockstep.
    """
    code = request.GET.get('code')
    handshake = read_oauth2_handshake(request) or {}
    client = get_client(callback_url)

    client.exchange_code_for_token(
        code, handshake.get('code_verifier'))
    return client.get_me()


def render_handle_collision(request, back='/profile'):
    """The  dead-end page, shared by every Twitter collision path.

    One renderer rather than two so the message and status cannot drift
    between the pre-creation refusal in the callback and the belt-and-braces
    check inside provisioning.
    """
    logger.warning(
        "twitter provisioning refused: handle collides with an "
        "existing Creator username"
    )
    return render(
        request,
        'twitter/handle_collision.html',
        {
            'error': (
                "A free2z account with this name already exists. "
                "Sign in to your existing account and link your X "
                "account from your settings instead."
            ),
            # The page the sign-in started from (an SDK-facing page from
            # `safe_x_return_path`, else /profile): leaving a refused sign-in
            # must not drop the visitor out of an app's flow.
            'back': back,
        },
        status=409,
    )


class TwitterCallbackView(OAuthCredentialDjangoResponseMixin, View):
    def dispatch(self, request, *args, **kwargs):
        # The cookie handshake is spent once the provider identity is
        # verified -- a `/start` binds at most one `/callback`. NOT
        # unconditionally: a rejected callback must leave a live handshake
        # alone, or any top-level navigation to
        # `/api/twitter/callback?state=wrong` -- another tab, a stale
        # bookmark, a link an attacker got the user to follow -- cancels a
        # sign-in that is still out at X, and the real return then fails
        # with a 400. Clear the cookie only after the identity check for this
        # reason; clearing it before then quietly drops that behavior.
        #
        # Deliberately `dispatch` and not a wrapper around `get`. The
        # url-write guard (`test_url_write_guard.py`) keys its narrow
        # allowlist on the function an offending expression LIVES in, so
        # moving this handler's body into a helper silently invalidates
        # every entry naming `TwitterCallbackView.get` -- the guard then
        # fails twice over, once for the unallowed reads at their new
        # address and once for the stale entries at the old one. Wrapping
        # from `dispatch` leaves `get` exactly where it was. Caught by the
        # codex adversarial review of this branch, not by the author.
        response = super().dispatch(request, *args, **kwargs)
        if getattr(request, 'twitter_handshake_spent', False):
            return spend_oauth2_handshake(response)
        return response

    def get(self, request, *args, **kwargs):
        if 'error' in request.GET:
            # Cancelled at X, or refused there: back to where the sign-in
            # started (an SDK-facing page keeps the visitor in the app's
            # flow), else /profile as before.
            back = handshake_return_path(read_oauth2_handshake(request))
            return HttpResponseBadRequest(
                f"Error: {escape(request.GET['error'])} "
                f"<a href='{escape(back)}'>Back</a>"
            )

        if not is_valid_twitter_request(request):
            return HttpResponse("Invalid request from Twitter", status=400)
        # Where a successful sign-in lands: back on the page an SDK app opened,
        # when `/start` was given one, else the dashboard as before.
        return_to = handshake_return_path(read_oauth2_handshake(request))

        #no request-derived `redirect_uri`. Unconfigured is the same
        # 503 `/start` gives, and the handshake is left unspent.
        callback_url = twitter_oauth2_callback_url()
        if callback_url is None:
            return HttpResponse(TWITTER_OAUTH2_NOT_CONFIGURED_DETAIL, status=503)

        twitter_user = get_twitter_user(request, callback_url)
        if not twitter_user:
            return HttpResponse("Unable to retrieve Twitter user", status=400)

        # The provider callback is a browser GET, so a TOTP must never be
        # carried in its query string. Consume the OAuth handshake now that
        # the provider identity has been verified -- `dispatch` clears the
        # cookie on the way out -- and keep only the server-side pending
        # account reference for the follow-up form POST, and only when there
        # is one.
        request.twitter_handshake_spent = True

        #refuse BEFORE any row exists. The get_or_create below
        # persists the TwitterProfile unconditionally, so a refusal after it
        # would leave a creator-less orphan -- and every later anonymous
        # attempt would take the `not created` branch straight past every
        # message into a silent redirect. A dead end explained once and never
        # again, and an identity that could then never be linked at all.
        if (
            request.user.is_anonymous
            and not TwitterProfile.objects.filter(
                twitter_id=twitter_user['id']
            ).exists()
            and handle_clashes_existing_account(twitter_user['username'])
        ):
            return render_handle_collision(request, back=return_to)

        with transaction.atomic():
            if request.user.is_authenticated:
                account = Creator.objects.select_for_update().get(
                    pk=request.user.pk,
                )
                if account.kt_account_epoch != request.user.kt_account_epoch:
                    return HttpResponse(STALE_IDENTITY_DETAIL, status=409)
                existing_profile = TwitterProfile.objects.filter(
                    twitter_id=twitter_user['id'],
                ).first()
                if (
                    existing_profile is None
                    or existing_profile.creator_id is None
                    or (
                        existing_profile.creator_id == request.user.pk
                        and not identity_can_authenticate(existing_profile, request.user)
                    )
                ):
                    try:
                        require_recent_auth(request)
                    except RecentAuthenticationRequired as exc:
                        return exc.response()

            twitter_profile, created = TwitterProfile.objects.get_or_create(
                twitter_id=twitter_user['id'],
                defaults={
                    'username': twitter_user['username'],
                    'name': twitter_user['name'],
                    'description': twitter_user['description'],
                    'profile_image_url': twitter_user['profile_image_url']
                }
            )

            if not created:
                # Anonymous sign-in callbacks must serialize with ownership
                # events for an already-linked profile. The read inside
                # get_or_create is intentionally lock-free; take the Creator
                # lock first, then reload and lock the profile so a marker
                # committed by an event cannot be overwritten or read stale.
                if (
                    request.user.is_anonymous
                    and twitter_profile.creator_id is not None
                ):
                    locked_creator_id = twitter_profile.creator_id
                    Creator.objects.select_for_update().get(
                        pk=locked_creator_id,
                    )
                    twitter_profile = TwitterProfile.objects.select_for_update().get(
                        pk=twitter_profile.pk,
                    )
                    if twitter_profile.creator_id != locked_creator_id:
                        return HttpResponse(STALE_IDENTITY_DETAIL, status=409)

                # Update only OAuth display metadata. A full model save could
                # write a stale fallback marker or linked epoch back over the
                # ownership event that just committed.
                twitter_profile.username = twitter_user['username']
                twitter_profile.name = twitter_user['name']
                twitter_profile.description = twitter_user['description']
                twitter_profile.profile_image_url = twitter_user['profile_image_url']
                twitter_profile.save(
                    update_fields=[
                        'username',
                        'name',
                        'description',
                        'profile_image_url',
                    ]
                )
                # An orphaned row -- from an interrupted flow, or from before the
                # refusal above moved ahead of creation -- carries no creator.
                # Whoever signs in and replays the OAuth IS the owner as far as
                # this platform can prove (same ownership rule as the social
                # app's association), so the profile becomes theirs; without
                # this, such a row is silently unlinkable forever. Deliberately
                # NOT a `kt_account_epoch` event: linking ADDS a
                # principal; see `dj.apps.ktauth.epoch`.
                if (
                    request.user.is_authenticated
                    and twitter_profile.creator_id is None
                ):
                    # This orphan did not grant access while it had no Creator.
                    # The identity-age heuristic used for passwordless recovery
                    # must therefore begin at the first association, not at the
                    # orphan row's historical creation time.  There is no
                    # recoverable association timestamp for already-adopted legacy
                    # rows; those remain subject to the documented heuristic in
                    # `ktauth.credentials`.
                    try:
                        require_recent_auth(request)
                    except RecentAuthenticationRequired as exc:
                        return exc.response()
                    twitter_profile.creator = request.user
                    twitter_profile.created_at = timezone.now()
                    # Stamped from `request.user`, which authentication loaded
                    # from the same row that validated this caller's own session
                    #. A replay by the owner after their own
                    # ownership event re-stamps here and gets the login back.
                    twitter_profile.linked_at_epoch = (
                        request.user.kt_account_epoch
                    )
                    twitter_profile.save(
                        update_fields=[
                            'creator',
                            'created_at',
                            'linked_at_epoch',
                            'fallback_rejected_at_epoch',
                        ]
                    )
                elif (
                    request.user.is_authenticated
                    and twitter_profile.creator_id == request.user.pk
                ):
                    if not identity_can_authenticate(twitter_profile, request.user):
                        try:
                            require_recent_auth(request)
                        except RecentAuthenticationRequired as exc:
                            return exc.response()
                    # `save(update_fields=...)` rather than a queryset `update()`:
                    # `dj/apps/test_url_write_guard.py` already blesses this
                    # function's `twitter_profile.save(...)` as the OAuth callback
                    # the provider redirect forces to be a GET, and one blessed
                    # write shape is better than a second allowlist entry.
                    twitter_profile.linked_at_epoch = (
                        request.user.kt_account_epoch
                    )
                    twitter_profile.fallback_rejected_at_epoch = None
                    twitter_profile.save(
                        update_fields=[
                            'linked_at_epoch',
                            'fallback_rejected_at_epoch',
                        ]
                    )
                if twitter_profile.allow_login and twitter_profile.creator_id:
                    # Only the profile's OWN creator may be treated as the
                    # account this proof authenticates. A signed-in caller
                    # presenting an X identity linked to a DIFFERENT account
                    # is signing in to that account (main's behaviour), never
                    # refreshing the caller's own authentication: otherwise a
                    # stale stolen session plus the attacker's own X login
                    # would satisfy every recent-auth gate on the victim
                    # (e.g. setting a first password).
                    if (
                        request.user.is_anonymous
                        or twitter_profile.creator_id != request.user.pk
                    ):
                        # Re-read both rows together after the metadata write.
                        # This is one READ COMMITTED snapshot for the marker
                        # and epoch comparison.
                        twitter_profile = TwitterProfile.objects.select_related(
                            'creator'
                        ).get(pk=twitter_profile.pk)
                        login_creator = twitter_profile.creator
                    else:
                        # The authenticated owner path holds the Creator lock
                        # and checked request.user's epoch before writing.
                        login_creator = request.user
                    if not identity_can_authenticate(
                        twitter_profile, login_creator
                    ):
                        return render(
                            request,
                            'twitter/stale_identity.html',
                            {'detail': STALE_IDENTITY_DETAIL, 'back': return_to},
                            status=403,
                        )
                    try:
                        ensure_account_can_sign_in(login_creator)
                    except InactiveAccount as exc:
                        return HttpResponse(exc.detail, status=403)
                    # A GET must never burn a TOTP step: the callback
                    # carries no code in its query string, so this is only an
                    # "is MFA enrolled" probe. The consuming verification of the
                    # submitted code belongs to the form POST below.
                    if has_active_totp(twitter_profile.creator):
                        request.session[TWITTER_MFA_PENDING_SESSION_KEY] = {
                            'creator_id': twitter_profile.creator_id,
                            'profile_id': twitter_profile.pk,
                            'created_at': int(timezone.now().timestamp()),
                            'next': return_to,
                        }
                        return self._totp_form(request)
                    # `login_creator`, NOT `twitter_profile.creator`. The latter
                    # is a lazily-resolved FK: it would be fetched HERE, after the
                    # epoch check, so an ownership event committing in between
                    # would be baked into the new session's auth hash as the NEW
                    # epoch and the session would survive the eviction. Signing in
                    # the instance the check was made against is what makes the
                    # session stale instead. (codex adversarial review)
                    # Deletion grace period: "Keep my account?" first, never
                    # a session (dj.apps.g12f.account_deletion).
                    try:
                        keep = keep_redirect(
                            login_creator, methods=[AMR_LEGACY_TWITTER],
                            next_path=return_to)
                    except InactiveAccount as exc:
                        return HttpResponse(exc.detail, status=403)
                    if keep is not None:
                        return keep
                    login(request, login_creator)
                    record_login(
                        request, login_creator, methods=[AMR_LEGACY_TWITTER],
                    )
                    logger.info("twitter_oauth2_callback_success")
                    return redirect(return_to)

            if created:
                if not request.user.is_anonymous:
                    # Deliberately NOT a `kt_account_epoch` event.
                    # Linking ADDS a principal; see `dj.apps.ktauth.epoch`. It is
                    # also why this GET callback needs no write-guard amnesty and
                    # no transaction of its own: the counter is not touched here.
                    twitter_profile.creator = request.user
                    twitter_profile.linked_at_epoch = (
                        request.user.kt_account_epoch
                    )
                    twitter_profile.save()
                else:
                    blocked = self.handle_new_twitter_user(twitter_user, request)
                    if blocked is not None:
                        return blocked

        # if it wasn't created and allow_login is False,
        # then, we saved the info as above, but we don't login
        # So, I guess they are either already logged in or they
        # are anonymous... HRM
        return redirect(return_to)

    def post(self, request, *args, **kwargs):
        pending = request.session.get(TWITTER_MFA_PENDING_SESSION_KEY)
        if not isinstance(pending, dict):
            return HttpResponse("Invalid or expired Twitter login.", status=400)

        created_at = pending.get('created_at')
        if (
            not isinstance(created_at, int)
            or int(timezone.now().timestamp()) - created_at
            > TWITTER_MFA_PENDING_TTL_SECONDS
        ):
            request.session.pop(TWITTER_MFA_PENDING_SESSION_KEY, None)
            return HttpResponse("Invalid or expired Twitter login.", status=400)

        profile = (
            TwitterProfile.objects.select_related('creator')
            .filter(
                pk=pending.get('profile_id'),
                creator_id=pending.get('creator_id'),
                allow_login=True,
            )
            .first()
        )
        #  again, on the second half of the same login. The GET above
        # checked it before showing the TOTP form; an ownership event can
        # commit while that form is on screen, and this POST is what actually
        # creates the session.
        if profile is not None and profile.creator is not None:
            try:
                ensure_account_can_sign_in(profile.creator)
            except InactiveAccount as exc:
                request.session.pop(TWITTER_MFA_PENDING_SESSION_KEY, None)
                return HttpResponse(exc.detail, status=403)
            if not identity_can_authenticate(profile, profile.creator):
                request.session.pop(TWITTER_MFA_PENDING_SESSION_KEY, None)
                return render(
                    request,
                    'twitter/stale_identity.html',
                    {
                        'detail': STALE_IDENTITY_DETAIL,
                        'back': handshake_return_path(pending),
                    },
                    status=403,
                )
        if profile is None or profile.creator is None:
            request.session.pop(TWITTER_MFA_PENDING_SESSION_KEY, None)
            return HttpResponse("Invalid or expired Twitter login.", status=400)

        attempt_identifier = f"{profile.creator_id}:{profile.pk}"
        attempt = claim_totp_attempt(
            "twitter",
            attempt_identifier,
            TWITTER_MFA_PENDING_TTL_SECONDS,
        )
        if attempt is None:
            return HttpResponse(
                "Twitter login is temporarily unavailable.",
                status=503,
            )
        if attempt > TWITTER_MFA_ATTEMPT_LIMIT:
            request.session.pop(TWITTER_MFA_PENDING_SESSION_KEY, None)
            return HttpResponse(
                "Too many Twitter login attempts. Start again.",
                status=429,
            )

        gate = check_user_totp(profile.creator, request.POST.get('otp_token'))
        if not gate.passed:
            if attempt == TWITTER_MFA_ATTEMPT_LIMIT:
                request.session.pop(TWITTER_MFA_PENDING_SESSION_KEY, None)
                return HttpResponse(
                    "Too many Twitter login attempts. Start again.",
                    status=429,
                )
            return self._totp_form(
                request,
                error=INVALID_OTP_TOKEN_MESSAGE,
                status_code=400,
            )

        request.session.pop(TWITTER_MFA_PENDING_SESSION_KEY, None)
        try:
            keep = keep_redirect(
                profile.creator, methods=[AMR_LEGACY_TWITTER],
                second_factor=gate.second_factor,
                next_path=handshake_return_path(pending),
            )
        except InactiveAccount as exc:
            clear_totp_attempt("twitter", attempt_identifier)
            return HttpResponse(exc.detail, status=403)
        if keep is not None:
            clear_totp_attempt("twitter", attempt_identifier)
            return keep
        login(request, profile.creator)
        record_login(
            request, profile.creator,
            methods=[AMR_LEGACY_TWITTER],
            second_factor=gate.second_factor,
        )
        clear_totp_attempt("twitter", attempt_identifier)
        logger.info("twitter_oauth2_callback_success")
        return redirect(handshake_return_path(pending))

    @staticmethod
    def _totp_form(request, error=None, status_code=200):
        response = render(
            request,
            'twitter/totp_login.html',
            {'error': error},
        )
        response.status_code = status_code
        # A no-referrer form POST sends Origin: null in browsers, so Django
        # rejects it before checking the CSRF token or authenticator code.
        # Send only the origin: the callback URL contains OAuth credentials.
        response["Referrer-Policy"] = "strict-origin"
        return response

    def handle_new_twitter_user(self, twitter_user, request):
        # Twitter is new and the user is not logged in
        User = get_user_model()

        # If no user is logged in, create a new user account
        username = twitter_user['username']
        if is_forbidden_username(username):
            # Provider handles must not claim application-owned route
            # namespaces. A reserved name is a route, not anyone's account,
            # so suffixing here stays correct.
            username = available_username(username)
        elif User.objects.filter(username__iexact=username).exists():
            #, refuse-not-link. The X/Twitter handle matches an
            # existing Creator's username case-insensitively. A matching
            # handle proves nothing about ownership -- anyone can register
            # @alice on X -- so never attach this profile to that account,
            # and never mint a lookalike "alice1" duplicate either (that is
            # how two duplicate pairs reached production). Proving ownership
            # requires an authenticated session: sign in to the existing
            # account first and link from settings. The callback refuses
            # BEFORE creating the profile row; this repeat check is
            # belt-and-braces for any path that reaches provisioning anyway.
            return render_handle_collision(
                request,
                back=handshake_return_path(read_oauth2_handshake(request)),
            )

        # Create and configure a new user
        new_user = User.objects.create(
            username=username,
            full_name=twitter_user['name'],
            description=twitter_user['description'],
            avatar_url=twitter_user['profile_image_url'],
        )
        new_user.set_unusable_password()
        new_user.save(update_fields=['password', 'password_set', 'updated_at'])

        # Link the new user to the Twitter profile
        twitter_profile = TwitterProfile.objects.get(twitter_id=twitter_user['id'])
        twitter_profile.creator = new_user
        twitter_profile.save()
        #the welcome 2Z, inside the callback's transaction.atomic()
        # with the account itself. Never fails the sign-in.
        # Keyed on the X user id (shared with the social X provider), so
        # unlinking and re-provisioning earns no second grant.
        welcome_new_account(
            new_user, path="twitter",
            identity_key=identity_welcome_key("x", twitter_user['id']),
        )
        login(request, new_user)
        record_login(request, new_user, methods=[AMR_LEGACY_TWITTER])
        logger.info("twitter_oauth2_callback_success")


# Starts the PKCE oauth bit
class AuthorizeView(View):
    # Unauthenticated by design (sign-in with X starts signed out), and it
    # must touch NEITHER the database nor `request.session`: a plain Django
    # `View` has no DRF throttle, so anything it persists per anonymous GET
    # is inflatable for free. The handshake rides in a signed cookie
    # instead -- see `TWITTER_OAUTH2_HANDSHAKE_COOKIE`.
    def get(self, request):
        #the SERVER owns the authorize URL. It used to return only
        # `{state, code_challenge}` and leave the browser to assemble the rest
        # from a build-time `VITE_TWITTER_CLIENT_ID` that was set in no
        # Dockerfile, no Cloud Build substitution and no k8s manifest -- so it
        # was `undefined` in every image ever shipped and 100% of new-UI users
        # got "Sign-in with X is not configured" for two months, while this
        # endpoint kept answering 200. A build-time variable that can go
        # missing without any signal is the failure mode; the fix is to stop
        # having one. `client_id` lives in the same ConfigMap the callback
        # already reads to exchange the code, so the two cannot disagree.
        client_id = (getattr(settings, 'TWITTER_CLIENT_ID', '') or '').strip()
        #a blank `CANONICAL_ORIGIN` is "not configured" too, never a
        # `redirect_uri` derived from this request's Host.
        callback_url = twitter_oauth2_callback_url()
        if not client_id or callback_url is None:
            response = JsonResponse(
                {'detail': TWITTER_OAUTH2_NOT_CONFIGURED_DETAIL},
                status=503,
            )
            response['Cache-Control'] = 'no-store'
            return response

        # An SDK-facing page asked to be returned to (`next`). One this server
        # will not return to is refused here, visibly, rather than dropped:
        # dropping it would sign the visitor in and land them on /profile,
        # out of the app's flow.
        requested_next = request.GET.get('next')
        if requested_next is not None and safe_x_return_path(requested_next) is None:
            response = JsonResponse(
                {'detail': 'Sign-in with X cannot return to this page.'},
                status=400,
            )
            response['Cache-Control'] = 'no-store'
            return response

        # Generate a random state
        state = get_random_string(length=32)

        # PKCE. 64 chars of [A-Za-z0-9] is a valid RFC 7636 verifier
        # (43-128 unreserved characters). It never leaves this server except
        # in the signed, HttpOnly handshake cookie and the token exchange.
        code_verifier = get_random_string(length=64)

        #S256, not `plain`. Under `plain` the challenge IS the
        # verifier, so the verifier was published in the authorize URL and
        # leaked through `Referer` to x.com, browser history and history sync
        # -- the precondition of the takeover `spend_oauth2_handshake` exists
        # to close. Only this half changes: the callback replays the verifier
        # from the cookie regardless of method and X checks it against the
        # method it recorded at authorize time, so in-flight `plain`
        # handshakes still complete and the two Deployments need no lockstep
        # (see `get_twitter_user`).
        code_challenge = pkce_challenge(code_verifier)
        authorize_url = TWITTER_OAUTH2_AUTHORIZE_ENDPOINT + '?' + urlencode({
            'response_type': 'code',
            'client_id': client_id,
            'redirect_uri': callback_url,
            'scope': TWITTER_OAUTH2_SCOPE,
            'state': state,
            'code_challenge': code_challenge,
            'code_challenge_method': 'S256',
            'intent': 'authenticate',
        })

        response_data = {
            'state': state,
            'code_challenge': code_challenge,
            # Named, because it changed: the classic React client
            # assembles its own URL from these fields and must not keep
            # sending `plain` with an S256 challenge.
            'code_challenge_method': 'S256',
            'authorize_url': authorize_url,
        }
        # Low-cardinality operational signal for. The public uptime
        # synthetic marks its own request so its 240 hourly probes cannot look
        # like human demand without a corresponding callback. This header is
        # telemetry only: it does not change authentication or the response.
        # Do not log state, client_id, or the callback URL.
        if request.headers.get("X-Free2z-Synthetic-Probe") != "twitter-start":
            logger.info("twitter_oauth2_start_ready")
        response = JsonResponse(response_data)
        response.set_cookie(
            TWITTER_OAUTH2_HANDSHAKE_COOKIE,
            # `next` only ever names an SDK-facing page (`safe_x_return_path`);
            # anything else is dropped and the sign-in lands on `/profile`.
            sign_oauth2_handshake(state, code_verifier, requested_next),
            max_age=TWITTER_OAUTH2_HANDSHAKE_MAX_AGE,
            path=TWITTER_OAUTH2_HANDSHAKE_PATH,
            # Same transport posture as the session cookie it replaces.
            secure=settings.SESSION_COOKIE_SECURE or None,
            httponly=True,
            # Lax, not Strict: the callback is a top-level navigation FROM
            # x.com, and a Strict cookie is not sent on it.
            samesite='Lax',
        )
        response['Cache-Control'] = 'no-store'
        return response


# v1 below


class RequestTokenView(OAuthCredentialResponseMixin, APIView):
    # Legacy Twitter OAuth v1 start. Left open (status quo) because the
    # flow can begin from a signed-out browser; it burns a Twitter API
    # call, hence the anon throttle. See  - the v1 flow is a
    # candidate for deletion, which needs a product call, not a
    # security PR. Alone in 'anon-oauth' with its callback partner below: an
    # unauthenticated POST that spends a Twitter API quota unit is freely
    # automatable, so whatever bucket it sits in can be drained on demand. It
    # must not share with the signup budget or with the email-link landings
    #.
    permission_classes = [permissions.AllowAny]
    throttle_classes = THIRD_PARTY_OAUTH_THROTTLES

    def post(self, request):
        correlation_id = self.oauth_correlation_id
        try:
            cli = TwitterOAuthClient(
                os.environ['TWITTER_API_KEY'],
                os.environ['TWITTER_API_KEY_SECRET'],
            )
            cb_url = request.build_absolute_uri('/api/twitter/v1/access-token')
        except Exception:
            return _oauth_failure(
                TWITTER_OAUTH1_REQUEST_TOKEN_FAILED,
                correlation_id,
                "configuration",
            )

        try:
            resp = cli.get_request_token(cb_url)
        except Exception:
            # Provider exceptions can echo credentials. Keep them out of
            # Django's 500 traceback and return a fixed response.
            return _oauth_failure(
                TWITTER_OAUTH1_REQUEST_TOKEN_FAILED,
                correlation_id,
                "provider_request",
            )

        try:
            request.session['oauth_token_secret'] = resp['oauth_token_secret']
            response_token = resp['oauth_token']
        except Exception:
            return _oauth_failure(
                TWITTER_OAUTH1_REQUEST_TOKEN_FAILED,
                correlation_id,
                "provider_response",
            )

        # Return the request token in the response
        return Response(response_token)


class TwitterCallback1View(OAuthCredentialResponseMixin, APIView):
    # Redirect target for Twitter itself; arrives without our session.
    # 'anon-oauth' with the request-token half above — it spends the second
    # Twitter API call of the same dance.
    permission_classes = [permissions.AllowAny]
    throttle_classes = THIRD_PARTY_OAUTH_THROTTLES

    def get(self, request):
        correlation_id = self.oauth_correlation_id
        _log_oauth_event(TWITTER_OAUTH1_CALLBACK_RECEIVED, correlation_id)

        try:
            oauth_token = request.query_params['oauth_token']
            oauth_verifier = request.query_params['oauth_verifier']
            request_token_secret = request.session['oauth_token_secret']
        except Exception:
            return _oauth_failure(
                TWITTER_OAUTH1_CALLBACK_FAILED,
                correlation_id,
                "callback_input",
            )

        try:
            application_key = os.environ['TWITTER_API_KEY']
            application_secret = os.environ['TWITTER_API_KEY_SECRET']
        except Exception:
            return _oauth_failure(
                TWITTER_OAUTH1_CALLBACK_FAILED,
                correlation_id,
                "configuration",
            )

        try:
            oauth = OAuth1Session(
                application_key,
                client_secret=application_secret,
                resource_owner_key=oauth_token,
                resource_owner_secret=request_token_secret,
                verifier=oauth_verifier,
            )
            with twitter_oauth1_provider_deadline():
                access_token = oauth.fetch_access_token(
                    "https://api.twitter.com/oauth/access_token",
                    timeout=TWITTER_OAUTH1_PROVIDER_TIMEOUT,
                )
            access_key = access_token['oauth_token']
            access_secret = access_token['oauth_token_secret']
        except Exception:
            return _oauth_failure(
                TWITTER_OAUTH1_CALLBACK_FAILED,
                correlation_id,
                "token_exchange",
            )

        try:
            oauth = OAuth1Session(
                application_key,
                client_secret=application_secret,
                resource_owner_key=access_key,
                resource_owner_secret=access_secret,
            )
            with twitter_oauth1_provider_deadline():
                provider_response = oauth.get(
                    'https://api.twitter.com/1.1/account/verify_credentials.json',
                    timeout=TWITTER_OAUTH1_PROVIDER_TIMEOUT,
                )
        except Exception:
            # Never log the exception: OAuth/HTTP exceptions may contain the
            # signed request, application secret, or provider response body.
            return _oauth_failure(
                TWITTER_OAUTH1_CALLBACK_FAILED,
                correlation_id,
                "account_lookup",
            )

        if provider_response.status_code != 200:
            return _oauth_failure(
                TWITTER_OAUTH1_CALLBACK_FAILED,
                correlation_id,
                "account_status",
            )

        # TODO: create/save
        return redirect('/profile')


class TwitterDeleteView(APIView):
    # Deletes the caller's own TwitterProfile. Had no permission at all;
    # an anonymous DELETE hit the ORM with AnonymousUser and 500'd.
    permission_classes = [permissions.IsAuthenticated]

    def delete(self, request):
        try:
            with transaction.atomic():
                account = Creator.objects.select_for_update().get(
                    pk=request.user.pk,
                )
                profile = TwitterProfile.objects.filter(
                    creator=account,
                ).first()
                if profile is None:
                    return Response(
                        {"detail": "No such linked identity."},
                        status=status.HTTP_404_NOT_FOUND,
                    )
                if not can_remove(account, method_of(profile)):
                    return Response(
                        {"detail": LAST_SIGNIN_METHOD_DETAIL},
                        status=status.HTTP_409_CONFLICT,
                    )
                deleted, _ = TwitterProfile.objects.filter(
                    creator=account,
                ).delete()
                if not deleted:
                    return Response(
                        {"detail": "No such linked identity."},
                        status=status.HTTP_404_NOT_FOUND,
                    )
                bump_account_epoch(
                    request.user.pk, event=EVENT_TWITTER_IDENTITY_UNLINKED
                )
                if not signin_survives(account):
                    raise _LastSignInMethodLost
        except _LastSignInMethodLost:
            return Response(
                {"detail": LAST_SIGNIN_METHOD_DETAIL},
                status=status.HTTP_409_CONFLICT,
            )
        return Response(status=status.HTTP_204_NO_CONTENT)
