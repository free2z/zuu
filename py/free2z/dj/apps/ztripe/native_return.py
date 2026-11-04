"""Secure, migration-free state for native Stripe Checkout returns.

Stripe always returns to an HTTPS endpoint on our dedicated return origin. That
endpoint validates a signed, time-limited bridge token and emits a bounded,
signed app claim without mutating state from GET.  The authenticated ZUULI
claim is user-bound and intentionally bounded-but-repeatable: a response lost
during a pod restart can be retried safely because claiming never credits
money.  A separate signed status token lets the app wait for the verified
webhook without ever treating the browser redirect as fulfillment.

The HTTPS success landing performs a bounded Stripe lookup. Production admits
that work through one atomic fixed-window Redis counter. Local tests use a
locked LocMemCache; DummyCache and unknown non-atomic implementations fail
closed.
"""

from __future__ import annotations

import hashlib
import http.client
import logging
import os
import re
import secrets
import signal
import ssl
import threading
import time
from contextlib import contextmanager

from django.conf import settings
from django.core import signing
from django.core.cache import cache, caches
from django.core.cache.backends.dummy import DummyCache
from django.core.cache.backends.locmem import LocMemCache

logger = logging.getLogger(__name__)

APP_RETURN_URI = "cash.free2z.zuuli://checkout/return"
BRIDGE_MAX_AGE_SECONDS = 24 * 60 * 60
APP_CLAIM_MAX_AGE_SECONDS = 10 * 60
STATUS_MAX_AGE_SECONDS = 3 * 24 * 60 * 60

_BRIDGE_SALT = "free2z.stripe.native-return.bridge.v1"
_APP_CLAIM_SALT = "free2z.stripe.native-return.app-claim.v1"
_STATUS_SALT = "free2z.stripe.native-return.status.v1"
_NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{32}$")
_DIGEST_RE = re.compile(r"^[a-f0-9]{64}$")
_PAYMENT_INTENT_RE = re.compile(r"^pi_[A-Za-z0-9]{8,255}$")
_CHECKOUT_SESSION_RE = re.compile(r"^cs_(?:test_|live_)?[A-Za-z0-9]{8,255}$")
_PROVIDER_LEASE_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
_SESSION_DIGEST_RE = re.compile(r"^[a-f0-9]{64}$")
_local_lock = threading.Lock()
_LOCAL_ADMISSION_LOCK_PATH = "/tmp/free2z-native-return-admission.lock"
_NATIVE_ADMISSION_PREFIX = "stripe-native-return:admission:"
_NATIVE_STATUS_PREFIX = "stripe-native-return:status:"
_NATIVE_ADMISSION_SCRIPT = """
local redis_time = redis.call('TIME')
local now = tonumber(redis_time[1])
local now_ms = now * 1000 + math.floor(tonumber(redis_time[2]) / 1000)
local window = tonumber(ARGV[1])
local window_end = now - (now % window) + window
local count = redis.call('GET', KEYS[1])
if count and tonumber(count) >= tonumber(ARGV[2]) then
  return {0, window_end - now, ''}
end

count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIREAT', KEYS[1], window_end)
end

if ARGV[3] == '1' then
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now_ms)
  if tonumber(redis.call('ZCARD', KEYS[2])) >= tonumber(ARGV[4]) then
    local earliest = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
    return {0, math.max(1, math.ceil((tonumber(earliest[2]) - now_ms) / 1000)), ''}
  end
end
if ARGV[3] == '1' then
  local lease_ms = tonumber(ARGV[5]) * 1000
  redis.call('ZADD', KEYS[2], now_ms + lease_ms, ARGV[6])
  redis.call('PEXPIRE', KEYS[2], lease_ms + 1000)
end
return {1, window_end - now, ARGV[3] == '1' and ARGV[6] or ''}
"""


class NativeReturnUnavailable(RuntimeError):
    """The atomic admission store cannot safely complete an operation."""


class NativeReturnUserMismatch(ValueError):
    """A valid app claim belongs to a different authenticated user."""


class NativeReturnStripeDeadlineExceeded(TimeoutError):
    """The Stripe lookup exceeded its total wall-clock budget."""


