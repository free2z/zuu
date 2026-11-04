"""
Single-use, TTL-bound storage for OAuth ``state`` -> PKCE verifier binding.

Modeled 1:1 on ``dj.apps.zauth.challenges``. Primary path is the Django cache
(``cache.set("socialstate:<state>", payload, 600)``). When the only configured
backend is the per-process local-memory (or dummy) cache -- which is NOT shared
across gunicorn workers and would make a state minted by one worker invisible to
the next -- we fall back to a small DB-backed table so the flow stays correct in
production.

Direct flows bind ``state`` to the exact redirect/provider and a backend-held
PKCE verifier. Mobile uses two states: the provider-facing state is atomically
consumed by the fixed HTTPS relay, which stores a code-bound completion state
containing only the app-supplied S256 challenge. The original verifier never
leaves the app before redemption.
"""
import json
import logging
from datetime import timedelta

from django.core.cache import cache, caches
from django.core.cache.backends.locmem import LocMemCache
from django.core.cache.backends.dummy import DummyCache
from django.db import transaction
from django.utils import timezone

STATE_TTL_SECONDS = 600
KEY_PREFIX = "socialstate:"
logger = logging.getLogger(__name__)

# Redis GETDEL is available in every deployed Redis version, but use a Lua
# script so this remains one atomic operation if the client/backend changes its
# command surface. Crucially, a miss performs no write: an attacker cannot fill
# the shared Redis instance by submitting random state values.
_POP_SCRIPT = """
local value = redis.call('GET', KEYS[1])
if value then
  redis.call('DEL', KEYS[1])
end
return value
"""


def _cache_is_shared() -> bool:
    """True only for a real cross-process cache backend."""
    # ``django.core.cache.cache`` is a ConnectionProxy, so isinstance(cache,
    # LocMemCache) is always false. Resolve the configured backend itself;
    # otherwise tests/dev silently exercise the Redis branch and the intended
    # cross-worker DB fallback is dead code.
    backend = caches["default"]
    return not isinstance(backend, (LocMemCache, DummyCache))


def _key(state: str) -> str:
    return f"{KEY_PREFIX}{state}"


def store_state(
    state: str, payload: dict, ttl_seconds: int = STATE_TTL_SECONDS,
) -> None:
    if not isinstance(ttl_seconds, int) or ttl_seconds <= 0:
        raise ValueError("OAuth state TTL must be a positive integer")
    if _cache_is_shared():
        cache.set(_key(state), json.dumps(payload), ttl_seconds)
        return

    from .models import SocialState
    SocialState.objects.update_or_create(
        state=state,
        defaults={
            "payload": json.dumps(payload),
            "expires": timezone.now() + timedelta(seconds=ttl_seconds),
        },
    )


def _decode_payload(raw) -> dict | None:
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return None


def get_state(state: str) -> dict | None:
    """Read an unexpired state without consuming it."""
    if not state:
        return None
    if _cache_is_shared():
        return _decode_payload(cache.get(_key(state)))

    from .models import SocialState
    try:
        row = SocialState.objects.get(state=state, expires__gt=timezone.now())
    except SocialState.DoesNotExist:
        return None
    return _decode_payload(row.payload)


def pop_state(state: str) -> dict | None:
    """
    Return the stored payload for ``state`` and delete it (single use).
    Returns None if there is no unexpired state.
    """
    if not state:
        return None

    if _cache_is_shared():
        try:
            redis_client = cache.client.get_client(write=True)
            raw = redis_client.eval(
                _POP_SCRIPT, 1, cache.make_key(_key(state)),
            )
            if raw is not None:
                # django-redis stores serializer/compressor output, not the
                # JSON string itself. The raw client returns those bytes.
                raw = cache.client.decode(raw)
        except Exception:
            # A cache outage or unsupported shared backend must fail closed.
            # Never fall back to a non-atomic get/delete for auth state.
            logger.exception("social OAuth state atomic pop failed")
            return None
        return _decode_payload(raw)

    from .models import SocialState
    with transaction.atomic():
        try:
            row = SocialState.objects.select_for_update().get(state=state)
        except SocialState.DoesNotExist:
            return None

        payload_raw = row.payload
        expired = row.expires <= timezone.now()
        # Single use: always consume the row once looked up. The row lock makes
        # this a true one-winner claim under concurrent provider callbacks.
        row.delete()
    if expired:
        return None
    return _decode_payload(payload_raw)
