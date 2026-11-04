"""@F2ZP2P announcements: durable ledger, execution and sweep.

PRODUCERS (inside the transaction that creates the event):

*func:`on_zpage_first_published` -- receiver of
  ``g12f.publication.zpage_first_published``, which both publication paths
  send exactly on the first draft -> public transition;
*func:`on_comment_created` -- called from the comment ``post_save``
  receiver for a newly created comment.

Each writes ONE:class:`~dj.apps.twitter.models.Announcement` under its
unique ``event_key`` (a duplicate is a no-op INSERT) and defers the job on
commit. A rollback takes the row with it; a process that dies between COMMIT
and the defer leaves a ``pending`` row the periodic sweep picks up.

EXECUTION (:func:`run_announcement`, the ``twitter.announce`` task) claims the
row with a compare-and-set, re-checks everything that can have changed since
the event (kill switch, age, visibility, caps, provider pause), generates
copy + image, commits ``posting``, and only then calls X. See the model
docstring for the state machine and ``client_x`` for the error classes.

Observability: every state change emits one JSON line with
``event="f2zp2p_announcement"``; lines that need a human carry ``alert`` and
``severity=ERROR`` and are what ``monitoring/alert-policies/
f2zp2p-announcement-failing.json`` matches.
"""
from __future__ import annotations

import logging
import random
import uuid
from datetime import timedelta

from django.conf import settings
from django.db import connection, transaction
from django.db.models import F, Q
from django.utils import timezone

from dj.apps.jobs.logs import emit_json_line
from dj.apps.jobs.priorities import BACKGROUND
from dj.apps.twitter.models import Announcement

logger = logging.getLogger(__name__)

EVENT = "f2zp2p_announcement"
QUEUE = "social"
TASK_NAME = "twitter.announce"
SWEEP_TASK_NAME = "twitter.sweep_announcements"
#Below every ordinary job (default 0); see tasks.py.
PRIORITY = BACKGROUND

#A row in ``generating`` this long has lost its worker (a job's worst case is
#~255s, every provider call being bounded by a total deadline below).
GENERATING_STALE = timedelta(minutes=15)
#A row in ``posting`` this long may or may not have been created on X.
POSTING_STALE = timedelta(minutes=15)
#Pending rows older than this (in live mode) mean announcements are not
#going out.
BACKLOG_ALERT_AGE = timedelta(minutes=30)
SWEEP_BATCH = 100
#Media ids are reused on retry only with this much validity left.
MEDIA_REUSE_MARGIN = timedelta(minutes=10)
MAX_BACKOFF_SECONDS = 60 * 60
#Total wall-clock per provider call (seconds); see deadline.py. One job's
#worst case is COPY + 2 x (IMAGE-or-CARD + UPLOAD) + CREATE, ~255s.
COPY_DEADLINE = 60
IMAGE_DEADLINE = 75
CARD_DEADLINE = 30
UPLOAD_DEADLINE = 30
CREATE_DEADLINE = 30
MEDIA_DEFAULT_TTL_SECONDS = 60 * 60
#An operator may not Retry a needs_reconciliation row sooner than this after
#it was flagged: an abandoned create can still be in flight (deadline.py).
RECONCILE_COOLDOWN = timedelta(minutes=15)

#pg_advisory_xact_lock key serialising the cap check + reservation.
_CAP_LOCK_KEY = 0x1865F2


# --------------------------------------------------------------------------- #
# Mode
# --------------------------------------------------------------------------- #
OFF, DRY_RUN, LIVE = "off", "dry_run", "live"


def effective_mode(force_live: bool = False) -> str:
    """The mode this process may act in. ``live`` needs the live namespace."""
    mode = LIVE if force_live else settings.F2ZP2P_ANNOUNCEMENTS
    if mode == LIVE and settings.NAMESPACE != settings.F2ZP2P_LIVE_NAMESPACE:
        return DRY_RUN
    return mode


def _log(ann, message, *, alert=None, **extra):
    payload = {
        "event": EVENT,
        "announcement_id": getattr(ann, "pk", None),
        "event_key": getattr(ann, "event_key", None),
        "status": getattr(ann, "status", None),
        "reason": getattr(ann, "reason", None),
        "attempts": getattr(ann, "attempts", None),
        "x_post_id": getattr(ann, "x_post_id", None),
        "alert": alert,
    }
    payload.update(extra)
    emit_json_line(logger, payload, "ERROR" if alert else "INFO", message)


# --------------------------------------------------------------------------- #
# Producers
# --------------------------------------------------------------------------- #
def zpage_event_key(zpage_id) -> str:
    return f"zpage:first-published:{zpage_id}"


def comment_event_key(comment_uuid) -> str:
    return f"comment:created:{comment_uuid}"


def _record(event_key, kind, *, using, **fields):
    """Insert the ledger row once and wake the job after COMMIT."""
    with transaction.atomic(using=using):
        ann, created = Announcement.objects.using(using).get_or_create(
            event_key=event_key, defaults={"kind": kind, **fields},
        )
    if created:
        pk = ann.pk
        transaction.on_commit(lambda: defer_announcement(pk), using=using)
        _log(ann, f"f2zp2p announcement recorded: {event_key}")
    return ann


