"""The money for a paid AI translation ( §6.2).

ONE ROW IS THE WHOLE STORY
--------------------------
A translation charge needs somewhere durable to record "this creator paid N 2Z
for this language of this article, and here is what happened to it". The
obvious answer is a new table; the answer taken here is the
``dj.apps.tuzis.IdempotencyKey`` row that the request already has to create,
with the job's state in its ``response_body`` JSON.

That is not a shortcut, it is the property that makes the money safe: the
charge, the retry receipt and the delivery record are **the same row**, so
there is no window in which one exists and the others do not, and no second
table that can disagree with the first. It also means this ships with no
migration, which matters more than usual right now -- 's wave 2b owns the
schema and two agents claiming the same migration leaf number kills a deploy.

THE STATE MACHINE
-----------------
``queued``     debited, job enqueued. The only state in which money is at risk.
``delivered``  the draft variant exists. Terminal.
``refunded``   the full charge was credited back. Terminal.
``settled``    the failure was attributable to the request AND the provider had
               already done billable work, so the metered cost was kept and the
               rest credited back. Terminal. Never more than the quote.

Every transition is a compare-and-set under ``SELECT... FOR UPDATE`` on this
row, so the worker, a retry of the worker and the reaper below can all try at
once and exactly one wins.:func:`settle_failure` credits inside that same
transaction, which is what makes "refund twice" impossible rather than
unlikely.

WHY ``settled`` EXISTS
------------------------------
``refund()`` used to credit the FULL charge for every failure with no notion of
cause. That made a failed translation free to the buyer while the provider had
already billed us for every output token it generated -- measured at **$0.4447
of provider spend against $0.0000 of revenue** for one refunded failure on a
100,000-character zPage (gpt-4o, seeded prices, real tokenizer). Realised loss
so far is small (production has seen six refunds, ~$0.60, in fourteen days); the
defect is that the same 2Z come straight back, so nothing bounded how often it
could happen. See:mod:`settlement` for the full arithmetic.

``refund()`` still exists and still means "credit everything", and it is what
almost every failure resolves to::mod:`dj.apps.g12f.translation.settlement`
holds the fault table, and every failure mode we currently understand except
"the buyer mutated the article under a job they had already paid for, again"
is ours or the provider's. The mechanism is here so that the one attributable
class settles honestly, and so the decision is written down instead of implied.

THE TWO BUGS THIS DELIBERATELY DOES NOT REPRODUCE
--------------------------------------------------------
1. **Eligibility before the key.** ``CreatorSubscribeView`` checks the balance
   before it reads ``Idempotency-Key``, so a retry of a charge that SUCCEEDED
   is answered "insufficient funds" once the money is spent -- telling the
   client a completed purchase failed. The purchase view here claims the key
   FIRST and replays a completed claim before any balance is read; a test
   pins it.
2. **"The claim commits immediately".** That docstring is false under
   ``AtomicMiddleware``, which wraps the whole POST in one transaction. The
   purchase view sets ``atomic_request = False`` so it is true again, and owns
   its transaction boundaries explicitly.

WHY A REAPER EXISTS
-------------------
The debit commits and the job is enqueued on commit. Almost everything that
can go wrong afterwards is handled inside the job, which refunds. What is NOT
handled there is the job never running at all: a worker OOM-killed between
fetch and execution, or -- the realistic one -- a rolling deploy where a web
pod already knows ``g12f.translate_zpage`` and the worker pod does not yet, so
the job fails with "task not found" and none of the task's own refund code ever
executes.

:func:`reap_abandoned` is the answer: any charge still ``queued`` after
:data:`ABANDONED_AFTER` is refunded in full, whatever became of its job. It
runs on a cron (``tasks.reap_translation_charges``), on every read of the
status endpoint, and from a management command. The deadline is deliberately
far longer than the job's own document timeout, so it can only ever catch a
job that is genuinely gone -- and if it does race a very slow job, the job
finds the charge no longer ``queued`` and declines to deliver, which spends
one provider call rather than charging for something twice.
"""
import logging
import uuid
import zlib
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from decimal import Decimal

from django.conf import settings
from django.db import DatabaseError, models, transaction
from django.db.models.fields.json import KeyTextTransform, KeyTransform
from django.db.models.functions import Collate
from django.utils import timezone

from dj.apps.g12f.translation import settlement
from dj.apps.jobs.logs import emit_json_line
from dj.apps.tuzis import ledger
from dj.apps.tuzis.models import (
    IdempotencyKey,
    fingerprint,
)

logger = logging.getLogger(__name__)

#Idempotency scope. Distinct from every other 2Z scope, so a key a client
#reuses across features can never replay a donation as a translation.
SCOPE = "zpage-translate"

# Account deletion retains translation charge rows for metering and
# reconciliation. The marker makes the content scrub durable across a worker
# that was already running when deletion purged the account.
ACCOUNT_DELETION_SCRUB_MARKER = "_account_deletion_scrubbed"
ACCOUNT_DELETION_PRIVATE_CONTENT_KEYS = frozenset({
    "_attempted_output", "attempted_output_preview", "_fragments",
    "error_detail", "warnings",
})


def _scrub_deleted_response_content(body):
    """Keep accounting state while enforcing a previously committed scrub."""
    if not body.get(ACCOUNT_DELETION_SCRUB_MARKER):
        return body
    return {
        key: value for key, value in body.items()
        if key not in ACCOUNT_DELETION_PRIVATE_CONTENT_KEYS
    }

QUEUED = "queued"
DELIVERED = "delivered"
REFUNDED = "refunded"
SETTLED = "settled"

#Both terminal failure states. A failure is one of these two and nothing
#else, so anything counting failures counts both or it is counting a subset
#that grows the day a settlement becomes partial.
FAILED = (REFUNDED, SETTLED)

#``jsonPayload.event`` of the line:func:`settle_failure` writes for every
#settled failure. A contract with anyone reading the logs: renaming
#it silently empties every Logs Explorer query built on it.
REFUND_EVENT = "translation_refunded"

#How long a charge may sit ``queued`` before it is presumed abandoned and
#refunded. Must comfortably exceed
#``service.DOCUMENT_TIMEOUT_SECONDS`` (15 minutes) plus the job's retry
#backoff, or the reaper would refund translations that are still being made.
#Six times that, because refunding late costs a creator patience and
#refunding early costs us a translation we already paid for.
DEFAULT_ABANDONED_AFTER = timedelta(minutes=90)


def abandoned_after():
    configured = getattr(settings, "ZPAGE_TRANSLATION_ABANDONED_AFTER", None)
    if configured is None:
        return DEFAULT_ABANDONED_AFTER
    if isinstance(configured, timedelta):
        return configured
    return timedelta(seconds=float(configured))


#The OUTER deadline: past this a ``queued`` charge is refunded even
#when its procrastinate job is still waiting in the queue.
#
#``abandoned_after()`` is measured from PURCHASE, and it was sized when an
#account could hold one job. With ten per account on a lane that runs one at
#a time, a job that is merely WAITING can pass 90 minutes -- ten 12-minute
#documents put the eighth start at minute 84 -- and refunding it then is
#worse than useless: if it has started, its delivery rolls back against a
#refunded charge and the provider spend is thrown away; if not, the creator's
#batch silently loses its tail. (codex adversarial review of, finding
#1.) So past ``abandoned_after()`` the reaper refunds only a charge whose job
#is no longer ``todo``/``doing`` -- the job that never arrived, which is what
#the reaper is for -- and waits for the rest until this outer bound. Six
#hours exceeds the worst case of a full platform queue even on ONE slot
#(20 x the 15-minute document budget = 5 hours; on the 4-slot lane of
#it is 75 minutes), so it is only reached by a lane that has stopped
#draining; the `translation` queue-backlog alert fires long before.
DEFAULT_ABANDONED_HARD_AFTER = timedelta(hours=6)

#The task every charge's job runs; its kwargs carry ``job_id``.
TRANSLATE_TASK_NAME = "g12f.translate_zpage"


def abandoned_hard_after():
    configured = getattr(
        settings, "ZPAGE_TRANSLATION_ABANDONED_HARD_AFTER", None
    )
    if configured is None:
        hard = DEFAULT_ABANDONED_HARD_AFTER
    elif isinstance(configured, timedelta):
        hard = configured
    else:
        hard = timedelta(seconds=float(configured))
    return max(hard, abandoned_after())


def scheduled_job_ids(job_ids):
    """Which of these charge job ids still have a ``todo``/``doing`` job.

    Read straight from ``procrastinate_jobs`` the way ``dj.apps.jobs.health``
    reads it (``args ->> 'job_id'``, the kwarg ``translate_zpage.defer``
    passes). A job the worker never got -- an unknown task on an old pod
    (status ``failed``), an enqueue that never happened (no row) -- is absent
    here, which is exactly the set the reaper exists to refund.
    """
    job_ids = [str(job_id) for job_id in job_ids if job_id]
    if not job_ids:
        return set()
    from django.db import connection

    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT args ->> 'job_id' FROM procrastinate_jobs "
            "WHERE task_name = %s AND status IN ('todo', 'doing') "
            "AND (args ->> 'job_id') = ANY(%s)",
            [TRANSLATE_TASK_NAME, job_ids],
        )
        return {row[0] for row in cursor.fetchall()}


def new_job_id():
    return str(uuid.uuid4())


def request_fingerprint(*, zpage_id, language, source_digest, price):
    """Identity of one purchase.

    The source digest is in here on purpose: retrying the same key after the
    creator has edited the article is not the same request, and answering it
    with the old receipt would hide the fact that they are now buying a
    translation of different text. It comes back as a 409 instead.
    """
    return fingerprint({
        "zpage": zpage_id,
        "language": language,
        "source_digest": source_digest,
        "price": int(price),
    })


def initial_body(*, job_id, zpage_id, language, source_digest, target_digest,
                 price, ai_model, balance, settlement_policy=None,
                 batch_id=None):
    """The response body AND the durable charge record. One object, one truth.

    ``target_digest`` is the digest of whatever draft already occupies the
    target language at purchase time (``None`` when nothing does). The worker
    refuses to deliver over a draft that has changed since -- otherwise a
    creator who keeps editing their own hand-written Spanish draft while the
    job runs finds it silently replaced by machine output, and their work is
    gone. Found by the codex adversarial review.

    ``batch_id`` is set only on a record a ``POST.../translations/`` batch
    created, and is absent otherwise, so a single purchase's body is
    exactly what it always was.
    """
    body = {
        "job_id": job_id,
        "status": QUEUED,
        "zpage_id": zpage_id,
        "language": language,
        "source_digest": source_digest,
        "target_digest": target_digest,
        "price": int(price),
        # The settlement terms the CLIENT said it displayed, not the server's own
        # version. Absent or stale means legacy terms -- an unconditional
        # refund -- because a creator can only be charged against terms they were
        # actually shown, and we do not control when a browser tab reloads.
        "settlement_policy": (
            int(settlement_policy)
            if str(settlement_policy or "").isdigit()
            else None
        ),
        "charged": str(ledger.to_tuzis(price)),
        "refunded": "0.000",
        "balance": str(balance),
        "ai_model_id": str(ai_model.pk),
        "ai_model": ai_model.display_name,
        "error": None,
        "error_detail": None,
    }
    if batch_id is not None:
        body["batch_id"] = str(batch_id)
    return body


