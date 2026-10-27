"""Atomic admission limits for confirmation-mail issuance.

One account may attempt confirmation or resend at most ten times per rolling
24 hours. Each case-folded recipient identity permits three delivery claims
across accounts in that window; Gmail and Googlemail identities also group
plus tags and dots. Other providers' aliases remain separate. Definitive
non-delivery or database rollback releases only the exact recipient claim;
uncertain delivery and the account attempt remain charged.

Production uses Redis Lua scripts for atomic sliding-window claims. Local
development and tests use Django's cache primitives under a process lock.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time

from django.conf import settings
from django.core.cache import caches
from rest_framework.exceptions import APIException


CONFIRMATION_USER_LIMIT = 10
CONFIRMATION_RECIPIENT_LIMIT = 3
CONFIRMATION_PERIOD_SECONDS = 24 * 60 * 60
CONFIRMATION_PERIOD_MILLISECONDS = CONFIRMATION_PERIOD_SECONDS * 1000

ALLOWED = "allowed"
USER_LIMITED = "user_limited"
RECIPIENT_LIMITED = "recipient_limited"

_CONFIRMATION_ADMISSION_LOCK = threading.Lock()

_ACCOUNT_ATTEMPT_SCRIPT = """
local clock = redis.call('TIME')
local now = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
local cutoff = now - tonumber(ARGV[1])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
local user_count = redis.call('ZCARD', KEYS[1])
if user_count >= tonumber(ARGV[2]) then
    return 0
end

