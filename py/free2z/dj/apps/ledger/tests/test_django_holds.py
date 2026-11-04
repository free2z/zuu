"""Django hold shims and mixed-fleet reservation compatibility."""
import uuid
from decimal import Decimal

import pytest
from django.db import connection

from dj.apps.ledger import api, holds, invariants
from dj.apps.tuzis import ledger
from dj.apps.tuzis.models import ProviderReservation
from dj.apps.tuzis.test_ledger_dual_write import journaled_pod_reserves

pytestmark = pytest.mark.django_db


def test_reserve_replays_open_and_retries_released_without_double_charge(creator_factory):
    user = creator_factory(tuzis=10)
    key = uuid.uuid4()
    first = ledger.reserve(user, 6, scope='ai_image', operation_key=key)
    assert isinstance(first, holds.HoldReservation)
    assert ledger.reserve(user, 6, scope='ai_image', operation_key=key).pk == first.pk
    assert api.read_balance(user.pk).held == 6000
    assert not ProviderReservation.objects.filter(user=user).exists()
    assert ledger.release_reservation(first)
    assert not ledger.release_reservation(first)
    second = ledger.reserve(user, 6, scope='ai_image', operation_key=key)
    assert second.pk != first.pk
    ledger.settle_reservation(second, amount=4)
    ledger.settle_reservation(second, amount=4)
    user.refresh_from_db()
    assert user.tuzis == Decimal('6')
    with pytest.raises(ledger.InsufficientFunds):
        ledger.reserve(user, 6, scope='ai_image', operation_key=key)
    invariants.assert_l2()


def test_legacy_and_new_reservations_never_represent_same_operation(creator_factory):
    user = creator_factory(tuzis=20)
    key = uuid.uuid4()
    old = journaled_pod_reserves(user, 6, scope='ai_prompt', operation_key=key)
    replay = ledger.reserve(user, 6, scope='ai_prompt', operation_key=key)
    assert isinstance(replay, ProviderReservation) and replay.pk == old.pk
    fresh = ledger.reserve(user, 3, scope='ai_image', operation_key=uuid.uuid4())
    view = api.read_balance(user.pk)
    assert (view.balance, view.held, view.available) == (14000, 3000, 11000)
    from rest_framework.test import APIClient
    client = APIClient()
    client.force_authenticate(user=user)
    reported = client.get('/api/sdk/v1/balance').json()
    assert (reported['balance_milli_2z'], reported['held_milli_2z'],
            reported['available_milli_2z']) == (20000, 9000, 11000)
    with connection.cursor() as cursor:
        cursor.execute('SELECT count(*) FROM ledger_hold')
        assert cursor.fetchone() == (1,)
    ledger.settle_reservation(replay, amount=4)
    ledger.release_reservation(fresh)
    user.refresh_from_db()
    assert user.tuzis == 16
    invariants.assert_l2()


def test_partial_fixed_collection_rolls_back_until_caller_releases(creator_factory):
    user = creator_factory(tuzis=10)
    held = ledger.reserve(user, 8, scope='ai_image', operation_key=uuid.uuid4())
    with connection.cursor() as cursor:
        cursor.execute('UPDATE g12f_creator SET tuzis=4 WHERE id=%s', [user.pk])
    with pytest.raises(ledger.InsufficientFunds):
        ledger.settle_reservation(held, amount=7)
    with connection.cursor() as cursor:
        cursor.execute('SELECT count(*) FROM ledger_hold WHERE id=%s', [held.pk])
        assert cursor.fetchone() == (1,)
        cursor.execute('SELECT count(*) FROM ledger_ai_usage WHERE hold_id=%s', [held.pk])
        assert cursor.fetchone() == (0,)
    assert ledger.release_reservation(held)
    assert api.read_balance(user.pk).available == 4000
    invariants.assert_l2()
