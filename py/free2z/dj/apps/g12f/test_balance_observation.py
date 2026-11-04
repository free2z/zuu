"""Balance provenance survives delayed responses without a browser clock."""
from datetime import datetime, timezone
from decimal import Decimal
from concurrent.futures import ThreadPoolExecutor
import re

import pytest
from django.db import connection, connections
from django.test.utils import CaptureQueriesContext

from dj.apps.g12f.models import Creator
from dj.apps.g12f.serializers.creator import CreatorProfileDetailSerializer


@pytest.mark.django_db
def test_auth_balance_reselects_cached_user_with_database_observation(
    api_client, creator_factory, settings, monkeypatch,
):
    creator = creator_factory(tuzis=Decimal('10'))
    api_client.force_authenticate(user=creator)
    Creator.objects.filter(pk=creator.pk).update(tuzis=Decimal('35'))
    # Neither an application clock nor an activated timezone may stamp the
    # independently cached authentication row as a new balance observation.
    settings.TIME_ZONE = 'America/New_York'
    monkeypatch.setattr('django.utils.timezone.now', lambda: datetime(
        2000, 1, 1, tzinfo=timezone.utc,
    ))
    with CaptureQueriesContext(connection) as queries:
        response = api_client.get('/api/auth/user/')

    assert response.status_code == 200
    body = response.json()
    assert body['tuzis'] == '35.000'
    assert re.fullmatch(r'[1-9][0-9]*:(?:0|[1-9][0-9]*)', body['balance_snapshot'])
    snapshot_selects = [q['sql'] for q in queries.captured_queries
                        if 'pg_current_snapshot()' in q['sql']]
    assert len(snapshot_selects) == 1
    assert '"g12f_creator"."tuzis"' in snapshot_selects[0]
    assert 'pg_snapshot_xmax(pg_current_snapshot())' in snapshot_selects[0]
    assert re.search(
        r'SELECT COUNT\(\*\) FROM pg_snapshot_xip\(pg_current_snapshot\(\)\)',
        snapshot_selects[0], re.IGNORECASE,
    )
    assert 'pg_snapshot_xip(pg_current_snapshot())' in snapshot_selects[0]
    assert 'STATEMENT_TIMESTAMP' not in snapshot_selects[0]



@pytest.mark.django_db(transaction=True)
def test_delayed_old_response_keeps_older_balance_snapshot(
    api_client, creator_factory, monkeypatch,
):
    creator = creator_factory(tuzis=Decimal('10'))
    api_client.force_authenticate(user=creator)
    original = CreatorProfileDetailSerializer.to_representation
    newer = []
    delayed = False

    def commit_credit():
        # A different database connection commits while the old response is
        # rendering, like the independent node credit process.
        try:
            with connections['default'].cursor() as cursor:
                cursor.execute('SET statement_timeout = 3000')
            Creator.objects.filter(pk=creator.pk).update(tuzis=Decimal('35'))
        finally:
            connections['default'].close()

    def serialize_after_credit(serializer, instance):
        nonlocal delayed
        if not delayed:
            delayed = True
            # The old SELECT finished, but its response has not rendered.
            # A credit and another authoritative GET finish in that gap.
            with ThreadPoolExecutor(max_workers=1) as worker:
                worker.submit(commit_credit).result(timeout=5)
            newer.append(api_client.get('/api/auth/user/').json())
        return original(serializer, instance)

    monkeypatch.setattr(
        CreatorProfileDetailSerializer, 'to_representation', serialize_after_credit,
    )
    old = api_client.get('/api/auth/user/').json()

    assert old['tuzis'] == '10.000'
    assert newer[0]['tuzis'] == '35.000'
    assert snapshot_order(old) < snapshot_order(newer[0])


@pytest.mark.django_db
def test_unobserved_profile_representation_does_not_invent_snapshot(
    creator_factory,
):
    creator = creator_factory()
    assert 'balance_snapshot' not in CreatorProfileDetailSerializer(creator).data


@pytest.mark.django_db
def test_profile_write_cannot_forge_balance_observation(api_client, creator_factory):
    creator = creator_factory()
    api_client.force_authenticate(user=creator)
    forged = '18446744073709551615:0'
    response = api_client.patch('/api/auth/user/', {
        'description': 'Updated profile', 'balance_snapshot': forged,
    }, format='json')
    assert response.status_code == 200
    assert 'balance_snapshot' not in response.json()
    observed = api_client.get('/api/auth/user/').json()['balance_snapshot']
    assert observed != forged


@pytest.mark.django_db
def test_public_creator_does_not_expose_private_balance_metadata(
    api_client, creator_factory,
):
    creator = creator_factory()
    body = api_client.get(f'/api/creator/{creator.username}/').json()
    assert 'tuzis' not in body
    assert 'balance_snapshot' not in body