def _never_block(producer):
    """A social announcement must never fail a publish or a comment.

    The producer runs in a SAVEPOINT, so a database error inside it rolls
    back only its own writes and leaves the caller's transaction usable;
    any exception is logged and swallowed. The cost of a swallowed failure
    is one missing announcement, which is logged at ERROR.
    """
    def wrapper(*args, using="default", **kwargs):
        if settings.F2ZP2P_ANNOUNCEMENTS == OFF:
            return None
        try:
            with transaction.atomic(using=using):
                return producer(*args, using=using, **kwargs)
        except Exception:
            logger.exception("f2zp2p: could not record an announcement")
            return None
    wrapper.__name__ = producer.__name__
    wrapper.__doc__ = producer.__doc__
    return wrapper


@_never_block
def _record_zpage(zpage_id, using="default"):
    from dj.apps.g12f.models import zPage

    page = zPage._base_manager.using(using).filter(pk=zpage_id).only(
        "pk", "creator_id",
    ).first()
    if page is None:
        return None
    return _record(
        zpage_event_key(zpage_id), Announcement.ZPAGE_FIRST_PUBLISHED,
        using=using, zpage_id=page.pk, subject_user_id=page.creator_id,
    )


def on_zpage_first_published(sender=None, zpage_id=None, using="default",
                             **kwargs):
    """Receiver for ``g12f.publication.zpage_first_published``."""
    if zpage_id is None:
        return None
    return _record_zpage(zpage_id, using=using or "default")


@_never_block
def on_comment_created(comment, using="default"):
    """Called from the comment ``post_save`` receiver for ``created``."""
    reason = comment_suppression_reason(comment)
    if reason is not None:
        # Not public now; not recorded. (Execution re-checks anyway.)
        logger.info(
            "f2zp2p: comment %s not announced (%s)", comment.pk, reason,
        )
        return None
    return _record(
        comment_event_key(comment.pk), Announcement.COMMENT_CREATED,
        using=using, comment_id=comment.pk, subject_user_id=comment.author_id,
    )


# --------------------------------------------------------------------------- #
# Fence for the RETIRED Pub/Sub tweeter
# --------------------------------------------------------------------------- #
#The consumer name the legacy ``tweet_comments`` listener claims under
#(``comments.CommentConsumerClaim``). That listener acknowledges, WITHOUT
#posting, every comment it finds already claimed.
LEGACY_TWEETER_CONSUMER = "tweet_comments"
#Longer than Pub/Sub's maximum message retention (7 days, counted from
#PUBLICATION), so every message still sitting in ``tweetcomments-<ns>``
#names a fenced comment.
LEGACY_FENCE_LOOKBACK = timedelta(days=8)
LEGACY_FENCE_BATCH = 1000


def fence_comment_for_retired_tweeter(comment, using="default") -> None:
    """Pre-claim ``comment`` for the retired tweeter, in the creating TX.

    ``comment-tweeter`` is scaled to 0 but its subscription is not managed by
    any manifest (the listener creates it on subscribe) and rules_k8s never
    prunes, so ``tweetcomments-<ns>`` keeps collecting every new comment. An
    image revert or a scale-up would otherwise replay up to 7 days of them,
    uncapped, one DALL-E image each. The claim is DATA, so it fences the old
    image too: its callback sees ``claimed=False`` and acks without posting.

    Runs whatever F2ZP2P_ANNOUNCEMENTS says. MUST NOT raise.
    """
    from dj.apps.comments.models import CommentConsumerClaim

    try:
        with transaction.atomic(using=using):
            CommentConsumerClaim.objects.using(using).get_or_create(
                comment_id=comment.pk, consumer=LEGACY_TWEETER_CONSUMER,
            )
    except Exception:
        logger.exception(
            "f2zp2p: could not fence comment %s from the retired tweeter "
            "(the sweep will)", comment.pk,
        )


def _valid_uuids(values):
    out = []
    for value in values:
        try:
            out.append(uuid.UUID(str(value)))
        except (TypeError, ValueError):
            continue
    return out


def fence_retired_comment_tweeter(now=None) -> int:
    """Backfill the fence for recent comments that lack it.

    Covers comments written by pre-release web pods during the rollout and
    any path that bypasses ``post_save``. Retention runs from PUBLICATION,
    not from the comment, so a comment of any age whose NEW_COMMENT outbox
    message is still undelivered, or was delivered within the window, is
    fenced too. Returns how many were fenced.
    """
    from dj.apps.comments.models import Comment, CommentConsumerClaim
    from dj.apps.jobs.models import OutboxMessage

    now = now or timezone.now()
    since = now - LEGACY_FENCE_LOOKBACK
    try:
        in_flight = OutboxMessage.objects.filter(
            topic=settings.PUBSUB["NEW_COMMENT"]["topic"],
        ).filter(
            Q(published_at__isnull=True) | Q(published_at__gte=since)
        ).values_list("payload__uuid", flat=True)
        pks = list(
            Comment._base_manager.filter(
                Q(created_at__gte=since)
                | Q(pk__in=_valid_uuids(in_flight))
            ).exclude(
                consumer_claims__consumer=LEGACY_TWEETER_CONSUMER,
            ).values_list("pk", flat=True)[:LEGACY_FENCE_BATCH]
        )
        CommentConsumerClaim.objects.bulk_create(
            [CommentConsumerClaim(comment_id=pk,
                                  consumer=LEGACY_TWEETER_CONSUMER)
             for pk in pks],
            ignore_conflicts=True,
        )
    except Exception:
        logger.exception("f2zp2p: retired-tweeter fence backfill failed")
        return 0
    return len(pks)


