"""Publishing ``aep`` and ``agen`` to resource servers (spec §6.2, §6.3).

A resource server -- the AI gateway first -- compares a token's ``aep`` with
the account's current epoch and its ``agen`` with the grant's current
generation, and refuses a token that is behind. It reads the current values
from the shared Redis this module writes to:

    <namespace>:aep:<sub>                -> the account epoch
    <namespace>:agen:<client_id>:<sub>   -> the grant generation

``<namespace>`` is ``settings.OIDC_EPOCH_REDIS_NAMESPACE`` (the DBNAME, like
every other shared-Redis key here, so stage and prod never read each other).
Values are decimal strings written with the RAW redis client, not through
``cache.set``: django-redis pickles values and prefixes keys, and a Rust
client could read neither.

Two properties matter more than the write itself:

* **After commit.** The publication is scheduled with ``transaction.
  on_commit``; a rollback of the ownership event publishes nothing.
* **Monotonic.** Two ownership events on one account commit in some order,
  but their ``on_commit`` callbacks run in their own threads and could land
  in the other order, leaving Redis one behind the database. The write is a
  Lua compare-and-set that only ever raises the stored value, so the larger
  epoch wins whichever callback runs last.

A failed publication is retried a few times, then logged at ERROR and
swallowed: the ownership event has already committed and must not be
undone by a cache. What bounds the damage of a publication that never
lands is the **TTL**: entries live for ``OIDC_EPOCH_REDIS_TTL_SECONDS``,
the access-token lifetime (300 s), so a stale counter can outlive the
missed event by at most one token lifetime -- the same bound the spec
already accepts for a token whose revocation has not propagated -- after
which every resource server misses, fails closed, and asks the internal
epoch endpoint, which reads the row. (A seven-day TTL would have left a
stale counter readable for a week; codex adversarial review.)

Under the base settings the cache is process-local (LocMemCache) and has no
raw client; the values are then kept in that cache under the same keys so
tests and local development can read them back through
:func:`read_account_epoch`.
"""
from __future__ import annotations

import logging
import time

from django.conf import settings
from django.core.cache import caches
from django.db import transaction

logger = logging.getLogger(__name__)

#Only raise the stored value. ARGV[1] = the candidate, ARGV[2] = ttl seconds.
_SET_IF_GREATER = """
local current = redis.call('GET', KEYS[1])
if (not current) or (tonumber(current) < tonumber(ARGV[1])) then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  return 1
end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 0
"""


def _namespace() -> str:
    return getattr(settings, "OIDC_EPOCH_REDIS_NAMESPACE", "free2z")


DEFAULT_TTL_SECONDS = 300
#Attempts per publication, with these pauses between them (seconds).
RETRY_PAUSES = (0.05, 0.2)


def _ttl() -> int:
    return int(getattr(settings, "OIDC_EPOCH_REDIS_TTL_SECONDS", DEFAULT_TTL_SECONDS))


def account_epoch_key(public_id) -> str:
    return f"{_namespace()}:aep:{public_id}"


def grant_generation_key(public_id, client_id) -> str:
    return f"{_namespace()}:agen:{client_id}:{public_id}"


def _raw_redis():
    """The redis-py client behind CACHES['default'], or None (LocMem, dummy)."""
    backend = caches["default"]
    client = getattr(backend, "client", None)
    get_client = getattr(client, "get_client", None)
    if get_client is None:
        return None
    return get_client(write=True)


def _write(key: str, value: int) -> None:
    redis_client = _raw_redis()
    if redis_client is not None:
        redis_client.eval(_SET_IF_GREATER, 1, key, str(value), str(_ttl()))
        return
    # Process-local fallback (dev, pytest): same key, same monotonic rule.
    cache = caches["default"]
    current = cache.get(key)
    if current is None or int(current) < value:
        cache.set(key, value, _ttl())


def _publish(key: str, value: int) -> None:
    value = int(value)
    for attempt, pause in enumerate((*RETRY_PAUSES, None)):
        try:
            _write(key, value)
            return
        except Exception:
            if pause is None:
                # The ownership event is committed; the TTL bounds how long
                # a stale value can be read (module docstring). Countable:
                # the alerting metric for it is a follow-up of.
                logger.exception(
                    "oidc: epoch publication failed for %s after %d attempts",
                    key, attempt + 1,
                )
                return
            time.sleep(pause)


def publish_account_epoch(public_id, epoch: int) -> None:
    _publish(account_epoch_key(public_id), epoch)


def publish_grant_generation(public_id, client_id: str, generation: int) -> None:
    _publish(grant_generation_key(public_id, client_id), generation)


def schedule_publish_account_epoch(public_id, epoch: int, using=None) -> None:
    transaction.on_commit(lambda: publish_account_epoch(public_id, epoch), using=using)


def schedule_publish_grant_generation(public_id, client_id: str, generation: int, using=None) -> None:
    transaction.on_commit(
        lambda: publish_grant_generation(public_id, client_id, generation), using=using,
    )


def _read(key: str):
    redis_client = _raw_redis()
    if redis_client is not None:
        raw = redis_client.get(key)
        return None if raw is None else int(raw)
    value = caches["default"].get(key)
    return None if value is None else int(value)


def read_account_epoch(public_id):
    """What a resource server would read for this account, or ``None``."""
    return _read(account_epoch_key(public_id))


def read_grant_generation(public_id, client_id: str):
    return _read(grant_generation_key(public_id, client_id))