class NativeReturnRedisDeadlineExceeded(NativeReturnUnavailable):
    """The admission-store operation exceeded its total wall-clock budget."""


NATIVE_RETURN_REDIS_DEADLINE_SECONDS = 2
NATIVE_RETURN_ENDPOINT_DEADLINE_SECONDS = 2


@contextmanager
def _native_return_operation_deadline(
    seconds: float,
    *,
    timeout_error: type[Exception],
    operation: str,
):
    """Hard-bound a synchronous dependency call in a Gunicorn worker.

    Socket timeouts are inactivity bounds and a dependency client may retry.
    Production's sync Gunicorn handlers run on the process main thread, where
    ITIMER_REAL also stops a response that dribbles bytes or retries forever.
    If another process alarm owns that mechanism, fail closed instead of
    silently dropping the bound.
    """
    supported = (
        threading.current_thread() is threading.main_thread()
        and hasattr(signal, "SIGALRM")
        and hasattr(signal, "ITIMER_REAL")
        and hasattr(signal, "setitimer")
        and hasattr(signal, "getitimer")
    )
    if not supported:
        raise NativeReturnUnavailable(
            f"{operation} wall-clock deadline is unavailable"
        )
    previous_handler = signal.getsignal(signal.SIGALRM)
    previous_timer = signal.getitimer(signal.ITIMER_REAL)
    if previous_handler != signal.SIG_DFL or previous_timer[0] > 0:
        raise NativeReturnUnavailable(
            f"{operation} wall-clock deadline is already owned"
        )

    def deadline_exceeded(_signum, _frame):
        raise timeout_error(
            f"{operation} exceeded its wall-clock deadline"
        )

    signal.signal(signal.SIGALRM, deadline_exceeded)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)


@contextmanager
def native_return_stripe_deadline(seconds: float):
    """Hard-bound the synchronous Stripe lookup."""
    with _native_return_operation_deadline(
        seconds,
        timeout_error=NativeReturnStripeDeadlineExceeded,
        operation="Stripe native-return lookup",
    ):
        yield


@contextmanager
def native_return_redis_deadline(seconds: float | None = None):
    """Hard-bound one admission-store operation, including client retries."""
    if seconds is None:
        seconds = NATIVE_RETURN_REDIS_DEADLINE_SECONDS
    with _native_return_operation_deadline(
        seconds,
        timeout_error=NativeReturnRedisDeadlineExceeded,
        operation="native-return Redis operation",
    ):
        yield


@contextmanager
def native_return_local_admission_slot():
    """Let at most one callback worker per pod wait on Redis.

    The callback Deployment deliberately has two synchronous workers per pod.
    A half-open Redis must not let replay traffic occupy both of them and then
    make the load balancer's health check queue behind the same dependency.
    This non-blocking file lock is pod-local, survives Gunicorn forks without
    relying on ``--preload``, and is released by the kernel on worker exit.
    """
    import fcntl

    flags = os.O_CREAT | os.O_RDWR
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(_LOCAL_ADMISSION_LOCK_PATH, flags, 0o600)
    except OSError as exc:
        raise NativeReturnUnavailable(
            "native return local admission slot is unavailable"
        ) from exc
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise NativeReturnUnavailable(
                "native return local admission slot is busy"
            ) from exc
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def ensure_native_return_endpoint_ready(origin_parts) -> None:
    """Prove the deployed TLS/catch-all boundary before creating Checkout.

    Static settings validation cannot prove DNS, certificate readiness, or the
    manually applied GCE Ingress. A payable mobile Session is therefore issued
    only after the exact dedicated host answers its private sentinel path over
    verified TLS through the isolated callback backend. Local development has
    no GCLB boundary and is intentionally exempt.
    """
    hostname = origin_parts.hostname.lower()
    if hostname in {"localhost", "127.0.0.1", "::1", "testserver"}:
        return
    connection = None
    try:
        with _native_return_operation_deadline(
            NATIVE_RETURN_ENDPOINT_DEADLINE_SECONDS,
            timeout_error=NativeReturnUnavailable,
            operation="native-return endpoint readiness probe",
        ):
            connection = http.client.HTTPSConnection(
                hostname,
                port=443,
                timeout=NATIVE_RETURN_ENDPOINT_DEADLINE_SECONDS,
                context=ssl.create_default_context(),
            )
            connection.request(
                "GET",
                "/.well-known/free2z-native-return-readiness",
                headers={"Accept": "text/html"},
            )
            response = connection.getresponse()
            # Drain only this small private-404 body so the connection closes
            # deterministically; a misrouted large response fails closed.
            body = response.read(4097)
            if (
                response.status != 404
                or len(body) > 4096
                or response.getheader("X-Free2Z-Callback-Backend") != "isolated"
                or "no-store" not in (
                    response.getheader("Cache-Control") or ""
                ).lower()
                or (response.getheader("Referrer-Policy") or "").lower()
                != "no-referrer"
            ):
                raise NativeReturnUnavailable(
                    "native return endpoint did not prove its isolated boundary"
                )
    except NativeReturnUnavailable:
        raise
    except Exception as exc:
        raise NativeReturnUnavailable(
            "native return endpoint is unavailable"
        ) from exc
    finally:
        if connection is not None:
            connection.close()