def defer_announcement(announcement_id, schedule_at=None) -> None:
    """Wake the job for one row. MUST NOT raise (runs from ``on_commit``)."""
    try:
        from procrastinate.exceptions import AlreadyEnqueued

        from dj.apps.twitter import tasks
    except Exception:
        logger.exception("f2zp2p: could not import the announce task")
        return
    try:
        options = {"queueing_lock": f"f2zp2p-announce-{announcement_id}"}
        if schedule_at is not None:
            options["schedule_at"] = schedule_at
        tasks.announce_task.configure(**options).defer(
            announcement_id=announcement_id,
        )
    except AlreadyEnqueued:
        pass
    except Exception:
        # The row is durable; the sweep re-defers it.
        logger.exception(
            "f2zp2p: could not defer announcement %s; the sweep will",
            announcement_id,
        )


# --------------------------------------------------------------------------- #
# Visibility (shared helpers only -- )
# --------------------------------------------------------------------------- #
def zpage_suppression_reason(page):
    from dj.apps.comments.visibility import zpage_visible

    if page is None:
        return "deleted"
    if not page.is_published:
        return "not_published"
    if not zpage_visible(page, None):
        return "not_public"
    return None


def comment_suppression_reason(comment):
    from dj.apps.comments.visibility import comment_visible

    if comment is None:
        return "deleted"
    if comment.is_banned:
        return "moderated"
    if not comment.author.is_active:
        return "author_inactive"
    parent = comment.parent
    while parent is not None:
        if parent.is_banned:
            return "moderated"
        parent = parent.parent
    if not comment_visible(comment, None):
        return "not_public"
    return None


# --------------------------------------------------------------------------- #
# Facts
# --------------------------------------------------------------------------- #
def _origin():
    return settings.CANONICAL_ORIGIN.rstrip("/")


def _public_x_handle(user):
    from dj.apps.twitter.models import TwitterProfile

    try:
        profile = user.twitter_profile
    except (TwitterProfile.DoesNotExist, AttributeError):
        return ""
    if profile is None or not profile.is_public:
        return ""
    return profile.username or ""


def _og_card_url(page):
    """The Svelte social card, VERSIONED like the frontend's own meta tags
    (``?v=<updated_at>``, lib/meta.ts). The card is CDN-cached for an hour
    with a stale window; an unversioned URL would upload a card the creator
    has since replaced. The version is also part of the facts digest, so a
    cover/title change invalidates media cached on a pending announcement."""
    from urllib.parse import quote

    version = quote(page.updated_at.isoformat() if page.updated_at else "1")
    return f"{_origin()}/og/zpage/{page.free2zaddr}.png?v={version}"


def build_facts(ann):
    """``(Facts, None)`` for a still-public event, else ``(None, reason)``."""
    from dj.apps.comments.models import Comment
    from dj.apps.g12f.models import zPage
    from dj.apps.twitter.announcement_content import (
        EXCERPT_CHARS, Facts, plain_text,
    )

    if ann.kind == Announcement.ZPAGE_FIRST_PUBLISHED:
        page = zPage._base_manager.select_related("creator").filter(
            pk=ann.zpage_id,
        ).first() if ann.zpage_id else None
        reason = zpage_suppression_reason(page)
        if reason:
            return None, reason
        path = page.get_public_url()
        if not path:
            return None, "no_public_url"
        return Facts(
            kind=ann.kind,
            url=f"{_origin()}{path}",
            title=page.title or "",
            creator=page.creator.username,
            x_handle=_public_x_handle(page.creator),
            description=page.description or "",
            excerpt=plain_text(page.content)[:EXCERPT_CHARS],
            og_card_url=_og_card_url(page),
        ), None

    comment = Comment._base_manager.select_related("author").filter(
        pk=ann.comment_id,
    ).first() if ann.comment_id else None
    reason = comment_suppression_reason(comment)
    if reason:
        return None, reason
    parent_object = comment.content_object
    title, og_card = "", ""
    if isinstance(parent_object, zPage):
        title = parent_object.title or ""
        og_card = _og_card_url(parent_object)
    elif parent_object is not None:
        title = getattr(parent_object, "title", "") or ""
    text = " ".join(
        part for part in (comment.display_headline, plain_text(comment.content))
        if part
    )
    return Facts(
        kind=ann.kind,
        include_link=settings.F2ZP2P_COMMENT_LINKS,
        url=f"{_origin()}{comment.get_url()}",
        title=title,
        creator=comment.author.username,
        x_handle=_public_x_handle(comment.author),
        excerpt=text[:EXCERPT_CHARS],
        is_reply=comment.parent_id is not None,
        og_card_url=og_card,
    ), None


# --------------------------------------------------------------------------- #
# State transitions
# --------------------------------------------------------------------------- #
#The states a running job may move a row OUT of. Anything else means an
#operator (or the sweep) took the row away mid-run, and the job must stop.
IN_FLIGHT = (Announcement.GENERATING, Announcement.POSTING)


class OwnershipLost(Exception):
    """The row left the in-flight state under us (operator suppress/retry)."""


