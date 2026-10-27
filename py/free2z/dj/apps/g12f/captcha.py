"""Single-use reCAPTCHA verification for the sign-in path.

Before this module, ``CreatorLoginSerializer`` treated Google's
``timeout-or-duplicate`` error code as a *success*::

    # hack to reuse captcha from create
    error_code = r.json().get('error-codes', ['foobar'])[0]
    recaptcha_success = r.json().get('success') or error_code == 'timeout-or-duplicate'

``timeout-or-duplicate`` is the one answer Google gives for a token that has
already been redeemed **or** has aged out. Accepting it meant one solved
CAPTCHA authorised an unbounded number of ``/api/auth/login/`` attempts,
forever — a token solved last year still worked. That is the credential
stuffing half of.

The replay was not gratuitous, which is why it cannot simply be deleted. Three
live flows present ONE token more than once, and each was checked in the source
rather than assumed:

1. **Sign-up.** ``authStore.signup()`` POSTs ``/api/start/`` (which redeems the
   token at Google) and then POSTs ``/api/auth/login/`` with the SAME token to
   establish the session. Google answers the second call
   ``timeout-or-duplicate``.
2. **MFA.** ``OTPModal.svelte`` re-POSTs login with the same ``captcha_result``
   plus ``otp_token``, once per code the user types, and never re-executes
   reCAPTCHA.
3. **The classic React client**, whose combined button POSTs ``/api/start/``
   first on every authentication attempt and falls through to
   ``/api/auth/login/`` with the same token.

Note what is NOT on that list, because the throttle sizing depends on it and an
earlier draft of this module got it wrong: the **Svelte login** path does not
walk the dance at all. ``UnifiedAuthModal.handleLogin`` calls
``authStore.loginOnly()``, which POSTs ``/api/auth/login/`` directly with a
freshly executed token — ``tests/browser/auth-mfa.spec.ts`` asserts
``/api/start/`` is never requested. ``authStore.login()``, the combined
dance, has no caller in the Svelte app at all. (Caught by the codex
adversarial review of.)

So the property we actually want is not "a token is used once". It is:

    **A solved CAPTCHA authorises a bounded amount of work, for a bounded
    time, and is dead afterwards.**

That is what this module implements, with no client change at all:

* The first ``siteverify`` that returns ``success: true`` for a token opens a
  **grant** in the shared cache, keyed by the token's SHA-256 (never the token
  itself — it is a bearer credential and the cache gets dumped and logged).
* The grant expires ``CAPTCHA_TOKEN_LIFETIME_SECONDS`` after the response's own
  ``challenge_ts``, so retention is Google's documented ~2 minute token
  lifetime rather than a number we invented, and the store cannot grow without
  bound.
* Every subsequent presentation of that token — which Google answers
  ``timeout-or-duplicate`` — is accepted only while the grant is live and only
  until ``CAPTCHA_GRANT_MAX_USES`` presentations have been charged.

An attacker who buys one solve therefore buys at most
``CAPTCHA_GRANT_MAX_USES`` credential guesses inside a ~2 minute window,
instead of unlimited guesses forever.

Fail-open, deliberately, and this is the load-bearing decision
------------------------------------------------------------

The production ``default`` cache sets ``IGNORE_EXCEPTIONS: True``, so a Redis
outage does not raise — ``cache.get()`` returns the default and ``cache.add()``
returns ``None``. A missing grant is therefore indistinguishable from "Redis is
down" on the read alone, and a naive implementation would reject **every**
second leg of the dance during a cache blip. That is not a degraded feature: it
is a total sign-in outage for the whole site. When this module was written,
``prod_settings.py`` allowed the TOTP counter to fail closed *only* because
``/api/auth/login/`` carried no such counter, and this module kept it that
way by not failing closed either.

** moved that assumption on purpose.** The sign-in path's ``anon-login``
throttle now counts in the ``auth_throttle`` cache alias (errors NOT
swallowed) and answers 503 when it cannot count -- so a Redis outage IS now
a password sign-in outage, by the throttle, before this module is reached.
This module still degrades open, and that remains right for the cases the
throttle does not cover: a blip on the ``default`` alias alone (this store)
while the throttle's reads succeed, and a store that answers but has lost
the grant.

Hence:func:`_grant_store_is_live`: before refusing a replay for a missing
grant, write a random value and read it back. A store that cannot return what
it was just given is down, and the request degrades to the pre- behaviour
(accept the duplicate) with a countable log line. A store that answers
correctly proves the absent grant is a genuine replay, and the request is
refused. The decision is made from *observed* behaviour, not inferred from an
exception type that ``IGNORE_EXCEPTIONS`` guarantees will never arrive.

The cost is stated plainly: while this grant store is unreadable the CAPTCHA
is as replayable as it was before this change. The ``anon-login`` throttle is
no longer off at the same time: it fails CLOSED (503) when its own
store is down, so the sign-in path keeps one brake -- or refuses outright --
rather than losing both. (Both aliases point at the same Redis in prod, so a
full Redis outage is a 503 on sign-in, not an open lane.)

Not the whole answer
--------------------

reCAPTCHA is one layer. The other half of  is the per-IP ``anon-login``
throttle now attached to ``/api/auth/login/`` (via
``PasswordLoginRateThrottle``, which unlike a plain ``AnonRateThrottle``
charges an authenticated caller too — otherwise logging in first bypasses it).
Neither stops an attacker who both rotates source addresses and buys a solve
per ten guesses; together they turn "free and unlimited" into "metered and
paid for".

And one more layer is deliberately absent: nothing here is armed until the
grant writer has been live longer than a rolling deploy can last. See
:data:`CAPTCHA_GRANT_MIXED_FLEET_SECONDS` — a defence that fails real sign-ins
on the day it ships does not get to ship.
"""