def bridge_token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def checkout_session_digest(session_id: str) -> str:
    if not valid_checkout_session_id(session_id):
        raise ValueError("invalid Stripe Checkout Session")
    return hashlib.sha256(session_id.encode("ascii")).hexdigest()


def _shared_redis_client():
    backend = caches["default"]
    if isinstance(backend, DummyCache):
        raise NativeReturnUnavailable("native return admission cache is disabled")
    if isinstance(backend, LocMemCache):
        return None
    try:
        return cache.client.get_client(write=True)
    except Exception as exc:
        raise NativeReturnUnavailable(
            "native return admission cache is not an atomic Redis backend"
        ) from exc


def make_bridge_token(user_id: int, purpose: str) -> str:
    if purpose not in {"success", "cancel"}:
        raise ValueError("invalid native return purpose")
    return signing.dumps(
        {
            "v": 2,
            "uid": user_id,
            "purpose": purpose,
            "nonce": secrets.token_urlsafe(24),
        },
        salt=_BRIDGE_SALT,
        compress=False,
    )


def read_bridge_token(token: str, purpose: str) -> dict | None:
    if not isinstance(token, str) or len(token) > 1024:
        return None
    try:
        payload = signing.loads(
            token,
            salt=_BRIDGE_SALT,
            max_age=BRIDGE_MAX_AGE_SECONDS,
        )
    except signing.BadSignature:
        return None
    if (
        not isinstance(payload, dict)
        or payload.get("v") not in {1, 2}
        or payload.get("purpose") != purpose
        or not isinstance(payload.get("uid"), int)
        or payload["uid"] < 1
        or not isinstance(payload.get("nonce"), str)
        or not _NONCE_RE.fullmatch(payload["nonce"])
    ):
        return None
    return payload


def make_app_claim_token(bridge_token: str, payload: dict) -> str:
    """Create a bounded claim without mutating state from the HTTPS GET."""
    return signing.dumps(
        {**payload, "bridge_digest": bridge_token_digest(bridge_token)},
        salt=_APP_CLAIM_SALT,
        compress=True,
    )


def _read_app_claim_token(token: str) -> dict | None:
    if not isinstance(token, str) or len(token) > 2048:
        return None
    try:
        payload = signing.loads(
            token,
            salt=_APP_CLAIM_SALT,
            max_age=APP_CLAIM_MAX_AGE_SECONDS,
        )
    except signing.BadSignature:
        return None
    if (
        not isinstance(payload, dict)
        or payload.get("v") != 1
        or not isinstance(payload.get("uid"), int)
        or payload["uid"] < 1
        or payload.get("outcome") not in {"success", "cancel", "processing"}
        or not isinstance(payload.get("bridge_digest"), str)
        or not _DIGEST_RE.fullmatch(payload["bridge_digest"])
    ):
        return None
    if payload["outcome"] == "success" and (
        not valid_checkout_session_id(payload.get("session_id"))
        or not valid_payment_intent_id(payload.get("payment_intent"))
    ):
        return None
    if payload["outcome"] == "processing":
        allowed = {"v", "uid", "outcome", "bridge_digest"}
        if "session_digest" in payload:
            allowed.add("session_digest")
            if (
                not isinstance(payload["session_digest"], str)
                or not _SESSION_DIGEST_RE.fullmatch(payload["session_digest"])
            ):
                return None
        if set(payload) != allowed:
            # A processing claim may carry only a one-way correlation digest.
            # It still asserts no provider status, payment, or credit.
            return None
    return payload


