"""Server-authenticated Zcash login challenges and rollout compatibility.

The canonical v2 token is stateless: the wallet signs a compact token whose
HMAC binds its version, timestamp, nonce, and requested Zcash address.  After
the server token is authenticated, a short-lived digest marker is claimed
atomically *before* expensive wallet-signature recovery so exactly one request
can spend that work.  Invalid wallet signatures intentionally burn the token.

The one-winner claim is a database row with a uniqueness constraint in every
environment.  Redis is intentionally not authoritative here: the production
instance is ephemeral, so a restart would erase a replay marker and make an
already-redeemed stateless token valid again for the remainder of its lifetime.

Two strict settings control the temporary v1-to-v2 rolling-deployment bridge.
``ZCASH_CHALLENGE_LEGACY_MIRROR_WRITES_ENABLED`` controls issuance into v1's
exact address-keyed django-redis slot, while
``ZCASH_CHALLENGE_LEGACY_MIRROR_REQUIRED`` controls whether a new-pod v2 login
must atomically compare/delete that exact mirror after claiming PostgreSQL.
They transition only through true/true, true/false, then false/false; the
locally unsafe false/true combination is rejected. Follow
docs/security/zcash-auth-admission.md's staged operator sequence and wait one
full ``CHALLENGE_TTL_SECONDS`` after the final mirror-writing pod drains before
any v1 rollback.

New pods also atomically consume strictly shaped v1 tokens from the same slot.
Remove the v1 path after the compatibility window. Old pods retain v1's
non-durable get/delete behavior while they are alive; this bridge cannot
retrofit PostgreSQL claims or atomic reads into code that is already running.
An old pod that has already read a proof can race another old pod (or a new
pod) before its separate delete. Draining old pods is the only complete close
for that in-flight residual.

New pods create their uncommitted PostgreSQL claim before comparing/deleting a
legacy Redis proof, so a normal database failure leaves the proof available.
After compare/delete wins, no error path restores Redis: a process crash or an
ambiguous PostgreSQL commit can burn that one rollout-only proof, but restoring
it could reopen an assertion after an authentication token committed. This
bounded availability sacrifice is deliberate; replay safety wins.
"""

import base64
import hashlib
import hmac
import logging
import re
import secrets
import threading
import time
from dataclasses import dataclass
from datetime import timedelta

from django.conf import settings
from django.core.cache import caches
from django.core.cache.backends.dummy import DummyCache
from django.core.cache.backends.locmem import LocMemCache
from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from .validation import is_valid_zcash_login_address


CHALLENGE_TTL_SECONDS = 300
CHALLENGE_PREFIX = "ZUULI-Login:v2:"
CHALLENGE_VERSION = "v2"
LEGACY_CHALLENGE_PREFIX = "ZUULI-Login:"
LEGACY_CHALLENGE_KEY_PREFIX = "zcashchallenge:"
_HMAC_CONTEXT = b"free2z/zauth/zcash-challenge/v2\x00"
_LEGACY_CLAIM_CONTEXT = b"free2z/zauth/zcash-challenge/v1-claim\x00"
_TOKEN_RE = re.compile(
    r"\AZUULI-Login:v2:(?P<timestamp>[0-9]{10}):"
    r"(?P<nonce>[A-Za-z0-9_-]{22}):(?P<tag>[A-Za-z0-9_-]{43})\Z"
)
_LEGACY_TOKEN_RE = re.compile(r"\AZUULI-Login:[A-Za-z0-9_-]{32}\Z")
logger = logging.getLogger(__name__)
CLAIM_CLEANUP_BATCH_SIZE = 100
_LEGACY_COMPAT_LOCAL_LOCK = threading.Lock()
_CLAIM_CLEANUP_LOCK_ID = int.from_bytes(
    hashlib.sha256(b"free2z/zauth/expired-claim-cleanup/v1").digest()[:8],
    byteorder="big",
    signed=True,
)


class ChallengeClaimUnavailable(RuntimeError):
    """The durable replay store could not safely decide a winner."""


class ChallengeCompatibilityUnavailable(RuntimeError):
    """The transitional v1-compatible cache could not decide safely."""