def _owned(ann, statuses=IN_FLIGHT):
    """This attempt's row: same lease, still in one of ``statuses``."""
    return Announcement.objects.filter(
        pk=ann.pk, lease=ann.lease, status__in=statuses,
    )


def _finish(ann, status, reason="", *, alert=None, from_statuses=IN_FLIGHT,
            **fields):
    """Conditionally move THIS attempt's in-flight row to ``status``.

    Conditional on the row still being in flight under this attempt's
    lease, so neither an operator's "Suppress" during a slow generation nor
    a newer attempt that took the row over after the sweep can be
    overwritten by the job that was running (codex review). Raises
    :class:`OwnershipLost` otherwise.
    """
    now = timezone.now()
    moved = _owned(ann, from_statuses).update(
        status=status, reason=reason, updated_at=now, **fields,
    )
    if not moved:
        raise OwnershipLost(ann.event_key)
    ann.status = status
    ann.reason = reason
    for key, value in fields.items():
        setattr(ann, key, value)
    _log(ann, f"f2zp2p announcement {status}: {ann.event_key} {reason}".strip(),
         alert=alert)
    return status


def _owned_update(ann, **fields):
    """Write evidence (copy, media) only while THIS attempt still owns the
    generating row. A stale attempt must never overwrite what a newer one
    posted -- reconciliation compares X against exactly these fields."""
    if not _owned(ann, (Announcement.GENERATING,)).update(**fields):
        raise OwnershipLost(ann.event_key)
    for key, value in fields.items():
        setattr(ann, key, value)


def _still_owned(ann):
    if not _owned(ann, (Announcement.GENERATING,)).exists():
        raise OwnershipLost(ann.event_key)


def _schedule_retry(ann, error_message, *, status_code=None,
                    retry_after=None, reason="retryable"):
    if ann.attempts >= settings.F2ZP2P_MAX_ATTEMPTS:
        return _finish(
            ann, Announcement.FAILED, "attempts_exhausted",
            alert="terminal_failure",
            last_error=error_message[:2000], last_status_code=status_code,
        )
    if retry_after is None:
        delay = min(MAX_BACKOFF_SECONDS, 60 * 2 ** max(0, ann.attempts - 1))
        delay += random.uniform(0, delay / 4)
    else:
        delay = min(MAX_BACKOFF_SECONDS, max(1, retry_after) + 5)
    when = timezone.now() + timedelta(seconds=delay)
    _finish(
        ann, Announcement.PENDING, reason, next_attempt_at=when,
        last_error=error_message[:2000], last_status_code=status_code,
    )
    defer_announcement(ann.pk, schedule_at=when)
    return Announcement.PENDING


def _provider_paused():
    """True while a recent 401/402/403 has not been followed by a success."""
    window = settings.F2ZP2P_PROVIDER_PAUSE_SECONDS
    if window <= 0:
        return False
    since = timezone.now() - timedelta(seconds=window)
    last_auth = Announcement.objects.filter(
        status=Announcement.FAILED,
        last_status_code__in=(401, 402, 403),
        updated_at__gte=since,
    ).exclude(reason="duplicate_content").order_by("-updated_at").values_list(
        "updated_at", flat=True,
    ).first()
    if last_auth is None:
        return False
    return not Announcement.objects.filter(
        status=Announcement.POSTED, posted_at__gt=last_auth,
    ).exists()


def _reserve_capacity(ann, *, dry_run=False):
    """Apply the spend caps atomically; reserve a slot on success.

    A reservation (``budget_reserved_at``) is taken ONCE, after the free
    pre-checks (kill switch, age, visibility, provider pause, credentials --
    a row refused by those spent nothing and holds no slot) and before any
    paid call, and counts for the whole window whatever happens next -- a retry,
    a failure, even a later suppression. Copy, image and upload are spent
    by then, so "only successful posts count" would let a 429 storm buy
    unlimited generation (codex review). A row that already holds a
    reservation (a retry) is not re-checked.

    Dry runs are budgeted against dry-run reservations only, so a stage
    rehearsal exercises the same caps without touching live capacity.
    """
    if ann.budget_reserved_at is not None:
        return None
    now = timezone.now()
    with transaction.atomic():
        _take_cap_lock()
        pool = Announcement.objects.filter(
            budget_reserved_at__gte=now - timedelta(days=1),
        ).exclude(pk=ann.pk)
        if dry_run:
            pool = pool.filter(status=Announcement.DRY_RUN)
        else:
            pool = pool.exclude(status=Announcement.DRY_RUN)
        hour = pool.filter(budget_reserved_at__gte=now - timedelta(hours=1))
        if hour.count() >= settings.F2ZP2P_HOURLY_CAP:
            return "rate_capped"
        if pool.count() >= settings.F2ZP2P_DAILY_CAP:
            return "daily_capped"
        if ann.subject_user_id is not None and hour.filter(
            subject_user_id=ann.subject_user_id,
        ).count() >= settings.F2ZP2P_AUTHOR_HOURLY_CAP:
            return "author_rate_capped"
        Announcement.objects.filter(pk=ann.pk).update(budget_reserved_at=now)
        ann.budget_reserved_at = now
    return None