def read_app_claim(token: str, user_id: int) -> dict | None:
    """Validate a bounded claim for its authenticated user.

    Repeating this read within the claim's ten-minute signed lifetime is safe:
    it neither queries Stripe nor writes money. Keeping it retryable avoids the
    irrecoverable SET-NX acknowledgement window of a one-time marker.
    """
    payload = _read_app_claim_token(token)
    if payload is None:
        return None
    if payload["uid"] != user_id:
        raise NativeReturnUserMismatch
    return payload


def _admission_namespace_digest() -> str:
    namespace = getattr(settings, "NATIVE_RETURN_ADMISSION_NAMESPACE", None)
    if not isinstance(namespace, str) or not namespace:
        raise NativeReturnUnavailable("native return admission is misconfigured")
    return hashlib.sha256(
        namespace.encode("utf-8", errors="surrogatepass")
    ).hexdigest()


def _admission_key(identity: str) -> str:
    namespace_digest = _admission_namespace_digest()
    digest = hashlib.sha256(
        identity.encode("utf-8", errors="surrogatepass")
    ).hexdigest()
    return f"{_NATIVE_ADMISSION_PREFIX}{namespace_digest}:owner:{digest}"


def _provider_slots_key() -> str:
    return (
        f"{_NATIVE_ADMISSION_PREFIX}{_admission_namespace_digest()}"
        ":provider-slots"
    )


def _fixed_window_retry(window_seconds: int) -> int:
    now = int(time.time())
    return max(1, window_seconds - (now % window_seconds))


def ensure_native_return_admission_ready() -> None:
    """Fail closed unless the configured admission store is reachable now."""
    backend = caches["default"]
    if isinstance(backend, DummyCache):
        raise NativeReturnUnavailable("native return admission cache is disabled")
    if isinstance(backend, LocMemCache):
        if getattr(settings, "NATIVE_RETURN_ALLOW_LOCAL_CACHE", False):
            return
        raise NativeReturnUnavailable(
            "native return admission requires shared Redis"
        )
    try:
        with native_return_redis_deadline():
            client = _shared_redis_client()
            if client is None or client.ping() is not True:
                raise NativeReturnUnavailable(
                    "native return admission Redis did not answer"
                )
    except NativeReturnUnavailable:
        raise
    except Exception as exc:
        raise NativeReturnUnavailable(
            "native return admission Redis is unavailable"
        ) from exc