def public_body(body):
    """The subset of the record an API response may carry."""
    if not isinstance(body, dict):
        return {}
    return {
        key: value
        for key, value in body.items()
        if not key.startswith("_")
    }


# --------------------------------------------------------------------------- #
# Lookups
# --------------------------------------------------------------------------- #
def record_for_job(job_id):
    """The charge record for a job id, or ``None``.

    Scoped to:data:`SCOPE`, so a job id cannot address a donation receipt.
    """
    if not job_id:
        return None
    return IdempotencyKey.objects.filter(
        scope=SCOPE, response_body__job_id=str(job_id)
    ).select_related("user").first()


def latest_record(user, zpage_id, language):
    """The most recent charge this user made for this article + language."""
    return (
        IdempotencyKey.objects.filter(
            scope=SCOPE,
            user=user,
            response_body__zpage_id=zpage_id,
            response_body__language=language,
        )
        .order_by("-created_at")
        .first()
    )


#How far back ``GET /api/zpage/{addr}/translations/`` looks. It is the job
#TRAY, not a purchase history: anything still ``queued`` is at most
#``abandoned_after()`` plus one reaper tick old. A delivered record whose
#exact output is still the current draft remains visible past this window so
#its warnings can be reviewed from a fresh device. Other finished outcomes
#age out; see:func:`latest_records_by_language`.
JOBS_LIST_WINDOW = timedelta(days=30)

#The keys of a charge record the jobs list may return. Projected one by one,
#never the whole ``response_body``: a refunded record can carry
#``_fragments`` -- up to ``settlement.MAX_CARRIED_CHARS`` of paid-for
#translation -- and a tray listing 96 languages must not haul all of them
#across the wire to drop them in Python. ``warnings`` is passed through when
#present ( adds it). ``attempted_output_preview`` is NOT selected: it is
#text, the tray does not show it, and the single-job route serves it to a
#client that opens one job; the tray only learns that one exists
#(``has_attempted_output_preview``).
JOB_LIST_KEYS = (
    "job_id", "batch_id", "status", "language", "source_digest", "price",
    "charged", "refunded", "billed", "fault", "error", "error_detail",
    "settled_at", "ai_model", "warnings",
)
OPTIONAL_JOB_LIST_KEYS = frozenset({
    "batch_id", "billed", "fault", "settled_at", "warnings",
})


def latest_records_by_language(user, zpage_id, now=None, draft_digests=None):
    """``{language: job dict}`` -- the newest charge per language, this article.

    The newest-per-language choice is made IN SQL (``DISTINCT ON`` the
    language, newest first), so the rows that leave Postgres are one per
    language, never the article's whole purchase history.

    A delivered record whose exact output digest is still the current draft is
    also eligible outside that window while its durable charge record exists.
    That is the narrow exception which lets a fresh device recover
    the current draft's provenance without turning the tray into purchase
    history.

    WHAT THE QUERY COSTS, because the record's article is a JSON key and there
    is no index on JSON. The ordinary filter is ``scope = 'zpage-translate'
    AND user_id = <buyer> AND created_at >= now - JOBS_LIST_WINDOW``; only the
    explicit current-draft exception admits an older row, and then only for an
    exact language/output digest. The ``user_id`` foreign-key index and the
    ``(scope, user_id, key)`` unique btree prefix keep either branch on this
    buyer's rows before Postgres applies the JSON predicates. Recent rows are
    bounded by what the buyer could afford in a month; the older-draft branch
    can inspect that buyer's historical charge rows for exact current digests.
    """
    now = now or timezone.now()
    query = IdempotencyKey.objects.filter(
        scope=SCOPE,
        user=user,
        response_body__zpage_id=zpage_id,
        response_body__has_key="language",
    )
    if draft_digests:
        live_drafts = models.Q()
        for language, digest in draft_digests.items():
            live_drafts |= models.Q(
                response_body__language=language,
                response_body__status=DELIVERED,
                response_body__draft_digest=str(digest),
            )
        query = query.filter(
            models.Q(created_at__gte=now - JOBS_LIST_WINDOW) | live_drafts
        )
    else:
        query = query.filter(created_at__gte=now - JOBS_LIST_WINDOW)
    rows = (
        query
        .annotate(_language=KeyTextTransform("language", "response_body"))
        .order_by("_language", "-created_at", "-pk")
        .distinct("_language")
        .annotate(
            _has_preview=models.ExpressionWrapper(
                models.Q(response_body__has_key="attempted_output_preview"),
                output_field=models.BooleanField(),
            ),
            **{
                f"_k_{key}": KeyTransform(key, "response_body")
                for key in JOB_LIST_KEYS
            },
        )
        .values(
            "_language", "created_at", "_has_preview",
            *(f"_k_{key}" for key in JOB_LIST_KEYS),
        )
    )
    latest = {}
    for row in rows:
        language = row["_k_language"]
        if not isinstance(language, str):
            continue
        item = {
            "created_at": row["created_at"].isoformat(),
            "has_attempted_output_preview": bool(row["_has_preview"]),
        }
        for key in JOB_LIST_KEYS:
            value = row[f"_k_{key}"]
            if value is None and key in OPTIONAL_JOB_LIST_KEYS:
                continue
            item[key] = value
        latest[language] = item
    return latest


def draft_provenances_by_language(user, zpage_id, draft_digests):
    """Newest trusted delivery per language whose output is still the draft.

    A later failed purchase is allowed to become the tray's newest job without
    erasing warnings belonging to the draft that is still saved. One query
    checks all current draft digests; the digest is written in the same
    transaction as delivery, so a match proves which paid job produced those
    exact bytes.
    """
    if not draft_digests:
        return {}
    matches = models.Q()
    for language, digest in draft_digests.items():
        matches |= models.Q(
            response_body__language=language,
            response_body__draft_digest=str(digest),
        )
    rows = (
        IdempotencyKey.objects.filter(
            scope=SCOPE,
            user=user,
            response_body__zpage_id=zpage_id,
            response_body__status=DELIVERED,
        )
        .filter(matches)
        .annotate(_language=KeyTextTransform("language", "response_body"))
        .order_by("_language", "-created_at", "-pk")
        .distinct("_language")
        .values("_language", "response_body")
    )
    return {
        row["_language"]: row["response_body"]
        for row in rows
        if isinstance(row["_language"], str)
    }


def latest_delivery_warnings_by_language(user, zpage_id, languages):
    """Warnings from the newest delivered draft per language, even if edited.

    These are historical context for an unverified draft. They never establish
    current provenance and must not be used as the warnings for publish
    approval;:func:`draft_provenances_by_language` remains the digest check.
    """
    languages = tuple(languages)
    if not languages:
        return {}
    rows = (
        IdempotencyKey.objects.filter(
            scope=SCOPE,
            user=user,
            response_body__zpage_id=zpage_id,
            response_body__status=DELIVERED,
            response_body__language__in=languages,
        )
        .annotate(_language=KeyTextTransform("language", "response_body"))
        .order_by("_language", "-created_at", "-pk")
        .distinct("_language")
        .values("_language", "response_body")
    )
    return {
        row["_language"]: row["response_body"].get("warnings", [])
        for row in rows
        if isinstance(row["_language"], str)
        and isinstance(row["response_body"].get("warnings", []), list)
    }


def records_for_batch(user, batch_id, languages):
    """The per-language charge records a batch purchase created, in order."""
    keys = [batch_key(batch_id, language) for language in languages]
    by_key = {
        record.key: record
        for record in IdempotencyKey.objects.filter(
            scope=SCOPE, user=user, key__in=keys,
        )
    }
    return [by_key.get(key) for key in keys]


def batch_key(batch_id, language):
    """The per-language record key of a batch purchase: ``{batch}:{lang}``.

    Cannot collide with a single-language purchase, whose key must parse as a
    bare UUIDv4, and cannot collide across batches, because ``batch_id`` is
    the batch's own claim in:data:`BATCH_SCOPE`, unique per user.
    """
    return f"{batch_id}:{language}"


#Idempotency scope of the BATCH claim itself (``POST.../translations/``).
#Deliberately NOT:data:`SCOPE`: every row in that scope is read as a charge
#by the reaper, the failure ceilings and ``reconcile_zpage_variants`` (which
#reports a row without a charge's ``status`` as ``charge-unreadable`` drift).
#The batch row is a receipt -- which per-language charges this key created
#-- and the money lives on those charges, exactly as for a single purchase.
BATCH_SCOPE = "zpage-translate-batch"


def batch_fingerprint(*, zpage_id, source_digest, items):
    """Identity of one batch purchase: article, source and every (lang, price).

    Order-insensitive, so a client that re-sorts its picker between a request
    and its retry is still asking for the same thing.
    """
    return fingerprint({
        "zpage": zpage_id,
        "source_digest": source_digest,
        "items": sorted(
            [language, int(price)] for language, price in items
        ),
    })


# --------------------------------------------------------------------------- #
# Bounded worker transactions
# --------------------------------------------------------------------------- #
#MILLISECONDS. How long a WORKER-side translation transaction (the delivery
#in ``tasks.translate_zpage``,:func:`settle_failure`) waits for a row lock
#before giving up with SQLSTATE 55P03.
#
#Why a bound at all: the ``translation`` lane has exactly ONE
#PgBouncer server connection (``max_db_connections=1`` with session
#affinity). PgBouncer's ``query_wait_timeout`` is 30 s and Procrastinate's
#heartbeat timeout is 30 s, so anything that holds that one connection for
#30 s fails the lane's other clients and makes this worker look dead. The
#delivery locks the zPage row, and an API request holding that row inside
#its ``AtomicMiddleware`` transaction can keep it for as long as gunicorn
#lets the request run -- 600 s.
#
#Why 5 s: every lock this code takes is a single primary-key row (the zPage,
#the target variant, the charge record) that a healthy writer holds for
#milliseconds, so 5 s is three orders of magnitude of headroom for a slow but
#legitimate holder and a sixth of the 30 s budget above. It matches
#``ledger/migrations/0002_writer_boundary.py``.
DEFAULT_WORKER_LOCK_TIMEOUT_MS = 5_000

#MILLISECONDS. Upper bound on any single statement in those transactions
#(SQLSTATE 57014 when exceeded). The largest is the UPDATE that writes a
#translated body of at most 100,000 characters -- milliseconds in practice.
#15 s, half of the 30 s ``query_wait_timeout`` / heartbeat budget above, so
#one stalled statement cannot by itself starve the lane or miss a heartbeat;
#it is a backstop for an I/O stall or a pathological plan, not a budget
#anything should approach. Larger than the lock timeout on purpose, so a lock
#wait is always reported as 55P03 rather than as a statement timeout.
DEFAULT_WORKER_STATEMENT_TIMEOUT_MS = 15_000

#The two SQLSTATEs that mean "contended, try again", never "broken":
#``lock_not_available`` and ``query_canceled``.
CONTENTION_SQLSTATES = frozenset({"55P03", "57014"})