def _take_cap_lock():
    """Serialise every cap check + the write it guards (transaction-scoped).

    Without it two workers can both count N-1 and both proceed, which is
    exactly how a cap of N becomes N+1 once WORKER_REPLICAS > 1."""
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(%s)", [_CAP_LOCK_KEY])


def _posting_cap_reached(ann) -> bool:
    """Would moving ``ann`` to ``posting`` now exceed a cap?

    MUST be called inside the transaction that performs that move: the lock
    it takes is held until COMMIT, so the count and the transition are one
    step for every other worker."""
    _take_cap_lock()
    now = timezone.now()
    posted = Announcement.objects.filter(
        status__in=Announcement.PROVIDER_REACHED,
        posting_started_at__gte=now - timedelta(days=1),
    ).exclude(pk=ann.pk)
    hour = posted.filter(posting_started_at__gte=now - timedelta(hours=1))
    return (
        hour.count() >= settings.F2ZP2P_HOURLY_CAP
        or posted.count() >= settings.F2ZP2P_DAILY_CAP
        or (ann.subject_user_id is not None and hour.filter(
            subject_user_id=ann.subject_user_id,
        ).count() >= settings.F2ZP2P_AUTHOR_HOURLY_CAP)
    )


# --------------------------------------------------------------------------- #
# Execution
# --------------------------------------------------------------------------- #
def run_announcement(announcement_id, *, force_live=False) -> str:
    """Execute one announcement. Returns the resulting status (or 'noop')."""
    now = timezone.now()
    lease = uuid.uuid4()
    claimed = Announcement.objects.filter(
        pk=announcement_id, status=Announcement.PENDING,
    ).filter(
        Q(next_attempt_at__isnull=True) | Q(next_attempt_at__lte=now)
    ).update(
        status=Announcement.GENERATING, attempts=F("attempts") + 1,
        updated_at=now, lease=lease,
    )
    if not claimed:
        return "noop"
    ann = Announcement.objects.get(pk=announcement_id)
    if ann.lease != lease:  # taken over between the claim and this read
        return "noop"
    try:
        return _execute(ann, force_live=force_live)
    except OwnershipLost:
        logger.info(
            "f2zp2p: %s was taken over (operator/sweep); stopping",
            ann.event_key,
        )
        return "noop"
    except Exception as exc:  # noqa: BLE001
        # Nothing public has happened unless the row reached `posting`;
        # re-read it rather than trust the in-memory copy.
        current = Announcement.objects.filter(
            pk=ann.pk, lease=ann.lease,
        ).values_list("status", flat=True).first()
        logger.exception("f2zp2p: unexpected error in %s", ann.event_key)
        try:
            if current == Announcement.POSTING:
                return _finish(
                    ann, Announcement.NEEDS_RECONCILIATION, "unexpected_error",
                    alert="needs_reconciliation", last_error=repr(exc)[:2000],
                )
            if current == Announcement.GENERATING:
                return _schedule_retry(
                    ann, repr(exc), reason="unexpected_error",
                )
        except OwnershipLost:
            return "noop"
        raise


