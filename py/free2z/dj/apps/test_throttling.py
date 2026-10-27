"""Throttle wiring guards.

Throttling was entirely commented out. Re-enabling it on a live money-handling
API has one failure mode that matters far more than "an attacker got through":
throttling the *site itself* off the air. So these tests pin the wiring, not
the numbers:

* No globally-applied throttle keys anonymous requests on client IP. The
  SvelteKit SSR pod fetches the public reads server-to-server with no
  ``X-Forwarded-For``, so every anonymous page view of free2z.cash would land
  in one bucket and 429 the whole site. This excludes ``AnonRateThrottle`` and
  also DRF's stock ``UserRateThrottle``, which falls back to IP when the
  request is anonymous.
* Every view that opts into anon throttling keeps a user throttle too.
  ``throttle_classes`` on a view *replaces* the default list rather than adding
  to it, so a view that lists only ``AnonRateThrottle`` silently exempts every
  logged-in caller — the exact opposite of the intent.
* Every scope named by a throttle class in use has a configured rate. DRF
  raises ``ImproperlyConfigured`` at request time for a missing scope, i.e. a
  500 on the endpoint, not a startup error.
* The anon scopes stay *separate*. DRF's anon cache key has no view
  component, so a scope is one shared per-IP budget and the noisiest endpoint
  in it sets the floor for every other endpoint in it. Machine-paced polling
  sharing a bucket with signup meant a busy office egress could 429
  registration for the whole network. There is a behavioural proof of the
  isolation below, plus a pinned inventory so a new anonymous-reachable view
  cannot land on "whatever the default is" without a deliberate edit.
* One scope's *number* is pinned, not just its wiring: ``anon-login``. It is
  the exception because the endpoint it gates, ``/api/start/``, is POSTed by
  both front ends on every sign-in attempt while looking like a
  once-in-a-lifetime registration endpoint — a mis-sizing there blocks
  sign-in for a whole egress and the wiring tests cannot see it. See
  ``test_the_sign_in_bucket_is_sized_for_sign_ins_not_registrations``.
"""
import json
import logging
from types import SimpleNamespace
from unittest import mock

import pytest
import redis
from django.core.cache import cache, caches
from django.core.cache.backends.locmem import LocMemCache
from django.test import override_settings
from django.urls import URLPattern, URLResolver, get_resolver, resolve
from django_redis.exceptions import ConnectionInterrupted
from rest_framework.exceptions import AuthenticationFailed
from rest_framework.settings import api_settings
from rest_framework.throttling import (
    AnonRateThrottle, SimpleRateThrottle, UserRateThrottle,
)
from rest_framework.views import APIView

from dj.apps.zauth.admission import (
    ZcashChallengeAddressAdmissionThrottle,
    ZcashChallengeAdmissionThrottle,
    ZcashLoginAdmissionThrottle,
)
from dj.apps.zauth.views import ZcashChallengeView, ZcashLoginView
from dj.free2z.throttling import (
    ACCOUNT_RECOVERY_THROTTLES, BROADCAST_JOIN_THROTTLES,
    LINK_LANDING_THROTTLES, LOGIN_PATH_THROTTLES, OAUTH_STATE_THROTTLES,
    OAUTH_COMPLETION_THROTTLES,
    NATIVE_CHECKOUT_RETURN_THROTTLES, OIDC_AUTHORIZE_THROTTLES,
    OIDC_TOKEN_THROTTLES, PASSWORD_LOGIN_THROTTLES,
    POLLING_THROTTLES,
    THIRD_PARTY_OAUTH_THROTTLES,
    THROTTLE_FAIL_OPEN_EVENT,
    ZCASH_CHALLENGE_THROTTLES, ZCASH_LOGIN_THROTTLES,
    AuthenticatedUserRateThrottle,
    NativeCheckoutReturnRateThrottle,
    PublicAnonRateThrottle,
)

#Every anon opt-in list. Anything added to dj/free2z/throttling.py must be
#listed here or the pairing and distinctness guards silently skip it.
ALL_PUBLIC_THROTTLE_LISTS = [
    POLLING_THROTTLES,
    LOGIN_PATH_THROTTLES,
    PASSWORD_LOGIN_THROTTLES,
    ACCOUNT_RECOVERY_THROTTLES,
    LINK_LANDING_THROTTLES,
    NATIVE_CHECKOUT_RETURN_THROTTLES,
    THIRD_PARTY_OAUTH_THROTTLES,
    OAUTH_STATE_THROTTLES,
    OAUTH_COMPLETION_THROTTLES,
    BROADCAST_JOIN_THROTTLES,
    OIDC_AUTHORIZE_THROTTLES,
    OIDC_TOKEN_THROTTLES,
]


@pytest.fixture(autouse=True)
def _clear_throttle_history():
    """Throttle counters live in the process-local cache and would otherwise
    leak between tests (and into the rest of the suite)."""
    cache.clear()
    yield
    cache.clear()


def _view_classes():
    def walk(resolver):
        for pattern in resolver.url_patterns:
            if isinstance(pattern, URLResolver):
                yield from walk(pattern)
            elif isinstance(pattern, URLPattern):
                yield pattern.callback

    seen = {}
    for callback in walk(get_resolver()):
        cls = getattr(callback, "cls", None) or getattr(
            callback, "view_class", None
        )
        if cls is not None and issubclass(cls, APIView):
            # Keyed on the class object, not (module, qualname): DRF's
            # @api_view builds a throwaway subclass whose __qualname__ is
            # always "WrappedAPIView" and only copies __name__ from the
            # wrapped function. Deduping on qualname collapsed every
            # function-based view in a module into one entry — so, for
            # example, dyte's live_meeting_status, webhook and
            # webhook_recording_status_update were audited as a single view.
            seen[id(cls)] = cls
    return list(seen.values())


def _view_label(cls):
    """``module.name`` — ``__name__`` because @api_view views share a qualname."""
    return f"{cls.__module__}.{cls.__name__}"


def _anon_reachable_view_classes():
    """Views an unauthenticated caller can reach.

    DRF ANDs ``permission_classes``, so one ``IsAuthenticated`` in the list
    closes the view to anonymous callers regardless of what sits beside it.
    Everything else is treated as reachable — deliberately over-inclusive,
    since a custom class that happens to deny anonymous access only costs one
    extra inventory line, whereas missing a genuinely public view is the thing
    this audit exists to prevent.
    """
    out = []
    for cls in _view_classes():
        perms = [p.__name__ for p in getattr(cls, "permission_classes", [])]
        if perms and "IsAuthenticated" not in perms:
            out.append(cls)
    return out


def _anon_scopes(cls):
    """Scopes that actually bucket an *anonymous* caller by IP on this view.

    Asked behaviourally rather than by class name, because "is this an anon
    throttle" is not answerable from the type: DRF's ``UserRateThrottle``
    falls back to the client IP when the request is anonymous, which is what
    makes ``BruteRateThrottle`` a credential-stuffing control at all. A
    name-based check would report OTP login as unthrottled.
    """
    from django.contrib.auth.models import AnonymousUser
    from rest_framework.request import Request
    from rest_framework.test import APIRequestFactory

    request = Request(APIRequestFactory().get("/"))
    request.user = AnonymousUser()

    scopes = set()
    for throttle_cls in getattr(cls, "throttle_classes", []):
        if issubclass(throttle_cls, ZcashChallengeAdmissionThrottle):
            scopes.add("atomic-zcash-challenge")
            continue
        if issubclass(throttle_cls, ZcashLoginAdmissionThrottle):
            scopes.add("atomic-zcash-login")
            continue
        if not issubclass(throttle_cls, SimpleRateThrottle):
            continue
        if throttle_cls().get_cache_key(request, view=None) is not None:
            scopes.add(throttle_cls.scope)
    return frozenset(scopes)


def test_user_throttle_is_global():
    assert (
        AuthenticatedUserRateThrottle in api_settings.DEFAULT_THROTTLE_CLASSES
    )


def test_drf_uses_the_one_normalized_proxy_hop():
    """Keep DRF aligned with nginx's authoritative API XFF contract."""
    assert api_settings.NUM_PROXIES == 1


def test_no_global_throttle_keys_anonymous_requests_on_ip():
    """The site-down guard.

    Every anonymous page view of free2z.cash reaches Django from the SvelteKit
    SSR pod's IP, so *any* globally-applied throttle that keys anonymous
    requests by IP puts the whole signed-out site in one bucket. That rules out
    AnonRateThrottle and, less obviously, DRF's stock UserRateThrottle — which
    silently falls back to ``get_ident()`` when the request is anonymous.

    Asserted behaviourally, against a synthesised anonymous request, so it
    holds for any throttle class someone adds later rather than just the two we
    know about today.
    """
    from django.contrib.auth.models import AnonymousUser
    from rest_framework.request import Request
    from rest_framework.test import APIRequestFactory

    request = Request(APIRequestFactory().get("/api/zpage/"))
    request.user = AnonymousUser()

    offenders = []
    for throttle_cls in api_settings.DEFAULT_THROTTLE_CLASSES:
        if not issubclass(throttle_cls, SimpleRateThrottle):
            continue
        if throttle_cls().get_cache_key(request, view=None) is not None:
            offenders.append(
                f"{throttle_cls.__module__}.{throttle_cls.__qualname__}"
            )
    assert not offenders, (
        "These global throttles bucket anonymous requests by IP, which means "
        "all SSR-originated traffic shares one key and the site 429s under "
        "load. Make them opt-in per view via "
        "one of the scoped opt-in lists in dj/free2z/throttling.py "
        "instead:\n  "
        + "\n  ".join(offenders)
    )