def bound_worker_transaction():
    """``SET LOCAL`` the two timeouts above on the CURRENT transaction.

    ``SET LOCAL`` rather than ``SET`` because the connection is a PgBouncer
    transaction-pooled one: a session-level ``SET`` would outlive this
    transaction and leak into whichever client the server connection serves
    next. Must be called inside ``transaction.atomic()``; a no-op off
    PostgreSQL. Values are integers in milliseconds with the unit written out,
    because Postgres reads a bare integer here as milliseconds and a reader
    should not have to know that.
    """
    from django.db import connection

    if connection.vendor != "postgresql":
        return
    lock_ms = int(getattr(
        settings, "ZPAGE_TRANSLATION_LOCK_TIMEOUT_MS",
        DEFAULT_WORKER_LOCK_TIMEOUT_MS,
    ))
    statement_ms = int(getattr(
        settings, "ZPAGE_TRANSLATION_STATEMENT_TIMEOUT_MS",
        DEFAULT_WORKER_STATEMENT_TIMEOUT_MS,
    ))
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT set_config('lock_timeout', %s, true), "
            "set_config('statement_timeout', %s, true)",
            [f"{lock_ms}ms", f"{statement_ms}ms"],
        )


def is_contention(exc):
    """Whether a database error is a lock or statement timeout (retryable)."""
    cause = getattr(exc, "__cause__", None)
    code = getattr(cause, "sqlstate", None) or getattr(cause, "pgcode", None)
    return code in CONTENTION_SQLSTATES


def stash_contended_run(record_pk, meter):
    """Keep a contended run's paid-for work on its still-``queued`` record.

    Called when a delivery lost a lock race and the job is about to be retried.
    Two things are kept, for two readers:

    * ``_fragments`` -- the retry's ``carried_fragments`` reads them from every
      recent record for the document, this one included, so it recalls them
      instead of paying the provider for the same document again;
    * ``_contended_spend`` -- what the provider work so far COST, which the
      retry seeds its meter with (``tasks.translate_zpage``). Without it a
      retry that then fails early -- the creator edits the article during the
      retry delay -- settles as if no provider work ever happened, and drops
      out of the failure ceilings.

    Best effort, never raises: failing to stash costs a re-translation and an
    under-counted meter, not correctness.
    """
    if meter is None:
        return False
    changes = {
        "_contended_spend": {
            "calls": int(meter.calls or 0),
            "input_tokens": int(meter.input_tokens or 0),
            "output_tokens": int(meter.output_tokens or 0),
        },
    }
    # `carried` too: a SECOND contended attempt recalled the first one's stash
    # rather than regenerating it, and writing only its own new fragments
    # would replace that stash with a subset.
    paid_for = {**meter.carried, **meter.fragments}
    if paid_for:
        changes["_fragments"] = paid_for
    try:
        with transaction.atomic():
            bound_worker_transaction()
            return _transition(record_pk, (QUEUED,), changes) is not None
    except Exception:
        logger.exception(
            "could not stash translation fragments on charge %s", record_pk
        )
        return False


# --------------------------------------------------------------------------- #
# Transitions
# --------------------------------------------------------------------------- #
def _transition(record_pk, allowed_from, changes, *, drop=()):
    """Compare-and-set on the record's status. Returns the new body or ``None``.

    ``None`` means "somebody else already moved it", which every caller treats
    as "then it is not mine to settle" -- that is what makes the worker, its
    retry and the reaper safe to run concurrently.

    MUST be called inside a transaction that also contains whatever the change
    describes (the credit, the variant write). The caller supplies it.

    ``drop`` names keys to REMOVE from the body in the same write -- a merge
    cannot express that, and "absent" is what readers of a clean record expect.
    """
    row = (
        IdempotencyKey.objects.select_for_update()
        .filter(pk=record_pk)
        .first()
    )
    if row is None:
        return None
    body = row.response_body if isinstance(row.response_body, dict) else {}
    if body.get("status") not in allowed_from:
        return None
    body = {**body, **changes}
    for key in drop:
        body.pop(key, None)
    body = _scrub_deleted_response_content(body)
    IdempotencyKey.objects.filter(pk=record_pk).update(response_body=body)
    return body


#Per-warning bounds on what a delivered record stores. The record is
#a row in the money table, and a translation that dropped every one of 400
#code identifiers needs to say "these, and more", not carry all 400.
MAX_WARNING_ITEMS = 20
MAX_WARNING_ITEM_CHARS = 200


def warning_entries(violations):
    """``safety.UnsafeTranslation``\\ s as ``[{code, detail, items}]``, bounded."""
    entries = []
    for violation in violations or ():
        items = [
            str(item)[:MAX_WARNING_ITEM_CHARS]
            for item in list(getattr(violation, "items", ()) or ())[
                :MAX_WARNING_ITEMS
            ]
        ]
        entries.append({
            "code": violation.code,
            "detail": str(violation)[:500],
            "items": items,
        })
    return entries


def mark_started(record_pk, *, started_at=None):
    """Stamp ``started_at``: the worker checked the source and is starting work.

    The lower end of the window in which an edit of the article can abort this
    job. Purchase time is NOT that bound once jobs queue: ten jobs
    bought up front at one digest, each later killed by its own separate edit
    and revert, would all share the purchase instant and be counted as one
    mutation by:func:`_count_mutations`. A job only starts after the worker
    has compared the article with the digest it was bought against, so an edit
    that aborts it happened after it READ the article.

    ``started_at`` MUST be taken before that read, not when this is called:
    the worker does several queries between reading the source and getting
    here, and an edit landing in that gap would fall outside the interval --
    one edit then reads as two mutations and the second job is billed (codex
    adversarial review of, round 4). Best effort and idempotent: a retry
    re-stamps, and a row no longer ``queued`` is left alone.

    BOUNDED, and a lock timeout SKIPS the stamp ( security round). The
    ``select_for_update`` in:func:`_transition` used to wait unbounded, so a
    writer holding this charge row pinned the translation lane's single pooled
    connection exactly as  describes for the delivery. With
    :func:`bound_worker_transaction` it gives up after the lock timeout, and
    then this returns ``None`` and the job carries on unstamped -- it is never
    failed, retried or refunded over this. Skip rather than retry because:

    * the stamp only SHARPENS mutation counting; a record without one falls
      back to ``created_at`` in:func:`_count_mutations`, which can only widen
      an interval, i.e. count FEWER mutations -- the lenient direction, and the
      per-account failed-spend ceiling (which does not read the stamp) still
      bounds the cost;
    * a retry would spend another full lock timeout of the lane's 30-second
      budget on the same contended row, for a value the fallback approximates.

    Any other database error still propagates.
    """
    started_at = started_at or timezone.now()
    try:
        with transaction.atomic():
            bound_worker_transaction()
            return _transition(
                record_pk, (QUEUED,), {"started_at": started_at.isoformat()}
            )
    except DatabaseError as exc:
        if not is_contention(exc):
            raise
        logger.warning(
            "translation charge %s: started_at not stamped, the charge row was "
            "locked (%s); mutation counting falls back to created_at",
            record_pk, getattr(exc.__cause__, "sqlstate", None),
        )
        return None


def mark_delivered(record_pk, *, actual_cost=None, warnings=None,
                   draft_digest=None):
    """Called INSIDE the transaction that writes the draft variant.

    ``warnings`` is:func:`warning_entries` output: the ``safety`` checks this
    draft did not pass but was delivered anyway. Always written, as an
    empty list for a clean delivery, so a client can tell "no warnings" from a
    record delivered before warnings existed (no key at all).

    A delivery with warnings is billed exactly like a clean one -- the debit
    taken at purchase stands. That is a policy, and it lives in
    ``settlement.CHARGE_DELIVERED_WITH_WARNINGS_IN_FULL``.

    The contended-delivery stash (``_fragments`` and ``_contended_spend``, see
    :func:`stash_contended_run`) is CLEARED here. It exists so a retry of the
    SAME purchase can finish without paying the provider again; once that
    purchase is delivered it has done its job, and left in place
    :func:`carried_fragments` hands it to the creator's NEXT purchase of the
    same document -- a re-roll that replays the old translation at full price
    with zero provider calls. (independent review of.)
    """
    changes = {
        "status": DELIVERED,
        "error": None,
        "error_detail": None,
        "warnings": list(warnings or []),
    }
    if draft_digest is not None:
        changes["draft_digest"] = str(draft_digest)
    if actual_cost is not None:
        changes["actual_cost"] = int(actual_cost)
    return _transition(
        record_pk, (QUEUED,), changes,
        drop=("_fragments", "_contended_spend"),
    )


def refund(record_pk, *, code, detail=""):
    """Credit the FULL charge back and mark the record refunded.

    The unconditional full refund, kept as its own name because that is what
    most failures are and because the reaper (and every caller that has no
    spend to account for) means exactly this. Implemented on top of
    :func:`settle_failure` so there is only one place that moves this money.
    """
    return settle_failure(record_pk, code=code, detail=detail)