def admit_native_return(
    identity: str,
    *,
    window_seconds: int,
    limit: int,
    reserve_provider_slot: bool = False,
    provider_slots: int = 1,
    provider_lease_seconds: int = 8,
) -> tuple[bool, int, str | None]:
    """Atomically admit one return and, for success, one provider slot.

    The signed-owner/IP identity is hashed before it reaches Redis. Production
    requires django-redis; DEBUG-only LocMem execution is serialized so tests
    exercise the same fixed-window semantics without claiming cross-process
    safety. Provider slots outlive the six-second hard lookup deadline by two
    seconds as crash recovery, but a live request releases its unique lease as
    soon as the bounded lookup finishes. Production admits at most one active
    Stripe lookup, preserving a worker with only one two-worker replica healthy.
    """
    if (
        not isinstance(identity, str)
        or not identity
        or not isinstance(window_seconds, int)
        or isinstance(window_seconds, bool)
        or window_seconds < 1
        or not isinstance(limit, int)
        or isinstance(limit, bool)
        or limit < 1
        or not isinstance(reserve_provider_slot, bool)
        or not isinstance(provider_slots, int)
        or isinstance(provider_slots, bool)
        or provider_slots < 1
        or not isinstance(provider_lease_seconds, int)
        or isinstance(provider_lease_seconds, bool)
        or provider_lease_seconds < 1
    ):
        raise NativeReturnUnavailable("native return admission is misconfigured")
    key = _admission_key(identity)
    provider_key = _provider_slots_key()
    backend = caches["default"]
    if isinstance(backend, DummyCache):
        raise NativeReturnUnavailable("native return admission cache is disabled")
    if isinstance(backend, LocMemCache):
        if not getattr(settings, "NATIVE_RETURN_ALLOW_LOCAL_CACHE", False):
            raise NativeReturnUnavailable(
                "native return admission requires shared Redis"
            )
        retry_seconds = _fixed_window_retry(window_seconds)
        try:
            with _local_lock:
                count = int(cache.get(key, 0))
                if count >= limit:
                    return False, retry_seconds, None
                # A globally saturated provider budget still consumes this
                # owner's attempt. Otherwise callers can spin on the shared
                # budget without ever reaching their own fixed-window limit.
                cache.set(key, count + 1, retry_seconds)
                now = time.time()
                active_slots = [
                    (str(token), float(expiry))
                    for token, expiry in cache.get(provider_key, [])
                    if float(expiry) > now
                ]
                if reserve_provider_slot and len(active_slots) >= provider_slots:
                    earliest = min(expiry for _, expiry in active_slots)
                    return False, max(1, int(earliest - now) + 1), None
                lease_token = None
                if reserve_provider_slot:
                    lease_token = secrets.token_urlsafe(18)
                    active_slots.append(
                        (lease_token, now + provider_lease_seconds)
                    )
                    cache.set(
                        provider_key,
                        active_slots,
                        provider_lease_seconds + 1,
                    )
        except Exception as exc:
            logger.error("native checkout local admission failed")
            raise NativeReturnUnavailable(
                "native return admission failed"
            ) from exc
        return True, retry_seconds, lease_token

    try:
        with native_return_redis_deadline():
            client = _shared_redis_client()
            if client is None:  # LocMem is handled above; defensive fail-closed.
                raise NativeReturnUnavailable(
                    "native return admission requires atomic Redis"
                )
            lease_token = secrets.token_urlsafe(18)
            allowed, retry_seconds, returned_lease = client.eval(
                _NATIVE_ADMISSION_SCRIPT,
                2,
                backend.make_key(key),
                backend.make_key(provider_key),
                window_seconds,
                limit,
                1 if reserve_provider_slot else 0,
                provider_slots,
                provider_lease_seconds,
                lease_token,
            )
        if isinstance(returned_lease, bytes):
            returned_lease = returned_lease.decode("ascii", errors="strict")
        returned_lease = returned_lease or None
        if returned_lease is not None and returned_lease != lease_token:
            raise NativeReturnUnavailable(
                "native return admission returned an invalid provider lease"
            )
        return (
            int(allowed) == 1,
            max(1, int(retry_seconds)),
            returned_lease,
        )
    except NativeReturnUnavailable:
        raise
    except Exception as exc:
        logger.error("native checkout shared admission failed")
        raise NativeReturnUnavailable("native return admission failed") from exc


def release_native_return_provider_slot(lease_token: str | None) -> bool:
    """Release only this request's provider lease; TTL remains crash recovery."""
    if (
        not isinstance(lease_token, str)
        or _PROVIDER_LEASE_TOKEN_RE.fullmatch(lease_token) is None
    ):
        return False
    provider_key = _provider_slots_key()
    backend = caches["default"]
    try:
        if isinstance(backend, LocMemCache):
            if not getattr(settings, "NATIVE_RETURN_ALLOW_LOCAL_CACHE", False):
                return False
            with _local_lock:
                active_slots = cache.get(provider_key, [])
                remaining = [
                    (str(token), float(expiry))
                    for token, expiry in active_slots
                    if str(token) != lease_token
                ]
                removed = len(remaining) != len(active_slots)
                if remaining:
                    now = time.time()
                    timeout = max(
                        1,
                        int(max(expiry for _, expiry in remaining) - now) + 1,
                    )
                    cache.set(provider_key, remaining, timeout)
                else:
                    cache.delete(provider_key)
                return removed
        with native_return_redis_deadline():
            client = _shared_redis_client()
            if client is None:
                return False
            return bool(client.zrem(backend.make_key(provider_key), lease_token))
    except Exception:
        # Release failure must never replace the truthful checkout response.
        # The eight-second lease expires on its own and preserves capacity.
        logger.exception("native checkout provider lease release failed")
        return False


