"""Throttle presets for the free2z API.

The one thing that must not happen here is throttling the *site* off the air.
Any IP-keyed throttle applied globally does exactly that, because the SvelteKit
SSR pod fetches the public reads server-to-server, with no X-Forwarded-For:
every anonymous page view of free2z.cash arrives from one IP and would share
one bucket. Enumerated from every ``*.server.ts`` in the SvelteKit app, that
set is exactly ``/api/zpage/``, ``/api/creator/``, ``/api/comments/``,
``/api/tagging/autocomplete``, ``/api/get-type/`` and ``/api/pricing/`` — a
short list on purpose, so do not assume a public read is SSR-fetched without
checking.

``/api/get-type/`` is not cheap: its historic case-insensitive fallback can
scan. After Django validates any presented session and confirms the path is not
a real creator profile, the anonymous Svelte caller therefore has a token
bucket *before the additional legacy type resolver*, keyed by
``X-Free2Z-Originating-Client``; trusted nginx overwrites that header from
realip on both free2z.cash SSR paths. SvelteKit starts a fresh two-hop XFF chain
from that value for its resolver call, so the downstream nginx brake retains
the visitor identity instead of grouping the whole SvelteKit pod. During mixed
rollout, an older ingress supplies no private identity; Svelte preserves that
absence and the downstream exact-location limiter deliberately uses an empty,
unaccounted key rather than grouping all old-ingress visitors by proxy pod.
Deferring admission until creator 404 keeps hover preloads and shared-NAT
profile traffic outside the small bucket. Classic now follows the same order:
creator first, then get-type only after 404, with a retryable state for resolver
rejections instead of a false permanent-looking creator 404.
Arbitrary or expired cookie text remains anonymous and cannot bypass it. During
the proxy-first rolling update, an old proxy may omit the new header; the app
and downstream nginx deliberately fail open for that bounded skew rather than
collapsing all visitors onto a proxy-pod identity. Putting an anon throttle on
Django instead would discard the authoritative visitor identity and merge the
whole anonymous site into the SSR pod's bucket.

That rules out a global ``AnonRateThrottle`` — and, less obviously, a global
plain ``UserRateThrottle``. Despite the name, DRF's ``UserRateThrottle`` falls
back to the client IP for unauthenticated requests, so it is *also* an anon
throttle. Hence:class:`AuthenticatedUserRateThrottle`, which is what
``DEFAULT_THROTTLE_CLASSES`` actually points at.

Anon throttling is therefore opt-in, per view, on the public endpoints that are
(a) reached directly from the browser, never through SSR, and (b) worth
protecting: account creation, credential flows, password reset mail, and the
Dyte endpoints that fan out to a paid third-party API.

Which bucket a view opts into is the other half of the design. DRF's
anon cache key has no view component, so one scope is one shared per-IP budget
and the noisiest endpoint in a scope decides the rate for all of them. Pick one
of the lists at the bottom of this module by asking two questions: what paces
the traffic (a timer, a person, an inbound link, a provider redirect), and how
much it hurts when this endpoint answers 429. Never mix a machine-paced
endpoint into a human-paced scope — that is exactly how polling came to starve
signup — and never put a freely automatable endpoint in with one whose 429 is
costly, because anything in a bucket can drain it on demand. ``dj/apps/test_throttling.py`` holds the full assignment inventory and
fails if a new anonymous-reachable view appears without an explicit decision.

For ordinary Django API locations, nginx trusts only Google's GFE ranges,
recursively normalizes the XFF chain, and sends exactly that client address
upstream. Shared settings use ``NUM_PROXIES=1`` so DRF selects that one value;
caller-supplied prefixes therefore cannot mint fresh buckets. These limits
still do not stop an attacker who rotates actual source addresses. The broad
SSR/prerender proxies deliberately do not inherit the API header override.

Exact paths the ingress routes straight from the GCLB to a gunicorn with NO
nginx (the OAuth callback Deployment) do not get that normalization: there
DRF's last XFF element is the load balancer's own address, so a stock anon
throttle on one of them is a single global bucket. The social OAuth relay's
throttle handles this with:func:`direct_gclb_client_ident`; check
``k8s/free2z/ingress.yaml`` before putting any anon scope on such a route.
They overwrite only the private identity consumed by the narrow historic-root
admission guard; ordinary SSR API reads still carry no XFF.
Zcash wallet authentication is the narrow exception: its direct GCLB -> exact
nginx -> Django path preserves the raw XFF suffix, captures the original nginx
socket peer, requires Google's documented GFE request range, and selects the
documented two-IP suffix endpoint-locally.
"""

import ipaddress
import json
import logging
import pickle

import redis
from django.conf import settings
from django.core.cache import caches
from django.core.cache.backends.base import InvalidCacheBackendError
from django.utils.connection import ConnectionProxy
from django_redis.exceptions import CompressorError, ConnectionInterrupted
from rest_framework.exceptions import APIException
from rest_framework.throttling import (
    AnonRateThrottle,
    SimpleRateThrottle,
    UserRateThrottle,
)

from dj.apps.zauth.admission import (
    _GCLB_GFE_REQUEST_NETWORKS,
    ZcashChallengeAddressAdmissionThrottle,
    ZcashChallengeAdmissionThrottle,
    ZcashLoginAdmissionThrottle,
)

logger = logging.getLogger(__name__)

#Cloud Logging ``jsonPayload.event`` for a fail-open. This string is the
#contract with ``monitoring/log-metrics/throttle-fail-open.json`` and the
#policy built on it; renaming it silently blinds the alert.
THROTTLE_FAIL_OPEN_EVENT = "throttle_fail_open"

#Cap on any single free-text field in that log line. The request path is
#caller-controlled, and an exception message can be arbitrarily long.
_MAX_LOGGED_FIELD_CHARS = 200