def _execute(ann, *, force_live):
    from dj.apps.twitter import announcement_content as content
    from dj.apps.twitter import client_x

    mode = effective_mode(force_live)
    if mode == OFF:
        return _finish(ann, Announcement.SUPPRESSED, "disabled")
    if not force_live and timezone.now() - ann.created_at > timedelta(
        seconds=settings.F2ZP2P_MAX_AGE_SECONDS,
    ):
        return _finish(ann, Announcement.SUPPRESSED, "stale")

    facts, reason = build_facts(ann)
    if reason:
        return _finish(ann, Announcement.SUPPRESSED, reason)

    if mode == LIVE:
        # BEFORE the reservation: a row that fails here has
        # bought nothing and never reached X, so it must not take a budget
        # slot. Otherwise a long 402 outage fills the trailing-day pool with
        # `provider_paused` rows and, once credits are topped up, every new
        # event is suppressed as `daily_capped` for up to a day.
        #
        # The canary is how an operator proves the provider is back, so it
        # is the one path the pause does not apply to.
        if not force_live and _provider_paused():
            return _finish(
                ann, Announcement.FAILED, "provider_paused",
                alert="provider_paused",
            )
        try:
            client_x._auth()
        except client_x.XNotConfigured as exc:
            return _finish(
                ann, Announcement.FAILED, "not_configured",
                alert="provider_auth", last_error=str(exc),
            )

    if not force_live:
        cap = _reserve_capacity(ann, dry_run=(mode == DRY_RUN))
        if cap:
            return _finish(ann, Announcement.SUPPRESSED, cap)
    elif ann.budget_reserved_at is None:
        # The canary skips the caps but its spend still counts against them.
        _owned_update(ann, budget_reserved_at=timezone.now())

    if mode == DRY_RUN:
        # The deterministic template only: no provider is called, nothing
        # is spent, nothing is posted.
        copy = content.generate_copy(facts, use_llm=False)
        return _finish(
            ann, Announcement.DRY_RUN, "", text=copy.text, url=facts.url,
            copy_source=copy.source, includes_link=facts.include_link,
        )

    # ---- live -------------------------------------------------------------
    if ann.text and not copy_matches_facts(ann, facts):
        # Generated on an earlier attempt from facts that have since changed
        # (the author edited the text, withdrew their public X handle, the
        # canonical URL moved, the comment-link setting flipped): never post
        # the stale copy, nor an image generated from the old content.
        logger.info("f2zp2p: regenerating stale copy for %s", ann.event_key)
        _owned_update(
            ann, text="", media_id="", media_expires_at=None,
            image_source="", image_data=None,
        )
    if not ann.text:
        copy = content.generate_copy(facts)
        _owned_update(
            ann, text=copy.text, copy_source=copy.source, url=facts.url,
            includes_link=facts.include_link, source_digest=facts.digest,
        )
        theme = copy.image_prompt
    else:
        theme = facts.title or "a lively online conversation"

    media_id = _ensure_media(ann, facts, theme)
    if media_id is None:  # a terminal/retry outcome was already recorded
        return ann.status

    # Generation and upload take minutes. The creator may have unpublished
    # the page, or a moderator banned the comment, in the meantime: look
    # again immediately before the public, non-idempotent step.
    fresh, reason = build_facts(ann)
    if reason:
        return _finish(ann, Announcement.SUPPRESSED, reason)
    if not copy_matches_facts(ann, fresh):
        # Changed during generation. Rare enough to just try again later
        # (this attempt's reservation still holds).
        return _schedule_retry(ann, "facts changed during generation",
                               reason="facts_changed")

    # Commit the intent BEFORE the non-idempotent create -- and, in the same
    # locked step, hold the POSTING rate to the caps: the reservation above
    # bounds generation spend, but a retry whose reservation has aged out of
    # the window must not push the posts in this hour past the cap (codex
    # review). Over the cap: try again later, the copy and media are kept.
    with transaction.atomic():
        cap_wait = False if force_live else _posting_cap_reached(ann)
        moved = 0 if cap_wait else _owned(
            ann, (Announcement.GENERATING,),
        ).update(
            status=Announcement.POSTING, posting_started_at=timezone.now(),
            updated_at=timezone.now(),
        )
    if cap_wait:
        return _schedule_retry(
            ann, "posting cap reached; waiting for the window",
            retry_after=15 * 60, reason="posting_capped",
        )
    if not moved:
        return "noop"
    ann.status = Announcement.POSTING

    try:
        post_id = _x_call(
            client_x.create_post, ann.text, [media_id] if media_id else (),
            create=True, ann=ann,
        )
    except client_x.XProviderError as exc:
        return _handle_create_error(ann, exc)

    ann.x_post_id = post_id
    # A create that outlived POSTING_STALE was flagged for reconciliation by
    # the sweep (same lease). Its id is exactly what reconciliation needs, so
    # record it rather than lose it.
    _finish(
        ann, Announcement.POSTED, "", x_post_id=post_id,
        posted_at=timezone.now(), last_status_code=201, last_error="",
        from_statuses=(Announcement.POSTING,
                       Announcement.NEEDS_RECONCILIATION),
    )
    _log(ann, f"f2zp2p posted {ann.event_key} as {post_id}",
         kind="spend", estimated_x_cost_usd=estimated_cost(ann))
    return Announcement.POSTED


def estimated_cost(ann) -> float:
    """Best-effort USD estimate of what X billed for this announcement."""
    cost = (settings.F2ZP2P_COST_POST_WITH_URL_USD if ann.includes_link
            else settings.F2ZP2P_COST_POST_USD)
    if ann.media_id:
        cost += settings.F2ZP2P_COST_MEDIA_USD
    return round(cost, 4)


def _record_late_create(announcement_id, lease, outcome):
    """Runs in an ABANDONED create thread when X finally answers.

    A late success is exactly the evidence reconciliation needs, so record
    it -- on the same attempt's row, only while it still awaits
    reconciliation (codex review). Its own DB connection is closed after.
    """
    from django.db import connection as thread_connection

    try:
        if "value" not in outcome:
            return
        post_id = str(outcome["value"])
        now = timezone.now()
        recorded = Announcement.objects.filter(
            # POSTING too: the answer can arrive before the job has
            # committed its "ambiguous" verdict; the job's own conditional
            # write then loses, which is the right outcome.
            pk=announcement_id, lease=lease,
            status__in=(Announcement.POSTING,
                        Announcement.NEEDS_RECONCILIATION),
        ).update(
            status=Announcement.POSTED, x_post_id=post_id, posted_at=now,
            reason="late_create_success", updated_at=now,
        )
        emit_json_line(
            logger,
            {"event": EVENT, "announcement_id": announcement_id,
             "x_post_id": post_id, "recorded": bool(recorded),
             "alert": None if recorded else "needs_reconciliation"},
            "INFO" if recorded else "ERROR",
            f"f2zp2p late create result for {announcement_id}: {post_id}",
        )
    finally:
        # Only the abandoned provider thread owns a private connection;
        # never close the caller's.
        import threading

        from dj.apps.twitter.deadline import THREAD_NAME

        if threading.current_thread().name == THREAD_NAME:
            thread_connection.close()


