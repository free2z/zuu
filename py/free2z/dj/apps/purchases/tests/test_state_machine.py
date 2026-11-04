"""The purchase-intent status state machine (spec purchase.md §1.2), against
real Postgres: every edge, every non-edge, the compare-and-swap, and the
constraints the database enforces underneath it."""
from __future__ import annotations

import itertools
from datetime import timedelta

import pytest
from django.db import IntegrityError, transaction
from django.utils import timezone

from dj.apps.purchases.models import (
    CREDITED_STATUSES,
    TERMINAL_STATUSES,
    TRANSITIONS,
    InvalidTransition,
    PurchaseIntent,
    Rail,
    Status,
)

pytestmark = pytest.mark.django_db

#: The spec's edges, written out independently of TRANSITIONS so a change to
#: the table has to change this too. Two readings are explicit (models.py):
#: expired/failed only from PRE-credit states, and failed -> paid.
SPEC_EDGES = {
    ("created", "pending"), ("pending", "paid"), ("paid", "credited"),
    ("created", "expired"), ("pending", "expired"), ("paid", "expired"),
    ("created", "failed"), ("pending", "failed"), ("paid", "failed"),
    ("expired", "paid"), ("failed", "paid"),
    ("credited", "refunded"), ("credited", "partially_refunded"),
    ("credited", "disputed"), ("credited", "clawed_back"),
    ("partially_refunded", "refunded"), ("partially_refunded", "disputed"),
    ("disputed", "credited"), ("disputed", "refunded"), ("disputed", "partially_refunded"),
}


def make_intent(creator, status=Status.CREATED, **extra):
    now = timezone.now()
    fields = {
        "creator": creator,
        "rail": Rail.STRIPE,
        "platform": "desktop",
        "status": status,
        "quantity_2z": 500,
        "quote": {},
        "pricing_version": "card-v3",
        "price_minor": 550,
        "currency": "USD",
        "created_at": now,
        "expires_at": now + timedelta(minutes=30),
    }
    if status in CREDITED_STATUSES:
        fields.update(credited_at=now, credited_milli_2z=500_000)
    fields.update(extra)
    return PurchaseIntent.objects.create(**fields)


def test_the_table_is_exactly_the_spec():
    table = {(a, b) for a, targets in TRANSITIONS.items() for b in targets}
    assert table == SPEC_EDGES
    assert set(TRANSITIONS) == {s.value for s in Status}
    assert TERMINAL_STATUSES == {Status.REFUNDED, Status.CLAWED_BACK}


@pytest.mark.parametrize(("current", "new"), sorted(itertools.product([s.value for s in Status], repeat=2)))
def test_every_pair_is_allowed_iff_it_is_an_edge(creator_factory, current, new):
    intent = make_intent(creator_factory(), status=current)
    extra = {}
    if new in CREDITED_STATUSES and current not in CREDITED_STATUSES:
        extra = {"credited_at": timezone.now(), "credited_milli_2z": 500_000}
    if (current, new) in SPEC_EDGES:
        intent.transition(new, **extra)
        assert PurchaseIntent.objects.get(pk=intent.pk).status == new
    else:
        with pytest.raises(InvalidTransition):
            intent.transition(new, **extra)
        assert PurchaseIntent.objects.get(pk=intent.pk).status == current


def test_a_stale_reader_loses_the_race(creator_factory):
    intent = make_intent(creator_factory(), status=Status.PENDING)
    stale = PurchaseIntent.objects.get(pk=intent.pk)
    intent.transition(Status.EXPIRED)
    # `stale` still believes pending; pending -> failed is an edge, but the
    # row is no longer pending, so the compare-and-swap refuses it.
    with pytest.raises(InvalidTransition) as excinfo:
        stale.transition(Status.FAILED)
    assert excinfo.value.current == Status.EXPIRED
    assert PurchaseIntent.objects.get(pk=intent.pk).status == Status.EXPIRED


def test_the_database_refuses_a_credit_without_its_fields(creator_factory):
    intent = make_intent(creator_factory(), status=Status.PAID)
    with pytest.raises(IntegrityError), transaction.atomic():
        PurchaseIntent.objects.filter(pk=intent.pk).update(status=Status.CREDITED)
    # ...and credit fields on an intent that never credited.
    with pytest.raises(IntegrityError), transaction.atomic():
        PurchaseIntent.objects.filter(pk=intent.pk).update(credited_milli_2z=1, credited_at=timezone.now())


def test_the_database_refuses_an_unknown_status(creator_factory):
    intent = make_intent(creator_factory())
    with pytest.raises(IntegrityError), transaction.atomic():
        PurchaseIntent.objects.filter(pk=intent.pk).update(status="settled")


def test_a_credit_needs_its_amount_not_just_its_time(creator_factory):
    """``NULL >= 1`` is UNKNOWN and a CHECK passes on UNKNOWN, so the amount's
    presence has to be asserted on its own (codex review)."""
    intent = make_intent(creator_factory(), status=Status.PAID)
    with pytest.raises(IntegrityError), transaction.atomic():
        PurchaseIntent.objects.filter(pk=intent.pk).update(
            status=Status.CREDITED, credited_at=timezone.now(),
        )
