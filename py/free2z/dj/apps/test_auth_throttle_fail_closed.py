"""Credential throttles fail CLOSED when their counter store is down.

Everything else in ``dj.free2z.throttling`` fails open on a cache outage, on
purpose (``test_throttling.py`` pins that). The credential scopes are the
exception: on password login, signup, password reset, OTP login and the OAuth
starts the throttle IS the brake on guessing, and "Redis is down" must not
mean "unlimited guesses for as long as it stays down". They answer 503.

Two halves, and the tests below pin each separately because either alone is
inert:

* the throttle class decides to refuse (``fails_closed``) -- pinned with a
  mock counter store that raises;
* the counter store actually RAISES. Production's ``default`` cache has
  ``IGNORE_EXCEPTIONS: True``, so an outage there reaches no handler at all:
  ``cache.get`` returns an empty history and the throttle admits everything.
  The credential throttles therefore count in the ``auth_throttle`` alias,
  which ``prod_settings.py`` defines with ``IGNORE_EXCEPTIONS: False``. The
  real-django_redis tests show the difference that setting makes, and
  ``test_prod_defines_a_raising_auth_throttle_cache`` pins the prod config.

Negative control for the whole file: set ``fails_closed = False`` on
``FailClosedAuthThrottleMixin`` and every 503 assertion below turns into the
endpoint's own answer (400/401/406/...), i.e. an unthrottled request.
"""

import ast
import json
import logging
from pathlib import Path
from unittest import mock

import pytest
import redis
from django.core.cache import cache
from django.test import override_settings
from django.urls import URLPattern, URLResolver, get_resolver
from django.utils.connection import ConnectionProxy
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView

from dj.apps.otp.views import BruteRateThrottle
from dj.free2z import throttling
from dj.free2z.throttling import (
    AUTH_THROTTLE_CACHE_ALIAS,
    AUTH_THROTTLE_UNAVAILABLE_EVENT,
    THROTTLE_FAIL_OPEN_EVENT,
    AccountRecoveryAnonRateThrottle,
    AuthenticatedUserRateThrottle,
    FailClosedAuthThrottleMixin,
    LoginPathAnonRateThrottle,
    OAuthCompletionAnonRateThrottle,
    OAuthStateAnonRateThrottle,
    PasswordLoginRateThrottle,
    ThirdPartyOAuthAnonRateThrottle,
)

PY_DIR = Path(__file__).resolve().parents[2]

#The credential scopes. Pinned both ways by
#``test_the_fail_closed_scopes_are_exactly_the_credential_scopes``: a new
#credential endpoint must join deliberately, and a polling/landing scope
#must never drift in (a 503 there is an outage for no security gain).
AUTH_SCOPES = {
    "anon-login",          # /api/start/ + /api/auth/login/
    "anon-recovery",       # password reset request + consume
    "anon-oauth",          # X (Twitter) OAuth v1 request-token + callback
    "anon-oauth-state",    # social OAuth starts
    "anon-oauth-complete",  # social relay + knox-issuing login POST
    "brute",               # every TOTP endpoint, including OTP login
    # The OIDC provider: the consent step mints authorization codes;
    # the token endpoint takes codes, refresh tokens and client secrets.
    "anon-oidc-authorize",
    "anon-oidc-token",
}

AUTH_THROTTLE_CLASSES = [
    LoginPathAnonRateThrottle,
    PasswordLoginRateThrottle,
    AccountRecoveryAnonRateThrottle,
    ThirdPartyOAuthAnonRateThrottle,
    OAuthStateAnonRateThrottle,
    OAuthCompletionAnonRateThrottle,
    throttling.OIDCAuthorizeAnonRateThrottle,
    throttling.OIDCTokenAnonRateThrottle,
    BruteRateThrottle,
]