import hashlib
import json
import logging
import time
import uuid
from datetime import datetime, timedelta, timezone as dt_timezone

import requests
from django.conf import settings
from django.core.cache import cache
from django.utils import timezone

logger = logging.getLogger(__name__)

#Google's documented reCAPTCHA response-token lifetime. A token is valid for
#two minutes from the moment the challenge was served, after which
#``siteverify`` answers ``timeout-or-duplicate`` — the same code it uses for
#an already-redeemed token. Retention here is aligned to that rather than
#chosen: a grant that outlived Google's own token would let a duplicate be
#replayed after Google itself had stopped honouring the original.
#https://developers.google.com/recaptcha/docs/verify
CAPTCHA_TOKEN_LIFETIME_SECONDS = 120

#How many presentations one solved CAPTCHA may authorise.
#
#Counted from the real client flows above, not picked round. The longest is
#sign-up on an MFA account:
#1. ``POST /api/start/``      — redeems the token
#2. ``POST /api/auth/login/`` — establishes the session
#3..N. one more per OTP code the user types (``OTPModal.svelte`` reuses the
#same ``captcha_result`` on every retry and never re-executes reCAPTCHA)
#
#10 leaves 8 OTP retries inside the ~2 minute window for a human fumbling a
#six-digit code, which is generous, while capping an attacker at 10 password
#guesses per purchased solve. Lowering it below 3 would break MFA sign-in;
#raising it is a linear discount to a credential-stuffing operator.
CAPTCHA_GRANT_MAX_USES = 10

#Cloud Logging ``jsonPayload.event`` for the degraded mode. Stable string:
#a log-based metric can count it, and a captcha grant store that has been
#down for a week is invisible by construction otherwise — nothing 429s,
#nothing 500s, sign-in keeps working, and the replay defence is simply off.
CAPTCHA_GRANT_FAIL_OPEN_EVENT = "captcha_grant_fail_open"

#Cloud Logging ``jsonPayload.event`` for the one-time arming window below.
#Distinct from the fail-open event on purpose: one means "the cache is
#broken", the other means "the fleet is still mixed", and conflating them
#would make the first alert fire on every deploy of this feature.
CAPTCHA_GRANT_ARMING_EVENT = "captcha_grant_not_yet_armed"