def _x_call(fn, *args, create, ann=None):
    """An X call under a total deadline. A create that overran it may still
    land, so it is AMBIGUOUS (and a late answer is recorded); an upload that
    overran only orphans media."""
    import functools

    from dj.apps.twitter import client_x, deadline

    seconds = CREATE_DEADLINE if create else UPLOAD_DEADLINE
    on_late = None
    if create and ann is not None:
        on_late = functools.partial(_record_late_create, ann.pk, ann.lease)
    try:
        return deadline.call(fn, seconds, *args, on_late=on_late, lane="x")
    except deadline.ProviderBusy as exc:
        # Nothing was sent, create or not.
        raise client_x.XProviderError(
            client_x.RETRYABLE, str(exc), retry_after=300,
        ) from exc
    except deadline.DeadlineExceeded as exc:
        raise client_x.XProviderError(
            client_x.AMBIGUOUS if create else client_x.RETRYABLE, str(exc),
        ) from exc


def copy_matches_facts(ann, facts) -> bool:
    """Is ``ann``'s already-generated copy still true to the current facts?

    The source fingerprint must be unchanged (any edit to the text, title,
    handle, link or link setting invalidates the copy -- codex review), and,
    as a belt to those braces, the link must be exactly the current
    canonical URL (present iff links are on) and any @mention only the
    creator's CURRENT opted-in handle.
    """
    from dj.apps.twitter import announcement_content as content

    text = ann.text or ""
    if ann.source_digest != facts.digest:
        return False

    if facts.include_link:
        if not text.endswith(f"{content.LINK_SEPARATOR}{facts.url}"):
            return False
        body = text[: -len(facts.url)]
    else:
        body = text
    if content.contains_link(body):
        return False
    allowed = (facts.x_handle or "").lower()
    for mention in content.mentions(body):
        if mention.lower() != allowed:
            return False
    return True


def _handle_create_error(ann, exc):
    from dj.apps.twitter import client_x

    common = {"last_status_code": exc.status, "last_error": str(exc)[:2000]}
    if exc.kind == client_x.RETRYABLE:
        # Nothing was created (429/503/connect): back to pending. A post
        # that never reached X is not a reconciliation case.
        return _schedule_retry(
            ann, str(exc), status_code=exc.status,
            retry_after=exc.retry_after,
        )
    if exc.kind == client_x.AUTH:
        credits = exc.status == 402 or "credits" in (exc.problem or "")
        return _finish(
            ann, Announcement.FAILED,
            "credits_depleted" if credits else "provider_auth",
            alert="provider_credits" if credits else "provider_auth",
            **common,
        )
    if exc.kind == client_x.INVALID:
        reason = ("duplicate_content" if "duplicate" in str(exc).lower()
                  else "invalid_content")
        return _finish(
            ann, Announcement.FAILED, reason, alert="terminal_failure",
            **common,
        )
    return _finish(
        ann, Announcement.NEEDS_RECONCILIATION, "ambiguous_create",
        alert="needs_reconciliation", **common,
    )


def _ensure_media(ann, facts, theme):
    """Return a media id, ``""`` for a text-only post, or ``None`` when the
    row has already been moved to a retry/terminal state."""
    from dj.apps.twitter import announcement_content as content
    from dj.apps.twitter import client_x

    now = timezone.now()
    if ann.media_id and ann.media_expires_at and (
        ann.media_expires_at > now + MEDIA_REUSE_MARGIN
    ):
        return ann.media_id

    from dj.apps.twitter import deadline

    candidates = []  # (source, deadline seconds, lane, producer)
    if ann.copy_source == content.NEUTRAL_SOURCE:
        # The model declined this content: no picture of it either (the
        # generated theme and the OG card both derive from it).
        pass
    elif ann.image_data:
        # Generated on an earlier attempt from the same facts (a changed
        # digest clears it): re-upload it, never buy it again.
        cached = bytes(ann.image_data)
        candidates.append(("generated", None, None, lambda: cached))
    elif settings.F2ZP2P_IMAGE_ENABLED and (
        ann.image_generations < settings.F2ZP2P_MAX_IMAGE_GENERATIONS
    ):
        candidates.append((
            "generated", IMAGE_DEADLINE, "image",
            lambda: content.generate_image(theme, f"f2zp2p-{ann.event_key}"),
        ))
    if facts.og_card_url and ann.copy_source != content.NEUTRAL_SOURCE:
        candidates.append((
            "og_card", CARD_DEADLINE, "og_card",
            lambda: content.fetch_og_card(facts.og_card_url),
        ))

    for source, seconds, lane, produce in candidates:
        _still_owned(ann)  # do not buy an image for a suppressed row
        buying = source == "generated" and seconds is not None
        if buying:
            # Counted BEFORE the call: a timed-out generation may still bill.
            _owned_update(ann, image_generations=ann.image_generations + 1)
        try:
            if seconds is None:
                data = produce()
            else:
                data = deadline.call(produce, seconds, lane=lane)
        except Exception as exc:  # noqa: BLE001 -- fall through to next
            logger.warning(
                "f2zp2p: %s image unavailable for %s: %s",
                source, ann.event_key, type(exc).__name__,
            )
            continue
        if buying:
            _owned_update(ann, image_data=data)
        try:
            uploaded = _x_call(
                client_x.upload_image, data, "image/jpeg", create=False,
            )
        except client_x.XProviderError as exc:
            if exc.kind == client_x.AUTH:
                credits = exc.status == 402 or "credits" in (exc.problem or "")
                _finish(
                    ann, Announcement.FAILED,
                    "credits_depleted" if credits else "provider_auth",
                    alert="provider_credits" if credits else "provider_auth",
                    last_status_code=exc.status, last_error=str(exc)[:2000],
                )
                return None
            if exc.kind == client_x.RETRYABLE and exc.status == 429:
                _schedule_retry(
                    ann, str(exc), status_code=exc.status,
                    retry_after=exc.retry_after,
                )
                return None
            logger.warning(
                "f2zp2p: media upload failed for %s (%s); trying next",
                ann.event_key, exc,
            )
            continue
        # Without an explicit expiry, assume a conservative hour rather
        # than risk attaching an expired id to a paid create.
        expires = now + timedelta(
            seconds=uploaded.expires_after_secs or MEDIA_DEFAULT_TTL_SECONDS,
        )
        _owned_update(
            ann, media_id=uploaded.media_id, image_source=source,
            media_expires_at=expires,
        )
        return uploaded.media_id

    # Lose the image, never the post.
    _owned_update(ann, image_source="none")
    return ""