#(method, path) -- one real anonymous request per credential view. Each is
#answered by the throttle before any handler, serializer or provider runs.
AUTH_ENDPOINTS = [
    ("post", "/api/auth/login/"),
    ("post", "/api/auth/login"),
    ("post", "/api/start/"),
    ("post", "/api/emails/reset-password"),
    ("post", "/api/emails/do-reset-password"),
    ("post", "/api/otp/login/"),
    ("get", "/api/auth/social/google/start"),
    ("post", "/api/auth/social/google/"),
    # Well-formed: a malformed relay callback is rejected before Redis and is
    # deliberately not charged (see OAuthCompletionAnonRateThrottle).
    ("get", "/api/auth/social/mobile/callback?state=" + "R" * 32 + "&code=c"),
    ("post", "/api/twitter/v1/request-token"),
    ("get", "/api/twitter/v1/access-token"),
]


@pytest.fixture(autouse=True)
def _clear_throttle_history():
    cache.clear()
    yield
    cache.clear()


def _dead_store(exc):
    fake = mock.Mock()
    fake.get.side_effect = exc
    fake.set.side_effect = exc
    return fake


def _events(caplog, name):
    out = []
    for record in caplog.records:
        try:
            payload = json.loads(record.getMessage())
        except ValueError:
            continue
        if payload.get("event") == name:
            out.append(payload)
    return out


# ------------------------------------------------------------------ wiring


@pytest.mark.parametrize(
    "throttle_cls", AUTH_THROTTLE_CLASSES, ids=lambda c: c.__name__
)
def test_every_credential_throttle_fails_closed_on_the_raising_alias(
    throttle_cls,
):
    assert throttle_cls.fails_closed is True
    assert throttle_cls.cache is FailClosedAuthThrottleMixin.cache, (
        f"{throttle_cls.__name__} counts in a different cache than the "
        "auth_throttle alias; on prod's swallowing 'default' it can never "
        "see an outage, so fails_closed would never fire"
    )
    assert throttle_cls.scope in AUTH_SCOPES


def _served_throttle_classes():
    def walk(resolver):
        for pattern in resolver.url_patterns:
            if isinstance(pattern, URLResolver):
                yield from walk(pattern)
            elif isinstance(pattern, URLPattern):
                yield pattern.callback

    for callback in walk(get_resolver()):
        cls = getattr(callback, "cls", None) or getattr(
            callback, "view_class", None
        )
        if cls is not None and issubclass(cls, APIView):
            yield from getattr(cls, "throttle_classes", [])


def test_the_fail_closed_scopes_are_exactly_the_credential_scopes():
    """Both directions, over every throttle actually mounted in the URLconf."""
    closed = set()
    opened = set()
    for throttle_cls in _served_throttle_classes():
        scope = getattr(throttle_cls, "scope", None)
        if getattr(throttle_cls, "fails_closed", False):
            closed.add(scope)
        elif issubclass(throttle_cls, throttling.FailOpenThrottleMixin):
            opened.add(scope)

    assert closed == AUTH_SCOPES, (
        "fail-closed scopes drifted from the credential set: "
        f"extra={sorted(closed - AUTH_SCOPES)} "
        f"missing={sorted(AUTH_SCOPES - closed)}"
    )
    assert not (opened & AUTH_SCOPES), (
        "a credential scope is ALSO served by a fail-open class, so one of "
        f"its endpoints is still an open lane: {sorted(opened & AUTH_SCOPES)}"
    )
    # The load-shedding scopes stay fail-open; a 503 on polling or an
    # unsubscribe link is an outage with nothing to protect.
    assert {"anon-poll", "anon-link", "user"} <= opened, sorted(opened)


def test_the_global_user_ceiling_still_fails_open():
    assert AuthenticatedUserRateThrottle.fails_closed is False
    assert SimpleRateThrottle.cache is not FailClosedAuthThrottleMixin.cache


def test_the_proxy_resolves_the_auth_alias_when_it_is_configured():
    """Dev/CI fall back to 'default'; a configured alias must win."""
    with override_settings(
        CACHES={
            "default": {
                "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
            },
            AUTH_THROTTLE_CACHE_ALIAS: {
                "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
                "LOCATION": "auth-throttle-test",
            },
        }
    ):
        proxy = throttling._auth_throttle_cache()
    assert isinstance(proxy, ConnectionProxy)
    assert proxy._alias == AUTH_THROTTLE_CACHE_ALIAS


