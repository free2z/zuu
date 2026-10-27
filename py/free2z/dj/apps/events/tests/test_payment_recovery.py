"""Receipt recovery traverses immutable keys without claiming commit order."""
from datetime import timedelta
from urllib.parse import urlsplit, parse_qs
from uuid import UUID, uuid4

import pytest
from django.core import signing
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from dj.apps.events.models import Event
from dj.apps.events.recovery import BOUNDARY_SALT, CURSOR_MAX_AGE, CURSOR_SALT
from dj.apps.events.serializers import REDACTED_EVENT_MESSAGE

pytestmark = pytest.mark.django_db
URL = '/api/events/?recovery=payments'


def receipts(user, count, stamp=None):
    rows = [Event(receiving_user=user, type='BOUGHT_TUZI', amount=1,
                  id=UUID(int=i + 1)) for i in range(count)]
    Event.objects.bulk_create(rows)
    if stamp:
        Event.objects.filter(pk__in=[row.pk for row in rows]).update(created_at=stamp)
    return rows


def walk(client, first=URL):
    found, boundaries = [], set()
    while first:
        response = client.get(first)
        assert response.status_code == 200, response.content
        page = response.json()
        assert len(page['results']) <= 48
        assert page['previous'] is None
        boundaries.add(page['recovery_boundary'])
        found.extend(page['results'])
        first = page['next']
    assert len(boundaries) == 1
    return found, boundaries.pop()


def test_full_receipt_scan_ties_microseconds_and_page_cap(api_client, creator_factory):
    user = creator_factory()
    stamp = timezone.now().replace(microsecond=123456)
    rows = receipts(user, 101, stamp)
    api_client.force_authenticate(user=user)
    found, boundary = walk(api_client, URL + '&page_size=100000')
    assert [row['id'] for row in found] == [str(row.pk) for row in reversed(rows)]
    assert all(row['created_at'].endswith('.123456Z') for row in found)
    assert len({row['id'] for row in found}) == 101
    assert walk(api_client)[1] != boundary  # New scan identity, not a watermark.


def test_receipts_are_not_hidden_by_social_rows_or_mutable_feed_order(
    api_client, creator_factory,
):
    user = creator_factory()
    older, newer = receipts(user, 2)
    Event.objects.filter(pk=older.pk).update(
        created_at=timezone.now() - timedelta(days=2),
        updated_at=timezone.now() + timedelta(days=1), read=True,
    )
    Event.objects.bulk_create([Event(receiving_user=user, type='DONATION_RECEIVED', amount=1)
                               for _ in range(30)])
    Event.objects.create(receiving_user=user, type='ZEC_PENDING', amount=1)
    api_client.force_authenticate(user=user)
    normal = api_client.get('/api/events/').json()
    assert normal['results'][0]['id'] == str(older.pk)
    assert len(normal['results']) == 12
    assert 'recovery_boundary' not in normal
    recovered, _ = walk(api_client)
    assert {row['type'] for row in recovered} == {'BOUGHT_TUZI', 'ZEC_PENDING'}
    assert [row['id'] for row in recovered][-2:] == [str(newer.pk), str(older.pk)]
    assert recovered[-1]['read'] is True  # Read receipts remain part of recovery.


def test_keyset_resumes_after_read_update_deletion_and_new_head(
    api_client, creator_factory,
):
    user = creator_factory()
    rows = receipts(user, 52, timezone.now())
    api_client.force_authenticate(user=user)
    first = api_client.get(URL).json()
    Event.objects.filter(pk=rows[0].pk).update(read=True, updated_at=timezone.now())
    Event.objects.filter(pk=rows[-1].pk).delete()
    new = Event.objects.create(receiving_user=user, type='BOUGHT_TUZI', amount=7)
    remainder, boundary = walk(api_client, first['next'])
    assert boundary == first['recovery_boundary']
    assert remainder[-1]['read'] is True
    assert [row['id'] for row in remainder] == [str(row.pk) for row in reversed(rows[:4])]
    assert str(new.pk) not in {row['id'] for row in remainder}
    assert walk(api_client)[0][0]['id'] == str(new.pk)


def test_cursor_is_authenticated_recipient_bound_and_cannot_be_tampered(
    api_client, creator_factory,
):
    owner, other = creator_factory(), creator_factory()
    receipts(owner, 49)
    api_client.force_authenticate(user=owner)
    next_url = api_client.get(URL).json()['next']
    api_client.force_authenticate(user=other)
    denied = api_client.get(next_url)
    assert denied.status_code == 400
    assert 'results' not in denied.json()
    assert api_client.get(URL).json()['results'] == []
    api_client.force_authenticate(user=owner)
    cursor = parse_qs(urlsplit(next_url).query)['recovery_cursor'][0]
    denied = api_client.get(URL, {'recovery_cursor': cursor + 'x'})
    assert denied.status_code == 400
    assert api_client.get('/api/events/', {'recovery_cursor': cursor}).status_code == 400