@dataclass(frozen=True)
class LegacyMirrorPolicy:
    """One validated pod-local snapshot of the staged rollout controls."""

    writes_enabled: bool
    required: bool


_LEGACY_COMPARE_AND_DELETE_SCRIPT = """
local current = redis.call('GET', KEYS[1])
if not current or current ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[1])
return 1
"""


def _legacy_challenge_key(address: str) -> str:
    """Return the exact logical cache key used by the v1 implementation."""
    return f"{LEGACY_CHALLENGE_KEY_PREFIX}{address}"


def legacy_mirror_policy() -> LegacyMirrorPolicy:
    """Return the centrally configured policy, rejecting unsafe overrides.

    Settings import strictly parses both values and rejects false/true before
    Django starts. Retain the same validation here so an incomplete test
    override or alternate settings module cannot silently split issuance and
    login authority inside one process.
    """
    writes_enabled = getattr(
        settings,
        "ZCASH_CHALLENGE_LEGACY_MIRROR_WRITES_ENABLED",
        None,
    )
    required = getattr(
        settings,
        "ZCASH_CHALLENGE_LEGACY_MIRROR_REQUIRED",
        None,
    )
    if (
        type(writes_enabled) is not bool
        or type(required) is not bool
        or (required and not writes_enabled)
    ):
        logger.error("Invalid Zcash challenge legacy-mirror policy")
        raise ChallengeCompatibilityUnavailable
    return LegacyMirrorPolicy(
        writes_enabled=writes_enabled,
        required=required,
    )


def is_legacy_challenge(challenge: object) -> bool:
    """Accept only v1's fixed 24-byte token_urlsafe wire representation."""
    return (
        isinstance(challenge, str)
        and _LEGACY_TOKEN_RE.fullmatch(challenge) is not None
    )


def legacy_challenge_claim_identifier(address: str, challenge: str) -> str:
    """Return fixed-size, address-bound claim material for an accepted v1 token."""
    if not is_valid_zcash_login_address(address) or not is_legacy_challenge(challenge):
        raise ValueError("Invalid legacy Zcash challenge claim material")
    material = (
        _LEGACY_CLAIM_CONTEXT
        + address.encode("ascii")
        + b"\x00"
        + challenge.encode("ascii")
    )
    return f"legacy-v1:{hashlib.sha256(material).hexdigest()}"


def _compatibility_cache_backend():
    """Return the cache backend, rejecting non-shared production fallbacks."""
    backend = caches["default"]
    if isinstance(backend, DummyCache):
        raise ChallengeCompatibilityUnavailable
    if isinstance(backend, LocMemCache):
        if not getattr(settings, "ZCASH_CHALLENGE_ALLOW_LOCAL_CACHE", False):
            raise ChallengeCompatibilityUnavailable
        return backend
    if not all(
        hasattr(getattr(backend, "client", None), attribute)
        for attribute in ("encode", "get_client", "set")
    ):
        raise ChallengeCompatibilityUnavailable
    return backend


def store_legacy_compatible_challenge(address: str, challenge: str) -> None:
    """Mirror a v2 token into v1's slot and require a storage acknowledgement."""
    if not legacy_mirror_policy().writes_enabled:
        return
    if not is_valid_zcash_login_address(address) or not validate_challenge(
        address, challenge
    ):
        raise ValueError("Invalid v2 Zcash challenge compatibility material")

    key = _legacy_challenge_key(address)
    try:
        backend = _compatibility_cache_backend()
        if isinstance(backend, LocMemCache):
            # Local development has no mixed-process rollout.  Read-back under
            # the same lock supplies the acknowledgement LocMemCache.set lacks.
            with _LEGACY_COMPAT_LOCAL_LOCK:
                backend.set(key, challenge, timeout=CHALLENGE_TTL_SECONDS)
                acknowledged = backend.get(key) == challenge
        else:
            # Bypass RedisCache's IGNORE_EXCEPTIONS wrapper: a swallowed write
            # would return a challenge that an old pod cannot consume.
            acknowledged = backend.client.set(
                key,
                challenge,
                timeout=CHALLENGE_TTL_SECONDS,
            )
        if acknowledged is not True:
            raise RuntimeError("legacy-compatible challenge write was not acknowledged")
    except ChallengeCompatibilityUnavailable:
        raise
    except Exception as exc:
        logger.exception("Zcash legacy-compatible challenge storage failed")
        raise ChallengeCompatibilityUnavailable from exc