def _prod_caches_dict():
    tree = ast.parse((PY_DIR / "dj/free2z/prod_settings.py").read_text())
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Assign)
            and any(
                isinstance(t, ast.Name) and t.id == "CACHES"
                for t in node.targets
            )
            and isinstance(node.value, ast.Dict)
        ):
            return node.value
    raise AssertionError("prod_settings.py assigns no CACHES dict literal")


def _dict_get(node, key):
    for k, v in zip(node.keys, node.values):
        if isinstance(k, ast.Constant) and k.value == key:
            return v
    return None


def test_prod_defines_a_raising_auth_throttle_cache():
    """Without this alias, prod silently falls back to the swallowing default.

    Read from the source rather than imported: importing prod_settings needs
    the production environment. ``test_outbound_call_timeouts.py`` separately
    requires socket timeouts on every django_redis cache there, which is what
    turns a SILENT Redis into a prompt 503 instead of a hung worker.
    """
    entry = _dict_get(_prod_caches_dict(), AUTH_THROTTLE_CACHE_ALIAS)
    assert entry is not None, (
        f"prod_settings.CACHES has no {AUTH_THROTTLE_CACHE_ALIAS!r}: the "
        "credential throttles would count in 'default', whose "
        "IGNORE_EXCEPTIONS=True turns a Redis outage into no rate limiting"
    )
    backend = _dict_get(entry, "BACKEND")
    assert isinstance(backend, ast.Constant)
    assert backend.value == "django_redis.cache.RedisCache"
    options = _dict_get(entry, "OPTIONS")
    assert options is not None
    ignore = _dict_get(options, "IGNORE_EXCEPTIONS")
    assert isinstance(ignore, ast.Constant) and ignore.value is False, (
        "the auth_throttle alias must NOT swallow exceptions -- that is the "
        "whole mechanism"
    )


# --------------------------------------------------------------- behaviour


@pytest.mark.django_db
@pytest.mark.parametrize("method,path", AUTH_ENDPOINTS)
def test_a_dead_counter_store_refuses_every_credential_endpoint(
    api_client, method, path
):
    boom = redis.exceptions.ConnectionError(
        "Error 111 connecting to redis:6379. Connection refused."
    )
    with mock.patch.object(
        FailClosedAuthThrottleMixin, "cache", new=_dead_store(boom)
    ):
        response = getattr(api_client, method)(path, {}, format="json")

    assert response.status_code == 503, (
        f"{method.upper()} {path} admitted a request its throttle could not "
        f"count: {response.status_code} {response.content[:200]!r}"
    )
    assert response.json()["detail"].startswith("Sign-in is temporarily")
    assert response["Retry-After"] == "30"


@pytest.mark.django_db
def test_a_dead_auth_store_leaves_everything_else_serving(
    api_client, creator_factory
):
    """Fail-closed is scoped: session traffic and link landings keep working.

    Both stores are dead here. The credential endpoint refuses; an
    authenticated read (global ``user`` ceiling) and an anonymous email-link
    landing (``anon-link``) still reach their handlers.
    """
    boom = redis.exceptions.ConnectionError("Connection refused.")
    with mock.patch.object(
        FailClosedAuthThrottleMixin, "cache", new=_dead_store(boom)
    ), mock.patch.object(
        SimpleRateThrottle, "cache", new=_dead_store(boom)
    ):
        login = api_client.post("/api/auth/login/", {}, format="json")
        landing = api_client.get("/api/emails/confirm")
        api_client.force_authenticate(user=creator_factory())
        read = api_client.get("/api/zpage/")

    assert login.status_code == 503, login.content
    assert landing.status_code == 400, landing.content
    assert read.status_code == 200, read.content