def valid_payment_intent_id(value: object) -> bool:
    return isinstance(value, str) and _PAYMENT_INTENT_RE.fullmatch(value) is not None


def valid_checkout_session_id(value: object) -> bool:
    return isinstance(value, str) and _CHECKOUT_SESSION_RE.fullmatch(value) is not None


def make_status_token(user_id: int, payment_intent: str) -> str:
    if not valid_payment_intent_id(payment_intent):
        raise ValueError("invalid Stripe payment intent")
    return signing.dumps(
        {"v": 1, "uid": user_id, "payment_intent": payment_intent},
        salt=_STATUS_SALT,
        compress=False,
    )


def make_processing_status_token(user_id: int, session_digest: str) -> str:
    if not isinstance(session_digest, str) or not _SESSION_DIGEST_RE.fullmatch(
        session_digest
    ):
        raise ValueError("invalid Checkout Session digest")
    return signing.dumps(
        {"v": 2, "uid": user_id, "session_digest": session_digest},
        salt=_STATUS_SALT,
        compress=False,
    )


def read_status_token(token: str, user_id: int) -> dict | None:
    if not isinstance(token, str) or len(token) > 1024:
        return None
    try:
        payload = signing.loads(
            token,
            salt=_STATUS_SALT,
            max_age=STATUS_MAX_AGE_SECONDS,
        )
    except signing.BadSignature:
        return None
    if not isinstance(payload, dict) or payload.get("uid") != user_id:
        return None
    if payload.get("v") == 1:
        if set(payload) != {"v", "uid", "payment_intent"} or not (
            valid_payment_intent_id(payload.get("payment_intent"))
        ):
            return None
    elif payload.get("v") == 2:
        if set(payload) != {"v", "uid", "session_digest"} or not (
            isinstance(payload.get("session_digest"), str)
            and _SESSION_DIGEST_RE.fullmatch(payload["session_digest"])
        ):
            return None
    else:
        return None
    return payload


def _status_resolution_key(user_id: int, session_digest: str) -> str:
    if (
        not isinstance(user_id, int)
        or user_id < 1
        or not isinstance(session_digest, str)
        or not _SESSION_DIGEST_RE.fullmatch(session_digest)
    ):
        raise NativeReturnUnavailable("native return status key is invalid")
    namespace_digest = _admission_namespace_digest()
    identity = hashlib.sha256(
        f"{user_id}:{session_digest}".encode("ascii")
    ).hexdigest()
    return f"{_NATIVE_STATUS_PREFIX}{namespace_digest}:{identity}"


def record_status_resolution(
    user_id: int,
    session_id: str,
    payment_intent: str,
) -> None:
    """Best-effort correlation written only after webhook-authoritative credit."""
    if not valid_payment_intent_id(payment_intent):
        raise NativeReturnUnavailable("native return payment intent is invalid")
    digest = checkout_session_digest(session_id)
    key = _status_resolution_key(user_id, digest)
    try:
        with native_return_redis_deadline(0.25):
            cache.set(key, payment_intent, timeout=STATUS_MAX_AGE_SECONDS)
    except NativeReturnUnavailable:
        raise
    except Exception as exc:
        raise NativeReturnUnavailable(
            "native return status correlation is unavailable"
        ) from exc


def read_status_resolution(user_id: int, session_digest: str) -> str | None:
    key = _status_resolution_key(user_id, session_digest)
    try:
        with native_return_redis_deadline(0.25):
            payment_intent = cache.get(key)
    except NativeReturnUnavailable:
        raise
    except Exception as exc:
        raise NativeReturnUnavailable(
            "native return status correlation is unavailable"
        ) from exc
    if payment_intent is None:
        return None
    if not valid_payment_intent_id(payment_intent):
        raise NativeReturnUnavailable(
            "native return status correlation is malformed"
        )
    return payment_intent