#How long after the grant writer first appears before refusals begin.
#
#THE ROLLING-DEPLOY HAZARD THIS EXISTS FOR (codex adversarial review of
#). Prod runs 5 replicas with ``maxSurge: 50%`` and **no** session
#affinity, so during the deploy that introduces this feature an OLD pod can
#serve ``POST /api/start/`` -- redeeming the token at Google and writing no
#grant -- while a NEW pod serves the ``POST /api/auth/login/`` that follows.
#Redis is perfectly healthy, the probe passes, no grant exists, and a user
#with correct credentials is told "Invalid captcha". Every health check stays
#green throughout. Signup-then-login and the MFA second leg are the two flows
#that cross pods; CI only ever runs a homogeneous tree and cannot see this.
#
#The number is derived, not guessed: ``k8s/free2z/deployment.yaml`` sets
#``terminationGracePeriodSeconds: 600``, so a single draining old pod can
#legitimately keep serving for 10 minutes, and a 5-replica rollout drains in
#more than one batch. 1200s of draining + the 120s token lifetime is ~22
#minutes; 1800 leaves margin. If that grace period grows, this must grow
#with it.
#
#WHY THIS IS NOT A PER-DEPLOY HOLE. The stamp lives in the SHARED store with
#no expiry and is written once, by whichever new pod first serves a captcha.
#So the window opens exactly once -- for the deploy that introduces the
#feature -- and every later deploy finds a stamp from long ago and enforces
#continuously. A per-process warm-up would instead have re-opened the hole on
#every deploy and every pod restart, several times a day, forever.
#
#RESIDUAL, AND THE RUNBOOK LINE FOR IT. Rolling BACK to a pre- revision
#more than 30 minutes after this ships re-creates the mixed fleet with
#enforcement already armed, and correct logins then fail intermittently for
#the length of the rollback (up to two 600s drains). The automatic
#``prod-healthcheck`` rollback fires within minutes of a deploy, i.e. inside
#the window, so this is the *manual* late-rollback case only.
#
#Raising ``CAPTCHA_GRANT_MIXED_FLEET_SECONDS`` does NOT fix it and it is
#worth being exact about why: the pods still running this code already read
#the old value from their own environment, and the pre- pods replacing
#them do not read it at all. The operation that works is deleting the stamp
#from the shared store before the rollback, which re-opens exactly one
#window and disarms every enforcing pod at once. Use Django, so the key
#cannot be hand-derived wrongly::
#
#kubectl -n prod exec deploy/free2z -c free2z-gunicorn -- \
#python dj/free2z/manage.py shell -c \
#'from django.core.cache import cache; \
#from dj.apps.g12f.captcha import _enforcement_stamp_key; \
#print(cache.delete(_enforcement_stamp_key()))'
#
#If you must reach Redis directly, the WIRE key is not the logical one and
#an earlier draft of this comment got it wrong (codex adversarial review,
#round 3). Django's ``default_key_func`` is ``"%s:%s:%s" % (key_prefix,
#version, key)``; the prod cache sets ``OPTIONS["PREFIX"]``, which
#django-redis IGNORES (it is not the top-level ``KEY_PREFIX``), so the
#prefix is EMPTY and the version segment is ``1``::
#
#DEL:1:captcha-grant:<DBNAME>:writer-since
#
#Note ``<DBNAME>`` appears once, from:func:`_namespace`, not twice.
#``test_the_documented_rollback_key_is_the_key_redis_actually_holds`` pins
#that string against ``cache.make_key`` so this cannot drift into being
#wrong again -- a runbook line that deletes nothing is worse than none,
#because it is run at 3am and believed.
#
#Losing the stamp to a Redis eviction or flush has the same effect as the
#delete, which is the safe direction.
CAPTCHA_GRANT_MIXED_FLEET_SECONDS = 1800

#Google's error code for "already redeemed, or expired". One code, two
#meanings; the grant record is what tells them apart.
DUPLICATE_ERROR_CODE = "timeout-or-duplicate"

_GRANT_KEY_PREFIX = "captcha-grant"
_PROBE_KEY_PREFIX = "captcha-grant-probe"


def _namespace():
    """The operator-selected database environment, as a cache-key component.

    Stage, test and production share Redis database 1 on purpose, and
    django-redis's ``OPTIONS["PREFIX"]`` is not its top-level ``KEY_PREFIX``,
    so it isolates nothing -- ``NATIVE_RETURN_ADMISSION_NAMESPACE`` in
    settings.py exists for the same reason and says so. Every key this module
    writes therefore carries the environment itself.
    """
    return getattr(settings, "CAPTCHA_GRANT_NAMESPACE", "free2z")


def _enforcement_stamp_key():
    """Key for the arming clock. Namespaced, and that is not cosmetic.

    This key has NO expiry by design. Sharing it across environments would let
    one stage CAPTCHA arm production days before  ever deployed there, so
    production would refuse duplicates from the first second of its own rolling
    deploy -- exactly the mixed-fleet failure the window exists to prevent
   .
    """
    return f"captcha-grant:{_namespace()}:writer-since"