#The exception types that mean *"the counter store did not answer"* — the
#only failure this module is willing to convert into "no rate limiting".
#
#Everything here can come out of a ``cache.get()``/``cache.set()`` against a
#configured backend (``CACHES`` in ``prod_settings.py`` is
#``django_redis.cache.RedisCache``; dev and CI use ``LocMemCache``, which
#raises none of them):
#
#* ``ConnectionInterrupted`` — django_redis's own wrapper, raised when
#``IGNORE_EXCEPTIONS`` is False or absent (a misconfiguration this exists
#to survive).
#* ``CompressorError`` — django_redis failed to decompress a cached payload.
#* ``pickle.UnpicklingError`` / ``EOFError`` — the value under the key is
#corrupt or was written by something else. django_redis wraps the *transport*
#only; deserialization happens after that guard, so these arrive raw. This
#is still a counter-store fault, and the alternative is a 500 for every
#caller sharing that key until it expires — a fail-*closed* regression the
#old catch-all did not have. A hostile pickle payload can technically raise
#anything at all; those residual types 500, which is the right answer for
#something that is no longer "the cache misbehaved".
#* ``redis.RedisError`` — the whole redis-py family. django_redis's
#``omit_exception`` re-raises ``e.__cause__`` rather than its own wrapper
#when exceptions are not ignored, so the *raw* ``redis.exceptions.*``
#error is what actually reaches this frame; errors outside django_redis's
#``_main_exceptions`` (``ResponseError`` subclasses such as
#``AuthenticationError``, ``DataError``, ``InvalidResponse``) are never
#wrapped at all.
#
#Deliberately NOT here, because each is a bug or a different outage whose
#correct answer is a loud 500 rather than a silently disabled rate limiter:
#bare ``OSError``/``ConnectionError``/``TimeoutError`` (an auth backend
#making a network call raises those — that is exactly the  blast
#radius), ``django.db`` errors, and ``ImproperlyConfigured``.
#
#A type allowlist can never be provably complete — ``pickle.loads`` alone can
#raise ``ValueError``, ``AttributeError`` or ``ModuleNotFoundError`` on a bad
#payload — which is why it is not the only test. See
#:func:`_raised_inside_the_cache`.
#
#The builtin ``TimeoutError`` is the near miss, and it is left out on
#purpose. It *is* the fourth member of django_redis's ``_main_exceptions``,
#so in principle a socket timeout could reach here as the bare builtin — but
#redis-py normalises ``socket.timeout`` into ``redis.exceptions.TimeoutError``
#(a ``RedisError``, covered above) before django_redis ever sees it, while an
#authenticator's HTTP client timing out raises the builtin directly. Nothing
#at this frame can tell those apart, and unthrottling on an auth timeout is
#the bargain this change exists to stop making.
CACHE_FAILURE_EXCEPTIONS = (
    ConnectionInterrupted,
    CompressorError,
    redis.RedisError,
    pickle.UnpicklingError,
    EOFError,
)


#Modules that *are* the counter store. An exception that propagated out of a
#frame in one of these came from the cache, whatever its type.
_CACHE_MODULE_PREFIXES = (
    "django.core.cache.",
    "django_redis.",
    "redis.",
)


def _raised_inside_the_cache(exc):
    """Did this exception come out of the cache backend itself?

    The type allowlist above says what a cache failure usually *is*; this says
    where it came *from*, and the two together are what make the narrowing safe
    to ship. Deserialization is the reason: a backend guards the transport but
    decodes afterwards, so a value written by a different serializer surfaces
    as whatever ``pickle.loads`` felt like raising — ``ValueError``,
    ``AttributeError``, ``ModuleNotFoundError``. Listing those types would
    re-admit exactly the auth-backend faults  is about, since an
    authenticator raises the same ordinary types. Their *frames* differ, and
    that is the distinction worth keying on.

    Only frames on the raise path are walked, so this cannot be fooled by an
    auth backend that merely *called* the cache earlier and failed later.
    """
    tb = exc.__traceback__
    while tb is not None:
        module = tb.tb_frame.f_globals.get("__name__", "")
        if module.startswith(_CACHE_MODULE_PREFIXES):
            return True
        tb = tb.tb_next
    return False


def _bounded(value):
    """Cap one free-text log field. ``json.dumps`` handles the escaping."""
    text = str(value)
    if len(text) <= _MAX_LOGGED_FIELD_CHARS:
        return text
    return text[:_MAX_LOGGED_FIELD_CHARS] + "…"


def _log_throttle_fail_open(throttle, request, exc):
    """Emit one-line JSON Cloud Logging turns into ``jsonPayload``.

    A throttle that has been open for a week is the 3am scenario, and it is
    invisible by construction: nothing 429s, no request fails, and the only
    trace is this line. So it carries a stable ``event`` a log-based metric can
    count (see ``monitoring/``), and it names the exception that actually
    occurred instead of asserting a cause nobody verified.

    One line, always: ``json.dumps`` escapes the caller-controlled path, so a
    request path containing a newline cannot forge a second log record.
    """
    logger.warning(json.dumps(
        {
            "severity": "WARNING",
            "message": (
                f"Throttle {type(throttle).__name__} failed open: the counter "
                f"store raised {type(exc).__name__}. Rate limiting is NOT in "
                f"effect for this request."
            ),
            "event": THROTTLE_FAIL_OPEN_EVENT,
            "throttle": type(throttle).__name__,
            "scope": getattr(throttle, "scope", None),
            "path": _bounded(getattr(request, "path", "?")),
            "error_type": type(exc).__name__,
            "error_module": type(exc).__module__,
            "error_message": _bounded(exc),
        },
        separators=(",", ":"),
    ))


class FailOpenThrottleMixin:
    """Never let *the cache* being down take the API down.

    A global throttle puts a ``cache.get()`` + ``cache.set()`` on *every* API
    request, which quietly promotes the cache from "load-bearing for a few
    features" to "hard dependency of the whole API". Production points that at
    a single Redis address, so without this a blip there is a 500 on
    everything instead of a degraded feature.

    ``IGNORE_EXCEPTIONS: True`` on the prod cache is the primary mitigation and
    handles the common case. This is the belt to that pair of braces: it holds
    for a dropped OPTIONS key and for the errors django_redis re-raises rather
    than wraps — the invariant we want is "a cache failure degrades rate
    limiting", and that should not depend on one settings key staying set.

    Deliberately fails *open*. A throttle exists to shed abusive load, not to
    gate correctness; refusing real traffic because the counter store is
    unreachable trades a small problem for an outage.

    **Only for the counter store**. This used to catch every
    ``Exception``, which was a much bigger promise than the one above:
    ``get_cache_key`` is called from inside ``allow_request``, and
    :class:`AuthenticatedUserRateThrottle` resolves ``request.user`` there — so
    on the endpoints with deferred authentication the guard wrapped *the entire
    auth stack*, and any auth-backend fault silently disabled rate limiting at
    the exact moment authentication was misbehaving. Nobody chose that bargain.
    Two tests keep the fail-open contract now — a recognised cache exception
    type (:data:`CACHE_FAILURE_EXCEPTIONS`) or an exception that came out of the
    cache backend's own frames (:func:`_raised_inside_the_cache`). Everything
    else propagates and 500s loudly. Neither test alone is enough: the type list
    cannot be complete (``pickle.loads`` raises whatever it likes), and the
    frame walk alone would miss an error re-raised from outside the backend.

    A redis fault raised *inside* authentication (zauth reads the same cache)
    still fails open, and that is correct: the counter store really is down.

    **This is the belt, not the usual path.** With prod's
    ``IGNORE_EXCEPTIONS: True`` django_redis absorbs an ordinary Redis outage
    one layer below: ``cache.get()`` returns its default, the failed
    ``cache.set()`` is discarded, and this class never sees an exception — the
    throttle simply allows every request having read an empty history. So
    :func:`_log_throttle_fail_open` is *not* the signal for the common outage;
    ``monitoring/alert-policies/throttle-fail-open.json`` carries a second
    condition on django_redis's swallowed-error log for that (see
    ``DJANGO_REDIS_LOGGER`` in settings), and
    ``test_a_swallowed_cache_error_still_emits_one_countable_json_line`` pins
    the layering so it cannot change unnoticed.
    """

    #``True`` on the credential scopes: a counter-store failure
    #refuses the request with a 503 instead of admitting it unthrottled. Set
    #by:class:`FailClosedAuthThrottleMixin`, never directly -- that mixin
    #also moves the counters onto the cache alias that actually *raises*,
    #and a fail-closed flag on the swallowing ``default`` cache would be a
    #control that never fires. See that class.
    fails_closed = False

    def should_fail_open(self, exc):
        """Is this exception a counter-store failure (the name is historical)?

        True means "the cache did not answer" -- the only failure this module
        converts into a policy decision. Whether that decision is to admit
        (the default) or refuse (``fails_closed``) is ``allow_request``'s.
        """
        return (
            isinstance(exc, CACHE_FAILURE_EXCEPTIONS)
            or _raised_inside_the_cache(exc)
        )

    def allow_request(self, request, view):
        try:
            return super().allow_request(request, view)
        except Exception as exc:
            if not self.should_fail_open(exc):
                raise
            if self.fails_closed:
                _log_auth_throttle_unavailable(self, request, exc)
                raise AuthThrottleUnavailable() from exc
            _log_throttle_fail_open(self, request, exc)
            return True