def test_expired_scan_restarts_and_invalid_modes_fail_closed(
    api_client, creator_factory, monkeypatch,
):
    user = creator_factory()
    receipts(user, 49)
    api_client.force_authenticate(user=user)
    first = api_client.get(URL).json()
    clock = signing.time.time()
    monkeypatch.setattr(signing.time, 'time', lambda: clock + CURSOR_MAX_AGE + 2)
    assert api_client.get(first['next']).status_code == 400
    assert api_client.get(URL).status_code == 200
    assert api_client.get('/api/events/', {'recovery': 'all-users'}).status_code == 400


def test_empty_scan_is_complete_and_has_unique_server_identity(api_client, creator_factory):
    api_client.force_authenticate(user=creator_factory())
    first, second = api_client.get(URL).json(), api_client.get(URL).json()
    assert first['results'] == []
    assert first['count'] == 0
    assert first['next'] is None
    assert first['recovery_boundary'] != second['recovery_boundary']


def test_continuations_reuse_initial_count_hint_without_recounting(
    api_client, creator_factory,
):
    user = creator_factory()
    rows = receipts(user, 101)
    api_client.force_authenticate(user=user)
    first = api_client.get(URL).json()
    assert first['count'] == 101
    Event.objects.filter(pk=rows[0].pk).delete()
    Event.objects.bulk_create([Event(receiving_user=user, type='BOUGHT_TUZI', amount=7),
                               Event(receiving_user=user, type='BOUGHT_TUZI', amount=8)])
    with CaptureQueriesContext(connection) as queries:
        second = api_client.get(first['next']).json()
        third = api_client.get(second['next']).json()
    assert second['count'] == third['count'] == 101
    assert third['next'] is None
    assert not any('COUNT(' in query['sql'].upper() for query in queries)
    refreshed = api_client.get(URL).json()
    assert refreshed['count'] == 102
    assert {row['amount'] for row in refreshed['results'][:2]} == {7, 8}


def test_cursor_rejects_signed_noncanonical_or_out_of_bounds_keyset(
    api_client, creator_factory,
):
    user = creator_factory()
    receipts(user, 49)
    api_client.force_authenticate(user=user)
    first = api_client.get(URL).json()
    cursor = parse_qs(urlsplit(first['next']).query)['recovery_cursor'][0]
    payload = signing.loads(cursor, salt=CURSOR_SALT)
    state = signing.loads(payload['boundary'], salt=BOUNDARY_SALT)
    for count in (False, -1, '49', 2**63):
        malformed = {**state, 'count': count}
        forged = signing.dumps({**payload, 'boundary': signing.dumps(
            malformed, salt=BOUNDARY_SALT)}, salt=CURSOR_SALT)
        assert api_client.get(URL, {'recovery_cursor': forged}).status_code == 400
    for point in (['2999-01-01T00:00:00.000000+00:00', str(uuid4())],
                  ['2026-01-01T00:00:00', str(uuid4())], ['bad', 'bad']):
        payload['before'] = point
        forged = signing.dumps(payload, salt=CURSOR_SALT)
        assert api_client.get(URL, {'recovery_cursor': forged}).status_code == 400


@pytest.mark.django_db(transaction=True)
def test_late_commit_below_completed_baseline_is_found_on_next_full_scan(
    api_client, creator_factory,
):
    user = creator_factory()
    receipts(user, 51)
    api_client.force_authenticate(user=user)
    writer = connection.copy()
    identity = uuid4()
    try:
        writer.ensure_connection()
        writer.set_autocommit(False)
        with writer.cursor() as cursor:
            cursor.execute('SET LOCAL statement_timeout = 3000')
            cursor.execute('INSERT INTO events_event '
                           '(id, read, type, amount, receiving_user_id, created_at, updated_at) '
                           'VALUES (%s, false, %s, 7, %s, %s, %s)',
                           [identity, 'BOUGHT_TUZI', user.pk,
                            timezone.now() - timedelta(days=30), timezone.now()])
        baseline, _ = walk(api_client)
        assert str(identity) not in {row['id'] for row in baseline}
        writer.commit()
        recovered, _ = walk(api_client)
        assert str(identity) in {row['id'] for row in recovered}
        assert recovered[-1]['id'] == str(identity)
    finally:
        writer.close()


def test_recovery_preserves_counterparty_redaction(api_client, creator_factory):
    user, inactive = creator_factory(), creator_factory(is_active=False)
    Event.objects.create(receiving_user=user, contributor=inactive,
                         type='BOUGHT_TUZI', amount=3)
    api_client.force_authenticate(user=user)
    recovered, _ = walk(api_client)
    assert recovered[0]['contributor'] is None
    assert recovered[0]['message'] == REDACTED_EVENT_MESSAGE
    assert inactive.username not in str(recovered)


def test_receipt_recovery_requires_authenticated_account(api_client):
    response = api_client.get(URL)
    assert response.status_code == 403
    assert 'results' not in response.json()
