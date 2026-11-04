"""Creator.total's full-save protection is a cache invariant, not a ledger one.

``total`` is a display/ranking cache rebuilt from authoritative zPage totals.
It gates no spend or authorization, so stale data here cannot mint money and a
recompute can repair it. The full-save exclusion prevents an unrelated save
from reintroducing an old cache value between recomputes; it must remain
semantically separate from the authoritative ``tuzis`` ledger invariant.
"""
from decimal import Decimal
from queue import Queue
import threading

import pytest
from django.contrib.admin.sites import AdminSite
from django.core.management import call_command
from django.db import connection
from django.db.models import QuerySet

from dj.apps.g12f.admin import CreatorAdmin
from dj.apps.g12f.models.creator import (
    DERIVED_CACHE_FIELDS,
    LEDGER_ONLY_FIELDS,
    Creator,
)
from dj.apps.g12f.models.zpage import zPage


def cached_total(creator) -> Decimal:
    return Creator.objects.values_list("total", flat=True).get(pk=creator.pk)


def test_total_is_a_derived_cache_not_a_ledger_field():
    """The same save mechanism protects two deliberately distinct concepts."""
    assert "total" in DERIVED_CACHE_FIELDS
    assert "total" not in LEDGER_ONLY_FIELDS
    assert DERIVED_CACHE_FIELDS.isdisjoint(LEDGER_ONLY_FIELDS)


def test_admin_cannot_silently_edit_the_derived_cache():
    admin = CreatorAdmin(Creator, AdminSite())
    assert "total" in admin.get_readonly_fields(request=None)


@pytest.mark.django_db
def test_full_save_does_not_restore_a_stale_total(creator_factory):
    creator = creator_factory(total=Decimal("1.25"))
    stale = Creator.objects.get(pk=creator.pk)

    # Stand in for cache_total() completing on another instance after this one
    # was loaded. Its explicit update_fields write is authoritative for the
    # cache, even though the aggregate source rows remain the ultimate truth.
    Creator.objects.filter(pk=creator.pk).update(total=Decimal("9.50"))

    stale.full_name = "Unrelated profile edit"
    stale.save()

    row = Creator.objects.get(pk=creator.pk)
    assert row.total == Decimal("9.50")
    assert row.full_name == "Unrelated profile edit"
    # Full-save exclusions are resynced so a serializer cannot echo the stale
    # cache value even though the database row was protected.
    assert stale.total == Decimal("9.50")


@pytest.mark.django_db
def test_cache_total_explicitly_recomputes_the_derived_field(creator_factory):
    """Protection cannot block the cache's real writer or imply money semantics."""
    creator = creator_factory(total=Decimal("73.45"))

    # With no zPages the authoritative aggregates are empty, hence zero. This
    # demonstrates why a bad total is recoverable while a bad balance is not.
    creator.cache_total()

    assert creator.total == Decimal("0")
    assert cached_total(creator) == Decimal("0")


@pytest.mark.django_db
def test_score_pages_repairs_creator_total_drift(creator_factory, capsys):
    creator = creator_factory(total=Decimal("73.45"))
    zPage.objects.create(
        creator=creator,
        title="scheduled repair",
        content="test",
        free2zaddr="scheduled-creator-repair",
        # 125 ZEC-equivalent is a valid source aggregate. The former
        # NUMERIC(10,8) Creator.total overflowed above 99.99999999 and poisoned
        # every later repair in the global sweep.
        tuzi_total=125_000,
    )

    call_command("score_pages", chunk_size=1)

    assert cached_total(creator) == Decimal("125")
    assert "Repaired 1 creator total(s)" in capsys.readouterr().out


@pytest.mark.django_db(transaction=True)
def test_concurrent_recomputes_cannot_publish_the_older_total_last(
    creator_factory, monkeypatch
):
    """Force the exact out-of-order writer interleaving the row lock prevents.

    The older recompute pauses after aggregating 10 2Z. The source advances to
    30 2Z and a newer recompute starts. Without serialization the newer writer
    saves 0.03 first, then the older writer overwrites it with 0.01. With the
    Creator lock, the newer writer waits and recomputes 0.03 only after the
    older transaction releases it.
    """
    creator = creator_factory(total=Decimal("0"))
    page = zPage.objects.create(
        creator=creator,
        title="cache serialization",
        content="test",
        free2zaddr="cache-serialization",
        tuzi_total=10,
    )
    creator.cache_total()

    older = Creator.objects.get(pk=creator.pk)
    newer = Creator.objects.get(pk=creator.pk)
    older_ready = threading.Event()
    release_older = threading.Event()
    checkpoints = Queue()
    errors = []

    real_save = Creator.save
    real_get = QuerySet.get

    def pause_older_save(instance, *args, **kwargs):
        fields = set(kwargs.get("update_fields") or ())
        if (
            threading.current_thread().name == "older-cache"
            and "total" in fields
        ):
            older_ready.set()
            if not release_older.wait(timeout=10):
                raise AssertionError("older cache writer was never released")
        return real_save(instance, *args, **kwargs)

    def observe_newer_lock(queryset, *args, **kwargs):
        if (
            threading.current_thread().name == "newer-cache"
            and queryset.model is Creator
            and queryset.query.select_for_update
        ):
            checkpoints.put("newer-waiting-for-lock")
        return real_get(queryset, *args, **kwargs)

    monkeypatch.setattr(Creator, "save", pause_older_save)
    monkeypatch.setattr(QuerySet, "get", observe_newer_lock)

    def recompute(instance, finished):
        try:
            instance.cache_total()
        except Exception as exc:  # pragma: no cover - reported below
            errors.append(exc)
        finally:
            checkpoints.put(finished)
            connection.close()

    older_thread = threading.Thread(
        target=recompute, args=(older, "older-finished"), name="older-cache"
    )
    newer_thread = threading.Thread(
        target=recompute, args=(newer, "newer-finished"), name="newer-cache"
    )

    older_thread.start()
    assert older_ready.wait(timeout=10), "older writer never reached its save"
    zPage.objects.filter(pk=page.pk).update(tuzi_total=30)
    newer_thread.start()

    # New code reports that the newer call is attempting the locked Creator
    # read. On the unfixed implementation it has no such read, finishes first,
    # and reports "newer-finished" instead — after which releasing the older
    # writer deterministically restores the stale 0.01 cache.
    assert checkpoints.get(timeout=10) == "newer-waiting-for-lock"
    release_older.set()

    older_thread.join(timeout=10)
    newer_thread.join(timeout=10)
    assert not older_thread.is_alive()
    assert not newer_thread.is_alive()
    assert not errors, errors
    assert cached_total(creator) == Decimal("0.03")


@pytest.mark.django_db
def test_saving_a_total_only_instance_writes_nothing(creator_factory):
    """The new empty-update_fields edge preserves and resyncs the live cache."""
    creator = creator_factory(total=Decimal("1.25"))
    partial = Creator.objects.only("total").get(pk=creator.pk)

    Creator.objects.filter(pk=creator.pk).update(total=Decimal("9.50"))
    partial.total = Decimal("999")
    partial.save()

    assert cached_total(creator) == Decimal("9.50")
    assert partial.total == Decimal("9.50")