#Cloud Logging ``jsonPayload.event`` for a credential throttle that refused
#because its counter store did not answer. The opposite decision to
#:data:`THROTTLE_FAIL_OPEN_EVENT`, so a different name: one counts requests
#that went through unthrottled, this one counts sign-ins that were refused.
AUTH_THROTTLE_UNAVAILABLE_EVENT = "auth_throttle_unavailable"

#The cache alias the credential throttles count in. ``prod_settings.py``
#defines it on the same Redis as ``default`` but with
#``IGNORE_EXCEPTIONS: False`` -- the whole mechanism, because ``default``
#swallows a Redis outage below this module (``cache.get`` returns an empty
#history), so no exception would ever reach a fail-closed handler there.
#Dev and CI define no such alias and fall back to ``default`` (LocMemCache,
#which raises nothing either way); ``test_auth_throttle_cache_alias_raises``
#pins the prod definition so the fallback cannot silently become prod's.
AUTH_THROTTLE_CACHE_ALIAS = "auth_throttle"


def _auth_throttle_cache():
    alias = (
        AUTH_THROTTLE_CACHE_ALIAS
        if AUTH_THROTTLE_CACHE_ALIAS in settings.CACHES
        else "default"
    )
    # A proxy, not ``caches[alias]``: the latter is the calling thread's
    # connection object, and this is evaluated once at import. The proxy
    # resolves per access, exactly like DRF's own ``default_cache``.
    return ConnectionProxy(caches, alias)


class AuthThrottleUnavailable(APIException):
    """503 from a credential throttle whose counter store is down.

    503 and not 429: nobody exceeded anything, and a client that backs off on
    429 by lengthening its window has nothing to learn here. ``wait`` becomes
    ``Retry-After`` through DRF's own exception handler, as it does for
    ``Throttled``.
    """

    status_code = 503
    default_detail = (
        "Sign-in is temporarily unavailable. Please try again in a minute."
    )
    default_code = "auth_throttle_unavailable"
    wait = 30


def _log_auth_throttle_unavailable(throttle, request, exc):
    """ERROR, one JSON line: a credential endpoint is refusing everyone.

    Same shape and the same caller-controlled-field bounds as
    :func:`_log_throttle_fail_open`, so one log-based metric recipe fits both.
    """
    logger.error(json.dumps(
        {
            "severity": "ERROR",
            "message": (
                f"Throttle {type(throttle).__name__} failed closed: the "
                f"counter store raised {type(exc).__name__}. The request was "
                f"refused with 503; credential endpoints are unavailable "
                f"until it recovers."
            ),
            "event": AUTH_THROTTLE_UNAVAILABLE_EVENT,
            "throttle": type(throttle).__name__,
            "scope": getattr(throttle, "scope", None),
            "path": _bounded(getattr(request, "path", "?")),
            "error_type": type(exc).__name__,
            "error_module": type(exc).__module__,
            "error_message": _bounded(exc),
        },
        separators=(",", ":"),
    ))


class FailClosedAuthThrottleMixin:
    """Credential scopes: a dead counter store refuses, it does not admit.

     (epic ). Everything else in this module fails OPEN on a cache
    outage, deliberately: a throttle there sheds load, and refusing real
    traffic because Redis blinked trades a small problem for an outage. On a
    credential endpoint the bargain is the other way round. The throttle IS
    the control -- on password login it is the only per-source brake on
    guessing -- and "Redis is down" is precisely the window an attacker who
    can cause it wants: an unthrottled credential-stuffing lane for as long as
    the outage lasts, with nothing on any dashboard but a log line.

    Two things together make it real, and either alone is inert:

    * ``fails_closed = True`` --:class:`FailOpenThrottleMixin` raises
      :class:`AuthThrottleUnavailable` (503) instead of returning ``True``;
    * ``cache`` -- the ``auth_throttle`` alias, which RAISES. On ``default``
      (``IGNORE_EXCEPTIONS: True``) an ordinary outage never produces an
      exception at this layer at all.

    Mix it in FIRST, ahead of the fail-open base, so both attributes win the
    MRO lookup.

    **The cost, stated plainly:** while the auth-throttle Redis is down, every
    password sign-in, registration, password reset, OTP login and X/OAuth
    start answers 503. That is the chosen trade (epic, "Security"):
    sign-in outage over an unmetered guessing lane. Session- and token-
    authenticated traffic is unaffected -- only the global ``user`` ceiling
    touches the cache on those, and it still fails open. Zcash login already
    failed closed (``dj.apps.zauth.admission``), so it is not in this family.
    """

    fails_closed = True
    cache = _auth_throttle_cache()


