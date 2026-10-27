import base64
import contextlib
import hashlib
import json
import logging
import re
import threading

from django.core.cache import cache
from django.db import InterfaceError, OperationalError, connection, transaction
from django.db.models import BigIntegerField, Count, F, Q, Value
from django.db.models.functions import Cast, Lower
from django.utils.crypto import constant_time_compare, salted_hmac
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.renderers import JSONRenderer
from rest_framework.response import Response
from rest_framework.views import APIView

from dj.apps.g12f.localization import (
    is_content_language,
    variant_reads_enabled,
)
from dj.apps.g12f.models import (
    Creator, ZPageTranslation, ZPageVariant, zPage,
)
from dj.apps.g12f.serializers import (
    SitemapChunkSerializer,
    SitemapIndexSerializer,
)
from dj.apps.g12f.serializers.zpage import (
    MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE,
    RESERVED_VANITIES,
)

from dj.apps.tagging import hubs as tagging_hubs
from dj.apps.tagging.slugs import TagGraphTooLarge, slugify_tag


# Far below the sitemap protocol's 50,000-URL ceiling and small enough that
# even maximum-length usernames/slugs produce a modest response. This is also
# a public fresh-read endpoint, so keep its replay cost close to normal API
# pagination rather than using the protocol's much larger theoretical limit.
#
# It is a ROW count, not a URL count, and the two differ by a large
# factor: a multilingual zPage contributes one `<loc>` per published variant.
# The renderer, not this constant, is where that multiplication is bounded --
# see SITEMAP_MAX_BYTES_PER_ZPAGE and SITEMAP_MAX_URLS_PER_ZPAGE  in
# ts/svelte/free2z/src/lib/server/sitemap.ts. Together they bound one
# article's contribution in BYTES and in URLs whatever its variant count, so a
# chunk fits the protocol's 50 MiB / 50,000-URL limits by construction; the
# measured derivation, and why the `xhtml:link` cluster (which grows as
# variants SQUARED) is the term dropped first, live there.
SITEMAP_CHUNK_SIZE = 500
# How many PUBLISHED languages one zPage may report, SOURCE INCLUDED
# ( Part 8). It bounds a term that is otherwise open-ended: a
# variant's language is validated against the IANA registry rather than a
# four-item enum, so nothing in the schema stops one article from accumulating
# hundreds of them.
#
# It is used at TWO scales, and the distinction is the bug an adversarial
# review caught on the first cut of this change:
#
#   * PER ROW, as the length of `languages`. The SvelteKit parser enforces the
#     same number (MAX_SITEMAP_VARIANTS_PER_ZPAGE in
#     src/lib/server/sitemap.ts) and rejects the whole chunk if a row exceeds
#     it. So the two must agree EXACTLY, including on whether the source
#     counts -- it does. The first cut counted only translations here, so a
#     creator publishing 32 translations produced a 33-entry list that the
#     renderer refused, permanently 503ing a sitemap child and taking up to
#     499 unrelated articles offline with it. `_available_languages`
#     truncates instead.
#
# DERIVATION. It used to be a flat 32, justified as "far above the
# four UI locales that can appear in a sitemap URL, and everything beyond it
# is dropped LOSSLESSLY". Both halves of that justification are gone:
#
#   *  made every *content* language linkable, not just the four the
#     product chrome is translated into, so a dropped variant is now a URL
#     that never reaches a crawler and an `hreflang` that is never emitted.
#     Truncation is a real loss, so the bound has to be above anything a
#     creator can legitimately produce rather than merely above four.
#   * The write path already states that number: / cap a zPage at
#     MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE published translations,
#     and the source is excluded from that count. That cap + 1 source is
#     therefore the largest variant list the API can produce, and it is what
#     this is derived FROM rather than guessed near.
#
#  moved that cap from 64 to 96, so this is 97. The DERIVATION did not
# change -- which is the point of deriving it. What did have to change is the
# WIRE: see SITEMAP_WIDE_VARIANTS_HEADER below, whose boolean form could only
# ever say "the 65-language generation" and would have 503'd every sitemap
# child for the length of this rollout.
#
# Truncation survives for legacy and directly-mutated drift rows that predate
# the write-path cap -- it must, because raising a 503 here takes up to 499
# unrelated articles out of the sitemap -- but nothing a creator can publish
# today reaches it.
SITEMAP_MAX_VARIANTS_PER_ZPAGE = (
    MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE + 1
)
# What a SvelteKit replica that predates  accepts, and the reason this
# raise is HEADER-NEGOTIATED rather than simply larger.
#
# Django and SvelteKit are separate Deployments that roll independently, and
# `bin/bazel-apply.sh` rolls the backend first. `parseZPageEntries` rejects a
# row whose `languages` is longer than ITS bound and throws, which 503s the
# whole child -- so a new Django emitting 33 languages to a still-old
# SvelteKit takes up to 500 unrelated articles out of the sitemap for the
# length of the rollout, or indefinitely if the frontend roll fails. The same
# hazard the `X-Free2Z-Sitemap-Canonical-Address` negotiation above exists
# for, and the same fix: emit the wider list only to a caller that said it can
# read one. An old caller keeps receiving exactly the shape it was written
# against, and a NEW SvelteKit against an OLD Django receives a shorter list
# than it can handle, which is always safe.
#
# 32 is not re-derived here. It is a historical constant -- the number the
# deployed parser was compiled with -- and it is correct precisely because it
# is not a judgement about anything.
SITEMAP_LEGACY_VARIANT_CAP = 32
# The BOOLEAN header of the  generation: "I can read a wide list."
#
# It could only ever name one width, and  is what that costs. Raising the
# publish cap to 96 makes this backend emit up to 97 languages per row, while
# every SvelteKit replica still running 's code sends this header and
# parses at most 65 -- `parseLanguages` throws past its own bound, which 503s
# the whole child and takes up to 499 unrelated articles offline. Django rolls
# BEFORE the frontend does, so that window is every rollout, not a rare race.
#
# So `1` is frozen at 65, exactly as SITEMAP_LEGACY_VARIANT_CAP is frozen at
# 32: the number that generation's parser was compiled with, correct because
# it is not a judgement about anything. Do not re-derive it.
SITEMAP_WIDE_VARIANTS_HEADER = 'X-Free2Z-Sitemap-Wide-Variants'
SITEMAP_WIDE_VARIANTS_GENERATION_CAP = 65
# The header that replaces it, and the last one this contract should need: the
# caller states the NUMBER of languages per row its parser accepts, so a future
# cap change is a one-sided deploy again instead of a new header.
#
# Answered with `min(stated, SITEMAP_MAX_VARIANTS_PER_ZPAGE)`. Both directions
# of a mixed rollout are then safe by construction: a new SvelteKit against an
# old Django is ignored and receives the shorter list it can certainly parse,
# and a new Django against an old SvelteKit receives exactly what that replica
# said it could read. A value that is absent, unparseable, or below 1 falls
# back to the generation rules above rather than failing the request -- this is
# a representation hint on a read, and an unusable hint must degrade to a
# narrower answer, never to an error.
SITEMAP_MAX_VARIANTS_HEADER = 'X-Free2Z-Sitemap-Max-Variants'
# How many translation rows the per-chunk variant fetch may READ. A separate
# number from the per-row bound above, and it must be, because the two answer
# different questions: that one bounds the payload, this one bounds the query.
#
# The first cut set this to `SITEMAP_CHUNK_SIZE * SITEMAP_MAX_VARIANTS_PER_ZPAGE`
# (16,000), which the codex adversarial review showed a normally-operating
# product reaches: `f2z.languages.TRANSLATABLE` listed 39 languages we sell AI
# translations into, so 422 fully-translated articles inside one 500-id range
# trip it -- and tripping it 503s that sitemap child, taking up to 499
# unrelated articles out of the sitemap with it. A capacity guard that fires on
# success is a bug.
#
# It was 50,000, derived as ~2.5x a corpus where EVERY page in a chunk carries
# EVERY sellable translation -- 500 x 39 `f2z.languages.TRANSLATABLE` entries
# = 19,500.  took TRANSLATABLE from 39 to 78, which took that product to
# 39,000 and left 50,000 at 1.3x, and raised this to 100,000.
#
# DERIVATION, keeping the same 100,000 and re-anchoring WHY. A bound
# derived from the size of the sell list moves every time a language ships,
# and the failure mode of forgetting to re-derive it is a 503 that takes up to
# 499 unrelated articles out of the sitemap. The write path states a number
# that is re-derived DELIBERATELY rather than drifting: / refuse a
# translation past MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE with a 409
# whatever TRANSLATABLE grows to, so the largest a legitimately-published chunk
# can be is `SITEMAP_CHUNK_SIZE x MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE`.
#
# RE-DERIVED, keeping 100,000 again. That cap went 64 -> 96 so the
# product went 32,000 -> 48,000 rows, and 100,000 is 2.08x it. Still comfortably
# above the sell-list term as well: 500 x 79 `TRANSLATABLE` entries = 39,500.
# Both multiples are asserted in test_language_derived_bounds.py, so the next
# move of either term fails there instead of in production.
#
# It is still a real ceiling, and the cost of raising it is bounded: measured
# on a 40,000-page corpus this read is an index scan on (zpage_id) returning
# ~10 narrow (bigint, varchar, timestamptz) tuples per page at 2.0 ms for
# 5,150 rows -- ~0.39 us/row -- so 100,000 rows extrapolates to ~39 ms against
# a 1,000 ms statement timeout (it was ~20 ms at 50,000). The guard remains
# for legacy or directly-mutated drift data, and it deliberately counts the
# complete primary-key range because the query cannot know which rows the
# visibility filter will keep.
SITEMAP_MAX_VARIANT_ROWS_PER_CHUNK = 100_000
SITEMAP_MAX_INDEX_ENTRIES = 50_000
SITEMAP_MAX_DYNAMIC_PAGES = SITEMAP_MAX_INDEX_ENTRIES - 1
_BIGINT_MAX = (2 ** 63) - 1
SITEMAP_MAX_PAGE = ((_BIGINT_MAX - 1) // SITEMAP_CHUNK_SIZE) - 1
_REVISION_RE = re.compile(r"^(?P<count>[1-9][0-9]{0,3})-(?P<digest>[A-Za-z0-9_-]{16})$")
_REVISION_SALT = "dj.apps.g12f.sitemap.chunk.v1"
_NO_STORE_HEADERS = {
    "Cache-Control": "no-store",
    "X-Sitemap-Protocol": "2",
}
_SITEMAP_OUTCOME_HEADER = "X-Sitemap-Outcome"
_INDEX_CACHE_KEY = "sitemap:index:v3"
_INDEX_CACHE_SECONDS = 300
_INDEX_OVERFLOW_SENTINEL = "sitemap:index:v2:overflow"
_INDEX_BUSY_SENTINEL = "sitemap:index:v2:busy"
_INDEX_BUSY_SECONDS = 30
_CACHE_HEALTH_KEY = "sitemap:cache:v2:health"
_CACHE_HEALTH_SECONDS = 60
_INDEX_STATEMENT_TIMEOUT_MS = 1000
# The PostgreSQL advisory-lock namespace is database-wide. This positive int64
# is the ASCII bytes for "sitemap2", keeping the purpose recognizable while
# avoiding a collision with application row IDs.
#
# The index lane stays exactly one slot fleet-wide: building it is a full
# aggregate over every listed creator and zPage, so a single lane is the
# correct bound for it.
_INDEX_DB_LOCK_ID = 0x736974656D617032
# Chunk reads deliberately do NOT share that lane. A chunk is one primary-key
# range scan of at most SITEMAP_CHUNK_SIZE rows -- by design (see the comment
# on SITEMAP_CHUNK_SIZE) its cost is that of ordinary API pagination, not of
# the index aggregate. Sharing the index's single lane meant a crawler
# fetching the 15 advertised children in parallel -- the access pattern a
# sitemap index exists to invite -- serialized on one *non-blocking* lock, so
# all but one child got an instant 503. Measured on production: 10 of 15.
#
# Each child therefore gets its own lane, keyed by (kind, page), so distinct
# children never contend. What stops that from costing the fleet:
#
#   * How many chunk reads can be in flight at all is set by the request
#     concurrency of the fleet, not by this lane. gunicorn runs a SINGLE sync
#     worker per pod (k8s/free2z/deployment.yaml), so the ceiling is the
#     replica count -- the same ceiling every other anonymous endpoint has
#     always had. A sitemap-specific ceiling *below* that number is exactly
#     what  was.
#   * How long any one CHUNK read may hold its pod's only worker is bounded
#     by _CHUNK_STATEMENT_TIMEOUT_MS below. That is the term that actually
#     matters here, and it moves the right way: before this change a chunk
#     read that won the single lane could hold a worker for gunicorn's full
#     --timeout of 600s, so worst-case worker-seconds spent on CHUNK reads
#     goes from 1 x 600s to replicas x 1s.
#
#     Scope that claim carefully: the index build has its own 1s statement
#     timeout, but this paragraph only describes chunk reads. The index remains
#     the expensive query -- a GROUP BY over an expression, across the whole
#     Creator and zPage tables, not index-backed -- so a slow build degrades to
#     a retryable 503 rather than holding a worker for gunicorn's full 600s.
#
# Lane ids are drawn from the NEGATIVE int64 range so they can never collide
# with the positive index id above, whatever the hash produces. That is the
# only exclusivity claimed: the advisory-lock namespace is database-wide and
# shared, and dj/apps/dyte/management/commands/dyte_download_upload.py already
# mints signed ids from a sha256 prefix the same way. Collision odds there are
# ~2^-64, so this is a note for the next reader, not a hazard.
_CHUNK_LOCK_SALT = "dj.apps.g12f.sitemap.chunk.lane.v1"
# Derivation, not a guess: a chunk is one primary-key range scan of at most
# SITEMAP_CHUNK_SIZE (500) indexed rows over a single column, so this is about
# two orders of magnitude above its expected cost -- far too generous for
# ordinary load or a cold cache to trip, tight enough that a pathological plan
# or a lock wait cannot take a pod's only worker hostage for the 600s gunicorn
# allows. Overrunning it degrades to the same retryable 503 a busy lane
# returns, which is a designed, self-healing outcome for a crawler; worker
# starvation is not. That is the direction to err in if this ever needs
# retuning.
_CHUNK_STATEMENT_TIMEOUT_MS = 1000
_LOCAL_DB_LOCKS_GUARD = threading.Lock()
_LOCAL_DB_LOCKS = {}


logger = logging.getLogger(__name__)

_SITEMAP_CHUNK_EVENT = "sitemap_chunk"
_SITEMAP_INDEX_EVENT = "sitemap_index"
_SITEMAP_EVENT_MAX_BYTES = 4096
_SITEMAP_EVENT_LEVELS = {
    "INFO": logging.INFO,
    "WARNING": logging.WARNING,
    "ERROR": logging.ERROR,
}
_SAFE_ERROR_STACK_DEPTH = 8
_SAFE_FRAME_COMPONENT_RE = re.compile(r"[^A-Za-z0-9_.<>-]")


def _log_sitemap_event(
    outcome,
    severity,
    message,
    *,
    event=_SITEMAP_CHUNK_EVENT,
    **fields,
):
    """Emit one-line JSON that Cloud Logging can turn into ``jsonPayload``."""
    payload = {
        "severity": severity,
        "message": message,
        "event": event,
        "outcome": outcome,
        **fields,
    }
    line = json.dumps(payload, separators=(",", ":"))
    if len(line.encode("utf-8")) > _SITEMAP_EVENT_MAX_BYTES:
        # Keep the metric contract and a visible diagnostic, but never let a
        # future field turn one public request into an unbounded log entry.
        # json.dumps() escapes non-ASCII by default, so this fallback is also
        # guaranteed to fit the byte cap.
        bounded_fields = {}
        for name in (
            "sitemap_kind",
            "sitemap_page",
            "expected_count",
            "actual_count",
            "operation",
            "error_kind",
            "error_category",
            "error_type",
            "sqlstate",
        ):
            if name not in fields:
                continue
            value = fields[name]
            bounded_fields[name] = (
                value[:120] if isinstance(value, str) else value
            )
        line = json.dumps(
            {
                "severity": severity,
                "message": "Sitemap event exceeded its safe logging bound.",
                "event": event,
                "outcome": outcome,
                **bounded_fields,
                "payload_truncated": True,
            },
            separators=(",", ":"),
        )
    logger.log(_SITEMAP_EVENT_LEVELS.get(severity, logging.ERROR), line)


def _database_sqlstate(exc):
    """Return only PostgreSQL's fixed five-character SQLSTATE contract."""
    for attribute in ("pgcode", "sqlstate"):
        try:
            value = getattr(exc, attribute, None)
        except Exception:
            continue
        if isinstance(value, str) and re.fullmatch(r"[0-9A-Z]{5}", value):
            return value
    return None


def _safe_exception_text(exc):
    """Best-effort text for classification only; never return or log it."""
    try:
        return str(exc).lower()
    except Exception:
        return ""


def _database_error_kind(exc):
    """Classify an explicit PostgreSQL statement-timeout cancellation."""
    cause = exc.__cause__ or exc
    sqlstate = _database_sqlstate(cause)
    if "statement timeout" in _safe_exception_text(cause):
        return "statement_timeout"
    if sqlstate == "57014":
        # PostgreSQL uses the same stable SQLSTATE for statement_timeout and
        # external query cancellation. Keep the generic fallback distinct so
        # it is not mislabeled, while still making it observable if server
        # messages are localized or driver wording changes.
        return "query_cancelled"
    return "operational_error"


def _database_error_category(exc):
    """Classify common failures without copying database text into logs."""
    cause = exc.__cause__ or exc
    message = _safe_exception_text(cause)
    sqlstate = _database_sqlstate(cause)

    if "statement timeout" in message:
        return "statement_timeout"
    if sqlstate == "57014":
        return "query_cancelled"
    if sqlstate in {"57P01", "57P02", "57P03"}:
        return "server_unavailable"
    if sqlstate and sqlstate.startswith("08"):
        return "connection_failure"
    if sqlstate and sqlstate.startswith("53"):
        return "resource_exhausted"

    message_categories = (
        ("connection_refused", ("connection refused",)),
        (
            "connection_closed",
            (
                "server closed the connection",
                "connection is closed",
                "connection already closed",
            ),
        ),
        (
            "name_resolution",
            (
                "could not translate host name",
                "name or service not known",
                "temporary failure in name resolution",
            ),
        ),
        ("connection_timeout", ("connection timed out", "timeout expired")),
        ("transport_security", ("ssl", "tls")),
    )
    for category, needles in message_categories:
        if any(needle in message for needle in needles):
            return category
    return "operational_error"


def _database_error_fields(exc, operation="chunk_read"):
    """Return useful database metadata without exposing exception messages."""
    cause = exc.__cause__ or exc
    sqlstate = _database_sqlstate(cause)
    error_type = _SAFE_FRAME_COMPONENT_RE.sub("_", type(cause).__name__)[:120]
    error_category = _database_error_category(exc)
    error_stack = _safe_error_stack(exc)
    # Never hash exception text. Even a one-way digest would let someone test
    # guesses for a leaked hostname, username, SQL fragment, or credential.
    # These safe, bounded fields still correlate failures at the same code
    # origin without creating that oracle.
    fingerprint_source = json.dumps(
        {
            "operation": operation,
            "error_type": error_type,
            "sqlstate": sqlstate,
            "error_category": error_category,
            "error_origin": error_stack[-1] if error_stack else None,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    fields = {
        "operation": operation,
        "error_kind": _database_error_kind(exc),
        "error_category": error_category,
        "error_type": error_type,
        "error_fingerprint": hashlib.sha256(
            fingerprint_source.encode("utf-8")
        ).hexdigest()[:16],
    }
    if sqlstate:
        fields["sqlstate"] = sqlstate
    if error_stack:
        fields["error_stack"] = error_stack
    return fields


def _safe_error_stack(exc):
    """Identify failure frames without logging source, locals, paths, or text."""
    traceback = exc.__traceback__
    if traceback is None and exc.__cause__ is not None:
        traceback = exc.__cause__.__traceback__

    frames = []
    while traceback is not None:
        frame = traceback.tb_frame
        module = frame.f_globals.get("__name__", "unknown")
        function = frame.f_code.co_name
        # Module and function names come from loaded code, but sanitize and
        # bound them anyway so a dynamically-created exception cannot turn a
        # diagnostic field into an unbounded or multiline log payload.
        safe_module = _SAFE_FRAME_COMPONENT_RE.sub("_", str(module))[:120]
        safe_function = _SAFE_FRAME_COMPONENT_RE.sub("_", str(function))[:120]
        frames.append(f"{safe_module}:{safe_function}:{traceback.tb_lineno}")
        traceback = traceback.tb_next
    return frames[-_SAFE_ERROR_STACK_DEPTH:]


class SitemapDatabaseBusy(RuntimeError):
    """The bounded sitemap database lane is already held."""


class SitemapDatabaseUnavailable(SitemapDatabaseBusy):
    """The database failed while coordinating a sitemap lane."""


def _read_index_cache():
    try:
        return cache.get(_INDEX_CACHE_KEY)
    except Exception as exc:
        raise SitemapDatabaseBusy from exc


def _require_shared_cache():
    """Fail closed before an aggregate when the shared cache is unavailable."""
    try:
        wrote_health_key = cache.add(
            _CACHE_HEALTH_KEY, True, _CACHE_HEALTH_SECONDS
        )
        if wrote_health_key is not True:
            wrote_health_key = cache.touch(
                _CACHE_HEALTH_KEY, _CACHE_HEALTH_SECONDS
            )
        if wrote_health_key is not True:
            raise SitemapDatabaseBusy
        if cache.get(_CACHE_HEALTH_KEY) is not True:
            raise SitemapDatabaseBusy
    except SitemapDatabaseBusy:
        raise
    except Exception as exc:
        raise SitemapDatabaseBusy from exc


def _store_index_cache(payload, timeout=_INDEX_CACHE_SECONDS):
    try:
        cache.set(_INDEX_CACHE_KEY, payload, timeout)
        if cache.get(_INDEX_CACHE_KEY) != payload:
            raise SitemapDatabaseBusy
    except SitemapDatabaseBusy:
        raise
    except Exception as exc:
        raise SitemapDatabaseBusy from exc


def _chunk_lock_id(kind, page):
    """Map one child onto its own lane, identically in every process."""
    # Not hash(): PYTHONHASHSEED randomizes str hashing per process, so the
    # same child would get a different lane on every pod and the lane would
    # stop coordinating anything.
    digest = hashlib.sha256(
        f"{_CHUNK_LOCK_SALT}:{kind}:{page}".encode("utf-8")
    ).digest()
    # Force the sign bit, then reinterpret as a signed int64: every chunk lane
    # is negative and the index lane is positive, so they cannot collide.
    return (int.from_bytes(digest[:8], "big") | (1 << 63)) - (1 << 64)


def _local_lock(lock_id):
    """Return the in-process stand-in lane used off PostgreSQL."""
    with _LOCAL_DB_LOCKS_GUARD:
        lock = _LOCAL_DB_LOCKS.get(lock_id)
        if lock is None:
            # One entry per lane ever used in this process. Only reachable off
            # PostgreSQL -- i.e. the sqlite dev/test path, which is
            # single-process and whose sitemap has a handful of children -- so
            # it is not a growth concern. Production is PostgreSQL and never
            # touches this dict.
            lock = _LOCAL_DB_LOCKS[lock_id] = threading.Lock()
        return lock


def _acquire_database_lock(lock_id):
    """Take one lane for the rest of the CURRENT transaction, or refuse.

    Must run inside ``transaction.atomic()`` -- use:func:`_database_lane`,
    which opens it. ``pg_try_advisory_xact_lock`` is transaction-scoped:
    PostgreSQL releases it at COMMIT or ROLLBACK and there is no unlock call.
    That is what makes the lane correct behind PgBouncer in transaction mode,
    where the old session lock (``pg_try_advisory_lock`` here, then
    ``pg_advisory_unlock`` in a later statement) could be taken on one server
    connection and "released" on another, leaving the lane held forever by a
    pooled backend and every later request answered ``SitemapDatabaseBusy``.
    Called in autocommit it would be taken and dropped by the same implicit
    single-statement transaction -- a lane that coordinates nothing -- so that
    is refused loudly rather than degraded silently.
    """
    if connection.vendor != "postgresql":
        if not _local_lock(lock_id).acquire(blocking=False):
            raise SitemapDatabaseBusy
        return "local"

    if not connection.in_atomic_block:
        raise AssertionError(
            "sitemap lanes are transaction-scoped: acquire inside "
            "transaction.atomic() (use _database_lane)"
        )
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_try_advisory_xact_lock(%s)", [lock_id])
            acquired = cursor.fetchone()[0]
    except (OperationalError, InterfaceError) as exc:
        # The enclosing atomic rolls back (or, if the connection is gone,
        # Django closes it), and either ends the transaction that would own
        # the lock -- nothing can outlive this failure.
        raise SitemapDatabaseUnavailable from exc

    if not acquired:
        raise SitemapDatabaseBusy
    return "postgresql"


@contextlib.contextmanager
def _database_lane(lock_id):
    """Hold one sitemap lane for the duration of the ``with`` body.

    On PostgreSQL the body runs inside the transaction that owns a
    ``pg_try_advisory_xact_lock``, so the lane is released exactly when that
    transaction ends: on a normal exit (COMMIT), on an exception (ROLLBACK),
    or on a dead connection (the session ends). Semantics under contention are
    the old ones -- a non-blocking try, and:class:`SitemapDatabaseBusy` to the
    loser, raised from the ``with`` statement before the body runs.

    A database failure while ENTERING the lane (opening the connection, or the
    lock query itself) raises:class:`SitemapDatabaseUnavailable`; failures in
    the body propagate unchanged, exactly as they did around the old
    acquire/try/finally-release pair.

    Inside an ambient transaction (a ``TestCase``; never a sitemap GET, which
    ``AtomicMiddleware`` does not wrap and ``ATOMIC_REQUESTS`` is off) the
    atomic here is only a savepoint, so the lane is held until the OUTER
    transaction ends. The lock is re-entrant for its own session, so that
    changes nothing a single caller can observe.
    """
    if connection.vendor != "postgresql":
        lock = _local_lock(lock_id)
        if not lock.acquire(blocking=False):
            raise SitemapDatabaseBusy
        try:
            yield
        finally:
            lock.release()
        return

    entered = False
    try:
        with transaction.atomic():
            _acquire_database_lock(lock_id)
            entered = True
            yield
    except (OperationalError, InterfaceError) as exc:
        if entered:
            raise
        # Opening the transaction (connecting, CONN_HEALTH_CHECKS) failed
        # before the lock query ran.
        raise SitemapDatabaseUnavailable from exc


def _build_chunk_under_statement_timeout(kind, page):
    """Build one chunk with a hard bound on how long the database may take."""
    if connection.vendor != "postgresql":
        return build_sitemap_chunk(kind, page)

    # SET LOCAL, via set_config(..., is_local=True) because plain SET takes no
    # bind parameters. Being transaction-local is the point: CONN_MAX_AGE is
    # 60s, so a session-level SET would leak this timeout onto every later
    # request that reused the pooled connection.
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT set_config('statement_timeout', %s, true)",
                [f"{_CHUNK_STATEMENT_TIMEOUT_MS}ms"],
            )
        return build_sitemap_chunk(kind, page)


def _build_index_under_statement_timeout():
    """Build the full index manifest with a hard database time bound."""
    if connection.vendor != "postgresql":
        return build_sitemap_index()

    # The index consists of two expression aggregates. Keep both statements
    # inside the same transaction so SET LOCAL applies to each one, and keep
    # the transaction here rather than relying on a caller's ambient test or
    # request transaction. Without this atomic block, SET LOCAL runs in the
    # implicit transaction for its own statement and silently resets before
    # the aggregate begins.
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SHOW statement_timeout")
            previous_timeout = cursor.fetchone()[0]
            cursor.execute(
                """
                SELECT set_config(
                    'statement_timeout',
                    (
                        EXTRACT(
                            EPOCH FROM COALESCE(
                                LEAST(
                                    NULLIF(
                                        current_setting('statement_timeout'),
                                        '0'
                                    )::interval,
                                    %s::interval
                                ),
                                %s::interval
                            )
                        ) * 1000
                    )::bigint::text || 'ms',
                    true
                )
                """,
                [
                    f"{_INDEX_STATEMENT_TIMEOUT_MS}ms",
                    f"{_INDEX_STATEMENT_TIMEOUT_MS}ms",
                ],
            )
        payload = build_sitemap_index()
        # A nested atomic block is only a savepoint. On the success path,
        # SET LOCAL would otherwise remain in force until an ambient outer
        # transaction commits, potentially poisoning unrelated queries in the
        # same request. An exception rolls back this block and restores the
        # prior value automatically.
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT set_config('statement_timeout', %s, true)",
                [previous_timeout],
            )
        return payload


def _revision_digest(kind, page, count):
    digest = salted_hmac(
        _REVISION_SALT,
        f"{kind}:{page}:{count}",
        algorithm="sha256",
    ).digest()[:12]
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def make_sitemap_revision(kind, page, count):
    """Return a non-forgeable capability for one manifest member."""
    return f"{count}-{_revision_digest(kind, page, count)}"


def parse_sitemap_revision(kind, page, revision):
    """Return the signed expected row count, or ``None`` without DB access."""
    match = _REVISION_RE.fullmatch(revision)
    if not match:
        return None
    count = int(match.group("count"))
    if count > SITEMAP_CHUNK_SIZE:
        return None
    expected = make_sitemap_revision(kind, page, count)
    return count if constant_time_compare(revision, expected) else None


def _creator_queryset():
    return Creator.objects.filter(is_active=True).exclude(
        Q(banner_image__isnull=True) | Q(avatar_image__isnull=True)
    )


def _zpage_queryset():
    # `published_and_active()` rather than `is_published=True`. The
    # creator queryset above has always filtered `is_active`, so before this a
    # deactivated creator vanished from `/sitemap/creators/*.xml` while every
    # one of their article URLs stayed enumerated in
    # `/sitemap/zpages/*.xml` -- a takedown that goes on handing Google the
    # list of pages to fetch. This is also the only place the SvelteKit
    # sitemap needs fixing: `src/lib/server/sitemap.ts` renders whatever this
    # endpoint returns, so the two tiers cannot disagree here.
    #
    # `RESERVED_VANITIES` exclusion: `validate_vanity` has refused a
    # new zPage with one of these vanities since, but rows written before
    # that reservation existed can still carry one -- and the crawler tier
    # already 404s all of them via `_reject_reserved_vanity` in
    # `views/crawler.py`. Without this the sitemap advertises e.g.
    # `/{username}/dashboard` as an article URL while the reader tier serves
    # the SvelteKit dashboard route there instead, a URL Google is handed that
    # never renders the thing it is indexed for. Case-insensitive
    # (`Lower('vanity')`) because a legacy row can be mixed-case
    # (`Dashboard`) while `_reject_reserved_vanity` matches on
    # `value.lower()` -- a plain `vanity__in` would leave exactly those rows
    # advertised.
    return (
        zPage.objects.published_and_active()
        .filter(canonical_url='')
        .exclude(title='')
        .exclude(vanity='')
        .exclude(vanity__isnull=True)
        .annotate(_vanity_lower=Lower('vanity'))
        .exclude(_vanity_lower__in=RESERVED_VANITIES)
    )


def _tag_queryset():
    # `/tag/<slug>` topic hubs. The gate, the visibility rule and the
    # "has a slug at all" filter all live in `dj.apps.tagging.hubs` next to the
    # view that renders the page, so the sitemap and the hub cannot disagree
    # about which URLs are indexable -- a submitted URL that then declares
    # `noindex` is the one failure this costs real Search Console credit for.
    return tagging_hubs.sitemap_tag_queryset()


def _page_expression(chunk_size):
    # Integer primary keys make every page an index-backed ID range rather
    # than an increasingly expensive OFFSET. Subtracting one gives pages
    # exactly `chunk_size` possible IDs: 1..500, 501..1000, and so on.
    return Cast(
        (F('pk') - Value(1)) / Value(chunk_size),
        output_field=BigIntegerField(),
    )


def _page_manifest(queryset, chunk_size, limit=None):
    manifest = (
        queryset.annotate(page=_page_expression(chunk_size))
        .values('page')
        .annotate(count=Count('pk'))
        .order_by('page')
        .values('page', 'count')
    )
    if limit is not None:
        manifest = manifest[:limit]
    return list(manifest)


def _bounded_page_manifest(queryset, chunk_size, max_pages):
    return _page_manifest(queryset, chunk_size, limit=max_pages + 1)


def build_sitemap_index(
    chunk_size=SITEMAP_CHUNK_SIZE,
    max_dynamic_pages=SITEMAP_MAX_DYNAMIC_PAGES,
):
    """Return bounded deterministic pages, or ``None`` if the index is full."""
    creators = _bounded_page_manifest(
        _creator_queryset(), chunk_size, max_dynamic_pages
    )
    if len(creators) > max_dynamic_pages:
        return None

    remaining = max_dynamic_pages - len(creators)
    zpages = _bounded_page_manifest(_zpage_queryset(), chunk_size, remaining)
    if len(zpages) > remaining:
        return None

    # Tags take what is left AFTER creators and zpages, deliberately: an
    # article URL is the thing being ranked and a hub is how it gets found, so
    # if the 50,000-child ceiling is ever reached the hubs are what should be
    # dropped.
    remaining -= len(zpages)
    tags = _bounded_page_manifest(_tag_queryset(), chunk_size, remaining)
    if len(tags) > remaining:
        return None

    for kind, pages in (
        ("creators", creators), ("zpages", zpages), ("tags", tags),
    ):
        for item in pages:
            item["revision"] = make_sitemap_revision(
                kind, item["page"], item["count"]
            )

    return {
        'chunk_size': chunk_size,
        'creators': creators,
        'zpages': zpages,
        'tags': tags,
    }


def get_cached_sitemap_index():
    """Cache only the bounded manifest under one non-user-controlled key."""
    payload = _read_index_cache()
    if payload == _INDEX_OVERFLOW_SENTINEL:
        return None
    if payload == _INDEX_BUSY_SENTINEL:
        raise SitemapDatabaseBusy
    if payload is not None:
        return payload

    # Production deliberately ignores Redis exceptions. A plain miss therefore
    # cannot distinguish "not cached" from "cache unavailable"; prove a fixed
    # coordination key round-trips before allowing the expensive aggregate.
    _require_shared_cache()
    with _database_lane(_INDEX_DB_LOCK_ID):
        # Another request may have populated the fixed cache key between this
        # request's first miss and its lock acquisition.
        payload = _read_index_cache()
        if payload == _INDEX_OVERFLOW_SENTINEL:
            return None
        if payload == _INDEX_BUSY_SENTINEL:
            raise SitemapDatabaseBusy
        if payload is not None:
            return payload

        # The cache may have failed while this request waited for the database
        # lane. Re-probe immediately before the aggregate.
        _require_shared_cache()
        try:
            payload = _build_index_under_statement_timeout()
        except (OperationalError, InterfaceError):
            # Suppress repeated aggregate attempts while the database is
            # degraded. This matches the 30-second Retry-After response and
            # avoids turning many independent retries into a steady stream of
            # one-second failing scans. Re-raising rolls back the lane's
            # transaction, which releases the lane.
            try:
                _store_index_cache(_INDEX_BUSY_SENTINEL, _INDEX_BUSY_SECONDS)
            except SitemapDatabaseBusy:
                pass
            raise
        if payload is None:
            _store_index_cache(_INDEX_OVERFLOW_SENTINEL)
            return None

        _store_index_cache(payload)
        return payload


def _available_languages(source_language, translation_languages):
    """The variant list, ordered exactly as the zPage API reports it.

    Byte-for-byte the ordering:func:`localization.resolve_zpage_variant`
    produces for ``available_languages`` on a published page: real languages
    sorted by tag, with a non-language source (``und``) kept at the front
    rather than dropped or pretended to be English.

    Matching that ordering is not cosmetic. The SvelteKit sitemap feeds this
    list to the *same* ``cleanUrlLanguage`` / ``articleLanguageAlternates``
    helpers the article page feeds its ``available_languages`` to, so a sitemap
    URL and that URL's own ``rel=canonical`` are computed from one input by one
    function. Diverge here and the sitemap starts advertising URLs whose pages
    canonicalize elsewhere, which costs the whole hreflang cluster.
    """
    available = set(translation_languages)
    if source_language:
        available.add(source_language)
    ordered = sorted(code for code in available if is_content_language(code))
    if source_language and not is_content_language(source_language):
        ordered.insert(0, source_language)
    # NULL source_language means "detection has not run yet" ( §3.2) --
    # `zPage.source_language` has been nullable and M7 makes NULL
    # the replacement for `und`. It is not a language, so it is not a variant:
    # an untranslated page in that state reports `[]`, which the SvelteKit
    # renderer treats exactly like a single unnameable variant and emits the
    # clean URL with no cluster. Inserting a null here instead would put a
    # `null` in a list the parser requires to hold strings, and 503 the whole
    # chunk the day detection first leaves a row unlabelled.
    return _truncate_variants(ordered, source_language)


def _truncate_variants(ordered, source_language, cap=None):
    """``ordered`` cut to ``cap`` entries, source first, order preserved.

    Split out because it runs at TWO points with two different caps: here, at
    the contract's own ceiling, and again in:class:`SitemapChunkView` at the
    LEGACY ceiling when the caller is a SvelteKit replica that predates
    (see SITEMAP_LEGACY_VARIANT_CAP). One rule, so the two can never disagree
    about which language a truncated article keeps.
    """
    cap = SITEMAP_MAX_VARIANTS_PER_ZPAGE if cap is None else cap
    if len(ordered) <= cap:
        return ordered

    # Over the bound the renderer will accept. Truncate rather than raise:
    # raising takes a whole sitemap child (up to 500 unrelated articles)
    # offline over one unusual article, and only legacy or directly-mutated
    # rows can get here at all now that the bound is derived from the write
    # path's own cap (see SITEMAP_MAX_VARIANTS_PER_ZPAGE).
    #
    # WHICH languages get dropped used to be decided by SITEMAP_NAMED_LANGUAGES
    # -- `frozenset(languages.UI_LOCALES)`, the four locales the product chrome
    # is translated into -- on the premise that everything outside it was
    # unnameable and so lossless to discard.  deleted that premise: every
    # content language is linkable and gets an `hreflang`, so there is no
    # second class of variant left to drop preferentially. The partition is
    # gone with it.
    #
    # What replaces it is the one ordering constraint that is actually
    # load-bearing: THE SOURCE MUST SURVIVE. It owns the clean URL whenever
    # nothing else is negotiated, it is the `x-default` target, and
    # `cleanUrlLanguage` is computed from this very list on both tiers. A
    # plain `ordered[:N]` is sorted by tag, so a `zh-Hant` source would be
    # truncated away by 65 alphabetically-earlier translations and the
    # article's own canonical would start disagreeing with its cluster. Keep
    # it explicitly, then fill the remainder in the list's own order so the
    # result is still the ordering `resolve_zpage_variant` produces.
    keep = []
    if source_language in ordered:
        keep.append(source_language)
    for code in ordered:
        if len(keep) >= cap:
            break
        if code not in keep:
            keep.append(code)
    kept = set(keep)
    return [code for code in ordered if code in kept]


def _negotiated_variant_cap(request):
    """How many languages per row THIS caller's parser can read.

    Three generations of SvelteKit reader exist at once during a rollout, and
    `bin/bazel-apply.sh` rolls Django FIRST, so every one of them is a live
    caller of a backend that already knows the newest number. A row longer than
    the reader's own bound makes `parseLanguages` throw, which 503s that whole
    sitemap child and takes up to 499 unrelated articles offline for the length
    of the rollout -- or indefinitely if the frontend roll fails. So the width
    is something the caller STATES, never something this side assumes.

    Newest first:

    * ``X-Free2Z-Sitemap-Max-Variants: <n>``  -- the caller's own
      number, honoured up to SITEMAP_MAX_VARIANTS_PER_ZPAGE. This is the form
      that makes the next cap change a one-sided deploy again: a new reader
      asking for more than this backend has is simply given this backend's
      maximum, and a new backend never exceeds what the reader asked for.
    * ``X-Free2Z-Sitemap-Wide-Variants: 1``  -- a BOOLEAN, so it can
      only mean the one width that generation was compiled with: 65. Not
      re-derived, frozen, for the same reason SITEMAP_LEGACY_VARIANT_CAP is.
      Treating it as "the current maximum" is exactly the bug  found.
    * Neither -- SITEMAP_LEGACY_VARIANT_CAP, the pre- parser's 32.

    Never an error. A malformed, negative or non-numeric width is a broken
    representation hint on a read, and degrading to a narrower answer always
    renders while a 4xx hands the crawler nothing.
    """
    stated = request.headers.get(SITEMAP_MAX_VARIANTS_HEADER)
    if stated is not None:
        try:
            width = int(stated)
        except (TypeError, ValueError):
            width = 0
        if width >= 1:
            return min(width, SITEMAP_MAX_VARIANTS_PER_ZPAGE)
    if request.headers.get(SITEMAP_WIDE_VARIANTS_HEADER) == '1':
        return min(
            SITEMAP_WIDE_VARIANTS_GENERATION_CAP,
            SITEMAP_MAX_VARIANTS_PER_ZPAGE,
        )
    return SITEMAP_LEGACY_VARIANT_CAP


def _zpage_variant_index(start_pk, end_pk, cap=None):
    """Map each zPage id to its published translation languages and mtimes.

    One extra bounded query per chunk, and it is deliberately the SAME SHAPE as
    the chunk's own zPage read: a primary-key range on ``zpage_id``, not an
    ``IN`` list of the ids that survived the visibility filter.

    That is not a style preference, it is the whole cost story. Measured on a
    40,000-zPage corpus (10x production) with EXPLAIN ANALYZE:

        14,000 translations   IN-list    Seq Scan, 4.4 ms  (13,850 rows discarded)
        14,000 translations   pk-range   Index Scan on
                                         g12f_zpage_translation_pub_idx, 0.18 ms
        414,000 translations  IN-list    Index Scan, 4.3 ms
        414,000 translations  pk-range   Index Scan, 2.0 ms

    A 500-element ``= ANY(...)`` is opaque enough that PostgreSQL prefers a
    sequential scan while the table is small -- which is exactly the regime we
    are in today, and exactly the plan that would silently start overrunning
    ``_CHUNK_STATEMENT_TIMEOUT_MS`` as the table grows. A contiguous range is
    index-backed at every size.

    The range covers ids the visibility filter excludes (drafts, external
    canonicals, blank titles); their rows are simply not looked up by the
    caller. The bound is therefore expressed in terms of the RANGE, not the
    number of visible rows, which is the honest bound: the query cannot know
    which ids were kept.

    Three narrow columns, and never ``content`` -- the same discipline
    ``localized_list_translation_prefetch`` applies on the list endpoints, so a
    multi-row read cannot drag 100,000-character bodies through a pod's only
    sync gunicorn worker.

    ``order_by`` is explicit because ``ZPageTranslation.Meta.ordering`` is
    ``["language"]``: inheriting it would sort the whole filtered set by a
    column the index cannot supply. ``(zpage_id, language)`` is index-ordered
    *and* deterministic, which is what makes the LIMIT a meaningful bound
    rather than an arbitrary truncation.
    """
    cap = SITEMAP_MAX_VARIANT_ROWS_PER_CHUNK if cap is None else cap
    rows = list(
        ZPageTranslation.objects.filter(
            zpage_id__gte=start_pk,
            zpage_id__lt=end_pk,
            # Drafts are not content. A translation a creator has not published
            # must never reach a sitemap, and this is the only filter standing
            # between an unpublished variant and a crawler.
            is_published=True,
        )
        .order_by('zpage_id', 'language')
        .values_list('zpage_id', 'language', 'updated_at')[:cap + 1]
    )
    if len(rows) > cap:
        raise RuntimeError('Sitemap variant page exceeded its fixed bound.')

    index = {}
    for zpage_id, language, updated_at in rows:
        languages, latest = index.get(zpage_id, ([], None))
        languages.append(language)
        index[zpage_id] = (
            languages,
            updated_at if latest is None or updated_at > latest else latest,
        )

    if variant_reads_enabled():
        index = _apply_variant_languages(index, start_pk, end_pk, cap)
    return index


def _variant_language_index(start_pk, end_pk, cap):
    """Published TRANSLATION variant languages per zPage, from ``ZPageVariant``.

    The same pk-range shape and the same fixed bound as the translation sweep
    above, for the same measured reason -- a 500-element ``IN`` list is opaque
    enough that PostgreSQL will choose a sequential scan on a table this size.

    ``origin='source'`` is excluded, and that is a parity requirement rather
    than tidiness: the source is not a "translation" here, and its ``lastmod``
    is the zPage's own, already carried by the chunk row.
    """
    rows = list(
        ZPageVariant.objects.filter(
            zpage_id__gte=start_pk,
            zpage_id__lt=end_pk,
            is_published=True,
        )
        .exclude(origin=ZPageVariant.SOURCE)
        .order_by('zpage_id', 'language')
        .values_list('zpage_id', 'language')[:cap + 1]
    )
    if len(rows) > cap:
        raise RuntimeError('Sitemap variant page exceeded its fixed bound.')

    index = {}
    for zpage_id, language in rows:
        index.setdefault(zpage_id, []).append(language)
    return index


def _apply_variant_languages(index, start_pk, end_pk, cap):
    """Swap in the variant table's language set, keep the legacy ``lastmod``.

    **M5 flips content, not clocks.** Dual write does not mirror timestamps:
    ``ZPageVariant.updated_at`` is ``auto_now``, so it records when the MIRROR
    was written, and for every row migration ``0100`` created that is the date
    of the backfill. Taking ``lastmod`` from it would tell every crawler that
    a 2024 Spanish translation changed on deploy day -- a corpus-wide, false
    freshness signal, which is the one thing ``lastmod`` must never be, and it
    would arrive for free with a flag that is supposed to change nothing.

    So the LANGUAGES -- the set that decides which URLs and ``xhtml:link``
    alternates exist, i.e. the part a reader can actually reach -- come from
    the variant table, and the translation sweep's ``lastmod`` stays. On a
    reconciled corpus the two language sets are equal by construction; the
    parity suite asserts it, and the reconciler is what makes it true.
    """
    languages_by_page = _variant_language_index(start_pk, end_pk, cap)
    merged = {}
    for zpage_id in set(index) | set(languages_by_page):
        _legacy_languages, latest = index.get(zpage_id, ([], None))
        merged[zpage_id] = (languages_by_page.get(zpage_id, []), latest)
    return merged


def build_sitemap_chunk(kind, page, chunk_size=SITEMAP_CHUNK_SIZE):
    """Return one bounded, offset-free sitemap page, or ``None`` when empty."""
    start_pk = (page * chunk_size) + 1
    end_pk = ((page + 1) * chunk_size) + 1

    if kind == 'creators':
        rows = list(
            _creator_queryset()
            .filter(pk__gte=start_pk, pk__lt=end_pk)
            .order_by('pk')
            .values('username')[:chunk_size + 1]
        )
    elif kind == 'zpages':
        rows = list(
            _zpage_queryset()
            .filter(pk__gte=start_pk, pk__lt=end_pk)
            .order_by('pk')
            .values(
                'id',
                'vanity',
                'free2zaddr',
                'updated_at',
                'source_language',
                username=F('creator__username'),
            )[:chunk_size + 1]
        )
        # Skip the second query entirely for an empty or over-long page: the
        # first returns None below and the second raises, so neither is worth
        # a read.
        if 1 <= len(rows) <= chunk_size:
            variants = _zpage_variant_index(start_pk, end_pk)
            for row in rows:
                languages, translated_at = variants.get(row.pop('id'), ([], None))
                row['languages'] = _available_languages(
                    row['source_language'], languages
                )
                # A translation edit does not touch `zPage.updated_at`, so
                # without this the Spanish URL of an article whose Spanish text
                # was rewritten yesterday advertises the source's lastmod and
                # may simply not be recrawled. Reported per zPage rather than
                # per URL: one field, and it errs toward an extra crawl instead
                # of a missed one.
                if translated_at is not None and translated_at > row['updated_at']:
                    row['updated_at'] = translated_at
        else:
            for row in rows:
                row.pop('id', None)
    elif kind == 'tags':
        rows = [
            {'slug': slugify_tag(name)}
            for name in (
                tagging_hubs.sitemap_tag_queryset(
                    start_pk=start_pk, end_pk=end_pk
                )
                .order_by('pk')
                .values_list('name', flat=True)[:chunk_size + 1]
            )
        ]
        # No filtering of empty slugs here, and that is load-bearing rather
        # than an oversight: the row count has to equal the count the index
        # signed, or `SitemapChunkView` answers 409 for this child forever.
        # `sitemap_tag_queryset()` guarantees a non-empty slug in SQL instead,
        # and the canonical root's source name derives the same slug without
        # embedding one SQL CASE arm per sitemap candidate.
        #
        # `sitemap_tag_queryset()` uses the same globally resolved,
        # representative-deduplicated set for the index and this PK slice, so
        # an ordinary slug collision cannot make the signed count diverge.
    else:
        raise ValueError(f'Unsupported sitemap kind: {kind}')

    if not rows:
        return None
    if len(rows) > chunk_size:
        raise RuntimeError('Sitemap primary-key page exceeded its fixed bound.')

    return {
        'kind': kind,
        'page': page,
        kind: rows,
    }


class SitemapIndexView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    renderer_classes = [JSONRenderer]

    @extend_schema(
        responses={
            200: SitemapIndexSerializer,
            400: {'description': 'Query parameters are not accepted.'},
            503: {
                'description': (
                    'The sitemap index is temporarily busy or over capacity.'
                ),
            },
        },
        operation_id='sitemap_index_retrieve',
        description=(
            'Return deterministic nonempty pages used to build sitemap.xml.'
        ),
    )
    def get(self, request):
        if request.query_params:
            return Response(
                {'detail': 'This endpoint does not accept query parameters.'},
                status=status.HTTP_400_BAD_REQUEST,
                headers=_NO_STORE_HEADERS,
            )

        try:
            payload = get_cached_sitemap_index()
        except SitemapDatabaseUnavailable as exc:
            _log_sitemap_event(
                "database_error",
                "ERROR",
                "Sitemap index lane coordination failed at the database.",
                event=_SITEMAP_INDEX_EVENT,
                **_database_error_fields(
                    exc.__cause__ or exc,
                    operation="advisory_lock_acquire",
                ),
            )
            return Response(
                {'detail': 'Sitemap is temporarily busy.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
                headers={
                    'Cache-Control': 'no-store',
                    'Retry-After': '30',
                    'X-Sitemap-Protocol': '2',
                    _SITEMAP_OUTCOME_HEADER: 'database_error',
                },
            )
        except SitemapDatabaseBusy:
            return Response(
                {'detail': 'Sitemap is temporarily busy.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
                headers={
                    'Cache-Control': 'no-store',
                    'Retry-After': '30',
                    'X-Sitemap-Protocol': '2',
                },
            )
        except TagGraphTooLarge:
            # A corrupted or imported alias component is never truncated into
            # an asymmetric sitemap.  Omit the cached manifest and make the
            # crawler retry after reconciliation instead.
            return Response(
                {'detail': 'Sitemap tag graph is temporarily unavailable.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
                headers={
                    'Cache-Control': 'no-store',
                    'Retry-After': '300',
                    'X-Sitemap-Protocol': '2',
                },
            )
        except (OperationalError, InterfaceError) as exc:
            # Statement-timeout cancellations and lost connections are
            # retryable. Keep schema and programming failures uncaught so a
            # broken rollout still produces a traceback instead of looking
            # like ordinary crawler backpressure.
            _log_sitemap_event(
                "database_error",
                "ERROR",
                "Sitemap index read failed at the database.",
                event=_SITEMAP_INDEX_EVENT,
                **_database_error_fields(exc, operation="index_build"),
            )
            return Response(
                {'detail': 'Sitemap is temporarily busy.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
                headers={
                    'Cache-Control': 'no-store',
                    'Retry-After': '30',
                    'X-Sitemap-Protocol': '2',
                    _SITEMAP_OUTCOME_HEADER: 'database_error',
                },
            )
        if payload is None:
            return Response(
                {'detail': 'Sitemap index capacity exceeded.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
                headers={
                    'Cache-Control': 'no-store',
                    'Retry-After': '300',
                    'X-Sitemap-Protocol': '2',
                },
            )
        return Response(
            SitemapIndexSerializer(payload).data,
            headers=_NO_STORE_HEADERS,
        )


class SitemapChunkView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    renderer_classes = [JSONRenderer]

    @extend_schema(
        responses={
            200: SitemapChunkSerializer,
            400: {'description': 'Query parameters are not accepted.'},
            404: {'description': 'The requested sitemap page does not exist.'},
            409: {
                'description': (
                    'The sitemap changed after this page capability was issued.'
                ),
            },
            503: {'description': 'The fixed page bound was violated.'},
        },
        operation_id='sitemap_chunk_retrieve',
        description=(
            'Return one bounded, primary-key-ranged creator or internally '
            'canonicalized zPage sitemap page.'
        ),
    )
    def get(self, request, kind, page, revision):
        if request.query_params:
            return Response(
                {'detail': 'This endpoint does not accept query parameters.'},
                status=status.HTTP_400_BAD_REQUEST,
                headers=_NO_STORE_HEADERS,
            )
        if kind not in ('creators', 'zpages', 'tags') or page > SITEMAP_MAX_PAGE:
            return Response(
                {'detail': 'Sitemap page not found.'},
                status=status.HTTP_404_NOT_FOUND,
                headers=_NO_STORE_HEADERS,
            )
        expected_count = parse_sitemap_revision(kind, page, revision)
        if expected_count is None:
            return Response(
                {'detail': 'Sitemap page not found.'},
                status=status.HTTP_404_NOT_FOUND,
                headers=_NO_STORE_HEADERS,
            )

        # Per-child lane: two different children no longer contend, so the
        # parallel fetch of every advertised child that a sitemap index invites
        # is served rather than mostly 503'd. Replays of the SAME child
        # still serialize, and the loser still gets this retryable 503 -- that
        # backstop is intentionally kept, it just stops firing in normal use.
        lock_id = _chunk_lock_id(kind, page)
        # The lane is transaction-scoped: it is released when this
        # ExitStack closes the lane's transaction -- after the response data
        # is materialized, on every return path below and on any exception.
        with contextlib.ExitStack() as lane:
            try:
                lane.enter_context(_database_lane(lock_id))
            except SitemapDatabaseUnavailable as exc:
                _log_sitemap_event(
                    "database_error",
                    "ERROR",
                    "Sitemap chunk lane coordination failed at the database.",
                    sitemap_kind=kind,
                    sitemap_page=page,
                    **_database_error_fields(
                        exc.__cause__ or exc,
                        operation="advisory_lock_acquire",
                    ),
                )
                return Response(
                    {'detail': 'Sitemap is temporarily busy.'},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                    headers={
                        'Cache-Control': 'no-store',
                        'Retry-After': '30',
                        'X-Sitemap-Protocol': '2',
                        _SITEMAP_OUTCOME_HEADER: 'database_error',
                    },
                )
            except SitemapDatabaseBusy:
                return Response(
                    {'detail': 'Sitemap is temporarily busy.'},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                    headers={
                        'Cache-Control': 'no-store',
                        'Retry-After': '30',
                        'X-Sitemap-Protocol': '2',
                        _SITEMAP_OUTCOME_HEADER: 'lane_busy',
                    },
                )

            try:
                payload = _build_chunk_under_statement_timeout(kind, page)
                if payload is None or len(payload[kind]) != expected_count:
                    conflict = Response(
                        {
                            'detail': (
                                'Sitemap page changed; reload the sitemap index.'
                            ),
                        },
                        status=status.HTTP_409_CONFLICT,
                        headers={
                            **_NO_STORE_HEADERS,
                            _SITEMAP_OUTCOME_HEADER: 'revision_conflict',
                        },
                    )
                    # A designed answer, not a failure: a crawler replaying
                    # a child URL from an index it read before the chunk's row
                    # count moved (every publish in the newest chunk moves it).
                    # SvelteKit turns this into a valid one-URL sitemap, and the
                    # current index already advertises the new child URL. Its one
                    # log line is the gunicorn access record carrying
                    # `sitemap_outcome=revision_conflict`, which the
                    # sitemap_chunk_revision_conflicts metric counts. Without this,
                    # `django.request` ALSO writes "Conflict: <path>" at WARNING
                    # to stderr, which GKE grades ERROR -- ~20 a day in prod, all
                    # crawlers. `_has_been_logged` is the flag Django's own
                    # `log_response()` checks to skip a response already logged.
                    conflict._has_been_logged = True
                    return conflict

                # Materialize DRF's representation while this child's lane is
                # still held. Replays of the same child therefore cannot overlap
                # either the fresh query or its bounded serialization work.
                response_data = SitemapChunkSerializer(payload).data
                # Django and SvelteKit roll independently. An older SvelteKit
                # parser intentionally rejects unknown sitemap keys, so expose the
                # collision-safe address only to a caller that requested this
                # schema. New SvelteKit accepts both shapes and therefore also
                # works against an older Django replica that ignores the header.
                if kind == 'zpages':
                    if (
                        request.headers.get(
                            'X-Free2Z-Sitemap-Canonical-Address'
                        ) != '1'
                    ):
                        for row in response_data['zpages']:
                            row.pop('free2zaddr', None)
                    # Same reason, one contract over: a caller gets a variant
                    # list no longer than the one its parser was written against.
                    # Trimming HERE rather than in the query keeps the
                    # cached/queried payload version-independent -- one read
                    # serves every generation of caller. See
                    # _negotiated_variant_cap.
                    cap = _negotiated_variant_cap(request)
                    if cap < SITEMAP_MAX_VARIANTS_PER_ZPAGE:
                        for row in response_data['zpages']:
                            row['languages'] = _truncate_variants(
                                list(row['languages']),
                                row.get('source_language'),
                                cap=cap,
                            )
            except TagGraphTooLarge:
                _log_sitemap_event(
                    "bound_exceeded",
                    "WARNING",
                    "Sitemap tag graph exceeded its fixed safety bound.",
                    sitemap_kind=kind,
                    sitemap_page=page,
                )
                return Response(
                    {'detail': 'Sitemap tag graph is temporarily unavailable.'},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                    headers={
                        'Cache-Control': 'no-store',
                        'Retry-After': '300',
                        'X-Sitemap-Protocol': '2',
                    },
                )
            except RuntimeError:
                _log_sitemap_event(
                    "bound_exceeded",
                    "WARNING",
                    "Sitemap chunk exceeded its fixed page bound.",
                    sitemap_kind=kind,
                    sitemap_page=page,
                )
                return Response(
                    {'detail': 'Sitemap page bound exceeded.'},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                    headers={
                        'Cache-Control': 'no-store',
                        'Retry-After': '300',
                        'X-Sitemap-Protocol': '2',
                    },
                )
            except (OperationalError, InterfaceError) as exc:
                # Deliberately narrow: statement-timeout cancellations and lost
                # connections are OperationalError, and a retryable 503 is the
                # right thing to tell a crawler about those. A ProgrammingError or
                # IntegrityError -- a bad rollout, a schema mismatch -- is NOT
                # caught here; it must keep surfacing as a 500 with a traceback
                # rather than hiding behind an indistinguishable 503.
                #
                # Log even so: a silent 503 leaves only SvelteKit's "backend
                # failed with 503" and no cause. Deliberately omit the exception
                # message, source lines, locals, and filesystem paths: database
                # errors can contain SQL or other sensitive details. The safe
                # type, SQLSTATE, category, fingerprint, and module/function/line
                # stack signature retain correlation and failure-origin data.
                _log_sitemap_event(
                    "database_error",
                    "ERROR",
                    "Sitemap chunk read failed at the database.",
                    sitemap_kind=kind,
                    sitemap_page=page,
                    **_database_error_fields(exc),
                )
                return Response(
                    {'detail': 'Sitemap is temporarily busy.'},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                    headers={
                        'Cache-Control': 'no-store',
                        'Retry-After': '30',
                        'X-Sitemap-Protocol': '2',
                    },
                )

        return Response(
            response_data,
            headers=_NO_STORE_HEADERS,
        )
