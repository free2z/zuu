"""Reserving and reading handles. The only module that writes ``MessagingHandle``.

Two writers of reservations, and one reader:

* :func:`reserve_username_handles` — the bulk pass. Migration ``0002`` runs it
  with *historical* models, and ``manage.py handle_census --apply`` runs it
  with live ones, so both follow exactly the same collision policy. It is
  idempotent: an account that already has a row is skipped, a handle that is
  already held is skipped.
* :func:`ensure_username_handle` — one account, for accounts created after the
  migration (the ``post_save`` receiver) and as a fallback on POST paths.
* :func:`bound_handle` — the read. Everything that needs "what handle does this
  account own" calls this and nothing else.

The claim flow lives in ``claims.py`` because it validates user input; this
module never does.
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass

from django.db import IntegrityError, transaction

from . import policy

logger = logging.getLogger(__name__)

STATUS_BOUND = "bound"
STATUS_RETIRED = "retired"
SOURCE_USERNAME = "username"
SOURCE_CLAIMED = "claimed"


@dataclass
class ReservationStats:
    accounts: int = 0
    reserved: int = 0
    already_bound: int = 0
    ineligible: int = 0
    reserved_word: int = 0
    collision_or_taken: int = 0

    def as_dict(self):
        return asdict(self)


def reserve_username_handles(
    creator_model,
    handle_model,
    *,
    batch_size: int = 1000,
    using: str = "default",
    dry_run: bool = False,
) -> ReservationStats:
    """Reserve ``lowercase(username)`` for every eligible account that has none.

    **Collision policy.** Accounts are visited oldest first — ``date_joined``,
    then ``pk`` as the tie-break — so in a group of usernames that differ only
    by case, the earliest-created account reserves the handle and every later
    one finds it taken and is left unclaimed. ``is_active`` is deliberately not
    consulted: the working assumption says "earliest-created", and the census
    reports groups whose winner is inactive so an operator can decide.

    Handles already held (by any row, bound or retired) are never reassigned.

    ``reserved`` counts inserts attempted: one that lost to a concurrent writer
    is skipped by the database, and the row that won is already correct.

    ``dry_run`` counts exactly the same decisions and writes nothing, which is
    how ``handle_census`` reports the plan from inside a read-only transaction.
    """
    stats = ReservationStats()
    handles = handle_model._default_manager.using(using)
    taken = set(handles.values_list("handle", flat=True))
    has_row = set(
        handles.exclude(user__isnull=True).values_list("user_id", flat=True)
    )

    pending = []

    def flush():
        if dry_run:
            pending.clear()
        if pending:
            # ON CONFLICT DO NOTHING: when this runs as `handle_census --apply`
            # on a live site, a signup, a claim or an assertion can reserve a
            # row after the snapshot above. That row is already right; losing
            # to it must not roll back the whole backfill (codex review).
            handles.bulk_create(
                pending, batch_size=batch_size, ignore_conflicts=True
            )
            pending.clear()

    accounts = (
        creator_model._default_manager.using(using)
        .order_by("date_joined", "pk")
        .values_list("pk", "username")
        .iterator(chunk_size=2000)
    )
    for pk, username in accounts:
        stats.accounts += 1
        if pk in has_row:
            stats.already_bound += 1
            continue
        candidate, _reason = policy.eligibility(username)
        if candidate is None:
            stats.ineligible += 1
            continue
        if policy.is_reserved(candidate):
            stats.reserved_word += 1
            continue
        if candidate in taken:
            stats.collision_or_taken += 1
            continue
        taken.add(candidate)
        pending.append(
            handle_model(
                handle=candidate,
                user_id=pk,
                status=STATUS_BOUND,
                source=SOURCE_USERNAME,
            )
        )
        stats.reserved += 1
        if len(pending) >= batch_size:
            flush()
    flush()
    return stats


def handle_taken(handle: str) -> bool:
    """Whether any row (bound or retired) holds ``handle``.

    Filters on ``LOWER(handle)`` so PostgreSQL can answer from
    ``messaging_handle_ci_unique`` instead of scanning a table that only
    grows (retired rows are kept forever).
    """
    from django.db.models.functions import Lower

    from .models import MessagingHandle

    return (
        MessagingHandle.objects.alias(handle_lower=Lower("handle"))
        .filter(handle_lower=handle)
        .exists()
    )


def bound_handle(user) -> str | None:
    """The handle ``user`` owns, or ``None``. One indexed read, no writes."""
    from .models import MessagingHandle

    if user is None or not getattr(user, "pk", None):
        return None
    return (
        MessagingHandle.objects.filter(
            user_id=user.pk, status=STATUS_BOUND
        )
        .values_list("handle", flat=True)
        .first()
    )


def ensure_username_handle(user) -> str | None:
    """Return ``user``'s bound handle, reserving its username's if it can.

    **A write. Call it only from an unsafe-method code path** (``POST``), a
    signal, or a management command — ``dj/apps/test_url_write_guard.py`` Rule
    B forbids a read reaching it. Reserves only when the account has no row,
    its username is eligible and not a reserved word, and nobody holds the
    handle; otherwise returns what is there (possibly ``None``). The insert is
    in its own savepoint, so losing a race never breaks the caller's
    transaction.
    """
    from .models import MessagingHandle

    existing = bound_handle(user)
    if existing is not None:
        return existing
    if MessagingHandle.objects.filter(user_id=user.pk).exists():
        # A row that is not bound (retired) is not ours to replace.
        return None

    candidate = policy.auto_reservable(user.get_username())
    if candidate is None:
        return None
    if handle_taken(candidate):
        return None
    try:
        with transaction.atomic():
            MessagingHandle.objects.create(
                handle=candidate,
                user=user,
                status=STATUS_BOUND,
                source=SOURCE_USERNAME,
            )
    except IntegrityError:
        # Somebody else reserved or claimed it first, or this account got a
        # row concurrently. Either way the database has the answer.
        return bound_handle(user)
    return candidate