class AuthenticatedUserRateThrottle(FailOpenThrottleMixin, UserRateThrottle):
    """``UserRateThrottle`` restricted to *actually* authenticated callers.

    The stock class keys anonymous requests on the client IP
    (``get_cache_key`` → ``get_ident``), which makes it unsafe as a global
    default here: all SSR-originated anonymous traffic shares the SSR pod's IP.
    Returning ``None`` tells DRF not to throttle the request at all, so the
    global ceiling applies per logged-in identity and anonymous traffic is
    governed only by the explicit per-view opt-in lists at the bottom of this
    module.

    With endpoint-local deferred authentication (zauth, ) ``request.user``
    is first resolved *inside* this throttle, so ``AuthenticationFailed`` is
    raised from under ``allow_request``. It must keep its normal 401 rather
    than becoming a fail-open — which is now the mixin's default for every
    non-cache exception, not a local override. See
    ``test_an_auth_failure_inside_the_throttle_still_401s``.
    """

    def get_cache_key(self, request, view):
        if not (request.user and request.user.is_authenticated):
            return None
        return super().get_cache_key(request, view)


class StripeCheckoutAdmissionUnavailable(APIException):
    # 500, not 503. On /api/stripe/create-checkout-session/ a 503 is
    # reserved for the DESIGNED refusals (ZUULI's native-checkout fallback and
    # the operator's staged-off switch): the shipped ZUULI app retries exactly
    # a 503 as web checkout, and the write-failure alerts  exclude
    # exactly that 503. A dead admission store is a real outage, so it must
    # land on the other side of that line. The app does not retry a 500, which
    # is right: the web retry passes through this same throttle.
    status_code = 500
    default_detail = 'Checkout admission is temporarily unavailable.'
    default_code = 'checkout_admission_unavailable'


class StripeCheckoutUserRateThrottle(UserRateThrottle):
    """Fail-closed, per-buyer brake for the bounded Stripe request path.

    Production uses a dedicated Redis cache alias with exception swallowing
    disabled. The global API throttle intentionally fails open on Redis loss;
    this provider admission path must refuse before it occupies a worker.
    """

    scope = 'stripe-checkout'
    try:
        cache = caches['stripe_checkout_admission']
    except InvalidCacheBackendError:
        cache = caches['default']

    def allow_request(self, request, view):
        try:
            return super().allow_request(request, view)
        except Exception as exc:
            if not (
                isinstance(exc, CACHE_FAILURE_EXCEPTIONS)
                or _raised_inside_the_cache(exc)
            ):
                raise
            logger.error(json.dumps(
                {
                    'event': 'stripe_checkout_admission_unavailable',
                    'error_type': type(exc).__name__,
                },
                separators=(',', ':'),
                sort_keys=True,
            ))
            raise StripeCheckoutAdmissionUnavailable from exc


class SdkPurchaseRateThrottle(StripeCheckoutUserRateThrottle):
    """``POST /api/sdk/v1/purchases``: the same fail-closed admission
    brake, keyed so a third-party app cannot spend its user's budget.

    * An OAuth app gets its OWN bucket per (app, user), scope
      ``sdk-purchase``. A runaway or hostile app therefore cannot 429 the
      user's web wallet (``stripe-checkout``) or another app.
    * A first-party session/Knox caller stays on the user's own
      ``stripe-checkout`` bucket: it is the same person as the web wallet.
    * A request whose ``Idempotency-Key`` already has a FINISHED receipt is
      a replay: it does no provider work, so it spends no token. The view
      decides that (``view.is_finished_replay``), because only it knows the
      key's scope.
    """

    app_scope = 'sdk-purchase'

    @staticmethod
    def _application(request):
        from dj.apps.oidc.authentication import OAuthAccessToken

        auth = getattr(request, 'auth', None)
        return auth.application if isinstance(auth, OAuthAccessToken) else None

    def allow_request(self, request, view):
        is_replay = getattr(view, 'is_finished_replay', None)
        if is_replay is not None and is_replay(request):
            return True
        if self._application(request) is not None:
            self.scope = self.app_scope
            self.rate = self.get_rate()
            self.num_requests, self.duration = self.parse_rate(self.rate)
        return super().allow_request(request, view)

    def get_cache_key(self, request, view):
        application = self._application(request)
        if application is None:
            return super().get_cache_key(request, view)
        if not (request.user and request.user.is_authenticated):
            return None
        return self.cache_format % {
            'scope': self.app_scope,
            'ident': f'{application.pk}:{request.user.pk}',
        }


class PublicAnonRateThrottle(FailOpenThrottleMixin, AnonRateThrottle):
    """Abstract per-IP base for the opted-in public endpoints. Pick a subclass.

    DRF's cache key is ``throttle_<scope>_<ident>`` — **no view component**. So
    every view sharing a scope shares one per-IP bucket, and the endpoint with
    the highest legitimate request rate sets the floor for the rate of every
    other endpoint in that scope. That is: background live-status polling
    spent the same budget that gated signup and password reset, so one busy
    office egress could 429 registration for everyone behind it.

    The fix is not a bigger number, it is a bucket per traffic *shape*. A scope
    should group endpoints whose legitimate request rates are within an order
    of magnitude of each other, and must never put a machine-paced endpoint in
    with a human-paced one.

    ``scope = None`` here on purpose: a subclass that forgets to name a scope
    raises ``ImproperlyConfigured`` on its first request instead of silently
    rejoining a shared bucket. The loud failure is the point — and
    ``dj/apps/test_throttling.py`` catches it in CI first, so it never gets
    that far.
    """

    scope = None


class PollingAnonRateThrottle(PublicAnonRateThrottle):
    """Machine-paced public reads the browser fires on a timer.

    The homepage renders 8 CreatorCards, each polling ``live-status`` on a
    viewport-gated interval (15s live-with-count / 30s live / 60s idle), so one
    tab is ~8-32 req/min all by itself and a shared egress multiplies that by
    the number of visitors. Sized for that consumer; see ``anon-poll`` in
    settings.
    """

    scope = 'anon-poll'


class DytePollingAnonRateThrottle(PollingAnonRateThrottle):
    """Apply the Dyte polling budget to every non-POST operation.

    ``DyteMeeting`` also exposes POST on the same URL. Guest POSTs create a
    participant through the paid provider and use their tighter join budget.
    HEAD aliases the paid-provider GET path, so exempting only POST makes
    unexpected methods fail closed into the polling budget too.
    """

    def get_cache_key(self, request, view):
        if request.method == 'POST':
            return None
        return super().get_cache_key(request, view)


class BroadcastJoinAnonRateThrottle(PublicAnonRateThrottle):
    """Per-IP brake for anonymous broadcast participant creation.

    Only guest POSTs for the public ``broadcast`` type consume this scope.
    Authenticated callers retain the global user limit, protected stream
    types fail permission checks, and status polling remains in ``anon-poll``.
    """

    scope = 'anon-broadcast-join'

    def get_cache_key(self, request, view):
        if (
            request.method != 'POST'
            or view.kwargs.get('type', '').lower() != 'broadcast'
        ):
            return None
        return super().get_cache_key(request, view)