def settle_failure(record_pk, *, code, detail="", fault=None, meter=None,
                   metered_cost=0, ai_model=None, requester_caused=None,
                   attempted_output=None):
    """Settle a FAILED translation according to who is at fault.

    ``fault`` is a value from:mod:`settlement` (defaulting to
    :data:`settlement.PLATFORM`, i.e. our defect, i.e. a full refund).
    ``meter`` is the:class:`settlement.SpendMeter` for the run, if there was
    one; ``metered_cost`` is what the provider work it recorded costs in whole
    2Z, and is derived from ``meter`` + ``ai_model`` when not given.

    ``attempted_output`` is the text a run that failed ON ITS OUTPUT had
    produced. The first ``settlement.ATTEMPTED_OUTPUT_PREVIEW_CHARS``
    are kept privately as ``_attempted_output``, and served to the creator as
    ``attempted_output_preview`` only for
    ``settlement.SHOW_ATTEMPTED_OUTPUT_CODES``. Never logged.

    THE AMOUNT KEPT is ``min(metered_cost, charged)`` and only when
    ``fault == settlement.REQUEST``; otherwise it is zero. Three properties
    follow, and they are the whole point:

    * **We never bill for work that did not happen.** A failure before the
      provider call has no meter and no cost, so it is a full refund by
      arithmetic, whatever the fault table says.
    * **We never bill above the quote.** ``TranslateWithAiDialog`` guarantees
      no 2Z is committed from a screen that has not shown the number; charging
      *up to* that number for work actually performed keeps the guarantee.
    * **We never bill for our own defect.** ``fault`` comes from
      ``settlement.classify``, whose default for anything unrecognized is
      :data:`settlement.PLATFORM`.

    Idempotent by construction: the status compare-and-set and the credit are
    one transaction, so a second caller finds the row no longer ``queued`` and
    moves nothing.
    """
    fault = fault or settlement.PLATFORM
    if (
        fault == settlement.REQUEST
        and code in SOURCE_MUTATION_CODES
        and requester_caused is True
    ):
        fault = _one_edit_is_one_mutation(record_pk, code, fault)
    if meter is not None and not metered_cost:
        metered_cost = settlement.metered_cost(ai_model, meter)
    metered_cost = max(0, int(metered_cost or 0))
    # TWO numbers, on purpose, and they must not be collapsed back into one.
    # `metered_cost` errs LOW because it is what a creator may be billed;
    # `estimated_cost` errs high because it is what the failure-spend ceilings
    # are summed from, and a loss budget computed from a deliberately
    # conservative charge lets through as much extra spend as the discount.
    estimated_cost = max(
        metered_cost,
        int(settlement.estimated_cost(ai_model, meter) or 0),
    )
    provider_billed = bool(meter is not None and meter.billable)

    with transaction.atomic():
        # A lock or statement timeout here raises out of this function with
        # nothing credited and the record still `queued`: the worker's
        # Procrastinate retry (or, for the reaper, its next sweep) settles it.
        bound_worker_transaction()
        # Account deletion takes Creator before IdempotencyKey. Match that
        # order here before locking the charge and refunding, so deletion and a
        # late settlement cannot form a Creator <-> charge lock cycle.
        user_id = (
            IdempotencyKey.objects.filter(pk=record_pk)
            .values_list("user_id", flat=True)
            .first()
        )
        if user_id is None:
            return False
        from dj.apps.g12f.models import Creator

        creator = Creator._base_manager.select_for_update().filter(
            pk=user_id,
        ).first()
        if creator is None:
            return False
        row = (
            IdempotencyKey.objects.select_for_update()
            .select_related("user")
            .filter(pk=record_pk, user_id=user_id)
            .first()
        )
        if row is None:
            return False
        body = row.response_body if isinstance(row.response_body, dict) else {}
        if body.get("status") != QUEUED:
            return False
        charged = ledger.to_tuzis(body.get("charged") or 0)
        # WHICH TERMS DID THIS BUYER ACTUALLY SEE? The purchase records the
        # settlement policy the CLIENT declared, so a charge bought from a
        # screen that promised an unconditional refund -- an editor tab opened
        # before this deploy, or any client that never learned to send the
        # field -- is refunded in full whatever the fault table says.
        # Server-stamping the version here instead would charge that creator
        # against a promise they were never shown.
        may_bill = settlement.may_bill_under_policy(
            body.get("settlement_policy")
        )
        if fault == settlement.REQUEST and not may_bill:
            logger.warning(
                "zpage translation job=%s was attributable (%s) but was bought "
                "under settlement policy %r, which promised a full refund -- "
                "refunding in full",
                body.get("job_id"), code, body.get("settlement_policy"),
            )
        # `min` is the invariant, not a safety net: the metered cost of a
        # runaway generation can exceed the quote (that is what the provider
        # cap bounds), and the creator consented to the quote.
        billed = (
            min(ledger.to_tuzis(metered_cost), charged)
            if fault == settlement.REQUEST and may_bill
            else ledger.to_tuzis(0)
        )
        amount = charged - billed
        if amount > 0:
            # The unused part of the charge goes back: `sys:platform_revenue
            # -> user`, a refund named after the purchase record it settles.
            balance = ledger.credit(
                row.user, amount,
                source="sys:platform_revenue",
                ref_kind="translation",
                ref_id=str(row.pk),
                idem=f"translation_refund:{row.pk}",
            )
        else:
            balance = row.user.tuzis
        body = {
            **body,
            "status": REFUNDED if billed <= 0 else SETTLED,
            "refunded": str(amount),
            "billed": str(billed),
            # The creator's balance AFTER this settlement. The status endpoint
            # and the idempotent replay both report this field, so leaving the
            # purchase-time value here would tell a creator their balance is
            # the one they had before the credit landed.
            "balance": str(balance),
            "fault": fault,
            # THE FINDING OF FACT, stored apart from the fault it produced.
            #
            # `fault` is the SETTLEMENT: the first two forgiven mutations settle
            # as `platform` even though the buyer caused them. So counting
            # `fault == request` to drive the forgiveness allowance would mean
            # the allowance never advanced and nobody was ever billed, while
            # counting the error CODE means one of our own occurrences (our
            # detector relabelling the article) burns a forgiven slot and makes
            # the buyer's next genuine mutation billable earlier. Neither is
            # right, so the adjudication is its own field. (Reviewer of,
            # finding 1, second half.)
            "requester_caused": (
                None if requester_caused is None else bool(requester_caused)
            ),
            # What this failure probably cost US. The ceilings below sum this
            # one, never `metered_cost`.
            "estimated_cost": estimated_cost,
            # Recorded even when it is not billed: what a creator COULD have
            # been charged for this failure, deliberately conservative.
            "metered_cost": metered_cost,
            "provider_billed": provider_billed,
            "provider_calls": int(getattr(meter, "calls", 0) or 0),
            "provider_input_tokens": int(
                getattr(meter, "input_tokens", 0) or 0
            ),
            "provider_output_tokens": int(
                getattr(meter, "output_tokens", 0) or 0
            ),
            # Anchors the failure window. `created_at` is purchase time and a
            # document may run for minutes, so counting on it would let a slow
            # failure age out of a window it belongs in.
            "settled_at": timezone.now().isoformat(),
            "error": code,
            "error_detail": (detail or "")[:500],
        }
        if attempted_output:
            attempted = str(attempted_output)
            preview = attempted[:settlement.ATTEMPTED_OUTPUT_PREVIEW_CHARS]
            # For operators. Underscore-prefixed, so `public_body` never serves
            # it: for most codes it is translated text in the right language,
            # and a refund that hands that back is a free translation.
            body["_attempted_output"] = preview
            body["attempted_output_chars"] = len(attempted)
            if code in settlement.SHOW_ATTEMPTED_OUTPUT_CODES:
                # For the creator, only where the output is by definition not
                # the product. Every reader of this record is scoped to the
                # creator who paid (the status endpoint and the idempotent
                # replay both are). See `settlement.SHOW_ATTEMPTED_OUTPUT_CODES`.
                body["attempted_output_preview"] = preview
        if meter is not None and meter.fragments and (
            settlement.may_carry_fragments(code)
        ):
            # Work already paid for, carried on the money record so the next
            # purchase of this exact document does not pay for it twice.
            # Underscore-prefixed, so `public_body` never ships a translation
            # the creator was refunded for.
            #
            # NOT carried when the generated text is what we rejected -- a
            # safety refusal names the offence and not the fragment that
            # committed it, and an over-long document reassembles to the same
            # over-long document. Reusing either makes one bad generation
            # permanent. See `settlement.UNTRUSTWORTHY_OUTPUT_CODES`.
            body["_fragments"] = dict(meter.fragments)
        body = _scrub_deleted_response_content(body)
        IdempotencyKey.objects.filter(pk=row.pk).update(response_body=body)

    # ONE STRUCTURED LINE PER SETTLED FAILURE.
    #
    # The task that calls this returns normally afterwards -- the refund IS the
    # handling -- so Procrastinate records the job as succeeded and the
    # terminal-failure alert never sees it. This line records each failure;
    # the aggregate alert count is
    # computed from the charge rows themselves by `recent_refunds` below, in the
    # job-health sweep, so a dropped log line cannot lose the page.
    #
    # ERROR when the buyer did not cause it: that is a translation we sold and
    # could not deliver, which is a product failure however cleanly the money
    # came back. A buyer-caused settlement is expected behaviour.
    emit_json_line(
        logger,
        {
            "event": REFUND_EVENT,
            "status": body["status"],
            "code": code,
            "fault": fault,
            "requester_caused": body["requester_caused"],
            "job_id": body.get("job_id"),
            "user_id": row.user_id,
            "zpage_id": body.get("zpage_id"),
            "language": body.get("language"),
            "ai_model": body.get("ai_model"),
            "credited": str(amount),
            "billed": str(billed),
            "metered_cost": metered_cost,
            "provider_billed": provider_billed,
            "provider_calls": body["provider_calls"],
            "provider_input_tokens": body["provider_input_tokens"],
            "provider_output_tokens": body["provider_output_tokens"],
            "detail": (detail or "")[:200],
        },
        "WARNING" if body["requester_caused"] else "ERROR",
        (
            f"zpage translation {body['status']}: job={body.get('job_id')} "
            f"user={row.user_id} credited={amount} billed={billed} "
            f"fault={fault} metered={metered_cost} 2Z "
            f"(in={body['provider_input_tokens']} "
            f"out={body['provider_output_tokens']} "
            f"calls={body['provider_calls']}) reason={code} "
            f"({(detail or '')[:200]})"
        ),
    )
    return True


def _one_edit_is_one_mutation(record_pk, code, fault):
    """Re-decide a billable ``source_changed`` with its own edit counted ONCE.

    The caller (``translate_zpage``'s ``give_up``) classified this failure from
    ``requester_action_failures(user, zpage_id=...)``, which counts every PRIOR
    mutation in the window -- including the sibling jobs that the very same
    edit already aborted a moment earlier. With five jobs in flight and the
    default allowance of two, the third sibling to settle saw "two prior
    mutations" and was billed for an edit the creator made once.

    So the decision is taken again here, from the count with this charge's own
    edit -- and every sibling sharing it -- counted as the single mutation it
    is (``current=``). It can only LOWER the fault: the corrected count is
    never above the caller's, and:func:`settlement.classify` is monotone in
    it. Done here rather than at the call site so the whole rule lives next to
    the counter it corrects; the caller still owns every other input to the
    fault table.

    A read, outside the settlement transaction: if the row has meanwhile been
    settled by someone else, that transaction finds it no longer ``queued`` and
    moves nothing, whatever this returned.
    """
    record = (
        IdempotencyKey.objects.filter(pk=record_pk)
        .select_related("user")
        .only("pk", "created_at", "response_body", "user")
        .first()
    )
    if record is None:
        return fault
    body = record.response_body if isinstance(record.response_body, dict) else {}
    prior = requester_action_failures(
        record.user,
        zpage_id=body.get("zpage_id"),
        current=record,
        current_error=code,
    )
    decided = settlement.classify(
        code, prior_mutations=prior, requester_caused=True
    )
    if decided == settlement.REQUEST:
        return fault
    logger.info(
        "zpage translation job=%s: %s was caused by an edit that already "
        "aborted other jobs on this article; counted once, that leaves %d "
        "prior mutation(s), inside the allowance -- settling as %s, not %s",
        body.get("job_id"), code, prior, decided, fault,
    )
    return decided


# --------------------------------------------------------------------------- #
# The reaper
# --------------------------------------------------------------------------- #
def abandoned_records(now=None, limit=500):
    """Charges still ``queued`` past the deadline, oldest first.

    Past ``abandoned_after()`` but inside ``abandoned_hard_after()``, a charge
    whose job is still ``todo`` or ``doing`` is WAITING, not abandoned, and is
    left alone (; see:data:`DEFAULT_ABANDONED_HARD_AFTER`).
    """
    now = now or timezone.now()
    cutoff = now - abandoned_after()
    hard_cutoff = now - abandoned_hard_after()
    candidates = list(
        IdempotencyKey.objects.filter(
            scope=SCOPE,
            response_body__status=QUEUED,
            created_at__lt=cutoff,
        )
        .order_by("created_at")[:limit]
    )
    waiting = scheduled_job_ids(
        (record.response_body or {}).get("job_id")
        for record in candidates
        if record.created_at >= hard_cutoff
    )
    return [
        record for record in candidates
        if record.created_at < hard_cutoff
        or (record.response_body or {}).get("job_id") not in waiting
    ]