redis.call('ZADD', KEYS[1], now, ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return 1
"""

_RECIPIENT_CLAIM_SCRIPT = """
local clock = redis.call('TIME')
local now = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
local cutoff = now - tonumber(ARGV[1])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
local recipient_count = redis.call('ZCARD', KEYS[1])
if recipient_count >= tonumber(ARGV[2]) then
    return 0
end

redis.call('ZADD', KEYS[1], now, ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return 1
"""

_RECIPIENT_RELEASE_SCRIPT = "return redis.call('ZREM', KEYS[1], ARGV[1])"


def _recipient_quota_identity(recipient: str) -> str:
    """Group only aliases whose equivalence is a documented provider rule.

    Gmail ignores dots and plus tags in consumer ``gmail.com`` and
    ``googlemail.com`` addresses. Other providers have different rules, so
    preserve their local parts exactly (apart from the global case-fold).
    """
    local, separator, domain = recipient.casefold().rpartition("@")
    if not separator:
        return recipient.casefold()
    if domain in {"gmail.com", "googlemail.com"}:
        local = local.split("+", 1)[0].replace(".", "")
        domain = "gmail.com"
    return f"{local}@{domain}"


class ConfirmationMailAdmissionUnavailable(APIException):
    """Fail closed when the shared counter store cannot enforce mail limits."""

    status_code = 503
    default_detail = (
        "Confirmation email is temporarily unavailable. Please try again in a minute."
    )
    default_code = "confirmation_mail_admission_unavailable"


class ConfirmationMailThrottled(APIException):
    """An authenticated account exhausted its own confirmation-mail budget."""

    status_code = 429
    default_detail = "Confirmation email limit reached. Please try again later."
    default_code = "confirmation_mail_throttled"


def _admission_cache():
    # Production's auth_throttle alias raises on Redis errors, unlike default,
    # which intentionally ignores them. Tests and local development use the
    # configured default LocMemCache.
    alias = "auth_throttle" if "auth_throttle" in settings.CACHES else "default"
    return caches[alias]


def _user_key(cache, user_id: int) -> str:
    tag = "{confirmation-mail-v1}"
    return cache.make_key(f"confirmation-mail-v1:{tag}:user:{user_id}")


def _recipient_key(cache, recipient: str) -> str:
    digest = hmac.new(
        settings.SECRET_KEY.encode("utf-8"),
        _recipient_quota_identity(recipient).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    # The shared hash tag keeps this key in the confirmation quota's Redis
    # Cluster slot. The recipient itself never appears in Redis keys.
    tag = "{confirmation-mail-v1}"
    return cache.make_key(f"confirmation-mail-v1:{tag}:recipient:{digest}")


def _claim_local(
    cache, key: str, limit: int, *, limited_result: str, claim_id: str,
) -> str:
    """Locally atomic fallback for LocMemCache and simple test backends."""
    now = time.time()
    cutoff = now - CONFIRMATION_PERIOD_SECONDS
    try:
        events = []
        for event in cache.get(key) or []:
            # Read legacy timestamp-only entries written before claim IDs
            # existed; they age out naturally over the normal quota window.
            stamp = event[0] if isinstance(event, tuple) else event
            if stamp > cutoff:
                events.append(event)
        if len(events) >= limit:
            cache.set(key, events, timeout=CONFIRMATION_PERIOD_SECONDS)
            return limited_result

        events.append((now, claim_id))
        cache.set(key, events, timeout=CONFIRMATION_PERIOD_SECONDS)
        return ALLOWED
    except Exception as exc:
        raise ConfirmationMailAdmissionUnavailable() from exc


def _claim(
    cache, key: str, limit: int, script: str, *, limited_result: str,
    claim_id: str,
) -> str:
    try:
        redis_client = cache.client.get_client(write=True)
        result = redis_client.eval(
            script,
            1,
            key,
            CONFIRMATION_PERIOD_MILLISECONDS,
            limit,
            claim_id,
        )
    except (AttributeError, NotImplementedError):
        # LocMemCache has no Redis client. The lock protects the per-key
        # decision locally; production relies on the Redis Lua script.
        with _CONFIRMATION_ADMISSION_LOCK:
            return _claim_local(
                cache, key, limit, limited_result=limited_result,
                claim_id=claim_id,
            )
    except Exception as exc:
        # A timeout may mean Redis ran the script but its reply was lost. Do
        # not retry: that could double-claim or allow an unmetered send.
        raise ConfirmationMailAdmissionUnavailable() from exc

    if result == 1:
        return ALLOWED
    return limited_result


def claim_confirmation_account_attempt(user_id: int) -> str:
    """Spend one account attempt before recipient-specific suppression.

    Every valid request that reaches delivery admission costs one slot,
    regardless of opt-out or the mailbox-wide ceiling. This prevents the
    account quota from becoming an indirect signal about recipient activity.
    """
    cache = _admission_cache()
    return _claim(
        cache,
        _user_key(cache, user_id),
        CONFIRMATION_USER_LIMIT,
        _ACCOUNT_ATTEMPT_SCRIPT,
        limited_result=USER_LIMITED,
        claim_id=secrets.token_urlsafe(18),
    )


def claim_confirmation_recipient(
    recipient: str, *, claim_id: str | None = None,
) -> str:
    """Claim a mailbox-wide outbound slot, or suppress mail silently.

    Callers that may compensate a definitive delivery failure pass and retain
    a claim ID, then release that exact slot. A caller that omits it keeps the
    historical permanent-for-window claim behavior.
    """
    cache = _admission_cache()
    claim_id = claim_id or secrets.token_urlsafe(18)
    return _claim(
        cache,
        _recipient_key(cache, recipient),
        CONFIRMATION_RECIPIENT_LIMIT,
        _RECIPIENT_CLAIM_SCRIPT,
        limited_result=RECIPIENT_LIMITED,
        claim_id=claim_id,
    )


def release_confirmation_recipient(recipient: str, claim_id: str) -> bool:
    """Release one known-undelivered reservation; leave it charged on errors."""
    try:
        cache = _admission_cache()
        key = _recipient_key(cache, recipient)
    except Exception:
        return False
    try:
        redis_client = cache.client.get_client(write=True)
        return bool(redis_client.eval(_RECIPIENT_RELEASE_SCRIPT, 1, key, claim_id))
    except (AttributeError, NotImplementedError):
        with _CONFIRMATION_ADMISSION_LOCK:
            try:
                events = cache.get(key) or []
                kept = [
                    event for event in events
                    if not (isinstance(event, tuple) and event[1] == claim_id)
                ]
                if len(kept) == len(events):
                    return False
                if kept:
                    cache.set(key, kept, timeout=CONFIRMATION_PERIOD_SECONDS)
                else:
                    cache.delete(key)
                return True
            except Exception:
                # A failed compensation is conservative: the slot remains
                # consumed rather than risking an unmetered outbound send.
                return False
    except Exception:
        # Redis may have applied a release whose reply was lost. Retrying is
        # safe (ZREM is idempotent), but this call stays bounded and lets the
        # original delivery failure remain the surfaced error.
        return False