class LoginPathAnonRateThrottle(
    FailClosedAuthThrottleMixin, PublicAnonRateThrottle
):
    """Everything on the **sign-in** path: ``/api/start/`` and login.

    The name looks wrong for a view called ``SignUpView`` and is not. Both
    front ends implement one combined "log in or create account" button that
    POSTs ``/api/start/`` *first, on every authentication attempt*, and only
    falls through to ``/api/auth/login/`` when signup reports the user already
    exists (``zuu ts/svelte/free2z/src/lib/stores/auth.ts`` ``login()``;
    ``zuu ts/react/free2z/src/CreatorLoginModal.tsx`` ``handleCreate()``). So
    the legitimate traffic in this bucket is the rate of *all sign-ins* plus
    every mistyped-password retry — not the rate of registrations, which is
    the model the pre-review version of this scope was sized against.

    Two things follow, and both are why this is not merged into account
    recovery:

    * By this module's own rule, ``/api/start/`` is the highest-rate endpoint
      on the sign-in path, so it would set the floor for anything sharing its
      scope. Password reset is one to two orders of magnitude quieter.
    * A 429 here does **not** degrade gracefully. ``429`` is not in the
      Svelte fallback list ``[400, 401, 403, 409, 422]``, so the client never
      reaches ``/api/auth/login/`` and reports a generic "Authentication
      failed"; classic React snackbars the raw throttle payload. Draining this
      bucket therefore blocks **sign-in for existing accounts**, not just
      registration — 's user-facing outage from the other direction.

    ``/api/auth/login/`` joined this scope in  (via
    ``dj.apps.g12f.views.creator.CreatorLoginView``): it is the second request
    of the same two-request dance, at a 1:1 ratio with the first, so it
    belongs in the same budget rather than in a second one that would silently
    cap it at ``min()`` of two rates. The rate went 300 -> 600/minute in the
    same change because an attempt now spends two requests here, not one.

    What this bucket is NOT: the credential-stuffing control. It is generous
    by design (a 429 blocks sign-in for a whole egress) and per-IP limits do
    nothing against a botnet. The stuffing control on this path is the
    single-use reCAPTCHA grant in ``dj.apps.g12f.captcha`` — this is the brake
    on the single-source case.
    """

    scope = 'anon-login'


class PasswordLoginRateThrottle(LoginPathAnonRateThrottle):
    """The ``anon-login`` bucket, charged even to an authenticated caller.

    ``AnonRateThrottle.get_cache_key`` returns ``None`` when
    ``request.user.is_authenticated`` — "only throttle unauthenticated
    requests". That exemption is right for a public read and **wrong for a
    credential endpoint**, because DRF authenticates before it throttles and
    ``LoginView`` keeps the project's authentication classes even though its
    permission is ``AllowAny``. So an attacker who simply holds a session or
    knox token for an account they control is not anonymous at this view: the
    per-IP bucket is skipped entirely and only the 1200/minute per-user
    ceiling applies, which they multiply by rotating their own accounts. The
    IP throttle on the site's password endpoint would have been bypassable by
    logging in first (found by the codex adversarial review of ).

    Same scope, same budget, same bucket as
    :class:`LoginPathAnonRateThrottle` — the only difference is that nobody is
    exempt from it.:class:`NativeCheckoutReturnRateThrottle` closes the same
    exemption for the same reason; this is that argument applied to
    credentials rather than to a paid provider call.

    Not applied to ``/api/start/``: registration by an already-authenticated
    caller is not a credential-guessing lane, and widening that view's
    behaviour is not this change's job.
    """

    def get_cache_key(self, request, view):
        return self.cache_format % {
            'scope': self.scope,
            'ident': self.get_ident(request),
        }


class AccountRecoveryAnonRateThrottle(
    FailClosedAuthThrottleMixin, PublicAnonRateThrottle
):
    """"I forgot my password": the reset request and the reset consume.

    Genuinely human-paced and genuinely rare — unlike the sign-in path, which
    a person walks every time they visit on a new device. Kept in its own
    bucket so neither polling nor the far noisier sign-in path can spend the
    budget that stands between a network and recovering an account, and kept
    *tight* because nothing legitimate here bursts.

    Named for recovery rather than "auth" on purpose: a bucket called
    ``anon-auth`` invites a future login endpoint to join it, which would put
    the noisiest credential endpoint in the same budget as account recovery —
    the  mistake one level down. Login goes to
    :class:`LoginPathAnonRateThrottle`.
    """

    scope = 'anon-recovery'


class LinkLandingAnonRateThrottle(PublicAnonRateThrottle):
    """One-shot landings from an email we sent: confirm and opt-out.

    Each carries its own single-use token, so the throttle is not the security
    control — it is there to cap token-guessing. Separate from the credential
    scopes because arrival is paced by mail delivery rather than by a human
    deciding
    to act, so a send to a large corporate domain can burst from one egress in
    a way a signup never does.

    A 429 on an unsubscribe link is a CAN-SPAM problem, so keep endpoints
    whose traffic is driven by a third party or a timer out of this scope —
    they raise the floor for everyone sharing it. That is why the Twitter
    OAuth start endpoint sits in its own scope below rather than here.

    It does not follow that this bucket is undrainable: a tokenless GET is
    charged before the handler rejects it, so these two can exhaust their own
    scope. Scoping bounds the blast radius of a drained bucket; the normalized
    client identity from  determines who shares it.
    """

    scope = 'anon-link'