def _consume_legacy_compatible_slot(address: str, challenge: str) -> bool:
    """Atomically compare/delete one exact serialized compatibility entry.

    Misses and mismatches perform only a GET.  Shared-cache comparison uses
    django-redis's own key transformation and value encoder so it matches bytes
    written by the old ``cache.set`` implementation, including pickle settings.
    """
    key = _legacy_challenge_key(address)
    try:
        backend = _compatibility_cache_backend()
        if isinstance(backend, LocMemCache):
            with _LEGACY_COMPAT_LOCAL_LOCK:
                if backend.get(key) != challenge:
                    return False
                if backend.delete(key) is not True:
                    raise RuntimeError("legacy-compatible challenge delete failed")
                return True

        raw_client = backend.client.get_client(write=True)
        result = int(
            raw_client.eval(
                _LEGACY_COMPARE_AND_DELETE_SCRIPT,
                1,
                backend.make_key(key),
                backend.client.encode(challenge),
            )
        )
        if result not in (0, 1):
            raise RuntimeError("unexpected legacy challenge consume result")
        return result == 1
    except ChallengeCompatibilityUnavailable:
        raise
    except Exception as exc:
        logger.exception("Zcash legacy-compatible challenge consume failed")
        raise ChallengeCompatibilityUnavailable from exc


def consume_legacy_challenge(address: str, challenge: str) -> bool:
    """Atomically compare/delete one exact, strictly shaped v1 proof."""
    if not is_valid_zcash_login_address(address) or not is_legacy_challenge(
        challenge
    ):
        return False
    return _consume_legacy_compatible_slot(address, challenge)


def consume_v2_legacy_mirror(address: str, challenge: str) -> bool:
    """Atomically compare/delete the exact v2 mirror required during rollout."""
    if not is_valid_zcash_login_address(address) or not validate_challenge(
        address, challenge
    ):
        return False
    return _consume_legacy_compatible_slot(address, challenge)