@pytest.mark.parametrize(
    "throttles",
    ALL_PUBLIC_THROTTLE_LISTS,
    ids=[
        "polling", "login_path", "password_login", "account_recovery",
        "link_landing",
        "native_checkout_return", "third_party_oauth", "oauth_state",
        "oauth_completion", "broadcast_join", "oidc_authorize", "oidc_token",
    ],
)
def test_public_throttles_pair_anon_with_authenticated(throttles):
    """Every opt-in list must carry the user throttle as well as the anon one.

    ``throttle_classes`` on a view *replaces* DEFAULT_THROTTLE_CLASSES, so a
    list with only the anon class silently exempts every logged-in caller from
    the global ceiling — the opposite of the intent.
    """
    assert any(issubclass(t, PublicAnonRateThrottle) for t in throttles)
    if throttles is NATIVE_CHECKOUT_RETURN_THROTTLES:
        assert throttles == [NativeCheckoutReturnRateThrottle]
    else:
        assert AuthenticatedUserRateThrottle in throttles


def test_zcash_challenge_uses_atomic_admission_and_keeps_user_ceiling():
    assert ZCASH_CHALLENGE_THROTTLES == [
        ZcashChallengeAdmissionThrottle,
        AuthenticatedUserRateThrottle,
        ZcashChallengeAddressAdmissionThrottle,
    ]


def test_zcash_login_uses_independent_admission_and_keeps_user_ceiling():
    assert ZCASH_LOGIN_THROTTLES == [
        ZcashLoginAdmissionThrottle,
        AuthenticatedUserRateThrottle,
    ]


def test_zcash_views_pin_client_admission_before_lazy_user_authentication():
    assert ZcashChallengeView.throttle_classes[:2] == [
        ZcashChallengeAdmissionThrottle,
        AuthenticatedUserRateThrottle,
    ]
    assert ZcashLoginView.throttle_classes[:2] == [
        ZcashLoginAdmissionThrottle,
        AuthenticatedUserRateThrottle,
    ]
    challenge_names = ZcashChallengeAdmissionThrottle.allow_request.__code__.co_names
    login_names = ZcashLoginAdmissionThrottle.allow_request.__code__.co_names
    address_names = (
        ZcashChallengeAddressAdmissionThrottle.allow_request.__code__.co_names
    )
    assert "user" not in challenge_names
    assert "user" not in login_names
    assert "user" not in address_names


def test_anon_scopes_are_distinct():
    """The whole point of: one bucket per traffic shape, not one bucket.

    If two of these ever collapse onto the same scope name they silently
    become one shared per-IP budget again, and the starvation test below can
    still pass while the isolation is gone in production.
    """
    #The ONE sanctioned exception, and the reason it is not a loophole.
    #``anon-login`` is deliberately reached by two lists: LOGIN_PATH (for
    #/api/start/) and PASSWORD_LOGIN (for /api/auth/login/). They are two
    #legs of ONE sign-in attempt, so they must share one budget — a second
    #scope would leave the real per-IP ceiling at min(the two rates), which
    #nobody tuned. The lists differ only in whether an authenticated
    #caller is exempt, not in which bucket they charge.
    #
    #Adding to this set is a decision to re-create  for those scopes;
    #adding a scope to two lists WITHOUT adding it here still fails.
    SHARED_ON_PURPOSE = {"anon-login"}

    scopes = [
        t.scope
        for throttles in ALL_PUBLIC_THROTTLE_LISTS
        for t in throttles
        if issubclass(t, PublicAnonRateThrottle)
    ]
    duplicated = {s for s in scopes if scopes.count(s) > 1}
    assert duplicated <= SHARED_ON_PURPOSE, (
        "anon scopes must not be shared between the opt-in lists unless the "
        "sharing is a recorded decision: "
        f"{sorted(duplicated - SHARED_ON_PURPOSE)} in {scopes}"
    )
    assert SHARED_ON_PURPOSE <= set(scopes), (
        "a scope listed as shared-on-purpose is no longer in any list; drop "
        "it from SHARED_ON_PURPOSE so the guard stays tight"
    )
    assert None not in scopes, (
        "a concrete anon throttle inherited scope=None from "
        "PublicAnonRateThrottle; that is ImproperlyConfigured (a 500) on the "
        "first request to its view"
    )


def test_no_view_uses_the_shared_anon_scope():
    """Nothing may sit on DRF's stock ``anon`` scope.

    A rate for it stays configured as a backstop (so a stray stock
    ``AnonRateThrottle`` degrades to a limit instead of a 500), but a *view*
    landing there is  coming back: it would share one per-IP budget with
    anything else that drifted onto the same default.
    """
    offenders = sorted(
        f"{cls.__module__}.{cls.__name__} -> {t.__name__}"
        for cls in _view_classes()
        for t in getattr(cls, "throttle_classes", [])
        if getattr(t, "scope", None) == "anon"
    )
    assert not offenders, (
        "These views use the generic 'anon' scope. Pick a scoped list from "
        "dj/free2z/throttling.py (POLLING_/LOGIN_PATH_/ACCOUNT_RECOVERY_/"
        "LINK_LANDING_/THIRD_PARTY_OAUTH_THROTTLES) so the budget is not "
        "shared across traffic shapes:\n  "
        + "\n  ".join(offenders)
    )


@pytest.mark.django_db
def test_api_survives_the_throttle_cache_being_down(api_client, creator_factory):
    """A cache outage must degrade rate limiting, not 500 the whole API.

    The global throttle puts a cache round-trip on every request, and prod
    points that at a single Redis. ``IGNORE_EXCEPTIONS: True`` on the prod
    cache is the primary mitigation, but this asserts the invariant at the
    throttle itself so it survives a backend swap or a dropped OPTIONS key.

    The exception *type* is load-bearing since: fail-open is now scoped
    to ``CACHE_FAILURE_EXCEPTIONS``, so this raises what django_redis really
    re-raises when ``IGNORE_EXCEPTIONS`` is not set — the raw redis-py error
    from ``omit_exception``'s ``raise e.__cause__``.
    """
    creator = creator_factory()
    api_client.force_authenticate(user=creator)

    boom = redis.exceptions.ConnectionError(
        "Error 111 connecting to redis:6379. Connection refused."
    )

    with mock.patch.object(
        SimpleRateThrottle, "cache", new=mock.Mock()
    ) as fake_cache:
        fake_cache.get.side_effect = boom
        fake_cache.set.side_effect = boom
        response = api_client.get("/api/zpage/")

    assert response.status_code == 200, (
        "a throttle whose cache is unreachable must fail open, not 500: "
        f"{response.status_code} {response.content[:200]!r}"
    )


@pytest.mark.django_db
def test_anonymous_requests_survive_the_throttle_cache_being_down(api_client):
    """Same invariant on the anon-throttled path.

    Uses /api/emails/confirm specifically because it is one of the endpoints
    that really does carry PublicAnonRateThrottle — an endpoint whose only
    throttle is AuthenticatedUserRateThrottle would never touch the cache for
    an anonymous caller and the test would pass vacuously.
    """
    assert any(
        issubclass(t, AnonRateThrottle)
        for t in resolve("/api/emails/confirm").func.cls.throttle_classes
    ), "test target no longer carries an anon throttle; pick another endpoint"

    # django_redis's own wrapper, the other shape a cache outage arrives in.
    boom = ConnectionInterrupted(connection=None)

    with mock.patch.object(
        SimpleRateThrottle, "cache", new=mock.Mock()
    ) as fake_cache:
        fake_cache.get.side_effect = boom
        fake_cache.set.side_effect = boom
        response = api_client.get("/api/emails/confirm")

    # 400 "No token provided." is the normal answer to a bare GET; the point is
    # that it reached the handler at all instead of 500ing in the throttle.
    assert response.status_code == 400, (
        f"anonymous throttled read broke when the cache was down: "
        f"{response.status_code} {response.content[:200]!r}"
    )


@pytest.mark.django_db
@pytest.mark.parametrize(
    "exc_class",
    [
        RuntimeError,
        # The near miss: django_redis lists the builtin TimeoutError among the
        # errors it wraps, but redis-py normalises socket timeouts into
        # redis.exceptions.TimeoutError long before that, while an
        # authenticator's HTTP client timing out raises the builtin. Nothing at
        # this frame can tell the two apart, so the builtin is deliberately not
        # in CACHE_FAILURE_EXCEPTIONS. This pins that decision.
        TimeoutError,
    ],
    ids=["runtime_error", "builtin_timeout"],
)
def test_a_non_cache_error_does_not_silently_disable_the_throttle(
    api_client, creator_factory, exc_class
):
    """: fail-open is a bargain struck for *the cache*, nothing else.

    The mixin used to catch every ``Exception`` under ``allow_request``. ``allow_request`` calls ``get_cache_key``, and ``get_cache_key`` resolves
    ``request.user``, that guard covered the whole authentication stack: any
    auth-backend fault turned into a silently disabled rate limiter, logged as
    ``cache unavailable?``. An unrecognised error must now 500 loudly.

    Positive control: before the fix this returned **200** with rate limiting
    silently off, so the ``pytest.raises`` below fails against old behaviour.
    """
    creator = creator_factory()
    api_client.force_authenticate(user=creator)

    with mock.patch.object(
        SimpleRateThrottle, "cache", new=mock.Mock()
    ) as fake_cache:
        fake_cache.get.side_effect = exc_class("not a cache problem")
        with pytest.raises(exc_class, match="not a cache problem"):
            api_client.get("/api/zpage/")


@pytest.mark.django_db
def test_an_auth_fault_inside_the_throttle_does_not_fail_open(
    api_client, creator_factory
):
    """The  path exactly: the fault is raised from ``get_cache_key``.

    ``AuthenticatedUserRateThrottle.get_cache_key`` touches ``request.user``,
    which is what runs authentication on the deferred-auth endpoints. A fault
    there is an auth outage, not a Redis outage, and must not remove rate
    limiting. Positive control: this was a 200 before the fix.
    """
    creator = creator_factory()
    api_client.force_authenticate(user=creator)

    with mock.patch.object(
        AuthenticatedUserRateThrottle,
        "get_cache_key",
        side_effect=RuntimeError("auth backend is down"),
    ):
        with pytest.raises(RuntimeError, match="auth backend is down"):
            api_client.get("/api/zpage/")