class NativeCheckoutReturnRateThrottle(PublicAnonRateThrottle):
    """Atomic admission for browser returns that may query Stripe.

    These links are signed, but a caller can freely replay a URL they own for
    24 hours. A valid state is signed and user-bound, so charge that owner even
    when the browser has no session cookie and regardless of its reported IP.
    Malformed state is rejected before Redis and never allocates
    attacker-selected identity keys or waits on a failing dependency. This also closes
    ``AnonRateThrottle``'s normal authenticated exemption, which would let one
    account replay a slow Stripe lookup at the much larger user rate. Keep this
    out of email-link and OAuth budgets so retries cannot strand those flows.

    This overrides DRF's history-list throttle completely. Its documented
    read/modify/write race is unsafe for a synchronous third-party call across
    replicas; ``admit_native_return`` uses one Redis Lua operation for both the
    owner rate and the success-only provider-slot lease. A non-blocking
    pod-local slot lets at most one of the callback pod's two workers wait on a
    half-open Redis. Denial is recorded on
    the request instead of letting DRF raise its generic response before the
    view: a valid paid return can then render a private bounded app handoff and
    explicit retry page, while the Stripe lookup remains blocked. Redis failure
    is likewise recorded so the view can render its private 503 and never fail
    open.
    """

    scope = 'anon-checkout-return'

    def allow_request(self, request, view):
        from dj.apps.ztripe.native_return import (
            NativeReturnUnavailable,
            admit_native_return,
            native_return_local_admission_slot,
        )

        rate = self.get_rate()
        if rate is None:
            raise NativeCheckoutReturnAdmissionUnavailable
        self.num_requests, self.duration = self.parse_rate(rate)
        if not self.num_requests or not self.duration:
            raise NativeCheckoutReturnAdmissionUnavailable
        key = self.get_cache_key(request, view)
        if key is None:
            # The signed state is the cheap, dependency-free admission ticket.
            # Invalid input cannot reach Stripe and must not be able to make a
            # half-open Redis occupy every callback worker.
            return True
        try:
            with native_return_local_admission_slot():
                (
                    allowed,
                    self._retry_seconds,
                    provider_lease_token,
                ) = admit_native_return(
                    key,
                    window_seconds=self.duration,
                    limit=self.num_requests,
                    reserve_provider_slot=getattr(
                        self, '_reserve_provider_slot', False
                    ),
                    provider_slots=settings.NATIVE_RETURN_PROVIDER_SLOTS,
                    provider_lease_seconds=(
                        settings.NATIVE_RETURN_PROVIDER_LEASE_SECONDS
                    ),
                )
        except NativeReturnUnavailable:
            request._native_checkout_admission_unavailable = True
            return True
        if not allowed:
            request._native_checkout_retry_seconds = self._retry_seconds
        elif provider_lease_token is not None:
            request._native_checkout_provider_lease_token = provider_lease_token
        # The view consumes the markers above before any Stripe call. Returning
        # True here is deliberate: DRF's generic 429/503 renderer would strand
        # a customer outside ZUULI after Stripe's one-time browser redirect.
        return True

    def wait(self):
        return getattr(self, '_retry_seconds', None)

    def get_cache_key(self, request, view):
        from dj.apps.ztripe.native_return import (
            read_bridge_token,
            valid_checkout_session_id,
        )

        state = request.query_params.get('state')
        success_payload = read_bridge_token(state, 'success')
        payload = success_payload or read_bridge_token(state, 'cancel')
        # Reserve scarce provider capacity only when this request can reach
        # Stripe: a valid success state plus the handler's exact, single-valued
        # query contract. Malformed success links retain their owner rate but
        # cannot occupy a provider slot.
        self._reserve_provider_slot = (
            success_payload is not None
            and getattr(request.resolver_match, 'url_name', None)
            == 'stripe-native-return-success'
            and set(request.query_params.keys()) == {'state', 'session_id'}
            and len(request.query_params.getlist('state')) == 1
            and len(request.query_params.getlist('session_id')) == 1
            and valid_checkout_session_id(
                request.query_params.get('session_id')
            )
        )
        # Invalid state can never reach Stripe. Reject it in the view without
        # touching Redis: during a half-open cache incident even one fixed
        # sacrificial bucket would let anonymous traffic occupy every sync
        # callback worker for the full dependency deadline.
        if success_payload is not None:
            ident = f"signed-success-user-{success_payload['uid']}"
        elif payload is not None:
            # Cancellation uses the same signed-owner ceiling without spending
            # the paid-success budget or reserving provider capacity. The view
            # fails open only when this shared admission store is unavailable.
            ident = f"signed-cancel-user-{payload['uid']}"
        else:
            return None
        return self.cache_format % {
            'scope': self.scope,
            'ident': ident,
        }


class NativeCheckoutReturnAdmissionUnavailable(APIException):
    status_code = 503
    default_detail = "Checkout return verification is temporarily unavailable."
    default_code = "checkout_return_admission_unavailable"


class ThirdPartyOAuthAnonRateThrottle(
    FailClosedAuthThrottleMixin, PublicAnonRateThrottle
):
    """Anonymous endpoints that burn a call to somebody else's API.

    The Twitter OAuth v1 pair: request-token can be POSTed by anyone with no
    token or state, and each call spends a Twitter API quota unit; the
    callback then spends another to exchange it. DRF charges the throttle
    before any of that, which is the point.

    Deliberately alone in its scope. Anonymous traffic here is driven by a
    third party rather than by us, and the endpoint is trivially scriptable,
    so it must not sit in a bucket whose 429 hurts (email links, signup,
    account recovery). The two halves of the dance share this scope; a flood
    of request-token calls can therefore 429 a real user's callback, which is
    a retryable hiccup in a legacy flow ( has it down as a deletion
    candidate) and not worth another scope.
    """

    scope = 'anon-oauth'


class OAuthStateAnonRateThrottle(
    FailClosedAuthThrottleMixin, PublicAnonRateThrottle
):
    """Browser-driven OAuth starts that allocate a short-lived Redis key.

    This is separate from provider callbacks: callers can freely automate the
    start endpoint, while callbacks are paced by the provider and must remain
    deliverable even if somebody drains the start budget.
    """

    scope = 'anon-oauth-state'


#Bounds on a raw ``X-Forwarded-For`` before it is split, the same ones the
#Zcash parser uses: an attacker-supplied prefix must not cost unbounded work.
DIRECT_GCLB_XFF_MAX_CHARS = 1024
DIRECT_GCLB_XFF_MAX_ELEMENTS = 16


class DirectGCLBClientUnavailable(AuthThrottleUnavailable):
    """A GFE-peered request whose XFF suffix is not the documented shape."""


def direct_gclb_client_ident(request):
    """The client IP on a route the GCLB sends STRAIGHT to Django, else None.

    Most API traffic reaches Django through the nginx sidecar, which hands it
    exactly one normalized ``X-Forwarded-For`` value -- the contract DRF's
    ``NUM_PROXIES = 1`` is set for. A few exact paths do not:
    ``k8s/free2z/ingress.yaml`` routes ``/api/auth/social/mobile/callback``
    (and the Twitter callbacks) to the callback Deployment's gunicorn via a
    container-native NEG, with no nginx in between. There Google's external
    ALB appends ``<client-ip>,<load-balancer-ip>`` to whatever the caller
    sent, so DRF's ``addrs[-1]`` is the LOAD BALANCER's address -- the same
    for every caller. A stock anon throttle on such a route is one GLOBAL
    bucket: anyone who fills it switches the endpoint off for everyone.

    Three cases, by the TCP peer -- the one value nobody can forge:

    * **loopback** -- the nginx sidecar (every nginx ``proxy_pass`` to
      Django is ``localhost``): return None, the caller keeps DRF's normal
      one-hop identity.
    * **one of Google's documented GFE request sources** (the networks
      ``dj.apps.zauth.admission`` pins): the second XFF element from the
      right is the client the GFE saw; every element before it is
      caller-controlled and ignored. An unparseable suffix fails CLOSED
      (503) rather than collapsing callers into a shared key, the same rule
      as ``zcash_client_identity``.
    * **anything else** -- a pod inside the cluster, or a GFE in a range
      Google added after this list was written: the peer address ITSELF.
      Never the XFF suffix, which only a GFE is trusted to write (otherwise
      an in-cluster caller could spend a victim's bucket by naming their IP),
      and never DRF's ``addrs[-1]``, the global bucket this exists to
      prevent. An unlisted GFE degrades to coarse per-GFE buckets, not a
      global one. Both edges were found by successive codex reviews of.
    """
    try:
        peer = ipaddress.ip_address((request.META.get("REMOTE_ADDR") or "").strip())
    except ValueError:
        raise DirectGCLBClientUnavailable()
    if peer.is_loopback:
        return None
    if not any(
        peer.version == network.version and peer in network
        for network in _GCLB_GFE_REQUEST_NETWORKS
    ):
        return str(peer)
    forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR")
    if (
        not isinstance(forwarded_for, str)
        or len(forwarded_for) > DIRECT_GCLB_XFF_MAX_CHARS
        or forwarded_for.count(",") + 1 > DIRECT_GCLB_XFF_MAX_ELEMENTS
    ):
        raise DirectGCLBClientUnavailable()
    elements = forwarded_for.split(",")
    if len(elements) < 2:
        raise DirectGCLBClientUnavailable()
    try:
        client = ipaddress.ip_address(elements[-2].strip())
        ipaddress.ip_address(elements[-1].strip())
    except ValueError as exc:
        raise DirectGCLBClientUnavailable() from exc
    return str(client)