@pytest.mark.django_db
def test_the_refusal_is_one_countable_error_line(api_client, caplog):
    boom = redis.exceptions.TimeoutError("Timeout reading from socket")
    with caplog.at_level(logging.WARNING, logger="dj.free2z.throttling"):
        with mock.patch.object(
            FailClosedAuthThrottleMixin, "cache", new=_dead_store(boom)
        ):
            response = api_client.post("/api/auth/login/", {}, format="json")

    assert response.status_code == 503
    events = _events(caplog, AUTH_THROTTLE_UNAVAILABLE_EVENT)
    assert events, caplog.messages
    entry = events[-1]
    assert entry["severity"] == "ERROR"
    assert entry["throttle"] == "PasswordLoginRateThrottle"
    assert entry["scope"] == "anon-login"
    assert entry["error_type"] == "TimeoutError"
    assert entry["error_module"].startswith("redis")
    assert entry["path"] == "/api/auth/login/"
    assert not _events(caplog, THROTTLE_FAIL_OPEN_EVENT), (
        "a refusal must not ALSO be counted as a fail-open"
    )


@pytest.mark.django_db
def test_a_non_cache_error_is_not_dressed_up_as_a_503(api_client):
    """'s narrowing holds on the closed side too: only the cache counts.

    An unrelated bug must surface as itself, not as "sign-in unavailable".
    """
    with mock.patch.object(
        FailClosedAuthThrottleMixin,
        "cache",
        new=_dead_store(RuntimeError("not a cache problem")),
    ):
        with pytest.raises(RuntimeError, match="not a cache problem"):
            api_client.post("/api/auth/login/", {}, format="json")


@pytest.mark.django_db
def test_a_healthy_store_still_admits_and_still_429s(api_client):
    """The fail-closed path must not have broken the ordinary one."""
    first = api_client.post("/api/auth/login/", {}, format="json")
    assert first.status_code == 400, first.content  # captcha_result required

    with mock.patch.object(
        PasswordLoginRateThrottle, "rate", "1/minute", create=True
    ):
        api_client.post("/api/auth/login/", {}, format="json")
        throttled = api_client.post("/api/auth/login/", {}, format="json")
    assert throttled.status_code == 429, throttled.content


# ----------------------------------------------- the real django_redis path


def _unreachable_redis(*, ignore_exceptions):
    """prod's backend pointed at port 1 (refused immediately, never hangs).

    In this settings module the auth throttle's proxy resolves to 'default'
    (no auth_throttle alias is configured), so overriding 'default' is
    overriding the store the credential throttles really read.
    """
    return {
        "default": {
            "BACKEND": "django_redis.cache.RedisCache",
            "LOCATION": "redis://127.0.0.1:1/1",
            "OPTIONS": {
                "CLIENT_CLASS": "django_redis.client.DefaultClient",
                "IGNORE_EXCEPTIONS": ignore_exceptions,
            },
        }
    }


@pytest.mark.django_db
def test_real_redis_outage_on_a_raising_store_refuses_login(api_client):
    assert FailClosedAuthThrottleMixin.cache._alias == "default", (
        "precondition: this test assumes CI has no auth_throttle alias"
    )
    with override_settings(CACHES=_unreachable_redis(ignore_exceptions=False)):
        response = api_client.post("/api/auth/login/", {}, format="json")

    assert response.status_code == 503, (
        f"{response.status_code} {response.content[:200]!r}"
    )


@pytest.mark.django_db
def test_real_redis_outage_on_a_swallowing_store_cannot_fail_closed(
    api_client,
):
    """Why the separate alias exists, demonstrated rather than asserted.

    With ``IGNORE_EXCEPTIONS: True`` -- prod's ``default`` -- the very same
    outage never reaches the throttle: the request sails through to the
    serializer (400, missing captcha) with no rate limiting at all. If the
    credential throttles ever counted in ``default`` in prod, this is what
    fail-closed would silently degrade to.
    """
    with override_settings(CACHES=_unreachable_redis(ignore_exceptions=True)):
        response = api_client.post("/api/auth/login/", {}, format="json")

    assert response.status_code == 400, (
        f"{response.status_code} {response.content[:200]!r}"
    )