@pytest.mark.django_db
def test_an_auth_failure_inside_the_throttle_still_answers_unauthenticated(
    api_client,
):
    """The  invariant, kept by the narrowing rather than by an override.

    ``AuthenticatedUserRateThrottle`` carried its own ``should_fail_open`` that
    excluded ``APIException`` so a deferred ``AuthenticationFailed`` kept its
    real response. Scoping the mixin to cache errors subsumes that, so the
    override is gone — this is what stops it regressing. The failure mode being
    excluded is a **200**: bad credentials silently allowed through with the
    throttle open.
    """
    with mock.patch.object(
        AuthenticatedUserRateThrottle,
        "get_cache_key",
        side_effect=AuthenticationFailed("bad token"),
    ):
        response = api_client.get("/api/zpage/")

    assert response.status_code in (401, 403), (
        "an authentication failure raised inside the throttle must keep its "
        f"auth response, not fail open: {response.status_code}"
    )


@pytest.mark.django_db
def test_the_fail_open_log_line_names_the_error_it_actually_saw(
    api_client, creator_factory, caplog
):
    """A fail-open must be countable and must not assert an unverified cause.

    The old line was a fixed ``cache unavailable?`` string with no machine
    readable field, so a throttle open for a week looked exactly like silence
    and the one clue pointed at Redis regardless of what happened. This is the
    contract with ``monitoring/log-metrics/throttle-fail-open.json``.
    """
    creator = creator_factory()
    api_client.force_authenticate(user=creator)

    boom = redis.exceptions.TimeoutError("Timeout reading from socket")

    with caplog.at_level(logging.WARNING, logger="dj.free2z.throttling"):
        with mock.patch.object(
            SimpleRateThrottle, "cache", new=mock.Mock()
        ) as fake_cache:
            fake_cache.get.side_effect = boom
            fake_cache.set.side_effect = boom
            response = api_client.get("/api/zpage/")

    assert response.status_code == 200

    events = []
    for record in caplog.records:
        try:
            events.append(json.loads(record.getMessage()))
        except ValueError:
            continue
    fail_opens = [
        e for e in events if e.get("event") == THROTTLE_FAIL_OPEN_EVENT
    ]
    assert fail_opens, (
        "a fail-open emitted no parseable jsonPayload line; the log-based "
        f"metric would count nothing. Records: {caplog.messages}"
    )
    entry = fail_opens[0]
    assert entry["error_type"] == "TimeoutError"
    assert entry["error_module"].startswith("redis"), entry["error_module"]
    assert entry["throttle"] == "AuthenticatedUserRateThrottle"
    assert entry["path"] == "/api/zpage/"
    assert "Timeout reading from socket" in entry["error_message"]


@pytest.mark.django_db
def test_a_corrupt_cached_counter_fails_open_rather_than_500ing_a_key(
    api_client, creator_factory
):
    """Narrowing must not turn a cache fault into a permanent 500 for one key.

    A cache backend guards the *transport*; deserialization happens after that
    guard, so a value written by a different serializer — a rollback, a manual
    recovery, a protocol bump — surfaces as whatever ``pickle.loads`` chose to
    raise. Here it is a plain ``ValueError``, which is deliberately **not** in
    ``CACHE_FAILURE_EXCEPTIONS`` (an authenticator raises ``ValueError`` too).
    ``_raised_inside_the_cache`` is what keeps it fail-open: the exception came
    out of the cache backend's own frames.

    Without that, every caller sharing this throttle key would get a 500 until
    the key expired — for a long-lived key, indefinitely. A fail-*closed*
    regression hiding inside a security fix. Raised by the Codex adversarial
    review on.

    No mock: the counter is written by a real request and then really corrupted
    in the backend's store, because the point at issue is precisely what the
    backend does with a bad value.
    """
    creator = creator_factory()
    api_client.force_authenticate(user=creator)

    assert api_client.get("/api/zpage/").status_code == 200
    backend = caches["default"]
    assert isinstance(backend, LocMemCache), (
        f"this test corrupts LocMemCache's store; default cache is {backend}"
    )
    store = backend._cache
    assert store, "no throttle counter was cached; the test would be vacuous"
    # Pickle protocol 7 does not exist -> ValueError, not UnpicklingError.
    for key in list(store):
        store[key] = b"\x80\x07."

    response = api_client.get("/api/zpage/")

    assert response.status_code == 200, (
        "a corrupt throttle counter must degrade rate limiting for that key, "
        f"not 500 it: {response.status_code} {response.content[:200]!r}"
    )


def _fail_open_events(caplog):
    """The jsonPayload entries the log-based metric would actually count."""
    events = []
    for record in caplog.records:
        try:
            payload = json.loads(record.getMessage())
        except ValueError:
            continue
        if payload.get("event") == THROTTLE_FAIL_OPEN_EVENT:
            events.append(payload)
    return events