def snapshot_order(body):
    xmax, count = map(int, body['balance_snapshot'].split(':'))
    return xmax, -count


@pytest.mark.parametrize(
    ('older', 'newer'),
    [
        pytest.param(
            {'balance_snapshot': '120:7'}, {'balance_snapshot': '120:6'},
            id='same-xmax-fewer-in-progress-xids',
        ),
        pytest.param(
            {'balance_snapshot': '120:7'}, {'balance_snapshot': '121:40'},
            id='higher-xmax-even-with-more-in-progress-xids',
        ),
    ],
)
def test_balance_snapshot_serialized_order_is_load_independent(older, newer):
    """The public ``xmax:count`` token orders snapshots without ambient XIDs."""
    assert re.fullmatch(r'[1-9][0-9]*:(?:0|[1-9][0-9]*)', older['balance_snapshot'])
    assert re.fullmatch(r'[1-9][0-9]*:(?:0|[1-9][0-9]*)', newer['balance_snapshot'])
    assert snapshot_order(older) < snapshot_order(newer)


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    ('nested_savepoint', 'unrelated_xid_between_reads', 'unrelated_xid_before_third_read'),
    [
        pytest.param(False, False, False, id='without-savepoint-or-injected-xid'),
        pytest.param(True, False, False, id='with-savepoint-no-injected-xid'),
        pytest.param(False, True, False, id='xid-between-first-and-second-read'),
        pytest.param(False, False, True, id='xid-between-second-and-third-read'),
    ],
)
def test_low_xid_credit_completion_advances_snapshot_order(
    api_client, creator_factory, nested_savepoint, unrelated_xid_between_reads,
    unrelated_xid_before_third_read,
):
    """An XID allocated first may commit last; row xmin is not a revision."""
    creator = creator_factory(tuzis=Decimal('10'))
    api_client.force_authenticate(user=creator)
    writer = connection.copy()
    higher = connection.copy()
    try:
        writer.ensure_connection()
        writer.set_autocommit(False)
        with writer.cursor() as cursor:
            cursor.execute('SET LOCAL statement_timeout = 3000')
            cursor.execute('SELECT pg_current_xact_id()::text')
            low_xid = int(cursor.fetchone()[0])
            if nested_savepoint:
                cursor.execute('SAVEPOINT credit_savepoint')
            cursor.execute('UPDATE g12f_creator SET tuzis = %s WHERE id = %s',
                           [Decimal('35'), creator.pk])
            if nested_savepoint:
                cursor.execute('RELEASE SAVEPOINT credit_savepoint')
        higher.ensure_connection()
        with higher.cursor() as cursor:
            cursor.execute('SELECT pg_current_xact_id()::text')
            assert int(cursor.fetchone()[0]) > low_xid
        # A released savepoint is invisible until its top-level commits.
        old = api_client.get('/api/auth/user/').json()
        assert old['tuzis'] == '10.000'
        if unrelated_xid_between_reads:
            # A different transaction can legitimately move the global xmax
            # while this balance writer is still in flight. The observation
            # must remain ordered even when the fixed-xmax tie-break is not
            # the part of the token that advances.
            with higher.cursor() as cursor:
                cursor.execute('SELECT pg_current_xact_id()::text')
        writer.commit()
        new = api_client.get('/api/auth/user/').json()
        assert new['tuzis'] == '35.000'
        old_xmax, old_count = map(int, old['balance_snapshot'].split(':'))
        new_xmax, new_count = map(int, new['balance_snapshot'].split(':'))
        if unrelated_xid_between_reads:
            assert new_xmax > old_xmax
        elif new_xmax == old_xmax:
            assert new_count == old_count - 1
        else:
            # An unrelated transaction may allocate an XID in the interval
            # even when this case did not explicitly inject one.
            assert new_xmax > old_xmax
        assert snapshot_order(old) < snapshot_order(new)
        if unrelated_xid_before_third_read:
            # Exercise the real endpoint's shared serializer after an unrelated
            # transaction advances global XID state. The old exact-token check
            # failed here despite unchanged balance; ordering must remain valid.
            with higher.cursor() as cursor:
                cursor.execute('SELECT pg_current_xact_id()::text')
            third = api_client.get('/api/auth/user/').json()
            third_xmax, _ = map(int, third['balance_snapshot'].split(':'))
            assert third['tuzis'] == new['tuzis']
            assert third_xmax > new_xmax
            assert snapshot_order(new) <= snapshot_order(third)
        else:
            third = api_client.get('/api/auth/user/').json()
            assert third['tuzis'] == new['tuzis']
            assert snapshot_order(new) <= snapshot_order(third)
    finally:
        writer.close()
        higher.close()