# --------------------------------------------------------------------------- #
# Sweep
# --------------------------------------------------------------------------- #
def sweep() -> dict:
    """Re-defer due rows, surface stuck ones, and emit the health line."""
    now = timezone.now()

    stuck_generating = Announcement.objects.filter(
        status=Announcement.GENERATING, updated_at__lt=now - GENERATING_STALE,
    )
    requeued = 0
    for ann in stuck_generating[:SWEEP_BATCH]:
        requeued += Announcement.objects.filter(
            pk=ann.pk, status=Announcement.GENERATING,
            updated_at__lt=now - GENERATING_STALE,
        ).update(
            # lease=None: the lost job can no longer touch the row, and the
            # next claim issues a fresh one.
            status=Announcement.PENDING, next_attempt_at=now,
            reason="worker_lost", updated_at=now, lease=None,
        )

    stuck_posting = 0
    for ann in Announcement.objects.filter(
        status=Announcement.POSTING,
        posting_started_at__lt=now - POSTING_STALE,
    )[:SWEEP_BATCH]:
        if Announcement.objects.filter(
            pk=ann.pk, status=Announcement.POSTING,
        ).update(
            status=Announcement.NEEDS_RECONCILIATION,
            reason="worker_lost_during_create", updated_at=now,
        ):
            stuck_posting += 1
            ann.status = Announcement.NEEDS_RECONCILIATION
            ann.reason = "worker_lost_during_create"
            _log(ann, f"f2zp2p announcement lost mid-create: {ann.event_key}",
                 alert="needs_reconciliation")

    # A cached image is only for a retry; a settled row does not need it.
    Announcement.objects.filter(
        status__in=(Announcement.POSTED, Announcement.SUPPRESSED,
                    Announcement.DRY_RUN),
        image_data__isnull=False,
    ).update(image_data=None)

    retired_fenced = fence_retired_comment_tweeter(now)

    due = list(Announcement.objects.filter(
        status=Announcement.PENDING,
    ).filter(
        Q(next_attempt_at__isnull=True) | Q(next_attempt_at__lte=now)
    ).order_by("created_at").values_list("pk", flat=True)[:SWEEP_BATCH])
    for pk in due:
        defer_announcement(pk)

    day = now - timedelta(hours=24)
    counts = {
        status: Announcement.objects.filter(
            status=status, updated_at__gte=day,
        ).count()
        for status, _label in Announcement.STATUS_CHOICES
    }
    # Only rows that are OVERDUE: a row correctly waiting for its retry
    # (`next_attempt_at` in the future: 429 backoff, `posting_capped`) is
    # not a sign that nobody serves the queue.
    overdue = now - BACKLOG_ALERT_AGE
    backlog = Announcement.objects.filter(
        status=Announcement.PENDING,
    ).filter(
        Q(next_attempt_at__isnull=True, created_at__lt=overdue)
        | Q(next_attempt_at__lt=overdue)
    ).count()
    unreconciled = Announcement.objects.filter(
        status=Announcement.NEEDS_RECONCILIATION,
    ).count()
    posted_day = Announcement.objects.filter(
        status=Announcement.POSTED, posted_at__gte=day,
    )
    spend = round(
        posted_day.filter(includes_link=True).count()
        * settings.F2ZP2P_COST_POST_WITH_URL_USD
        + posted_day.filter(includes_link=False).count()
        * settings.F2ZP2P_COST_POST_USD
        + posted_day.exclude(media_id="").count()
        * settings.F2ZP2P_COST_MEDIA_USD,
        4,
    )
    mode = effective_mode()
    alert = None
    if mode == LIVE and backlog:
        alert = "backlog"
    summary = {
        "event": EVENT,
        "kind": "health",
        "mode": mode,
        "alert": alert,
        "deferred": len(due),
        "requeued_generating": requeued,
        "retired_tweeter_fenced": retired_fenced,
        "stuck_posting": stuck_posting,
        "backlog": backlog,
        "unreconciled": unreconciled,
        "last_24h": counts,
        "estimated_x_spend_usd_24h": spend,
    }
    emit_json_line(
        logger, summary, "ERROR" if alert else "INFO",
        f"f2zp2p announcement sweep: mode={mode} deferred={len(due)} "
        f"backlog={backlog} unreconciled={unreconciled} "
        f"posted_24h={counts[Announcement.POSTED]} "
        f"est_spend_24h=${spend} "
        f"failed_24h={counts[Announcement.FAILED]}",
    )
    return summary