def _contended_meter(record):
    """``(meter, ai_model)`` rebuilt from a record's ``_contended_spend``.

    ``(None, None)`` for the usual abandoned charge, which has none.
    """
    body = record.response_body if isinstance(record.response_body, dict) else {}
    spent = body.get("_contended_spend")
    if not isinstance(spent, dict):
        return None, None
    from dj.apps.openai.models import AIModel

    meter = settlement.SpendMeter()
    meter.calls = int(spent.get("calls") or 0)
    meter.input_tokens = int(spent.get("input_tokens") or 0)
    meter.output_tokens = int(spent.get("output_tokens") or 0)
    ai_model = AIModel.objects.filter(pk=body.get("ai_model_id")).first()
    return meter, ai_model


def reap_abandoned(now=None, limit=500):
    """Refund every charge whose job never arrived. Returns the count.

    Always a FULL refund, with no meter: the spend meter lives in the worker
    process, so a job killed between its provider calls and its own settlement
    leaves no record of what it spent. Those charges therefore settle as
    ``provider_billed: false`` and do not count toward the failure ceilings in
    :func:`failed_spend`, which UNDER-counts our real loss in exactly that case.
    Accepted: inventing a spend figure for a job whose accounting we lost would
    be worse than missing one, and the spend it hides is bounded by one document
    per abandoned charge.

    The exception is a charge whose attempts lost lock races: those
    wrote ``_contended_spend``, a durable record, so it is used -- still a full
    refund, but counted.
    """
    refunded = 0
    for record in abandoned_records(now=now, limit=limit):
        try:
            # Still a FULL refund (`fault` defaults to platform). But a job
            # whose every attempt lost a lock race at delivery DID leave a
            # durable record of what it spent (`stash_contended_run`), and that
            # spend must reach the failure ceilings like any other (codex
            # review of, round 5).
            meter, ai_model = _contended_meter(record)
            settled = settle_failure(
                record.pk,
                code="abandoned",
                detail=(
                    "the translation job did not complete within "
                    f"{abandoned_after()}"
                ),
                meter=meter,
                ai_model=ai_model,
            )
        except DatabaseError as exc:
            if not is_contention(exc):
                raise
            # One locked record must not withhold every other creator's
            # refund until the next sweep: this one
            # is still `queued` and the next sweep retries it.
            logger.warning(
                "reaper: charge %s is locked (%s) -- skipping it this sweep",
                record.pk, exc,
            )
            continue
        if settled:
            refunded += 1
    if refunded:
        logger.warning(
            "reaped %d abandoned zPage translation charge(s)", refunded
        )
    return refunded


# --------------------------------------------------------------------------- #
# Backpressure
# --------------------------------------------------------------------------- #
# NOT a rate limit, and not an eligibility gate -- the owner settled both on
# 2026-08-09 ("they bought the 2Zs, they can spend them on translations"). This
# is queue backpressure, it moves no money, and it says "try again shortly".
#
# It exists because of a real deployment fact the codex adversarial review
# found: production runs ONE procrastinate worker replica, with no `--queues`
# and no `--concurrency`, so it takes every queue one job at a time. A
# 100,000-character translation can hold that worker for the full
# `service.DOCUMENT_TIMEOUT_SECONDS` (15 minutes). Unbounded, a queue of them
# starves subscription renewals, scheduled publishing, search indexing, the job
# health sweep -- and this feature's own refund sweep, so the money it is
# holding stays held.
#
# THE REAL FIX IS A DEDICATED WORKER for the `translation` queue, and it is
# deliberately not in this PR. Isolating a queue means adding `--queues` to the
# existing worker, which turns "add a task on a new queue" into "that task is
# silently never processed" for whoever does it next. That is an infrastructure
# change with its own review, and CI validates none of it (see CLAUDE.md's
# CI blind spots). Until it lands, these two ceilings bound the damage:
#
#   * a per-account cap on in-flight translations (:func:`account_in_flight_cap`),
#     so no single account can queue an afternoon of work;
#   * a platform-wide ceiling on queued translations, so the aggregate backlog
#     the shared worker must clear before it gets back to billing is bounded.
#
#  RAISED BOTH, AND TIED THEM TOGETHER. The per-account cap was 1, which is
# the whole reason "start B while A runs" was refused and bulk translation was
# impossible; it is now 10 (see DEFAULT_MAX_IN_FLIGHT). The platform ceiling is
# no longer a hand-picked number: it is DERIVED from the translation lane's
# concurrency (:func:`max_queued`), and the rule that keeps the two coherent
# whatever they are configured to is in:func:`account_in_flight_cap` -- **no
# account may hold more than half of the platform queue.**
#
# WHY THE CEILING IS A FUNCTION OF THE LANE (workstream C). With
# `translation` on its own lane, starving the shared worker is no longer the
# binding concern; the reaper is. A charge is presumed abandoned
# `abandoned_after()` (90 minutes) after purchase, and a job admitted behind Q
# others on a lane of C slots may wait ceil(Q / C) documents of up to
# `service.DOCUMENT_TIMEOUT_SECONDS` (15 minutes) each. Keeping one document of
# margin, ceil(Q / C) x 15 <= 90 - 15 gives Q <= C x 5: five on the old shared slot, twenty on 's four.
# (Since this PR the reaper also leaves a job that is still `todo`/`doing` alone
# until `abandoned_hard_after()`, so overrunning this bound delays a refund
# rather than wasting a delivery -- the bound is what keeps it from happening.)
#
# `settings.ZPAGE_TRANSLATION_LANE_CONCURRENCY` is the one source of truth for
# the lane (see its comment in settings.py): 4, the dedicated
# `translation-worker`  deploys, which gives Q = 20 and an account cap of
# 10. (It was 1 -- Q = 5, account cap 2 -- while `translation` shared the
# catch-all's single slot with search and detection.)
# `ZPAGE_TRANSLATION_MAX_QUEUED` still overrides the derived number outright.
#Used only if the setting is missing entirely; matches settings.py and the
#manifest's --concurrency (py/dj/apps/jobs/test_queue_isolation.py).
DEFAULT_LANE_CONCURRENCY = 4

#One document of margin under the abandonment deadline, in documents.
ABANDONMENT_MARGIN_DOCUMENTS = 1


def lane_concurrency():
    return max(1, int(getattr(settings, "ZPAGE_TRANSLATION_LANE_CONCURRENCY",
                              DEFAULT_LANE_CONCURRENCY)))


def derived_max_queued():
    """``C x floor(abandoned_after / document budget - margin)``, at least C."""
    from dj.apps.g12f.translation.service import DOCUMENT_TIMEOUT_SECONDS

    documents = int(
        abandoned_after().total_seconds() // DOCUMENT_TIMEOUT_SECONDS
    ) - ABANDONMENT_MARGIN_DOCUMENTS
    return lane_concurrency() * max(1, documents)


def max_queued():
    configured = getattr(settings, "ZPAGE_TRANSLATION_MAX_QUEUED", None)
    if configured is not None:
        return int(configured)
    return derived_max_queued()


def translation_overdue_threshold_seconds():
    """The `translation` queue-backlog alert threshold, from the queue model.

    In a healthy, FULL platform queue of ``max_queued()`` jobs on a lane of
    ``lane_concurrency()`` slots, the oldest runnable job waits at most
    ``ceil(Q / C) - 1`` documents of the 15-minute budget before it starts.
    One more document of margin gives ``ceil(Q / C)`` documents: past that the
    lane is not draining. 4500 seconds at the defaults, whatever the lane,
    because ``Q`` is itself derived as ``C x 5``. Mirrored by the metric
    policy in ``monitoring/alert-policies/procrastinate-queue-backlog-
    threshold.json``, which a contract test holds equal to this.
    """
    import math

    from dj.apps.g12f.translation.service import DOCUMENT_TIMEOUT_SECONDS

    documents = math.ceil(max_queued() / lane_concurrency())
    return int(documents * DOCUMENT_TIMEOUT_SECONDS)


def _live_queued_count(now=None, user=None):
    """Queued charges that are work the worker is still going to do.

    A charge counts while it is younger than ``abandoned_after``, or -- -- while it is older but its job is still ``todo``/``doing`` and it is
    inside ``abandoned_hard_after()``: the reaper leaves those alone (see
    :func:`abandoned_records`), so they are real backlog and must hold their
    slot, or a deep queue would admit more work behind itself.

    Excluding the rest still matters: a charge whose job is gone is not work
    the worker will do, and counting it would keep a creator locked out until
    the next sweep. Python-side over the queued rows, which the platform cap
    keeps to a few dozen.
    """
    now = now or timezone.now()
    rows = IdempotencyKey.objects.filter(
        scope=SCOPE,
        response_body__status=QUEUED,
        created_at__gte=now - abandoned_hard_after(),
    )
    if user is not None:
        rows = rows.filter(user=user)
    rows = list(rows.values_list(
        "created_at", KeyTextTransform("job_id", "response_body")
    ))
    fresh = now - abandoned_after()
    waiting = scheduled_job_ids(
        job_id for created_at, job_id in rows if created_at < fresh
    )
    return sum(
        1 for created_at, job_id in rows
        if created_at >= fresh or job_id in waiting
    )


def queued_count(now=None):
    return _live_queued_count(now)


#``pg_advisory_xact_lock`` key serializing translation ADMISSION
#platform-wide. See:func:`lock_admission`.
ADMISSION_LOCK_KEY = zlib.crc32(b"zpage_translation_admission")


def lock_admission():
    """Serialize the platform-queue check with every other purchase's.

    The account cap is serialized by the buyer's balance row, which every
    purchase locks first. The PLATFORM cap is not: three creators each
    submitting ten languages hold three different buyer rows, all read zero
    queued, all pass ``0 + 10 <= 20`` and all commit -- 30 jobs under a
    ceiling of 20 (codex adversarial review of, finding 2). With one job
    per account that overshoot was one job per concurrent buyer; bulk makes it
    ten.

    Transaction-scoped, taken AFTER the buyer and article row locks -- the
    order every caller uses, so it cannot deadlock against itself -- and held
    only for the count, the debit and the record inserts that follow it.
    """
    from django.db import connection

    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(%s)", [ADMISSION_LOCK_KEY])


#Concurrent translation jobs one account may hold. Named and configurable
#since, which asked for the per-account concurrency cap to be a stated
#bound with a test on it rather than a property of a call to ``.exists()``.
#
#TEN (it was one) -- deliberately ABOVE the lane's concurrency
#(4 since 's dedicated lane; 1 before it), because the two bound different
#things. Wall-clock exposure to the reaper is bounded by the PLATFORM queue,
#which is derived from the lane (:func:`max_queued`); this cap bounds one
#account's SHARE of that queue, and:func:`account_in_flight_cap` never lets
#it exceed half. A ten-language batch on an otherwise idle 4-slot lane drains
#in ceil(10 / 4) = 3 documents, 45 minutes at the 15-minute worst case --
#inside the 75-minute budget. Capping at 4 would instead make "translate this
#into my ten languages" three separate purchases, which is the very thing
#exists to remove.
#
#Why not more: ten is a batch a person picks deliberately rather than
#"select all 79", and it is what a creator can lose to ONE source edit before
#the one-edit-one-mutation rule below has to be right, so it keeps that blast
#radius small while the rule is new.
#
#What it does NOT bound is successful spend: the owner decision of
#2026-08-09 ("they bought the 2Zs, they can spend them on translations")
#stands. A creator at the cap waits for one job to finish, nothing more.
DEFAULT_MAX_IN_FLIGHT = 10