def _grant_key(token):
    """Cache key for ``token``, which is never itself written anywhere.

    A reCAPTCHA response token is a bearer credential for the remainder of its
    two-minute life. Redis is dumped, replicated and inspected; hashing means a
    reader of the store cannot replay what they find in it.

    ``str()`` rather than ``token.encode`` because ``SignUpView`` reads
    ``captcha_result`` straight off ``request.data`` with no serializer, so a
    client can send a list or a number there. That can only reach this function
    if Google somehow answered ``success`` for it, but a 500 on the sign-in path
    is not the way to find out.
    """
    digest = hashlib.sha256(str(token).encode("utf-8")).hexdigest()
    return f"{_GRANT_KEY_PREFIX}:{_namespace()}:{digest}"


def _grant_ttl(payload, now=None):
    """Seconds of life left in the token, from Google's own ``challenge_ts``.

    Clamped into ``[1, CAPTCHA_TOKEN_LIFETIME_SECONDS]``:

    * The upper clamp matters because ``challenge_ts`` arrives from a remote
      party and our clock may lag Google's. Without it a future-dated (or
      simply skewed) timestamp would mint a grant that outlives the token.
    * The lower clamp only exists so a non-positive timeout — which Django
      reads as "expire immediately", i.e. no grant at all — cannot silently
      turn the very next leg of the dance into a rejected sign-in.

    A missing or unparseable ``challenge_ts`` falls back to the full lifetime.
    That is the pessimistic direction for retention and the safe one for
    availability, and it is what a stubbed/self-hosted verifier returns.
    """
    now = now or timezone.now()
    remaining = CAPTCHA_TOKEN_LIFETIME_SECONDS
    challenge_ts = payload.get("challenge_ts")
    if isinstance(challenge_ts, str) and challenge_ts:
        try:
            challenge = datetime.fromisoformat(
                challenge_ts.replace("Z", "+00:00")
            )
        except ValueError:
            challenge = None
        if challenge is not None:
            if challenge.tzinfo is None:
                challenge = challenge.replace(tzinfo=dt_timezone.utc)
            elapsed = (now - challenge) / timedelta(seconds=1)
            remaining = CAPTCHA_TOKEN_LIFETIME_SECONDS - elapsed
    return max(1, min(CAPTCHA_TOKEN_LIFETIME_SECONDS, int(remaining)))


def _grant_store_is_live():
    """Did the cache just return the exact value we just gave it?

    This is the whole reason the module can refuse a replay without risking a
    site-wide sign-in outage. ``IGNORE_EXCEPTIONS: True`` on the production
    cache converts a Redis fault into a silent ``None``, so "no grant found"
    and "the store is down" look identical on a read. A write followed by a
    read-back of a value nobody else has ever seen distinguishes them from
    observed behaviour.

    Returns ``False`` for any failure, including an exception the backend did
    not swallow, and for a ``DummyCache``-shaped backend that accepts writes
    and returns nothing — which genuinely cannot enforce single use.
    """
    key = f"{_PROBE_KEY_PREFIX}:{_namespace()}:{uuid.uuid4().hex}"
    sentinel = uuid.uuid4().hex
    try:
        cache.set(key, sentinel, timeout=10)
        observed = cache.get(key)
    except Exception:
        logger.warning("captcha grant store probe failed", exc_info=True)
        return False
    try:
        cache.delete(key)
    except Exception:
        # Cleanup is best effort; the 10s timeout collects it either way.
        logger.warning("captcha grant probe cleanup failed", exc_info=True)
    return observed == sentinel


def _mixed_fleet_window():
    """Seconds the arming window lasts. Overridable so tests can pin both sides.

    Read through ``settings`` rather than used as a bare constant because the
    steady state (armed) and the rollout state (not armed) are two different
    behaviours and both need a test. Production leaves it unset and gets
    :data:`CAPTCHA_GRANT_MIXED_FLEET_SECONDS`.
    """
    return getattr(
        settings,
        "CAPTCHA_GRANT_MIXED_FLEET_SECONDS",
        CAPTCHA_GRANT_MIXED_FLEET_SECONDS,
    )


def stamp_enforcement_clock(now=None):
    """Record, once and forever, when a grant-writing pod first served traffic.

    ``cache.add`` so the first writer wins: every later pod, and every later
    deploy, leaves the original instant alone. ``timeout=None`` is Django's
    "never expire" -- the whole point is that this outlives the rollout it is
    measuring, and outlives every rollout after it.

    Wall clock, deliberately, not ``monotonic()``: this value is compared
    across processes and pods, which have no shared monotonic origin. GKE nodes
    are NTP-synced and the comparison is against half an hour, so second-level
    skew is irrelevant. A clock that jumps BACKWARD makes the window look
    unexpired, which disarms enforcement -- the safe direction.
    """
    try:
        cache.add(_enforcement_stamp_key(), now or time.time(), timeout=None)
    except Exception:
        # Best effort. A store that cannot hold the stamp cannot hold grants
        # either, and consume_grant's probe is what handles that.
        logger.warning("captcha grant enforcement stamp failed", exc_info=True)