def _per_subscriber_ident(ident):
    """IPv4 as-is; IPv4-mapped IPv6 folded to IPv4; native IPv6 to its /64.

    One subscriber is routinely handed a whole /64 and privacy addressing
    rotates within it, so a per-address IPv6 bucket is a fresh bucket per
    request for anyone who wants one. Same policy as
    ``dj.apps.zauth.admission``. Anything unparseable is returned unchanged.
    """
    try:
        parsed = ipaddress.ip_address((ident or "").strip())
    except ValueError:
        return ident
    if isinstance(parsed, ipaddress.IPv6Address):
        if parsed.ipv4_mapped is not None:
            return str(parsed.ipv4_mapped)
        return ipaddress.ip_network((parsed, 64), strict=False).with_prefixlen
    return str(parsed)


class OAuthCompletionAnonRateThrottle(
    FailClosedAuthThrottleMixin, PublicAnonRateThrottle
):
    """Social OAuth completion: the mobile relay and the knox-issuing POST.

    ``ZuuliMobileOAuthRelayView`` (the provider's redirect back, mobile only)
    and ``SocialLoginView`` (``POST /api/auth/social/{provider}/``, which
    get-or-creates a Creator and issues a knox token).: until this
    class neither had any anonymous limit.

    **Its own scope, not ``anon-oauth-state``**: that bucket is the
    freely-scriptable start, and a drained start bucket must never strand an
    authorization already out at the provider. **Not ``anon-oauth``** either:
    the Twitter v1 request-token there is an unauthenticated POST anyone can
    fire at will. **Not ``anon-login``**: this traffic is paced by a
    provider redirect, not a person, and would raise the sign-in floor
    . The two views share one bucket because they are two legs of one
    sign-in, at most one of each per start -- the ``anon-login`` reasoning.

    A 429 here leaves the sign-in recoverable: DRF throttles before the
    handler, so the single-use ``state`` is not consumed and the same
    provider return can be retried once the window moves.

    Fail-closed like every credential scope: ``SocialLoginView``
    issues a credential, and the relay cannot work without Redis anyway.

    ``get_ident`` understands the relay's direct-from-GCLB route; see
    :func:`direct_gclb_client_ident`. Requests through nginx keep DRF's
    identity. Both are then grouped per IPv6 /64 (:func:`_per_subscriber_ident`)
    so the two legs of one sign-in still land in the same bucket.

    **A request the view will reject without a state lookup is not charged**
    (``view.rejects_without_state_lookup``). The relay shares its callback
    pods -- two sync workers each -- with the Stripe native returns, which
    keep invalid input away from Redis on purpose so a half-open Redis cannot
    pin every worker (``NativeCheckoutReturnRateThrottle``). Charging a
    malformed relay GET would put a Redis round trip in front of a 400 that
    needs none, re-opening exactly that. Found by the codex review of.
    """

    scope = 'anon-oauth-complete'

    def get_ident(self, request):
        return _per_subscriber_ident(
            direct_gclb_client_ident(request) or super().get_ident(request)
        )

    def get_cache_key(self, request, view):
        precheck = getattr(view, 'rejects_without_state_lookup', None)
        if precheck is not None and precheck(request):
            return None
        return super().get_cache_key(request, view)


class OIDCAuthorizeAnonRateThrottle(
    FailClosedAuthThrottleMixin, PublicAnonRateThrottle
):
    """The OIDC consent step: a person in a browser, deciding.

    GET answers from the registry without writing; POST issues a single-use
    authorization code. Both are cheap, but both are credential-adjacent --
    the POST is where a code is minted -- so the counter fails closed like
    every other credential endpoint since.
    """

    scope = 'anon-oidc-authorize'


class OIDCTokenAnonRateThrottle(
    FailClosedAuthThrottleMixin, PublicAnonRateThrottle
):
    """The OIDC token, revocation and introspection endpoints.

    Machine-paced: every signed-in device refreshes a five-minute access
    token, so the rate is sized for a large shared egress rather than for a
    person. Alone in its scope because a 429 here signs nobody out (the SDK
    retries) but sharing it with the consent step would let refresh traffic
    starve sign-in, which is 's shape.
    """

    scope = 'anon-oidc-token'


def _public(anon_throttle):
    """Pair an anon throttle with the user throttle it must never drop.

    Setting ``throttle_classes`` on a view *replaces* ``DEFAULT_THROTTLE_CLASSES``
    rather than adding to it, so listing only the anon class would silently
    exempt every logged-in caller from the global ceiling.
    """
    return [anon_throttle, AuthenticatedUserRateThrottle]


#Background/browser-driven public reads. Generous.
POLLING_THROTTLES = _public(PollingAnonRateThrottle)

#The two operations sharing DyteMeeting's URL have very different traffic
#and cost shapes: generous machine polling for GET, tight paid-provider
#participant creation for anonymous broadcast POSTs.
DYTE_MEETING_THROTTLES = [
    DytePollingAnonRateThrottle,
    BroadcastJoinAnonRateThrottle,
    AuthenticatedUserRateThrottle,
]

#Exported separately so throttle inventory tests can pin the new scope as a
#distinct public budget without duplicating ``anon-poll``.
BROADCAST_JOIN_THROTTLES = _public(BroadcastJoinAnonRateThrottle)

#The sign-in path: /api/start/ AND /api/auth/login/, one shared
#budget. Sized for every authentication attempt from a shared egress, at two
#requests per attempt — not for registrations.
LOGIN_PATH_THROTTLES = _public(LoginPathAnonRateThrottle)