def _redis_cache(*, ignore_exceptions):
    """prod's cache backend, pointed at a port nothing can be listening on.

    Port 1 needs root to bind and is not a service anything here runs, so the
    connection is refused immediately rather than hanging. The point is to
    exercise the **real** django_redis wrapper: a Mock raising a chosen type
    proves only that the tuple contains the type the test picked.
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
def test_real_django_redis_raises_a_type_the_fail_open_tuple_covers(
    api_client, creator_factory, caplog
):
    """Validate ``CACHE_FAILURE_EXCEPTIONS`` against the real backend.

    With ``IGNORE_EXCEPTIONS`` unset or False — the misconfiguration the mixin
    exists to survive — django_redis's ``omit_exception`` does
    ``raise e.__cause__``, so what reaches the mixin is the *raw* redis-py
    error and not django_redis's own wrapper. This asserts the tuple covers
    whatever that really is, with a live connection attempt, instead of
    trusting a mock to raise a type this file chose.
    """
    creator = creator_factory()
    api_client.force_authenticate(user=creator)

    with caplog.at_level(logging.WARNING, logger="dj.free2z.throttling"):
        with override_settings(CACHES=_redis_cache(ignore_exceptions=False)):
            response = api_client.get("/api/zpage/")

    assert response.status_code == 200, (
        "an unreachable Redis must degrade rate limiting, not 500: "
        f"{response.status_code} {response.content[:200]!r}"
    )
    events = _fail_open_events(caplog)
    assert events, (
        "the real backend raised something CACHE_FAILURE_EXCEPTIONS does not "
        f"cover, or nothing at all. Records: {caplog.messages}"
    )
    assert events[0]["error_module"].startswith("redis"), events[0]


class _CaptureHandler(logging.Handler):
    """Capture *formatted* output, which ``caplog`` does not give us.

    Two reasons formatting matters here: the record we care about is routed to
    a logger with ``propagate: False`` (so caplog's root handler never sees
    it), and the assertion is precisely that the configured formatter produces
    one line of JSON.
    """

    def __init__(self):
        super().__init__()
        self.lines = []

    def emit(self, record):
        self.lines.append(self.format(record))




@pytest.mark.django_db
def test_the_fail_open_log_line_cannot_forge_a_second_record(
    api_client, creator_factory, caplog
):
    """The path is caller-controlled; the log line must stay one JSON line.

    A metric that counts log entries is only as trustworthy as the caller's
    inability to write extra ones.
    """
    creator = creator_factory()
    api_client.force_authenticate(user=creator)

    boom = redis.exceptions.ConnectionError("down")

    with caplog.at_level(logging.WARNING, logger="dj.free2z.throttling"):
        with mock.patch.object(
            SimpleRateThrottle, "cache", new=mock.Mock()
        ) as fake_cache:
            fake_cache.get.side_effect = boom
            fake_cache.set.side_effect = boom
            api_client.get("/api/emails/confirm?token=%0A%7B%22event%22%3A1%7D")

    lines = [
        m for m in caplog.messages if THROTTLE_FAIL_OPEN_EVENT in m
    ]
    assert lines, caplog.messages
    for line in lines:
        assert "\n" not in line, line
        json.loads(line)


def test_anon_throttled_views_still_throttle_authenticated_callers():
    offenders = []
    for cls in _view_classes():
        throttles = getattr(cls, "throttle_classes", [])
        has_anon = any(
            issubclass(t, AnonRateThrottle) for t in throttles
        )
        has_authenticated_ceiling = any(
            issubclass(t, UserRateThrottle)
            or t is NativeCheckoutReturnRateThrottle
            for t in throttles
        )
        if has_anon and not has_authenticated_ceiling:
            offenders.append(f"{cls.__module__}.{cls.__qualname__}")
    assert not offenders, (
        "These views set throttle_classes with AnonRateThrottle but no "
        "authenticated ceiling, which drops the global user throttle for them:\n  "
        + "\n  ".join(sorted(offenders))
    )


def test_every_throttle_scope_in_use_has_a_rate():
    rates = api_settings.DEFAULT_THROTTLE_RATES
    in_use = set(api_settings.DEFAULT_THROTTLE_CLASSES)
    for cls in _view_classes():
        in_use.update(getattr(cls, "throttle_classes", []))

    missing = sorted(
        f"{t.__module__}.{t.__qualname__} (scope {t.scope!r})"
        for t in in_use
        if issubclass(t, SimpleRateThrottle)
        and getattr(t, "scope", None)
        and t.scope not in rates
    )
    assert not missing, (
        "A throttle whose scope has no rate raises ImproperlyConfigured on "
        "every request to its view (a 500, at runtime):\n  "
        + "\n  ".join(missing)
    )


@pytest.mark.django_db
def test_normal_spa_traffic_is_not_throttled(api_client, creator_factory):
    """A logged-in client making a normal burst of reads must sail through.

    Twelve back-to-back requests is far more than any screen fires on load and
    far below the configured ceiling; if this ever fails, the rate has been
    tightened into the range real users live in.
    """
    api_client.force_authenticate(user=creator_factory())
    for _ in range(12):
        assert api_client.get("/api/zpage/").status_code == 200


@pytest.mark.django_db
def test_anonymous_otp_login_is_actually_rate_limited(api_client):
    """The brute-force brake must really fire for *anonymous* callers.

    ``BruteRateThrottle`` subclasses ``UserRateThrottle``, whose name suggests
    it only covers logged-in users. It does not: DRF falls back to the client
    IP when the request is anonymous, which is the only thing that makes it a
    credential-stuffing control on a login endpoint. Asserted as a real 429
    rather than as class wiring, because the whole value of the throttle
    depends on that fallback — which the global default deliberately drops.
    """
    body = {"username": "nobody", "password": "wrong", "token": "000000"}
    statuses = [
        api_client.post("/api/otp/login/", body, format="json").status_code
        for _ in range(4)
    ]
    assert 429 in statuses, (
        f"anonymous /api/otp/login/ was never throttled: {statuses}"
    )


#Every endpoint the SvelteKit server fetches, enumerated by grepping every
#``*.server.ts`` in ``zuu ts/svelte/free2z``. All of these arrive from the
#SSR pod's single IP, so attaching any IP-keyed throttle to one of them puts
#the entire anonymous site in one bucket — the outage this guard exists to
#prevent.
#
#It is a SHORT list, and that matters: "SSR fetches it" is a load-bearing
#reason for leaving an endpoint unthrottled, so it must be checked rather
#than assumed. Most public reads are fetched by the *browser* through the
#orval client and would be perfectly throttleable. ``/api/pricing/`` is
#fetched server-side by the billing loader (``$lib/pricing``); the other
#four are fetched anonymously on ordinary page views.
SSR_ANONYMOUS_READS = [
    "/api/zpage/",
    "/api/creator/",
    "/api/comments/",
    "/api/tagging/autocomplete",
    # The `/tag/<slug>` hub resolver. Fetched server-side on every
    # tag-hub page view, which is a route whose whole purpose is to be entered
    # cold from a search engine -- an IP-keyed throttle here would 429 the
    # crawler, not an abuser. Its work is bounded by construction: the slug
    # shape is validated before any query, the candidate scan is capped at
    # TAG_SLUG_MAX_CANDIDATES, and it returns no rows.
    "/api/tagging/hub/zcash",
    # Historic root zPage links use this type resolver before detail. It is
    # intentionally absent from SSR_ANONYMOUS_READS_CHEAP below: a miss can
    # traverse the legacy case-insensitive identifier fallback, so the reason
    # it has no backend IP bucket is shared SSR identity, not cheapness. The
    # Svelte caller applies its ingress-keyed token bucket after a creator 404
    # and before this additional resolver; keeping real profiles out of that
    # bucket avoids hover/shared-NAT denial. zpage-canonical-redirect.test.mjs
    # pins both halves of that behavioural limit.
    "/api/get-type/throttle-root-fixture",
    "/api/pricing/",
]

#Every endpoint above is cheap to hammer. ``get_pricing()`` only reads the
#stored snapshot (or builds a display-only bootstrap estimate); exchange
#polling belongs to the refresh CronJob and never runs in this request path.
SSR_ANONYMOUS_READS_CHEAP = [
    path for path in SSR_ANONYMOUS_READS if not path.startswith("/api/get-type/")
]


@pytest.mark.django_db
@pytest.mark.parametrize("path", SSR_ANONYMOUS_READS)
def test_ssr_reads_carry_no_anon_throttle(path):
    """Structural half: no IP-keyed throttle is attached to an SSR read."""
    match = resolve(path)
    cls = getattr(match.func, "cls", None) or getattr(
        match.func, "view_class", None
    )
    offenders = sorted(_anon_scopes(cls))
    assert not offenders, (
        f"{path} is fetched by the SSR pod for every signed-out visitor, from "
        f"one IP. An IP-keyed throttle here ({offenders}) throttles the whole "
        f"anonymous site. Put the limit on a browser-reached endpoint instead."
    )


def test_get_type_ssr_read_keeps_only_the_authenticated_user_ceiling():
    """Pin the class: stock UserRateThrottle would bucket anonymous SSR by IP."""
    cls = resolve("/api/get-type/throttle-root-fixture").func.cls
    assert cls.throttle_classes == [AuthenticatedUserRateThrottle]


#The  audit: EVERY anonymous-reachable view in the URLconf, mapped to the
#per-IP scope it sits in. ``frozenset()`` means "deliberately no IP-keyed
#throttle", which is a decision, not an omission — most of those entries are
#fetched by the SvelteKit SSR pod, where an IP-keyed limit puts the entire
#signed-out site in one bucket (see the SSR tests at the bottom of this file).
#
#This exists because "left on the default" is how the bug spreads: a new
#public view that quietly joins whichever bucket happens to be handy
#re-creates the starvation this PR removes. Adding an anonymous-reachable
#view now forces an edit here, which forces someone to name the traffic shape.
ANON_SCOPE_INVENTORY = {
    # -- anon-poll: machine-paced, browser fires them on a timer -----------
    "dj.apps.dyte.views.live_meeting_status": {"anon-poll"},
    "dj.apps.dyte.views.PublicMeetingViewSet": {"anon-poll"},
    "dj.apps.dyte.views.DyteMeeting": {"anon-poll"},
    # The signed AI catalogue: the f2z-ai gateway polls it every 30s
    # from its own egress, a machine-paced read. Each request builds and signs
    # (two queries + one Ed25519 signature), so it gets a bucket rather than
    # none; 1200/minute is 600x the gateway's own rate per replica.
    "dj.apps.pricing.views.AICatalogView": {"anon-poll"},
    # Browser economy capability refreshes read current policy/config rows.
    "dj.apps.economy.views.CapabilitiesView": {"anon-poll"},

    # -- anon-login: the sign-in path ------------------------------------
    # SignUpView is here, not in a signup bucket, because both front ends
    # POST /api/start/ on EVERY authentication attempt and only fall through
    # to /api/auth/login/ if it says the user exists. Its real traffic is all
    # sign-ins plus retries, so it must not share a scope with anything
    # quieter — it would set the floor. ( adds /api/auth/login/ here.)
    "dj.apps.g12f.views.creator.SignUpView": {"anon-login"},

    # -- anon-recovery: forgot-password request + consume -----------------
    "dj.apps.emails.views.RequestResetPasswordView": {"anon-recovery"},
    "dj.apps.emails.views.ResetPasswordAPIView": {"anon-recovery"},

    # -- anon-link: one-shot landings from an email we sent ---------------
    "dj.apps.emails.views.ConfirmEmailView": {"anon-link"},
    "dj.apps.emails.views.OptOutEmailView": {"anon-link"},

    # -- checkout return: no anonymous IP bucket ----------------------------
    # Malformed input is rejected locally before Redis. Valid signed links use
    # the custom anon-checkout-return admission keyed to the signed owner, not
    # caller-controlled XFF; focused ztripe tests pin that separate contract.
    "dj.apps.ztripe.views.native_checkout_cancel": set(),
    "dj.apps.ztripe.views.native_checkout_success": set(),

    # -- anon-oauth: anonymous endpoints that spend a third party's quota --
    # Isolated because request-token is freely automatable, so its bucket can
    # be drained on demand and must not be shared with anything that matters.
    "dj.apps.twitter.views.RequestTokenView": {"anon-oauth"},
    "dj.apps.twitter.views.TwitterCallback1View": {"anon-oauth"},

    # -- anon-oauth-state: freely automatable Redis key allocation --------
    # Kept separate from callbacks so exhausting starts cannot strand an
    # authorization already in flight.
    "dj.apps.social.views.SocialStartView": {"anon-oauth-state"},

    # -- anon-oauth-complete: the two legs that finish a social sign-in ----
    #. The mobile relay (provider redirect, reached straight from the
    # GCLB with no nginx, hence its GFE-aware identity) and the knox-issuing
    # POST. Separate from the start bucket in both directions, and from
    # 'anon-login', whose floor a provider-paced endpoint must not raise.
    "dj.apps.social.views.ZuuliMobileOAuthRelayView": {"anon-oauth-complete"},
    "dj.apps.social.views.SocialLoginView": {"anon-oauth-complete"},

    # -- Zcash authentication: endpoint-local authoritative GCLB identity --
    # It deliberately is not SimpleRateThrottle: that implementation performs
    # a non-atomic get/set. Redis concurrency, bounded hashed keys, forged XFF
    # prefix rejection, no global bucket, and independent scopes are in zauth.
    "dj.apps.zauth.views.ZcashChallengeView": {"atomic-zcash-challenge"},
    "dj.apps.zauth.views.ZcashLoginView": {"atomic-zcash-login"},

    # -- brute: its own per-second pacer, predates the split --------------
    # UserRateThrottle subclass, so it IS IP-keyed for anonymous callers.
    "dj.apps.otp.views.LoginWithOTPView": {"brute"},

    # -- No IP-keyed throttle, because the SSR pod fetches them ------------
    # Every signed-out page view of free2z.cash reaches these from one pod IP,
    # so an anon throttle here 429s the whole anonymous site, not an abuser.
    # This list is exactly SSR_ANONYMOUS_READS above, verified by grepping
    # every *.server.ts in zuu ts/svelte/free2z — do not add to it by
    # assumption.
    "dj.apps.g12f.views.zpage.zPageView": set(),
    "dj.apps.g12f.views.creator.CreatorView": set(),
    "dj.apps.tagging.views.autocomplete": set(),
    "dj.apps.tagging.views.tag_hub": set(),
    "dj.apps.comments.views.CommentViewSet": set(),
    "dj.apps.comments.views.CommentListCreateAPIView": set(),
    "dj.apps.comments.views.ParentCommentListCreateAPIView": set(),
    "dj.apps.pricing.views.PricingView": set(),
    # The /api/sdk/v1/ unknown-path 404: no DB, no auth, no work --
    # it only turns Django's HTML 404 into the SDK error envelope.
    "dj.free2z.sdk_api.SdkNotFoundView": set(),
    "dj.apps.g12f.views.creator.GetTypeAPI": set(),

    # -- No IP-keyed throttle: public reads the BROWSER fetches ------------
    # NOT SSR-fetched — an earlier revision of this inventory labelled them
    # that way and it was wrong; nothing under routes/**/+page.server.ts calls
    # any of them, they go out from the browser through the orval client.
    # The real reason there is no bucket here is that these are low-value
    # public reads: cheap, cacheable, nothing to abuse, not worth the config
    # surface of a scope. Unlike the group above, any of them COULD be
    # throttled without risking the  site-wide outage, so this is the
    # group to revisit if one ever starts costing something.
    "dj.apps.g12f.views.series.ZPageSeriesViewSet": set(),
    "dj.apps.storytime.views.StoryDetail": set(),
    "dj.apps.openai.views.PublicConversationViewSet": set(),
    "dj.apps.openai.views.PublicPromptResponseViewSet": set(),
    "dj.apps.openai.views.AIModelViewSet": set(),
    "dj.apps.openai.views.AIPersonalityViewSet": set(),
    "dj.apps.pricing.views.PricingQuoteView": set(),
    "dj.apps.g12f.views.language_catalog.LanguageCatalogView": set(),
    "dj.apps.zuuli.views.ZuuliCapabilitiesView": set(),
    # Exact canonical legal resources are fixed in-memory, with no DB/provider
    # work. Capability polling must not consume access to consent documents.
    "dj.apps.economy.views.AgreementView": set(),
    # The handle authority's public key: an in-memory read, no database, no
    # provider call. A failing key load is remembered for a minute, so an
    # anonymous caller cannot drive Secret Manager traffic either.
    "dj.apps.handles.views.AuthorityInfoView": set(),

    # -- No IP-keyed throttle, because crawlers must not be rate-limited ---
    "dj.apps.g12f.views.sitemap.SitemapIndexView": set(),
    "dj.apps.g12f.views.sitemap.SitemapChunkView": set(),

    # -- No IP-keyed throttle: authenticated by a provider signature -------
    # Dyte's own servers post these, from Dyte's IPs, and a 429 is a 4xx the
    # provider does not retry — throttling them loses recordings. Their auth
    # is the RSA signature check inside the handler.
    "dj.apps.dyte.views.webhook": set(),
    "dj.apps.dyte.views.webhook_recording_status_update": set(),

    # Password login.  attached the throttle: the SAME 'anon-login' scope
    # as SignUpView, not a second one. Both UIs POST /api/start/ immediately
    # before /api/auth/login/ on every attempt, so 'anon-login' is already the
    # production sign-in bucket; a separate scope here would leave the
    # effective per-IP ceiling at min(the two rates) — a number nobody tuned.
    # The rate was raised 300 -> 600 in the same change to cover 2 requests
    # per attempt instead of 1.
    #
    # Note this is the project's CreatorLoginView. The stock upstream
    # LoginView must never be reachable again: it has no throttle_classes,
    # and the global default returns None for an anonymous caller, so it is
    # entirely unlimited. it is not even mounted.
    "dj.apps.g12f.views.creator.CreatorLoginView": {"anon-login"},
    # "Keep my account" (account deletion's grace period): the second half
    # of a sign-in -- it spends the keep token a sign-in just minted and then
    # signs in -- so it shares the sign-in bucket rather than a scope of its
    # own.
    "dj.apps.g12f.views.account_deletion.AccountDeletionKeepView": {"anon-login"},

    # -- No IP-keyed throttle: remaining auth-adjacent endpoints ----------
    # (The social relay and login POST that used to be recorded here as a
    # gap are on 'anon-oauth-complete' above since.)
    "dj.apps.social.views.SocialProvidersView": set(),  # static provider list
    # Same shape as SocialProvidersView: a constant-size boolean list built
    # from settings, no database, no provider call, no state. It also sets
    # `authentication_classes = []` so a native client holding a stale knox
    # token still gets its launch-time answer instead of a 401 — which means
    # even a token-bearing caller is anonymous here and the default
    # AuthenticatedUserRateThrottle can never key on a user. That is the
    # status quo for the anonymous callers who are this endpoint's entire
    # audience, not a new hole: there is no cheaper anonymous request to make.
    "dj.apps.social.views.ZuuliMobileSocialProvidersView": set(),
    "dj_rest_auth.views.LogoutView": set(),           # revokes own token only

    # dj_rest_auth's PasswordResetView, PasswordResetConfirmView and stock
    # LoginView used to be listed here as "in the URLconf but shadowed".
    # `include('dj_rest_auth.urls')` is spelled out route by route since
    #  and none of the three is mounted any more; if one reappears in
    # the URLconf this inventory flags it as unlisted, which is the point.

    # -- The OIDC provider  -----------------------------------------
    # The consent step is paced by a person in a browser; token, revocation
    # and introspection by machines refreshing 5-minute access tokens. Two
    # scopes, both fail-closed (credential endpoints), both isolated from
    # the sign-in and recovery buckets per.
    "dj.apps.oidc.views.AuthorizeView": {"anon-oidc-authorize"},
    "dj.apps.oidc.views.TokenView": {"anon-oidc-token"},
    "dj.apps.oidc.views.RevokeView": {"anon-oidc-token"},
    "dj.apps.oidc.views.IntrospectView": {"anon-oidc-token"},
    # Discovery and the JWKS are public, cacheable reads fetched by resource
    # servers and SDKs on a timer -- the polling shape.
    "dj.apps.oidc.views.DiscoveryView": {"anon-poll"},
    "dj.apps.oidc.views.RootDiscoveryView": {"anon-poll"},   # same view at /.well-known
    "dj.apps.oidc.views.JwksView": {"anon-poll"},
    # The internal epoch endpoint answers only a shared-secret bearer from
    # the AI gateway (503 while unconfigured, 401 otherwise) and is what a
    # resource server falls back to when the Redis publication is missing
    # -- exactly the moment a per-IP bucket on the gateway's few egress
    # addresses would turn a Redis blip into a gateway outage. Unthrottled
    # on purpose; the secret is the admission control.
    "dj.apps.oidc.views.InternalEpochView": set(),

    # -- No IP-keyed throttle: developer/browsable surface -----------------
    "dj.free2z.routers.PublicAPIRootView": set(),
    "dj.free2z.schema_view.SchemaView": set(),
    "drf_spectacular.views.SpectacularRedocView": set(),
    "drf_spectacular.views.SpectacularSwaggerView": set(),
}


def test_every_anonymous_reachable_view_has_an_explicit_anon_scope():
    """No anonymous-reachable view may be left on "whatever the default is".

    Both directions are pinned. A new public view fails here until someone
    names its traffic shape; a view whose scope silently changes (or whose
    throttle is dropped) fails here too. That is the guard that stops
    from reappearing on an endpoint nobody thought about.
    """
    actual = {
        _view_label(cls): set(_anon_scopes(cls))
        for cls in _anon_reachable_view_classes()
    }
    expected = {k: set(v) for k, v in ANON_SCOPE_INVENTORY.items()}

    unlisted = sorted(set(actual) - set(expected))
    stale = sorted(set(expected) - set(actual))
    changed = sorted(
        f"{k}: inventory says {sorted(expected[k])!r}, view has "
        f"{sorted(actual[k])!r}"
        for k in set(actual) & set(expected)
        if actual[k] != expected[k]
    )

    assert not unlisted, (
        "New anonymous-reachable views with no recorded throttle decision. "
        "Pick a list from dj/free2z/throttling.py by asking what paces the "
        "traffic — a timer (POLLING_THROTTLES), somebody signing in "
        "(LOGIN_PATH_THROTTLES), somebody who forgot their password "
        "(ACCOUNT_RECOVERY_THROTTLES), or an inbound link "
        "(LINK_LANDING_THROTTLES) — or record set() with the reason it must "
        "stay unthrottled, then add it to ANON_SCOPE_INVENTORY:\n  "
        + "\n  ".join(unlisted)
    )
    assert not stale, (
        "ANON_SCOPE_INVENTORY lists views that are no longer anonymously "
        "reachable. Remove them:\n  " + "\n  ".join(stale)
    )
    assert not changed, (
        "A view's anon throttle scope changed. If that was intended, update "
        "ANON_SCOPE_INVENTORY in the same commit so the change is reviewed "
        "rather than inferred:\n  " + "\n  ".join(changed)
    )


# The exact answer each isolation probe below must get from its OWN handler
#. These tests used to assert only ``!= 429``, which stayed green if the
# endpoint moved (404), lost its method (405) or crashed (500) -- i.e. green
# with nothing isolated, because a request that never reaches the view never
# touches a throttle bucket either. A body marker only that view produces is
# what proves the request was served, not merely "not throttled".
SIGNUP_EMPTY = (406, b"ReCAPTCHA not supplied.")
RESET_REQUESTED = (200, b"If that email is registered and confirmed")
CONFIRM_NO_TOKEN = (400, b"This link is incomplete")
RESET_UNKNOWN_TOKEN = (400, b"Invalid token.")


def _assert_served(response, expected, why):
    status_code, marker = expected
    assert response.status_code == status_code and marker in response.content, (
        f"{why}: expected {status_code} carrying {marker.decode()!r}, got "
        f"{response.status_code} {response.content[:200]!r}"
    )


def _rates(**overrides):
    """A ``SimpleRateThrottle.THROTTLE_RATES`` mapping with some scopes moved.

    Patched onto the class rather than via ``override_settings``, because DRF
    binds ``THROTTLE_RATES = api_settings.DEFAULT_THROTTLE_RATES`` at import
    time — the class attribute keeps pointing at the original dict, so
    overriding the setting has no effect on an already-imported throttle.
    """
    return {**SimpleRateThrottle.THROTTLE_RATES, **overrides}


@pytest.mark.django_db
def test_polling_does_not_starve_the_auth_flows(api_client):
    """, reproduced: exhaust the polling budget, then register and reset.

    Before the scope split these shared one ``anon`` bucket keyed only on the
    client IP, so background live-status polling from unrelated visitors
    behind the same CGNAT/office egress could 429 signup and password reset
    for that whole network.

    Rates are shrunk for the test instead of firing 1200 real requests. The
    numbers are not what is under test — the isolation is — and pinning them
    here would make the test fail every time someone retunes a rate, which is
    precisely the sort of brittleness that gets a guard deleted.
    """
    tiny = _rates(**{
        "anon-poll": "3/minute", "anon-login": "5/minute",
        "anon-recovery": "5/minute", "anon-link": "5/minute",
    })

    with mock.patch.object(SimpleRateThrottle, "THROTTLE_RATES", tiny):
        polling = [
            api_client.get("/api/dyte/public/").status_code for _ in range(8)
        ]
        assert 429 in polling, (
            "the polling bucket never filled, so this test proves nothing "
            f"about isolation: {polling}"
        )

        # Same client, same IP, immediately after. All must still work.
        signup = api_client.post("/api/start/", {}, format="json")
        _assert_served(
            signup, SIGNUP_EMPTY,
            "the sign-in path was starved by live-status polling from the "
            "same IP — #743 is back (or /api/start/ no longer answers). Note "
            "this blocks sign-in for EXISTING accounts too, since both UIs "
            "POST /api/start/ first on every attempt",
        )

        reset = api_client.post(
            "/api/emails/reset-password",
            {"email": "nobody-743@example.com"},
            format="json",
        )
        _assert_served(
            reset, RESET_REQUESTED,
            "password reset was starved by live-status polling from the same "
            "IP — #743 is back (or the route no longer answers)",
        )

        # And the link bucket, which the email confirm/opt-out landings share.
        confirm = api_client.get("/api/emails/confirm")
        _assert_served(
            confirm, CONFIRM_NO_TOKEN,
            "email-link landings were starved by polling from the same IP",
        )


@pytest.mark.django_db
def test_oauth_start_cannot_starve_the_email_link_landings(api_client):
    """The finding the codex review of this PR caught, pinned as a test.

    ``/api/twitter/v1/request-token`` is an unauthenticated POST needing no
    token or state, so anyone can fire it at will — which means whatever
    bucket it lives in can be drained on demand. It briefly shared 'anon-link'
    with email confirm and opt-out, where a standing 429 on an unsubscribe
    link is a CAN-SPAM problem. It has its own scope now; this fails if it
    ever moves back.
    """
    tiny = _rates(**{"anon-oauth": "3/minute", "anon-link": "5/minute"})

    twitter = mock.patch("dj.apps.twitter.views.TwitterOAuthClient")
    with twitter as fake_client, mock.patch.object(
        SimpleRateThrottle, "THROTTLE_RATES", tiny
    ):
        fake_client.return_value.get_request_token.return_value = {
            "oauth_token": "tok", "oauth_token_secret": "sec",
        }
        oauth = [
            api_client.post(
                "/api/twitter/v1/request-token", {}, format="json"
            ).status_code
            for _ in range(8)
        ]
        assert 429 in oauth, (
            f"the oauth bucket never filled; test proves nothing: {oauth}"
        )

        _assert_served(
            api_client.get("/api/emails/confirm"), CONFIRM_NO_TOKEN,
            "an OAuth-start flood took out the email confirm/opt-out landings "
            "from the same IP — an unsubscribe link must not be drainable by "
            "an unrelated, freely automatable endpoint",
        )


@pytest.mark.django_db
def test_sign_in_attempts_cannot_starve_account_recovery(api_client):
    """The review finding of, pinned: /api/start/ is the LOGIN path.

    Both front ends POST ``/api/start/`` first on every authentication
    attempt and only fall through to ``/api/auth/login/`` when it reports the
    user already exists. So its legitimate rate is every sign-in on the site,
    including mistyped-password retries — one to two orders of magnitude
    above "somebody forgot their password".

    It was originally grouped with the two password-reset endpoints in one
    ``anon-auth`` scope, which is this module's own mistake one level down:
    the noisiest endpoint in a scope sets the floor for every other endpoint
    in it. A burst of sign-ins from an office egress must not be able to take
    account recovery down for that network.
    """
    tiny = _rates(**{"anon-login": "3/minute", "anon-recovery": "5/minute"})

    with mock.patch.object(SimpleRateThrottle, "THROTTLE_RATES", tiny):
        signins = [
            api_client.post("/api/start/", {}, format="json").status_code
            for _ in range(8)
        ]
        assert 429 in signins, (
            f"the sign-in bucket never filled; test proves nothing: {signins}"
        )

        reset = api_client.post(
            "/api/emails/reset-password",
            {"email": "nobody-743@example.com"},
            format="json",
        )
        _assert_served(
            reset, RESET_REQUESTED,
            "a burst of sign-in attempts starved password reset from the "
            "same IP. /api/start/ fires on every login, so it will always be "
            "the noisy member of whatever scope it joins",
        )

        # A well-formed but unissued token: the point is reaching the handler
        # at all, not what it decides. (The field is a UUID, so a junk string
        # would 500 in the lookup and mask what this test is asserting.)
        consume = api_client.post(
            "/api/emails/do-reset-password",
            {
                "token": "00000000-0000-4000-8000-000000000000",
                "password": "irrelevant",
            },
            format="json",
        )
        _assert_served(
            consume, RESET_UNKNOWN_TOKEN,
            "a burst of sign-in attempts starved the reset-token consume "
            "endpoint from the same IP",
        )


@pytest.mark.django_db
def test_unrelated_anon_bucket_cannot_starve_zcash_challenges(api_client):
    """Challenge allocation has no shared budget with email-link traffic."""
    tiny = _rates(**{"anon-link": "3/minute"})

    with mock.patch.object(SimpleRateThrottle, "THROTTLE_RATES", tiny):
        landings = [
            api_client.get("/api/emails/confirm").status_code for _ in range(8)
        ]
        assert 429 in landings, (
            f"the email-link bucket never filled; test proves nothing: {landings}"
        )

        challenge = api_client.post(
            "/api/auth/zcash/challenge/",
            {"address": "t1WnCauSV6fbHzWBHtSrK2qvFRyU6J121nH"},
            format="json",
        )
        assert challenge.status_code == 200, (
            "an unrelated anonymous bucket starved Zcash challenge issuance: "
            f"{challenge.status_code} {challenge.content[:200]!r}"
        )
def test_the_sign_in_bucket_is_sized_for_sign_ins_not_registrations():
    """The number, not just the wiring — this is the test that was missing.

    ``anon-login`` was first set to 60/minute on the model "a person registers
    once in a lifetime". That model is wrong: ``/api/start/`` is POSTed by
    both front ends on *every* authentication attempt, so the legitimate load
    is the rate of all sign-ins from one egress IP, retries included. And a
    429 does not degrade — ``429`` is not in the clients' fallback list
    ``[400, 401, 403, 409, 422]``, so neither UI ever reaches
    ``/api/auth/login/`` and sign-in fails outright with a generic error.

    The floor below is the worst realistic *legitimate* burst behind one
    egress: a synchronised sign-in event (a classroom, workshop or conference
    of ~200 people signing in over ~2 minutes at ~1.5 attempts each) is about
    150 sign-in ATTEMPTS in a sliding minute — and each attempt
    spends TWO requests from this bucket, because ``/api/auth/login/`` joined
    the same scope. 300 req/min is therefore the floor, not 150. That
    multiplication is the whole reason this test exists in this shape: adding
    an endpoint to a scope silently halves the ceiling everyone else was sized
    against, which is how  nearly halved ``anon-link``.

    nginx normalizes ordinary API X-Forwarded-For to one client value and DRF
    uses ``NUM_PROXIES=1``; changing an attacker-controlled prefix cannot mint
    a fresh bucket. This number remains a legitimate-traffic allowance, not
    the sole abuse control — the credential-stuffing control on this path is
    the single-use captcha grant (dj/apps/g12f/captcha.py).

    Asserted as a floor, not an equality: retuning upward is fine and must not
    fail here. It fails only if someone sizes this bucket below the sign-in
    load again, which is exactly how this bug happened.
    """
    #200 people x 1.5 attempts, spread over the ~2 min of a synchronised
    #sign-in event, is ~150 sign-in attempts/min.
    MODELLED_SIGN_IN_ATTEMPTS_PER_MINUTE = 150
    #Derived, not asserted separately: every endpoint that shares this scope
    #is charged once per attempt, so the bucket has to carry their sum. Both
    #legs fire on every attempt, so this is len(paths), not an estimate.
    SIGN_IN_PATHS = ("/api/start/", "/api/auth/login/")

    scopes = set()
    for path in SIGN_IN_PATHS:
        path_scopes = _anon_scopes(resolve(path).func.cls)
        assert path_scopes, (
            f"{path} lost its anon throttle entirely; if that was deliberate, "
            "ANON_SCOPE_INVENTORY has to change too"
        )
        scopes |= path_scopes

    assert scopes == {"anon-login"}, (
        "the two legs of the sign-in dance must share exactly one bucket. "
        "Splitting them leaves the real per-IP sign-in ceiling at min(the two "
        f"rates), which nobody tuned. got {sorted(scopes)}"
    )

    floor = MODELLED_SIGN_IN_ATTEMPTS_PER_MINUTE * len(SIGN_IN_PATHS)
    for scope in scopes:
        rate = SimpleRateThrottle.THROTTLE_RATES[scope]
        num, period = rate.split("/")
        seconds = {"s": 1, "m": 60, "h": 3600, "d": 86400}[period[0]]
        per_minute = int(num) * 60 / seconds
        assert per_minute >= floor, (
            f"the sign-in path is gated by scope {scope!r} at {rate} "
            f"(={per_minute:g}/min), below the {floor}/min that "
            f"{MODELLED_SIGN_IN_ATTEMPTS_PER_MINUTE} attempts/min x "
            f"{len(SIGN_IN_PATHS)} requests/attempt produces for a "
            "synchronised sign-in event behind one office/campus egress. "
            "Both UIs POST /api/start/ AND /api/auth/login/ on EVERY login "
            "attempt and neither falls back on a 429, so this does not "
            "throttle registration — it blocks sign-in for existing accounts "
            "across that whole network. Either raise the rate or move an "
            "endpoint out of any scope shared with something quieter."
        )


@pytest.mark.django_db
def test_password_login_is_actually_rate_limited(api_client, creator_factory):
    """'s throttle half, asserted as a real 429 off a real request.

    ``/api/auth/login/`` had no throttle of any kind: dj-rest-auth's stock
    ``LoginView`` sets no ``throttle_classes``, and the global default
    (``AuthenticatedUserRateThrottle``) returns ``None`` for an anonymous
    caller — which every request to a login endpoint is. So an unlimited
    number of username/password guesses per second was the documented
    behaviour of the site's primary credential endpoint.

    Wiring assertions cannot see that: the view *had* throttle_classes (the
    inherited default), and the default *is* in the list. Only exhausting the
    bucket against the mounted URL proves it.
    """
    user = creator_factory(password="correct-password")
    tiny = _rates(**{"anon-login": "3/minute"})

    def duplicate_captcha(*_args, **_kwargs):
        # Answer like Google does for a replayed token, which is the token an
        # attacker has: the point is that the THROTTLE stops this, wherever
        # the captcha check lands.
        return SimpleNamespace(
            json=lambda: {
                "success": False, "error-codes": ["timeout-or-duplicate"],
            }
        )

    with mock.patch.object(SimpleRateThrottle, "THROTTLE_RATES", tiny), \
            mock.patch(
                "dj.apps.g12f.captcha.requests.post",
                duplicate_captcha,
            ):
        statuses = [
            api_client.post(
                "/api/auth/login/",
                {
                    "username": user.username,
                    "password": f"guess-{i}",
                    "captcha_result": "stuffed-token",
                },
                format="json",
            ).status_code
            for i in range(8)
        ]

    assert 429 in statuses, (
        "/api/auth/login/ never 429'd under a 3/minute bucket, so anonymous "
        f"credential guessing is unlimited: {statuses}"
    )


@pytest.mark.django_db
def test_login_throttle_is_not_escaped_by_authenticating_first(
    api_client, creator_factory
):
    """The IP bucket must charge an authenticated caller too ( codex).

    ``AnonRateThrottle.get_cache_key`` returns ``None`` when
    ``request.user.is_authenticated`` — "only throttle unauthenticated
    requests". DRF authenticates BEFORE it throttles, and ``LoginView`` keeps
    the project's authentication classes even though its permission is
    ``AllowAny``. So with a plain anon throttle here, an attacker logs in to an
    account THEY control, keeps the session, and then POSTs victim credential
    guesses to this endpoint with the per-IP bucket skipped entirely — only
    the 1200/minute per-user ceiling applies, which they multiply by rotating
    their own accounts.

    The anonymous 429 test cannot see this: it is the authenticated path that
    is exempt. ``NativeCheckoutReturnRateThrottle`` closes the same exemption
    for the same structural reason.
    """
    attacker = creator_factory(password="attacker-password")
    victim = creator_factory(password="victim-password")
    api_client.force_authenticate(user=attacker)

    tiny = _rates(**{"anon-login": "3/minute", "user": "10000/minute"})

    def duplicate_captcha(*_args, **_kwargs):
        return SimpleNamespace(
            json=lambda: {
                "success": False, "error-codes": ["timeout-or-duplicate"],
            }
        )

    with mock.patch.object(SimpleRateThrottle, "THROTTLE_RATES", tiny), \
            mock.patch(
                "dj.apps.g12f.captcha.requests.post",
                duplicate_captcha,
            ):
        statuses = [
            api_client.post(
                "/api/auth/login/",
                {
                    "username": victim.username,
                    "password": f"guess-{i}",
                    "captcha_result": "stuffed-token",
                },
                format="json",
            ).status_code
            for i in range(8)
        ]

    assert 429 in statuses, (
        "an authenticated caller was exempt from the per-IP login bucket, so "
        "the throttle half of #816 is bypassed by logging in first: "
        f"{statuses}"
    )


@pytest.mark.django_db
def test_login_is_served_by_the_throttled_view_on_both_slash_forms(api_client):
    """The shadow has to cover what dj-rest-auth's own pattern covers.

    Upstream mounts login as ``re_path(r'login/?$')``, so ``/api/auth/login``
    and ``/api/auth/login/`` are two distinct resolvable paths. A ``path()``
    override would shadow only the second, and ``APPEND_SLASH`` would not
    redirect the first because it still resolves — leaving the unthrottled
    stock view reachable at a URL one character away. Exactly the trap
    ``/api/auth/user`` already documents in the URLConf.
    """
    from dj.apps.g12f.views.creator import CreatorLoginView

    for suffix in ("", "/"):
        assert resolve(f"/api/auth/login{suffix}").func.cls is CreatorLoginView


@pytest.mark.django_db
def test_exhausting_the_sign_in_bucket_does_not_break_polling(api_client):
    """The converse direction, so the isolation is not accidentally one-way.

    A signup flood must not knock the live-status reads off a shared egress
    either; if it did, one scripted registration attempt would blank the
    'live now' indicators for a whole office.
    """
    tiny = _rates(**{"anon-poll": "10/minute", "anon-login": "3/minute"})

    with mock.patch.object(SimpleRateThrottle, "THROTTLE_RATES", tiny):
        signups = [
            api_client.post("/api/start/", {}, format="json").status_code
            for _ in range(8)
        ]
        assert 429 in signups, (
            f"the auth bucket never filled; test proves nothing: {signups}"
        )

        assert api_client.get("/api/dyte/public/").status_code == 200, (
            "public live-meeting reads were starved by a signup flood from "
            "the same IP; the scopes are not isolated in both directions"
        )


@pytest.mark.django_db
def test_public_endpoints_without_anon_throttle_are_not_rate_limited(
    api_client, creator_factory
):
    """Behavioural half: a burst well past the anon ceiling still sails through.

    20 requests each is under the configured rate, but the point is that these
    endpoints have no anon bucket at all — if one is ever attached, this is the
    test that notices before production does.
    """
    # `/api/tagging/hub/<slug>` 404s when nothing published carries the tag,
    # and a burst of 404s would prove nothing about throttling. Everything
    # else in the list is a collection endpoint that answers 200 while empty.
    import uuid as _uuid

    from dj.apps.g12f.models import zPage

    hub_page = zPage.objects.create(
        creator=creator_factory(),
        free2zaddr=str(_uuid.uuid4()),
        vanity=f"throttle-hub-{_uuid.uuid4()}",
        title="Throttle fixture",
        content="Fixture content",
        is_published=True,
    )
    hub_page.tags.add("zcash")

    for path in SSR_ANONYMOUS_READS_CHEAP:
        for _ in range(20):
            assert api_client.get(path).status_code == 200, path


# ------------------------------------------- social OAuth completion

SOCIAL_LOGIN_UNKNOWN_STATE = (400, b"state is missing, expired or does not match")
#`/start` with no redirect_uri: the view's own refusal, so it was served.
START_WITHOUT_REDIRECT = (400, b"redirect_uri and code_challenge must not repeat")
RELAY_UNKNOWN_STATE = (400, b"provider callback is missing, expired, or replayed")
#Well-formed, so the relay goes as far as the state lookup (and therefore
#is charged): a malformed callback is rejected before Redis and is NOT.
RELAY = "/api/auth/social/mobile/callback?state=" + "R" * 32 + "&code=c"

#What the GCLB sends a container-native NEG backend: the TCP peer is a GFE
#(35.191.0.0/16) and XFF ends ``<client-ip>,<load-balancer-ip>``. Everything
#before that suffix is whatever the caller chose to send.
GFE_PEER = "35.191.10.20"
LOAD_BALANCER_IP = "34.117.0.1"


def _via_gclb(client_ip, forged_prefix=None):
    xff = f"{client_ip}, {LOAD_BALANCER_IP}"
    if forged_prefix:
        xff = f"{forged_prefix}, {xff}"
    return {"REMOTE_ADDR": GFE_PEER, "HTTP_X_FORWARDED_FOR": xff}


@pytest.fixture
def _google_configured(settings):
    settings.GOOGLE_CLIENT_ID = "test-google-id"
    settings.GOOGLE_CLIENT_SECRET = "test-google-secret"


def _social_login(api_client, state="A" * 32, **extra):
    return api_client.post(
        "/api/auth/social/google/",
        {
            "code": "c",
            "state": state,
            "redirect_uri": "https://free2z.cash/auth/callback/google",
        },
        format="json",
        **extra,
    )


@pytest.mark.django_db
def test_social_login_is_actually_rate_limited(api_client, _google_configured):
    """A real 429 off a real request ('s acceptance).

    A wiring assertion cannot see this class of bug: the view always HAD
    ``throttle_classes`` -- the inherited default -- and that default returns
    ``None`` for an anonymous caller.
    """
    tiny = _rates(**{"anon-oauth-complete": "3/minute"})
    with mock.patch.object(SimpleRateThrottle, "THROTTLE_RATES", tiny):
        responses = [_social_login(api_client) for _ in range(5)]

    for response in responses[:3]:
        _assert_served(
            response, SOCIAL_LOGIN_UNKNOWN_STATE,
            "the first requests must reach the view itself",
        )
    assert [r.status_code for r in responses[3:]] == [429, 429]


@pytest.mark.django_db
def test_the_mobile_relay_is_actually_rate_limited(api_client):
    tiny = _rates(**{"anon-oauth-complete": "3/minute"})
    with mock.patch.object(SimpleRateThrottle, "THROTTLE_RATES", tiny):
        responses = [
            api_client.get(RELAY)
            for _ in range(5)
        ]

    for response in responses[:3]:
        _assert_served(response, RELAY_UNKNOWN_STATE, "relay handler must answer")
    assert [r.status_code for r in responses[3:]] == [429, 429]


@pytest.mark.django_db
def test_relay_and_login_share_one_completion_bucket(
    api_client, _google_configured,
):
    """Two legs of one sign-in, one budget -- the 'anon-login' shape."""
    tiny = _rates(**{"anon-oauth-complete": "2/minute"})
    with mock.patch.object(SimpleRateThrottle, "THROTTLE_RATES", tiny):
        api_client.get(RELAY)
        api_client.get(RELAY)
        login = _social_login(api_client)

    assert login.status_code == 429, login.content


@pytest.mark.django_db
def test_draining_oauth_starts_cannot_strand_a_completion(
    api_client, _google_configured,
):
    """Starts are freely scriptable; a sign-in already out at the provider
    must still be able to come back. And the other way round: garbage
    completions must not stop anyone from STARTING one."""
    tiny = _rates(**{
        "anon-oauth-state": "2/minute",
        "anon-oauth-complete": "2/minute",
    })
    start = "/api/auth/social/google/start"
    with mock.patch.object(SimpleRateThrottle, "THROTTLE_RATES", tiny):
        starts = [api_client.get(start).status_code for _ in range(4)]
        assert 429 in starts, f"start bucket never filled: {starts}"
        _assert_served(
            _social_login(api_client), SOCIAL_LOGIN_UNKNOWN_STATE,
            "a drained START bucket blocked the completion POST",
        )
        _assert_served(
            api_client.get(RELAY),
            RELAY_UNKNOWN_STATE,
            "a drained START bucket blocked the provider relay",
        )
        assert _social_login(api_client).status_code == 429

    cache.clear()
    with mock.patch.object(SimpleRateThrottle, "THROTTLE_RATES", tiny):
        for _ in range(3):
            _social_login(api_client)
        assert _social_login(api_client).status_code == 429
        _assert_served(
            api_client.get(start), START_WITHOUT_REDIRECT,
            "a drained COMPLETION bucket blocked starting a sign-in",
        )


@pytest.mark.django_db
def test_a_throttled_completion_does_not_consume_the_state(
    api_client, _google_configured,
):
    """A 429 must leave the sign-in recoverable, not stranded.

    DRF throttles in ``initial()``, before the handler pops the single-use
    state, so the same provider return can be retried once the window
    moves. This pins that ordering.
    """
    from dj.apps.social.state import get_state, store_state

    state = "B" * 32
    store_state(state, {
        "flow": "direct",
        "verifier": "v",
        "redirect_uri": "https://free2z.cash/auth/callback/google",
        "provider": "google",
    })
    tiny = _rates(**{"anon-oauth-complete": "1/minute"})
    with mock.patch.object(SimpleRateThrottle, "THROTTLE_RATES", tiny):
        _social_login(api_client, state="C" * 32)
        throttled = _social_login(api_client, state=state)

    assert throttled.status_code == 429
    assert get_state(state) is not None, "a 429 burned the user's state"


@pytest.mark.django_db
def test_the_relay_buckets_per_client_not_per_load_balancer(api_client):
    """The relay reaches gunicorn straight from the GCLB, without nginx.

    DRF's ``NUM_PROXIES = 1`` then takes the LAST XFF element -- the load
    balancer's own address, identical for every caller -- so a stock anon
    throttle on this route is ONE GLOBAL BUCKET: one script switches mobile
    sign-in off for everybody. Two different clients behind the same load
    balancer must have two different budgets.
    """
    tiny = _rates(**{"anon-oauth-complete": "2/minute"})
    relay = RELAY
    with mock.patch.object(SimpleRateThrottle, "THROTTLE_RATES", tiny):
        attacker = [
            api_client.get(relay, **_via_gclb("198.51.100.9")).status_code
            for _ in range(4)
        ]
        assert attacker[-1] == 429, attacker
        _assert_served(
            api_client.get(relay, **_via_gclb("203.0.113.7")),
            RELAY_UNKNOWN_STATE,
            "one client drained the relay for a different client: the "
            "throttle is keyed on the load balancer, i.e. global",
        )


@pytest.mark.django_db
def test_a_forged_xff_prefix_does_not_buy_a_fresh_relay_bucket(api_client):
    tiny = _rates(**{"anon-oauth-complete": "2/minute"})
    relay = RELAY
    with mock.patch.object(SimpleRateThrottle, "THROTTLE_RATES", tiny):
        statuses = [
            api_client.get(
                relay, **_via_gclb("198.51.100.9", forged_prefix=f"10.0.0.{i}")
            ).status_code
            for i in range(4)
        ]
    assert statuses[-1] == 429, statuses


@pytest.mark.parametrize("xff", [
    None,
    "",
    "198.51.100.9",                      # no load-balancer element
    "not-an-ip, 34.117.0.1",
    "198.51.100.9, not-an-ip",
    ",".join(["10.0.0.1"] * 17),        # over the element bound
])
@pytest.mark.django_db
def test_a_gfe_peer_with_an_unexpected_suffix_fails_closed(api_client, xff):
    """Never collapse unrelated callers into one shared key: refuse instead."""
    extra = {"REMOTE_ADDR": GFE_PEER}
    if xff is not None:
        extra["HTTP_X_FORWARDED_FOR"] = xff
    response = api_client.get(RELAY, **extra)

    assert response.status_code == 503, response.content
    assert response.json()["detail"].startswith("Sign-in is temporarily")


def test_direct_gclb_identity_trusts_the_suffix_only_from_a_gfe():
    """nginx (loopback) keeps DRF's identity; a GFE peer yields the client it
    appended; any OTHER peer is keyed on itself -- never on a suffix it could
    have forged, and never on DRF's last element (the load balancer)."""
    from rest_framework.test import APIRequestFactory

    from dj.free2z.throttling import direct_gclb_client_ident

    factory = APIRequestFactory()
    via_nginx = factory.get(
        "/", REMOTE_ADDR="127.0.0.1", HTTP_X_FORWARDED_FOR="198.51.100.9",
    )
    assert direct_gclb_client_ident(via_nginx) is None
    direct = factory.get("/", **_via_gclb("2001:db8::7", forged_prefix="1.2.3.4"))
    assert direct_gclb_client_ident(direct) == "2001:db8::7"
    # An in-cluster pod naming a victim's address gets its OWN bucket.
    forged = factory.get(
        "/", REMOTE_ADDR="10.0.1.10",
        HTTP_X_FORWARDED_FOR=f"203.0.113.7, {LOAD_BALANCER_IP}",
    )
    assert direct_gclb_client_ident(forged) == "10.0.1.10"
    # A GFE outside the pinned ranges: coarse, per-GFE -- not global.
    unlisted_gfe = factory.get(
        "/", REMOTE_ADDR="34.96.1.1",
        HTTP_X_FORWARDED_FOR=f"198.51.100.9, {LOAD_BALANCER_IP}",
    )
    assert direct_gclb_client_ident(unlisted_gfe) == "34.96.1.1"


@pytest.mark.django_db
def test_ipv6_rotation_inside_one_slash_64_shares_a_bucket(api_client):
    """A subscriber gets a whole /64; per-address buckets are free to mint."""
    tiny = _rates(**{"anon-oauth-complete": "2/minute"})
    with mock.patch.object(SimpleRateThrottle, "THROTTLE_RATES", tiny):
        rotated = [
            api_client.get(RELAY, **_via_gclb(f"2001:db8:1:2::{i:x}")).status_code
            for i in range(1, 5)
        ]
        assert rotated[-1] == 429, rotated
        _assert_served(
            api_client.get(RELAY, **_via_gclb("2001:db8:9:9::1")),
            RELAY_UNKNOWN_STATE,
            "a different /64 must have its own budget",
        )


@pytest.mark.parametrize("query", [
    "",
    "?code=c",
    "?state=" + "R" * 32,                          # neither code nor error
    "?state=" + "R" * 32 + "&code=c&error=x",      # both
    "?state=a&state=b&code=c",                     # repeated state
    "?state=" + "R" * 32 + "&code=a&code=b",       # repeated code
    "?state=short&code=c",                         # bad state format
    '?state=' + "R" * 31 + '"' + "&code=c",
])
@pytest.mark.django_db
def test_relay_precheck_matches_the_handler(api_client, query):
    """Malformed relay callbacks never touch Redis -- throttle OR handler.

    The relay's callback pods also serve Stripe native returns, which keep
    invalid input away from Redis so a half-open Redis cannot pin every sync
    worker. The completion throttle therefore skips exactly the requests the
    handler rejects before ``pop_state``. Both stores are dead here: a
    malformed callback still gets the handler's own 400, and it never reaches
    the state lookup either (so the precheck is not exempting anything the
    handler would go on to look up).
    """
    from dj.free2z.throttling import FailClosedAuthThrottleMixin

    dead = mock.Mock()
    dead.get.side_effect = dead.set.side_effect = redis.exceptions.TimeoutError(
        "Timeout reading from socket"
    )
    with mock.patch.object(FailClosedAuthThrottleMixin, "cache", new=dead), \
            mock.patch(
                "dj.apps.social.views.pop_state",
                side_effect=AssertionError("malformed callback reached Redis"),
            ):
        response = api_client.get("/api/auth/social/mobile/callback" + query)

    assert response.status_code == 400, response.content
    assert b"Sign-in is temporarily" not in response.content


@pytest.mark.django_db
def test_a_well_formed_relay_callback_is_still_charged_on_a_dead_store(
    api_client,
):
    """The other half of the precheck pin: well-formed input IS throttled."""
    from dj.free2z.throttling import FailClosedAuthThrottleMixin

    dead = mock.Mock()
    dead.get.side_effect = dead.set.side_effect = redis.exceptions.TimeoutError(
        "Timeout reading from socket"
    )
    with mock.patch.object(FailClosedAuthThrottleMixin, "cache", new=dead):
        response = api_client.get(RELAY)

    assert response.status_code == 503, response.content