def _enforcement_is_armed():
    """May a missing grant be treated as proof of a replay yet?

    ``False`` while the fleet may still contain pods that redeem CAPTCHAs
    without writing grants -- see
    :data:`CAPTCHA_GRANT_MIXED_FLEET_SECONDS` for the full hazard. Also
    ``False`` for any unreadable or nonsense stamp, because refusing a real
    user's correct password is a worse outcome than accepting a replay.
    """
    now = time.time()
    stamp_enforcement_clock(now)
    try:
        stamped = cache.get(_enforcement_stamp_key())
    except Exception:
        logger.warning("captcha grant enforcement stamp unreadable",
                       exc_info=True)
        return False
    if not isinstance(stamped, (int, float)) or isinstance(stamped, bool):
        return False
    return (now - stamped) >= _mixed_fleet_window()


def _log_fail_open(reason, exc=None):
    """One countable JSON line per degraded verification.

    ``json.dumps`` on a single line so Cloud Logging lifts it into
    ``jsonPayload``; nothing caller-controlled is interpolated, so there is
    nothing to escape beyond what dumps already handles.
    """
    logger.warning(json.dumps(
        {
            "severity": "WARNING",
            "message": (
                "reCAPTCHA replay protection is NOT in effect for this "
                f"request: {reason}. A duplicate token was accepted."
            ),
            "event": CAPTCHA_GRANT_FAIL_OPEN_EVENT,
            "reason": reason,
            "error_type": type(exc).__name__ if exc is not None else None,
        },
        separators=(",", ":"),
    ))


def open_grant(token, payload):
    """Record the first successful verification of ``token``.

    Called on the ``success: true`` branch by *both* captcha-protected
    endpoints, because either can be the first leg of the dance:
    ``/api/start/`` is first for the combined sign-in button, and
    ``/api/auth/login/`` is first for the dedicated login form.

    Returns ``True`` when this request may proceed. It refuses only in the one
    case that is unambiguously abuse: Google said ``success`` for a token whose
    grant is already exhausted. Google does not answer ``success`` twice for
    one token, so that path is defence in depth rather than a live flow.

    A cache failure here is not fatal and is deliberately NOT probed: the
    request already holds a genuinely fresh, Google-verified token, so there is
    no security decision to make and nothing to disclose as degraded. The only
    consequence is that the *next* leg finds no grant, and that leg does its own
    liveness probe.
    """
    # Start the arming clock at the earliest evidence that a grant-writing
    # pod is serving traffic, not at the first rejection: the window has to
    # cover the whole rollout, and it should start when the rollout starts.
    stamp_enforcement_clock()
    key = _grant_key(token)
    ttl = _grant_ttl(payload)
    try:
        if cache.add(key, 1, timeout=ttl):
            return True
        # add() was falsy. Either the key already exists -- a token Google
        # verified twice, which it does not do -- or the store is down and
        # swallowed the write. Charge a use so a live store still enforces the
        # budget, and allow anything a dead store cannot answer: this token is
        # fresh, and refusing it would turn a cache blip into a failed sign-in.
        uses = cache.incr(key)
    except Exception:
        logger.warning("captcha grant store unavailable on open", exc_info=True)
        return True
    if uses is None:
        return True
    return int(uses) <= CAPTCHA_GRANT_MAX_USES


def _refuse_or_wait_for_arming():
    """The reject decision, gated on the mixed-fleet window.

    The store is live and there is no grant. In the steady state that is a
    replay and the answer is no. During the deploy that introduces this
    feature it is just as likely to be a token an OLD pod redeemed, and
    refusing it fails a real sign-in -- so until the window has elapsed the
    request is allowed and the event is counted.
    """
    if _enforcement_is_armed():
        return False
    logger.warning(json.dumps(
        {
            "severity": "WARNING",
            "message": (
                "reCAPTCHA replay protection is not armed yet: a grant-writing "
                "pod has not been serving long enough to rule out a mixed "
                "fleet. A duplicate token was accepted."
            ),
            "event": CAPTCHA_GRANT_ARMING_EVENT,
        },
        separators=(",", ":"),
    ))
    return True