def _urlsafe(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _derived_hmac_key(secret: str) -> bytes:
    return hmac.new(
        str(secret).encode("utf-8"), _HMAC_CONTEXT, hashlib.sha256
    ).digest()


def _unsigned_token(timestamp: int, nonce: str) -> str:
    return f"{CHALLENGE_PREFIX}{timestamp}:{nonce}"


def _tag(secret: str, address: str, unsigned: str) -> str:
    message = address.encode("ascii") + b"\x00" + unsigned.encode("ascii")
    return _urlsafe(
        hmac.new(_derived_hmac_key(secret), message, hashlib.sha256).digest()
    )


def issue_challenge(
    address: str, *, now: int | None = None, nonce_bytes: bytes | None = None
) -> str:
    """Return a compact address-bound token for the wallet to sign verbatim."""
    timestamp = int(time.time()) if now is None else int(now)
    nonce_raw = secrets.token_bytes(16) if nonce_bytes is None else nonce_bytes
    if len(nonce_raw) != 16:
        raise ValueError("Zcash challenge nonce must be exactly 16 bytes")
    nonce = _urlsafe(nonce_raw)
    unsigned = _unsigned_token(timestamp, nonce)
    challenge = f"{unsigned}:{_tag(settings.SECRET_KEY, address, unsigned)}"
    # The serializer and existing wallet contract cap this field at 128 bytes.
    if len(challenge) > 128:  # pragma: no cover - fixed format is 92 bytes
        raise RuntimeError("Zcash challenge format exceeded its wire contract")
    return challenge


def validate_challenge(
    address: str, challenge: str, *, now: int | None = None
) -> bool:
    """Validate format, five-minute age, address binding, and server HMAC."""
    if not isinstance(address, str) or not isinstance(challenge, str):
        return False
    match = _TOKEN_RE.fullmatch(challenge)
    if match is None:
        return False

    issued_at = int(match.group("timestamp"))
    current = int(time.time()) if now is None else int(now)
    age = current - issued_at
    # Future timestamps are never accepted, and age 300 is already expired.
    if age < 0 or age >= CHALLENGE_TTL_SECONDS:
        return False

    unsigned = challenge.rsplit(":", 1)[0]
    supplied = match.group("tag")
    secrets_to_try = [
        settings.SECRET_KEY,
        *getattr(settings, "SECRET_KEY_FALLBACKS", []),
    ]
    # Evaluate every configured key so validation time does not reveal which
    # rotation key signed an otherwise-valid token.
    matched = False
    for secret in secrets_to_try:
        matched |= hmac.compare_digest(_tag(secret, address, unsigned), supplied)
    return matched


def challenge_digest(challenge: str) -> str:
    """Fixed-length, non-identifying replay key material."""
    return hashlib.sha256(challenge.encode("utf-8")).hexdigest()


def _delete_expired_claim_batch(now, batch_size: int) -> int:
    """Delete the oldest indexed batch while the cleanup lock is held."""
    from .models import ZcashChallengeClaim

    expired_ids = list(
        ZcashChallengeClaim.objects.filter(expires__lte=now)
        .order_by("expires", "pk")
        .values_list("pk", flat=True)[:batch_size]
    )
    if not expired_ids:
        return 0
    deleted, _details = ZcashChallengeClaim.objects.filter(
        pk__in=expired_ids,
        expires__lte=now,
    ).delete()
    return deleted


def cleanup_expired_challenge_claims(
    *, batch_size: int = CLAIM_CLEANUP_BATCH_SIZE
) -> int:
    """Best-effort bounded cleanup outside the login transaction.

    Production uses a transaction-scoped *try* advisory lock, so one worker
    deletes at most one oldest-first batch while every concurrent login skips
    immediately. Never call this from an existing transaction: PostgreSQL
    would retain the advisory lock until that outer transaction completed and
    couple cleanup to identity provisioning. SQLite/local development simply
    skips this maintenance path.

    Cleanup is never part of authentication correctness. Every failure is
    logged and swallowed; durable uniqueness remains authoritative until a
    later request successfully removes the expired row.
    """
    if (
        not isinstance(batch_size, int)
        or isinstance(batch_size, bool)
        or batch_size <= 0
        or batch_size > CLAIM_CLEANUP_BATCH_SIZE
    ):
        logger.warning("Ignoring invalid Zcash claim cleanup batch size")
        return 0
    try:
        if connection.vendor != "postgresql" or connection.in_atomic_block:
            return 0
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT pg_try_advisory_xact_lock(%s)",
                    [_CLAIM_CLEANUP_LOCK_ID],
                )
                acquired = bool(cursor.fetchone()[0])
            if not acquired:
                return 0
            return _delete_expired_claim_batch(timezone.now(), batch_size)
    except Exception:  # noqa: BLE001 - maintenance must never break login
        logger.warning(
            "Zcash expired-claim cleanup failed; authentication continues",
            exc_info=True,
        )
        return 0


def claim_challenge(challenge: str) -> bool:
    """Atomically claim a server-verified challenge exactly once.

    Callers must validate the server HMAC first, then claim before wallet
    signature recovery.  This function intentionally performs no
    authentication itself. Challenge client/address admission and independent
    login admission bound the rate of these rows, including rows committed for
    invalid signatures. For a valid signature, the login view's outer
    transaction couples this claim to identity and token provisioning so a
    retryable provisioning failure rolls all three back.
    """
    if not isinstance(challenge, str):
        return False

    from .models import ZcashChallengeClaim

    try:
        with transaction.atomic():
            ZcashChallengeClaim.objects.create(
                challenge_digest=challenge_digest(challenge),
                expires=timezone.now()
                + timedelta(seconds=CHALLENGE_TTL_SECONDS),
            )
    except IntegrityError:
        return False
    except Exception as exc:
        logger.exception("Zcash database replay claim failed")
        raise ChallengeClaimUnavailable from exc
    return True