#/api/auth/login/ specifically. Same 'anon-login' bucket, but charged to the
#client address even when the caller is authenticated -- holding a token for
#an account you control must not exempt you from the rate limit on the
#endpoint that checks passwords.
PASSWORD_LOGIN_THROTTLES = _public(PasswordLoginRateThrottle)

#Forgot-password request + consume. Tight; nothing legitimate here bursts.
ACCOUNT_RECOVERY_THROTTLES = _public(AccountRecoveryAnonRateThrottle)

#Email confirm / opt-out landings. Middling.
LINK_LANDING_THROTTLES = _public(LinkLandingAnonRateThrottle)

#Signed native Checkout browser returns. The custom throttle keys every caller
#to the signed owner (including authenticated callers), atomically applies its
#own six/minute ceiling, and owns the private recovery response. Appending the
#global user throttle would let its generic 429 strand an already-paid user
#after the custom throttle had reserved scarce provider capacity.
NATIVE_CHECKOUT_RETURN_THROTTLES = [NativeCheckoutReturnRateThrottle]

#Endpoints that spend a third party's API quota anonymously. Isolated.
THIRD_PARTY_OAUTH_THROTTLES = _public(ThirdPartyOAuthAnonRateThrottle)

#OAuth starts that allocate state in the shared cache. Isolated from every
#callback path so exhausting this bucket cannot block an in-flight login.
OAUTH_STATE_THROTTLES = _public(OAuthStateAnonRateThrottle)
#Social OAuth completion: the mobile relay + the knox-issuing login POST
#. Isolated from the start bucket above, in the other direction.
OAUTH_COMPLETION_THROTTLES = _public(OAuthCompletionAnonRateThrottle)

#The OIDC provider's consent step. Human-paced.
OIDC_AUTHORIZE_THROTTLES = _public(OIDCAuthorizeAnonRateThrottle)

#The OIDC provider's token, revocation and introspection endpoints.
#Machine-paced; isolated from the consent step.
OIDC_TOKEN_THROTTLES = _public(OIDCTokenAnonRateThrottle)

#Stateless Zcash challenge issuance needs a bounded admission brake. The
#first custom throttle atomically charges the authoritative client and parses
#the bounded body. Lazy inherited authentication then runs in the normal user
#throttle; only after it succeeds can the final custom throttle charge a
#validated address. Invalid credentials therefore create no address state.
#There is never a global kill-switch counter, and proxy/cache errors fail
#closed. The normal authenticated-user ceiling remains paired because setting
#this list replaces DRF's defaults.
ZCASH_CHALLENGE_THROTTLES = [
    ZcashChallengeAdmissionThrottle,
    AuthenticatedUserRateThrottle,
    ZcashChallengeAddressAdmissionThrottle,
]

#Zcash login has an independent authoritative-client bucket before database
#claiming and signature recovery. It applies to anonymous login and
#authenticated association; issuance traffic cannot consume it.
ZCASH_LOGIN_THROTTLES = [
    ZcashLoginAdmissionThrottle,
    AuthenticatedUserRateThrottle,
]


class HandleAssertionRateThrottle(AuthenticatedUserRateThrottle):
    """Per-account brake on minting key-transparency handle assertions.

    Not one of the ``_public`` lists above, and it is worth saying why it is
    shaped differently from every other opt-in throttle in this module.

    **It is never keyed on an IP**, and that is inherited rather than restated:
    :class:`AuthenticatedUserRateThrottle` returns ``None`` for an
    unauthenticated caller instead of falling back to the address, which is the
    whole reason that class exists. ``HandleAssertionView`` declares
    ``IsAuthenticated`` and DRF checks permissions before throttles, so the
    anonymous path is unreachable today; the inherited behaviour is what keeps
    it from silently becoming a shared per-IP budget — the  failure — if the
    view's permissions are ever loosened. The missing limit would then show up
    in ``dj/apps/test_throttling.py``'s anon inventory as an unlisted view.

    **It fails OPEN on a cache outage, like everything else on the default
    cache, and that is stated here because the obvious assumption is wrong.**
    An earlier revision of this class claimed to fail closed on the strength of
    subclassing plain ``UserRateThrottle``. It could not: production points the
    default cache at django_redis with ``IGNORE_EXCEPTIONS = True``
    (``prod_settings.py``), so a Redis outage is absorbed *below* this class —
    ``cache.get`` returns an empty history and ``cache.set`` is swallowed —
    and no exception ever reaches a handler here. Subclassing
    ``AuthenticatedUserRateThrottle`` makes the real behaviour explicit and
    keeps the residual non-swallowed cache faults degrading the same way as the
    rest of the API instead of 500ing this endpoint alone.

    What a genuinely fail-closed bucket would take is the shape
    ``StripeCheckoutUserRateThrottle`` uses: **its own cache alias** with
    ``IGNORE_EXCEPTIONS = False``, added to ``prod_settings.py``. That is a
    deployment change, and it is deliberately not made here — during a Redis
    outage the global ``user`` ceiling is open too, so this endpoint would be
    the only throttled thing on the API, and what an authenticated caller can
    then spend is one indexed row read and one Ed25519 signature per request
    with no database write. Revisit it when the endpoint is actually enabled in
    a manifest (it is not today) and the exposure is real rather than notional.
    """

    scope = 'kt-assertion'


#Key-transparency handle assertions (``dj.apps.ktauth``). The dedicated
#bucket first, then the global authenticated ceiling — setting
#``throttle_classes`` on a view REPLACES ``DEFAULT_THROTTLE_CLASSES``, so
#without the second entry this endpoint would be the one place a logged-in
#caller escaped the 'user' ceiling.
HANDLE_ASSERTION_THROTTLES = [
    HandleAssertionRateThrottle,
    AuthenticatedUserRateThrottle,
]


class HandleClaimRateThrottle(AuthenticatedUserRateThrottle):
    """Per-account bucket for ``POST /api/e2ee/handle/claim/``.

    Same shape as:class:`HandleAssertionRateThrottle` and for the same
    reasons: never keyed on an IP (an anonymous caller is refused by
    ``IsAuthenticated`` first, and this class would return ``None`` rather than
    fall back to an address), and it fails open with the rest of the default
    cache. A claim that slips through during a Redis outage is still bound by
    the database: one handle per account, one account per handle.
    """

    scope = 'e2ee-handle-claim'


#Messaging-handle claims (``dj.apps.handles``). Dedicated bucket first, then
#the global authenticated ceiling, for the reason given on
#``HANDLE_ASSERTION_THROTTLES``.
HANDLE_CLAIM_THROTTLES = [
    HandleClaimRateThrottle,
    AuthenticatedUserRateThrottle,
]