def consume_grant(token):
    """Charge one use against a live grant for ``token``.

    Returns ``True`` when the replay is authorised: a grant exists and its
    budget is not spent, or the grant store could not answer (see the
    module docstring for why that degrades open rather than closed).
    """
    key = _grant_key(token)
    try:
        uses = cache.incr(key)
    except ValueError:
        # django's cache contract: incr() on a missing key raises ValueError.
        # Missing means either "never granted / already expired" (reject) or
        # "the store is down and swallowed everything" (degrade). Only an
        # observation can tell those apart.
        if _grant_store_is_live():
            return _refuse_or_wait_for_arming()
        _log_fail_open("grant store did not return its own probe value")
        return True
    except Exception as exc:
        logger.warning("captcha grant store unavailable", exc_info=True)
        _log_fail_open("grant store raised", exc)
        return True
    if uses is None:
        # django_redis with IGNORE_EXCEPTIONS swallows the error and returns
        # None rather than raising. Same ambiguity, same resolution.
        if _grant_store_is_live():
            return _refuse_or_wait_for_arming()
        _log_fail_open("grant store returned no value for incr")
        return True
    return int(uses) <= CAPTCHA_GRANT_MAX_USES


#What the user is told when siteverify could not be asked. Contains
#"reCAPTCHA" on purpose: both front ends classify an auth failure as a
#captcha failure by regex on the message (``isCaptchaError`` in
#``lib/stores/auth.ts``) and tell the user to try again -- which is exactly
#right, because the next attempt re-executes reCAPTCHA and re-asks Google.
CAPTCHA_UNAVAILABLE_MESSAGE = (
    "reCAPTCHA verification is temporarily unavailable. Please try again."
)


class CaptchaUnavailable(Exception):
    """siteverify did not give us an answer we can decide on.

    Raised for a connect/read timeout, a connection failure, or a body that is
    not JSON (Google's own 5xx pages are HTML). Callers FAIL CLOSED on it: an
    unverifiable captcha is a refused one. It is a distinct type, rather than
    a ``False`` from:func:`verify_captcha_response`, so the caller can answer
    503 ("try again") instead of blaming the user's solve.
    """


def siteverify(token):
    """POST ``token`` to Google's siteverify and return the decoded body.

    Bounded by ``settings.RECAPTCHA_SITEVERIFY_TIMEOUT`` -- a (connect, read)
    pair. Before  this call had no timeout at all, and each prod pod runs
    a single sync gunicorn worker, so one slow or black-holed answer
    from Google held every request that pod would otherwise have served.

    Raises:class:`CaptchaUnavailable` on anything that is not a decodable
    answer. The token is never logged: it is a bearer credential until it
    expires.
    """
    try:
        response = requests.post(
            settings.RECAPTCHA_SITEVERIFY_URL,
            data={
                'secret': settings.RECAPTCHA_SECRET_KEY,
                'response': token,
            },
            timeout=settings.RECAPTCHA_SITEVERIFY_TIMEOUT,
        )
        return response.json()
    except (requests.RequestException, ValueError) as exc:
        # requests' JSONDecodeError is both a RequestException and a
        # ValueError; ValueError also covers a stub or older requests.
        logger.warning(
            "captcha_siteverify_unavailable: %s", type(exc).__name__,
        )
        raise CaptchaUnavailable(type(exc).__name__) from exc


def verify_captcha_response(payload, token, *, allow_replay):
    """Decide whether ``payload`` from ``siteverify`` authorises this request.

    :param payload: the decoded JSON body of Google's ``siteverify`` response.
    :param token: the ``captcha_result`` the client presented.
    :param allow_replay: whether this endpoint participates in the multi-leg
        dance. ``/api/auth/login/`` does (it is legs 2..N).
        ``/api/start/`` does not — it is always leg 1, so a duplicate there is
        never a legitimate client and is refused outright, exactly as it was
        before.

    Returns a plain bool. Callers own their own error shape (``SignUpView``
    answers 406, the login serializer raises ``ValidationError``), so this
    deliberately raises nothing.
    """
    if not isinstance(payload, dict):
        return False
    if payload.get("success"):
        return open_grant(token, payload)
    if not allow_replay:
        return False
    error_codes = payload.get("error-codes") or []
    if not isinstance(error_codes, (list, tuple)):
        return False
    if DUPLICATE_ERROR_CODE not in error_codes:
        # Anything else — bad secret, malformed token, missing input — was
        # never a valid solve and must not reach the grant store. Note this
        # checks membership rather than `error_codes[0]`: Google may return
        # several codes and the pre- code only ever inspected the first.
        return False
    return consume_grant(token)
