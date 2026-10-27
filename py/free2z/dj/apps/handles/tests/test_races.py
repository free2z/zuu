"""Concurrency: the database, not the pre-checks, decides who wins.

Each test holds one writer's transaction open *after* its insert, so the second
writer's pre-checks see nothing (the row is uncommitted) and it reaches its own
insert, which then blocks on the unique index until the first commits. That is
the exact interleaving the pre-checks cannot catch, forced deterministically.
"""

import threading
import time

import pytest
from django.db import IntegrityError, connection, transaction

from dj.apps.handles import claims
from dj.apps.handles.models import MessagingHandle

pytestmark = pytest.mark.django_db(transaction=True)

#: Long enough for the second writer to reach its blocked INSERT.
SETTLE_SECONDS = 0.5


def _race(first, second):
    """Run ``first`` in an open transaction, then ``second`` against it.

    Returns ``(first_result, second_result)``; an exception is the result.
    """
    inserted = threading.Event()
    release = threading.Event()
    results = {}

    def run_first():
        try:
            with transaction.atomic():
                results["first"] = first()
                inserted.set()
                release.wait(10)
        except Exception as exc:  # pragma: no cover - surfaced by the assert
            results["first"] = exc
            inserted.set()
        finally:
            connection.close()

    def run_second():
        inserted.wait(10)
        try:
            results["second"] = second()
            results["second_done_at"] = time.monotonic()
        except Exception as exc:
            results["second"] = exc
            results["second_done_at"] = time.monotonic()
        finally:
            connection.close()

    a = threading.Thread(target=run_first)
    b = threading.Thread(target=run_second)
    a.start()
    b.start()
    inserted.wait(10)
    time.sleep(SETTLE_SECONDS)
    assert "second" not in results, "the second writer did not block"
    released_at = time.monotonic()
    release.set()
    a.join(10)
    b.join(10)
    assert results["second_done_at"] >= released_at
    return results["first"], results["second"]


def test_two_accounts_racing_for_one_handle_one_wins(creator_factory):
    alice = creator_factory(username="a.lice")
    bob = creator_factory(username="b.ob")

    first, second = _race(
        lambda: claims.claim(alice, "prize"),
        lambda: claims.claim(bob, "prize"),
    )
    assert first == "prize"
    assert isinstance(second, claims.ClaimRefused)
    assert second.code == claims.CLAIM_TAKEN
    assert MessagingHandle.objects.get(handle="prize").user_id == alice.pk
    assert not MessagingHandle.objects.filter(user=bob).exists()


def test_one_account_racing_itself_gets_one_handle(creator_factory):
    carol = creator_factory(username="c.arol")

    first, second = _race(
        lambda: claims.claim(carol, "first_pick"),
        lambda: claims.claim(carol, "second_pick"),
    )
    assert first == "first_pick"
    assert isinstance(second, claims.ClaimRefused)
    assert second.code == claims.CLAIM_ALREADY_BOUND
    assert list(
        MessagingHandle.objects.filter(user=carol).values_list("handle", flat=True)
    ) == ["first_pick"]


def test_two_signups_racing_for_case_variant_usernames_one_wins(creator_factory):
    """The serializer's ``username__iexact`` check cannot stop this; the index does."""
    from django.contrib.auth import get_user_model

    Creator = get_user_model()
    first, second = _race(
        lambda: Creator.objects.create(username="Zed"),
        lambda: Creator.objects.create(username="zed"),
    )
    assert first.username == "Zed"
    assert isinstance(second, IntegrityError)
    assert list(
        Creator.objects.filter(username__iexact="zed").values_list(
            "username", flat=True
        )
    ) == ["Zed"]
    assert MessagingHandle.objects.get(handle="zed").user_id == first.pk


def test_a_backfill_that_loses_a_row_to_a_live_request_keeps_the_rest(
    creator_factory, mocker
):
    """``handle_census --apply`` on a live site: a claim lands mid-run."""
    from django.contrib.auth import get_user_model

    from dj.apps.handles import reservation

    late = creator_factory(username="late_a")
    later = creator_factory(username="late_b")
    MessagingHandle.objects.filter(user__in=[late, later]).delete()

    from django.db.models.query import QuerySet

    real_bulk_create = QuerySet.bulk_create

    def claim_first(self, objs, **kwargs):
        # Another request reserves late_a between the snapshot and the insert.
        MessagingHandle.objects.create(
            handle="late_a", user=late, source="username"
        )
        return real_bulk_create(self, objs, **kwargs)

    mocker.patch.object(
        QuerySet, "bulk_create", side_effect=claim_first, autospec=True
    )
    stats = reservation.reserve_username_handles(
        get_user_model(), MessagingHandle
    )
    assert stats.reserved == 2  # attempted; the conflicting one was skipped
    assert MessagingHandle.objects.get(user=later).handle == "late_b"
    assert MessagingHandle.objects.get(user=late).handle == "late_a"


def test_a_rename_that_loses_the_username_race_is_a_400_not_a_500(
    creator_factory, mocker
):
    """The serializers check ``username__iexact`` first; a race skips it.

    Simulated by disabling that check: the database index is what refuses,
    and the API must answer the way the check would have.
    """
    from rest_framework.test import APIClient

    from dj.apps.g12f.serializers.creator import CreatorProfileUpdateSerializer

    creator_factory(username="Quincy")
    renamer = creator_factory(username="renamer")
    mocker.patch.object(
        CreatorProfileUpdateSerializer,
        "validate_username",
        lambda self, value: value,
    )
    client = APIClient()
    client.force_authenticate(user=renamer)
    response = client.patch(
        "/api/auth/user/", {"username": "quincy"}, format="json"
    )
    assert response.status_code == 400, response.content
    assert response.json() == {
        "username": ["A user with that username already exists!"]
    }
    renamer.refresh_from_db()
    assert renamer.username == "renamer"