def max_in_flight():
    return max(
        1,
        int(getattr(settings, "ZPAGE_TRANSLATION_MAX_IN_FLIGHT",
                    DEFAULT_MAX_IN_FLIGHT)),
    )


def account_in_flight_cap():
    """The per-account cap as ENFORCED: never more than half the platform queue.

    ``max_in_flight()`` is the configured number; this is the number every
    purchase is checked against. Both settings are environment-tunable and
    nothing else relates them, so configuring an account cap at or above the
    platform ceiling would let one creator's bulk purchase occupy the whole
    queue and turn every other creator away with ``translation_backlog``.
    Halving makes that impossible by construction, whatever the two are set to,
    and at the defaults (10 of 20) it changes nothing.
    """
    return max(1, min(max_in_flight(), max_queued() // 2))


def max_batch_items():
    """The most languages one bulk purchase (or bulk quote) may name.

    Equal to the account cap: a batch larger than that could never be accepted
    whole, and bulk purchases are all-or-nothing.
    """
    return account_in_flight_cap()


def in_flight_count(user, now=None):
    return _live_queued_count(now, user=user)


def has_in_flight(user, now=None):
    """Whether this account is already at its concurrent-translation cap."""
    return in_flight_count(user, now=now) >= account_in_flight_cap()


def capacity(user, now=None):
    """``(remaining, in_flight)``: how many more jobs this account may start NOW.

    The smaller of what is left of its own cap and what is left of the
    platform queue, never negative. Advisory on the quote; the purchase
    re-checks both under its locks.
    """
    now = now or timezone.now()
    in_flight = in_flight_count(user, now=now)
    remaining = min(
        account_in_flight_cap() - in_flight,
        max_queued() - queued_count(now),
    )
    return max(0, remaining), in_flight


def in_flight_languages(user, zpage_id):
    """Languages of this article with a ``queued`` charge, any age.

    The set the draft ceiling has to RESERVE: every queued job into a
    language that holds no draft yet will create one when it delivers. Not
    built on ``_live_queued_count`` for the reason:func:`has_in_flight_for_target`
    gives -- a job past the abandonment deadline can still start late and
    deliver, so it still holds its slot until the reaper settles it.
    Over-reserving refuses a purchase that moves no money; under-reserving
    sells a job that aborts at delivery with ``draft_variant_limit``.

    Uses the ``(scope, user_id)`` prefix of the unique index, then the JSON
    predicates on that buyer's rows.
    """
    return set(
        IdempotencyKey.objects.filter(
            scope=SCOPE,
            user=user,
            response_body__status=QUEUED,
            response_body__zpage_id=zpage_id,
        ).values_list(KeyTextTransform("language", "response_body"), flat=True)
    ) - {None}


def has_in_flight_for_target(user, zpage_id, language):
    """Whether a purchase for THIS article and language is already running.

    Independent of:func:`max_in_flight`, and that independence is the point.
    Two live jobs for the same target can both pass their pre-flight checks,
    after which the first delivers and the second finds the draft changed --
    ``variant_changed``, which  attributes to the BUYER. Nobody edited
    anything: our own delivery moved the row.

    At the default cap of one this cannot arise, so the check is redundant
    today. It exists because the cap is a setting somebody will raise, and the
    thing that breaks when they do is a creator being charged for a conflict we
    created. The attribution of ``variant_changed`` in
    ``settlement.FAULT_BY_CODE`` rests on this exclusion; do not remove one
    without the other. (codex adversarial review of, round 5.)

    Deliberately NOT built on ``_live_queued_count``, which drops charges older than
    ``abandoned_after()``. That exclusion is right for the backpressure count --
    a charge the reaper has not reached yet is not work the worker will do, and
    counting it would lock a creator out of the whole feature. It is wrong here.
    ``translate_zpage`` requires only ``status == "queued"``, so a job that
    started late is still live past that cutoff; excluding it re-opens the exact
    overlap this function exists to prevent, at the one moment it is most likely
    (a rolling deploy re-queuing old jobs). The cost of being conservative is
    that one creator waits for one language until the reaper settles a stuck
    charge, which the ten-minute sweep bounds. The cost of being permissive is
    charging them for a conflict we created. (codex adversarial review of,
    round 6.)
    """
    return IdempotencyKey.objects.filter(
        scope=SCOPE,
        user=user,
        response_body__status=QUEUED,
        response_body__zpage_id=zpage_id,
        response_body__language=language,
    ).exists()


# --------------------------------------------------------------------------- #
# The failure path's own bounds
# --------------------------------------------------------------------------- #
# THIS IS A RATE LIMIT, AND IT IS A DELIBERATE REVERSAL -- read why.
#
# The 2026-08-09 owner decision ("they bought the 2Zs, they can spend them on
# translations") is about SUCCESSFUL spend, and it still stands: nothing here
# limits how many translations a creator may buy and receive. Its stated
# justification -- "the spend is self-limiting because it is real money" -- is
# simply not true of a refunded job, where the buyer's money comes straight back
# and ours does not. What follows limits the FAILURE path only:
#
#   * a ceiling on the provider spend our own failures may burn on behalf of one
#     account inside a window, and
#   * a platform-wide ceiling on the same, because a broken release is not one
#     abusive account -- it is many honest accounts each losing us a document,
#     and no per-account counter can see that shape at all.
#
# A refusal here moves NO money and says "not now". It is measured in 2Z of
# provider spend rather than in events on purpose: one failed 100,000-character
# document costs ~28 2Z of provider work and one failed short one costs ~2 2Z,
# so an event counter either lets the expensive shape through or forbids the
# cheap one. Set either ceiling to 0 to disable it.
#
# WHAT ONE 2Z OF THIS CEILING IS, which is the whole reason the number can be
# reasoned about at all. `failed_spend` sums `settlement.estimated_cost`, which
# is `service.translation_price` of the metered token counts; at the default
# translation markup of 1.0 `AIModel.get_tuzi_price` is `ceil(dollars * 100)`.
# So 1 2Z here == 1 cent of real provider spend, 100 2Z == $1.00/hour and
# 2,000 2Z == $20.00/hour -- **provided the token counts are the ones the
# provider metered**. (Raising ZPAGE_TRANSLATION_MARKUP breaks that identity:
# the ceilings would then be denominated in marked-up 2Z and admit
# proportionally less real spend. Nothing needs it today; if it ever moves,
# these two numbers have to move with it.)
#
# The identity holds EXACTLY at markup 1.0 -- `translation_price` copies the row
# and overrides `markup`, and `get_tuzi_price` does its arithmetic in `Decimal`
# before `ceil`. Exact-cent totals therefore stay exact here and in the creator's
# quote; fractional cents still round up by the intentional pricing rule.
#
# UNTIL  THEY WERE NOT, AND THE ERROR FELL UNEVENLY ON CREATORS BY THE
# LANGUAGE THEY WRITE IN. `estimated_cost` priced `meter.input_tokens`, which
# came from `count_message_tokens` -- `cl100k_base` for every model -- and the
# prompt is the creator's own article. cl100k over-counts against the encoding
# gpt-4o actually meters in by 3.17x for Hindi, 2.37x Thai, 2.25x Arabic, 1.86x
# Russian, 1.58x Simplified Chinese and 1.00x for English (measured on parallel
# prose; the same spread  measured on real translations). On the shape the
# failure path actually produces -- a failure part way through a document, so a
# large prompt and almost no reply -- the 100 2Z ceiling admitted 12.5 such
# failures for an English-writing creator and 4.2 for a Hindi-writing one. A
# refusal here moves no money, so the cost was a LOCKOUT, and it was a lockout
# that discriminated by the creator's language.  moved both counts onto
# `provider_message_tokens` / `provider_tokens`, so the identity above holds
# whatever language the article is in -- FOR A MODEL TIKTOKEN CAN MAP, which is
# every OpenAI row and is what production selects (see
# `settlement.OUTPUT_TOKEN_UNCERTAINTY`; every prod line in //
# that names a model names `openai/gpt-4o`). For Anthropic or Kimi there is no
# mapping, `cl100k_base` is a proxy for an encoding we cannot see, and the same
# bias is still here: measured on parallel ~1.8 kB articles, a Hindi prompt costs
# 1.47x an English one in o200k and 4.66x in cl100k. So this ceiling remains
# language-biased for an unmappable vendor.  closes the separate
# truncation-detection gap with provider termination reasons; provider-reported
# usage is still needed to remove this estimate bias. The constants did not
# change; what they measure did.
#
# SIZING, FROM PRODUCTION rather than from intuition, and re-costed in the
# corrected unit. Fourteen days of logs  hold eight paid
# translation jobs, all one creator, all one article: two delivered and six
# refunded. Those were costed at ~10 2Z each on the biased instrument; the one
# job whose counts the logs record in full (`in=6751 out=8228`, en->zh-Hans,
# gpt-4o) re-prices to **7 2Z**, so the worst REAL burst on record is ~42 2Z in
# one account in thirteen minutes, not ~60.
#
#   * 100 2Z/hour/account clears that burst with 2.4x of room (it was 1.7x when
#     the burst was read off the biased instrument), and caps the expensive
#     shape at about two max-size failures an hour -- $1.00/hour, $24/day --
#     against a bound of NOTHING before, where the concurrency
#     backpressure and the 900s document budget alone allow ~$43/day per
#     account ($53/day at 's raised output cap). "Two max-size failures"
#     is a LOW-EXPANSION target only -- read the per-language table
#     below before quoting it.
#
#   * 2,000 2Z/hour platform-wide is ~280 ordinary failures an hour: two orders
#     of magnitude above anything this feature has ever done. It can realistically
#     only be reached by a scripted loop or by a release that is failing
#     everything -- in which case declining to sell is the correct behaviour.
#
# PER-SCRIPT PRICING  DID NOT MOVE THESE NUMBERS. THE PER-LANGUAGE CAP
#  DOES, AND BY A LOT. The first half of this used to end "so the
# worst-case cost of one failed document is language-independent and the sizing
# above stands unchanged", and that was true for exactly as long as the cap was
# flat.
#
# The reasoning that still holds: `output_token_ratio(model, source, target)`
# replaced the flat 1.15 in `quote_document`, so the QUOTE depends on the target
# language -- and this ceiling does not read the quote. It sums `estimated_cost`,
# which prices the tokens the meter actually recorded.
#
# What changed is what bounds those tokens. `service._output_cap` is no longer
# `OUTPUT_CEILING_RATIO x` the source for everyone; it is
# `service.output_cap_ratio`, the target language's own measured expansion times
# `OUTPUT_CAP_HEADROOM`, floored at the old 2.5. It had to be: a correct Amharic
# translation fitted NEITHER attempt under the flat cap, so `am` was sellable and
# undeliverable, and Lao, Sinhala, Khmer and Burmese were the same shape. But the
# worst-case spend of one fully-failed document is now a function of the target.
# Measured on the -sized article above, one document that generates to the
# cap on every fragment and both attempts, gpt-4o, in 2Z of provider spend:
#
#   ====  =====  ======  =====  =====  =====  =====  =====
#..    `es`   `ja`    `my`   `km`   `si`   `am`   `lo`
#   ====  =====  ======  =====  =====  =====  =====  =====
#   was   73     73      73     73     73     73     73
#   now   73     100     153    155    156    210    283
#   ====  =====  ======  =====  =====  =====  =====  =====
#
# SO THE PER-ACCOUNT CEILING IS NOW REACHED BY A SINGLE FAILURE in the languages
#  set out to unblock: 283 2Z for Lao and 210 for Amharic against a 100 2Z
# hourly allowance, tested as `spend >= per_user`. The account is refused for the
# rest of the window after ONE failed Lao document, where before it got two
# max-size failures of any language. Platform-wide the ceiling falls from ~27
# fully-failed documents an hour to ~7.
#
# That is left as it is, deliberately, and it is not a money risk: erring tight
# bounds OUR loss and a refusal moves nobody's 2Z. It is a product cost, and it
# lands on the expensive scripts -- the same shape as the lockout-by-language
# described above, arriving through a different door. Two things make it
# tolerable rather than urgent: the worst case requires every fragment to cap
# TWICE, which after  means the model wrote 1.64x more than a correct
# translation in every fragment of the document; and 's whole point is that
# these languages stop failing. Raising the ceiling is a money decision, so it is
# tracked rather than taken here -- and if it is taken, the honest form is a
# per-language allowance, not a bigger flat number, for the same reason the cap
# itself is no longer flat.
#
# Both are bounds on OUR loss; neither is ever charged to anyone. The ceiling is
# on total spend INSIDE the window, not a rate, so "clears that burst" means the
# 42 2Z burst completes and the account is only refused if it keeps going for
# the rest of the hour.
DEFAULT_MAX_FAILED_SPEND_PER_USER = 100
DEFAULT_MAX_FAILED_SPEND_PLATFORM = 2000


def max_failed_spend_per_user():
    return int(getattr(settings, "ZPAGE_TRANSLATION_MAX_FAILED_SPEND_PER_USER",
                       DEFAULT_MAX_FAILED_SPEND_PER_USER))


def max_failed_spend_platform():
    return int(getattr(settings, "ZPAGE_TRANSLATION_MAX_FAILED_SPEND_PLATFORM",
                       DEFAULT_MAX_FAILED_SPEND_PLATFORM))


def _parse_settled_at(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    if timezone.is_naive(parsed):
        # We always write an aware stamp; a naive one can only come from a hand
        # edit, and reading it as UTC is the interpretation that keeps it inside
        # the window rather than silently dropping it from a spend total.
        return parsed.replace(tzinfo=dt_timezone.utc)
    return parsed


#How far back, by PURCHASE time,:func:`recent_refunds` looks for a refund
#SETTLED inside the window. Only an index-friendly bound on the scan; see the
#docstring for why purchase time cannot be the window itself.
RECENT_REFUNDS_HORIZON = timedelta(days=7)


def recent_refunds(now=None, window=None):
    """``{code: count}`` of translations we sold and failed to deliver.

    Every settled failure in ``window`` (default: the job-health failure
    window) EXCEPT the ones the buyer is established to have caused -- a
    creator editing their own article under a paid job is expected behaviour
    and paging on it would teach everyone to ignore this alert. Everything
    else counts: our defect, the provider's, the reaper's ``abandoned``, and a
    failure whose cause nobody could establish (``requester_caused`` is
    ``None``), because "we do not know why this failed" is the case an operator
    most needs to hear about.

    WHY THIS EXISTS. ``translate_zpage`` settles every failure it can observe
    inline and then returns normally, so Procrastinate records the job as
    succeeded and ``procrastinate_jobs.status = 'failed'`` -- the only thing the
    terminal-failure alert counts -- never happens for them. A revoked API key
    or a provider outage was a steady stream of refunds with no operator signal
    at all. This reads the charge rows, which are the source of truth for "was
    it delivered", rather than a log line, so the job-health sweep re-reports
    the same failure on every tick of the window exactly as it does for a
    terminal job failure, and one dropped log line cannot lose the page.

    SELECTED BY SETTLEMENT TIME, NOT PURCHASE TIME. The window is about when a
    failure HAPPENED, and purchase time does not bound that: the reaper stamps
    ``settled_at`` when it runs, and after a three-hour worker outage it refunds
    three-hour-old purchases in one tick. Filtering on ``created_at`` (as
    :func:`failed_spend` does) would drop exactly those refunds -- the outage
    this alert most needs to report. (codex adversarial review of.)

    So the database compares the ``settled_at`` stamp itself, as text under the
    ``C`` collation. Every stamp is written by ``timezone.now().isoformat()``,
    i.e. UTC with a fixed ``+00:00`` suffix, and ISO-8601 in one offset sorts
    bytewise in time order (an omitted ``.ffffff`` sorts before any fraction,
    which is also the right order). ``C`` because a locale collation may skip
    punctuation. The parsed comparison in Python below stays authoritative; the
    SQL only has to not drop a row this code wrote (a hand-edited stamp in
    another offset could be missed, and is not worth a cast that one malformed
    value would turn into a failed sweep). ``created_at`` still bounds the scan at
    :data:`RECENT_REFUNDS_HORIZON`, far beyond any delay the reaper survives
    unnoticed.

    A row with NO stamp predates ``settled_at``; it counts only when its
    purchase is recent enough that it could have failed inside the window, so a
    backlog of legacy refunds cannot hold the alert on.
    """
    now = now or timezone.now()
    if window is None:
        window = timedelta(
            seconds=settings.JOB_HEALTH_FAILURE_WINDOW_SECONDS
        )
    cutoff = now - window
    cutoff_text = cutoff.astimezone(dt_timezone.utc).isoformat()
    rows = (
        IdempotencyKey.objects.filter(
            scope=SCOPE,
            created_at__gte=now - RECENT_REFUNDS_HORIZON,
            response_body__status__in=FAILED,
        )
        .annotate(
            _settled_text=Collate(
                KeyTextTransform("settled_at", "response_body"), "C"
            )
        )
        .filter(
            models.Q(_settled_text__gte=cutoff_text)
            | models.Q(
                _settled_text__isnull=True,
                created_at__gte=cutoff - abandoned_after(),
            )
        )
    )
    # Only the four keys this needs, never the whole `response_body`: a
    # refunded receipt can carry `_fragments` -- up to MAX_CARRIED_CHARS of
    # paid-for translation -- and this runs every five minutes inside the
    # worker process that also serves the billing queue. (codex adversarial
    # review of.)
    projected = rows.values_list(
        KeyTextTransform("status", "response_body"),
        KeyTextTransform("requester_caused", "response_body"),
        KeyTextTransform("settled_at", "response_body"),
        KeyTextTransform("error", "response_body"),
    )
    codes = {}
    for status, requester_caused, stamp, error in projected:
        if status not in FAILED:
            continue
        # jsonb `true` reads back as the text 'true' through ->>.
        if requester_caused == "true":
            continue
        settled_at = _parse_settled_at(stamp)
        # No stamp: a legacy row the SQL above already bounded by purchase
        # time. Count it rather than hide a failure over its bookkeeping.
        if settled_at is not None and not (cutoff <= settled_at <= now):
            continue
        code = str(error or "unknown")
        codes[code] = codes.get(code, 0) + 1
    return dict(sorted(codes.items()))


def failed_spend(user=None, now=None):
    """``(failures, spend_2z)`` of provider-billing failures in the window.

    Only failures where the provider actually did billable work are counted.
    A purchase refused before any generation (the article vanished, the model
    was flagged off) cost us nothing, so it must not count against anybody --
    that is the same "charge them if openai charges us" rule read in the other
    direction.

    The database filter is on ``created_at`` (indexed, and purchase time) over a
    deliberately WIDER span than the window, and the window itself is then
    applied to the ``settled_at`` stamp in Python. A translation can run for
    minutes, so a row whose purchase is older than the window may have failed
    inside it; filtering on purchase time alone would let the slow, expensive
    failures -- the ones that cost the most -- age out of their own window.
    """
    now = now or timezone.now()
    window = settlement.failure_window()
    # The scan reaches back as far as a charge can still be LIVE: since
    # a job waiting in the queue keeps its charge until abandoned_hard_after(),
    # so it can fail -- with real provider spend -- that long after purchase.
    horizon = now - (window + abandoned_hard_after())
    cutoff = now - window
    rows = IdempotencyKey.objects.filter(
        scope=SCOPE,
        created_at__gte=horizon,
        response_body__provider_billed=True,
    )
    if user is not None:
        rows = rows.filter(user=user)
    failures = 0
    spend = 0
    # The body also carries up to 100k characters of reusable translation
    # fragments. Project the small set of accounting keys in SQL so each row
    # does not pull that payload across the database connection.
    projected = rows.values_list(
        "response_body__status",
        "response_body__settled_at",
        "response_body__estimated_cost",
        "response_body__metered_cost",
    )
    for status, settled_stamp, estimated_cost, metered_cost in projected:
        if status not in FAILED:
            continue
        settled_at = _parse_settled_at(settled_stamp)
        if settled_at is not None and settled_at < cutoff:
            continue
        failures += 1
        # What the failure cost US, not what was billed: a full refund of a
        # document we paid for is exactly the loss this ceiling exists to
        # bound.
        #
        # `estimated_cost` (undiscounted), NOT `metered_cost` (deliberately
        # discounted so a creator is never over-billed). Summing the charge-side
        # figure would make this ceiling let through as much extra spend as the
        # discount -- a "2,000 2Z" budget quietly worth 6,400. `metered_cost` is
        # the fallback for rows written before the two were separated.
        # (codex adversarial review of, round 4.)
        try:
            spend += max(
                0,
                int(
                    estimated_cost
                    if estimated_cost is not None
                    else (metered_cost or 0)
                ),
            )
        except (TypeError, ValueError):
            continue
    return failures, spend


def someone_else_edited_via_admin(zpage_id, creator_id, since, until=None):
    """Did a NON-CREATOR change this article through the Django admin?

    ``PageAdmin`` lets staff edit a creator's article and
    ``ZPageTranslationAdmin`` lets them edit and publish its translations
    (``g12f/admin.py``). A staff correction landing inside the generation window
    produces ``source_changed``, ``variant_changed`` or ``variant_published``
    with a full meter -- and the buyer changed nothing. ``language_source`` does
    not help either: ``signals.py`` labels a staff relabel ``creator``, so it
    reads as buyer evidence. (codex adversarial review of the  review
    fixes.)

    ``django.contrib.admin``'s ``LogEntry`` is positive evidence for a
    non-creator admin edit. Its absence is NOT evidence that the creator made
    the write: API and admin form writes have different audit paths, while
    queryset updates, management commands, shells, and SQL may have no actor
    record at all. The caller must treat an unrecorded actor conservatively.
    """
    from django.contrib.admin.models import LogEntry
    from django.contrib.contenttypes.models import ContentType
    from dj.apps.g12f.models import zPage, ZPageTranslation

    try:
        page_type = ContentType.objects.get_for_model(zPage)
        translation_type = ContentType.objects.get_for_model(ZPageTranslation)
    except Exception:
        # Content types unavailable: we cannot establish the actor, and an
        # unestablished actor is not a chargeable one.
        logger.exception("could not resolve content types for admin actor check")
        return True

    translation_ids = ZPageTranslation.objects.filter(
        zpage_id=zpage_id
    ).values_list("pk", flat=True)
    entries = LogEntry.objects.filter(action_time__gte=since)
    if until is not None:
        entries = entries.filter(action_time__lte=until)
    return (
        entries
        .exclude(user_id=creator_id)
        .filter(
            models.Q(
                content_type=page_type, object_id=str(zpage_id)
            )
            | models.Q(
                content_type=translation_type,
                object_id__in=[str(pk) for pk in translation_ids],
            )
        )
        .exists()
    )


def requester_action_failures(user, zpage_id=None, now=None, *, current=None,
                              current_error=None):
    """Prior mutate-the-target-after-paying failures for this buyer, in window.

    The repetition signal ``settlement.classify`` escalates on. Restricted to
    provider-billing failures for the same reason as:func:`failed_spend`: a
    mutation that cost us nothing is not evidence of anything.

    Counts the stored ADJUDICATION (``requester_caused``), not the error code.
    Counting the code makes one of OUR occurrences -- our detector relabelling
    the article mid-job -- consume one of the buyer's two forgiven slots and
    bring their next genuine mutation forward into being billable. That bites
    even when the failure it came from was refunded in full, which is what makes
    it worse than the headline case. (Reviewer of, finding 1, second half.)

    Records written before that field existed carry no adjudication and are not
    counted: a charge nobody adjudicated is not evidence against anyone.

    COUNTS MUTATIONS, NOT FAILED JOBS. Once a creator can have several
    jobs in flight on one article, one save of the article aborts every one of
    them with ``source_changed``. Counted per job, a single edit under five
    parallel jobs was FIVE mutations: jobs three to five were billed for an
    edit the creator made once, and the next genuine mutation inside the window
    was billed too. See:func:`_count_mutations` for how one edit is told apart
    from several, and:func:`settle_failure` for the half of the fix that keeps
    the later jobs of one edit from counting the earlier ones against it.

    ``current`` is the charge being settled now, if any: the count is then of
    the OTHER mutations, with ``current``'s own edit -- and every sibling job
    that edit also aborted -- counted as the one it is.
    """
    now = now or timezone.now()
    window = settlement.failure_window()
    cutoff = now - window
    rows = IdempotencyKey.objects.filter(
        scope=SCOPE,
        user=user,
        # As in failed_spend: as far back as a charge can still be live.
        created_at__gte=now - (window + abandoned_hard_after()),
        response_body__provider_billed=True,
    )
    if zpage_id is not None:
        rows = rows.filter(response_body__zpage_id=zpage_id)
    # As in failed_spend, select only the charge metadata this calculation
    # reads. In particular, never load carried fragments from response_body.
    projected = rows.values_list(
        "pk",
        "created_at",
        "response_body__status",
        "response_body__requester_caused",
        "response_body__settled_at",
        "response_body__error",
        "response_body__source_digest",
        "response_body__started_at",
        "response_body__zpage_id",
    )
    from types import SimpleNamespace

    adjudicated = []
    for (pk, created_at, status, requester_caused, settled_stamp, error,
         source_digest, started_at, body_zpage_id) in projected:
        if current is not None and pk == current.pk:
            continue
        if status not in FAILED:
            continue
        if requester_caused is not True:
            continue
        settled_at = _parse_settled_at(settled_stamp)
        if settled_at is not None and settled_at < cutoff:
            continue
        body = {
            "error": error,
            "source_digest": source_digest,
            "started_at": started_at,
            "zpage_id": body_zpage_id,
        }
        record = SimpleNamespace(pk=pk, created_at=created_at)
        adjudicated.append((record, body, settled_at))
    if current is None:
        return _count_mutations(adjudicated)
    current_body = (
        current.response_body if isinstance(current.response_body, dict) else {}
    )
    # Counting the current failure in, then taking it back out, is what makes
    # its siblings disappear: a sibling that shares current's edit adds no
    # stabbing point beyond the one current needs for itself.
    with_current = adjudicated + [
        (current, {**current_body, "error": current_error}, now)
    ]
    return max(0, _count_mutations(with_current) - 1)


#Failure codes that report a change to the SOURCE ARTICLE, which is one row
#shared by every job on that article -- so one write can abort several jobs.
#Every other attributable code is about the job's own target language
#(``variant_changed``, ``variant_published``, ``same_language``), which only
#that one job can observe, so one record is one mutation for those.
SOURCE_MUTATION_CODES = frozenset({"source_changed"})


def _count_mutations(adjudicated):
    """The FEWEST source edits that explain these failures, plus the rest.

    A job bought at source digest ``D`` that STARTED work at time ``c`` (the
    worker compared the article with ``D`` just before, see
    :func:`mark_started`) and failed ``source_changed`` at time ``s`` proves
    exactly one thing about the edit that killed it: it happened inside
    ``(c, s]`` -- after the job saw ``D`` and no later than the worker
    noticing. Purchase time is the wrong lower bound: jobs bought together and
    started one after another would all share it. (Adversarial review of
    .) One edit can only have aborted a SET of jobs if those
    intervals share a point, so the minimum number of edits that explains a
    set of aborted jobs is the minimum number of points stabbing all their
    intervals: sort by end, take the first end, discard every interval it
    stabs, repeat. Grouped by (article, digest), because jobs bought against
    different text were killed by different edits.

    The two shapes that matter:

    * five jobs running together, all killed by one save -- their intervals
      all contain the save, so ONE mutation;
    * five jobs bought together but each started after the previous one's
      edit-and-revert -- five disjoint intervals, so FIVE;
    * buy, edit, wait for the refund, revert, buy again, edit again -- the
      second purchase is after the first settled, the intervals are disjoint,
      so TWO. This is the cancel-for-free loop  exists to bound, and it
      must still count. Grouping on the digest alone (no time) would have
      collapsed it to one forever.

    It is a LOWER bound by construction, so it errs toward forgiving: a
    creator keeping a chain of overlapping jobs alive while editing back and
    forth can have two edits read as one. That halves the counter at worst,
    and the per-account failed-spend ceiling, which does not read this
    counter, still bounds the cost.
    """
    count = 0
    intervals = {}
    for record, body, settled_at in adjudicated:
        digest = body.get("source_digest")
        if body.get("error") not in SOURCE_MUTATION_CODES or not digest:
            count += 1
            continue
        # From when the job STARTED work (`mark_started`), not from purchase:
        # jobs bought together but started one after another, each killed by
        # its own edit, must not share an interval. A row with no stamp
        # (bought before, or never started) falls back to purchase time.
        start = _parse_settled_at(body.get("started_at")) or record.created_at
        # A legacy row with no settlement stamp proves only its own start.
        end = settled_at or start
        intervals.setdefault((body.get("zpage_id"), digest), []).append(
            (start, end)
        )
    for spans in intervals.values():
        point = None
        for start, end in sorted(spans, key=lambda span: span[1]):
            if point is not None and start < point:
                continue
            count += 1
            point = end
    return count


# --------------------------------------------------------------------------- #
# Never discard work already paid for
# --------------------------------------------------------------------------- #
def carried_fragments(
    user, zpage_id, language, source_digest, ai_model_id, *, own_record_pk=None,
):
    """Fragments a PREVIOUS attempt at this exact document already paid for.

    Keyed by everything that decides what the right translation is (see
    ``settlement.fragment_key``), so a hit is only ever the same question asked
    twice. Harvested from earlier charge records for the same article, language
    and source digest -- including refunded ones, which is the point: the
    creator paid nothing for those tokens and we paid full price, so re-buying
    the same translation must not make us pay again.

    The creator is still quoted, and still charged, the full price for the new
    purchase. That is not double-billing: the failed attempt was refunded in
    full, so across both attempts they pay one quote and we pay roughly one
    quote of provider cost -- which is the cost-plus promise, finally kept on
    the retry path too.

    ``own_record_pk`` is the charge being run. ITS stash (a contended attempt
    at this same purchase, ) survives a void caused by ANOTHER record:
    see the loop below.
    """
    records = (
        IdempotencyKey.objects.filter(
            scope=SCOPE,
            user=user,
            response_body__zpage_id=zpage_id,
            response_body__language=language,
            response_body__source_digest=source_digest,
            response_body__ai_model_id=str(ai_model_id),
        )
        .order_by("-created_at")
        .only("response_body")[:5]
    )
    records = list(records)
    # A rejection OF THE OUTPUT anywhere in the recent history of THIS document
    # voids the whole cache for it, not just that attempt's own fragments.
    #
    # The poisoned fragment can have been stored by an EARLIER, differently-shaped
    # failure -- a truncation stores fragments 1..k-1 without any of them ever
    # having been safety-checked as a document, and the rejection only happens on
    # the attempt that finally assembles them. So refusing to store on the
    # rejecting attempt is not enough; the read side has to distrust the history
    # too. Conservative and self-healing: the void lifts as the offending record
    # ages out of the lookup window, and the cost of being wrong is one document
    # re-translated at our expense. (codex adversarial review of.)
    #
    # A DELIVERY WITH WARNINGS counts as such a rejection. Those
    # violations used to fail the job and void this cache; delivering them
    # instead must not quietly turn the next purchase -- the creator buying
    # again BECAUSE the draft came back with warnings -- into a replay of the
    # same recalled fragments and the same warnings, at no provider cost.
    # The charge being run is fetched separately rather than trusted to be in
    # the five most recent records: a newer purchase must not push its own
    # stash out of the window.
    own = (
        IdempotencyKey.objects.filter(pk=own_record_pk, scope=SCOPE)
        .only("response_body")
        .first()
        if own_record_pk is not None
        else None
    )
    for record in records:
        if own is not None and record.pk == own.pk:
            continue
        body = record.response_body or {}
        rejected = (
            body.get("error")
            if body.get("status") in FAILED
            and not settlement.may_carry_fragments(body.get("error"))
            else None
        )
        if rejected is None and body.get("status") == DELIVERED:
            rejected = next(
                (
                    warning.get("code")
                    for warning in body.get("warnings") or ()
                    if isinstance(warning, dict)
                    and not settlement.may_carry_fragments(warning.get("code"))
                ),
                None,
            )
        if rejected is not None:
            logger.info(
                "translation fragment carry-over voided for zpage=%s %s: a "
                "recent attempt had its generated output rejected (%s)",
                zpage_id, language, rejected,
            )
            # Except THIS charge's own stash (codex review of, round 7).
            # It is the output of an earlier attempt at the SAME purchase that
            # lost a lock race at delivery, so it is newer work than whatever
            # was rejected, and replaying it is the retry finishing that
            # delivery -- not a re-buy replaying a rejection. Voiding it too
            # makes every contended retry pay the provider for the whole
            # document again, against one fixed quote.
            return _stored_fragments([own] if own is not None else [])
    return _stored_fragments(([own] if own is not None else []) + records)


def _stored_fragments(records):
    """``_fragments`` of each record, earliest-listed wins per key."""
    carried = {}
    for record in records:
        body = record.response_body or {}
        stored = body.get("_fragments")
        if not isinstance(stored, dict):
            continue
        for key, text in stored.items():
            if isinstance(key, str) and isinstance(text, str):
                carried.setdefault(key, text)
    return carried


def total_outstanding():
    """Sum of 2Z currently at risk. For the management command and alerting."""
    total = Decimal("0")
    for record in IdempotencyKey.objects.filter(
        scope=SCOPE, response_body__status=QUEUED
    ).only("response_body"):
        body = record.response_body or {}
        total += ledger.to_tuzis(body.get("charged") or 0)
    return total
