"""Opt-in notices through the real gateway and worker on PostgreSQL."""
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier

import pytest
from django.core import mail
from django.db import close_old_connections, transaction
from django.utils import timezone

from dj.apps.emails.models import Email, OptOutEmail
from dj.apps.events.models import Event
from dj.apps.g12f.models import Creator
from dj.apps.events.low_balance_notice import dispatch_one
from . import test_hold_foundation, test_gateway_calls

pytestmark = pytest.mark.django_db
holder = test_hold_foundation.holder
ledger_third_party = test_hold_foundation.third_party


@pytest.fixture
def third_party(ledger_third_party):
    return ledger_third_party[0]


def set_enabled(user, enabled=True):
    Creator.objects.filter(pk=user.pk).update(low_balance_notice_enabled=enabled)


def queue(user):
    Creator.objects.filter(pk=user.pk).update(low_balance_notice_pending=True, low_balance_notice_pending_epoch=user.kt_account_epoch)


@pytest.mark.django_db(transaction=True)
def test_pre_hold_completion_and_hold_refusal_share_cooldown(holder, third_party):
    # Existing production call_complete records the refusal and the hold path
    # independently enqueues a concurrent admission failure.
    set_enabled(holder)
    claimed = test_gateway_calls.claim(holder, third_party)
    completion = {'model': 'review-model', 'provider': 'review-provider',
                  'finish_reason': 'stop', 'partial': False,
                  'error': {'code': 'insufficient_balance', 'message': 'balance'}}
    assert test_gateway_calls.complete(holder, third_party, claimed['call_id'],
                                       completion=completion, no_hold=True)['status'] == 'recorded'
    holder.refresh_from_db()
    assert holder.low_balance_notice_pending
    assert dispatch_one(holder.pk)
    assert Event.objects.filter(receiving_user=holder, type='LOW_BALANCE_NOTICE').count() == 1
    # Account starts with 100 2Z. A hold too large for its available balance
    # must not be confused with its cap. Raise the cap and reserve 101 2Z.
    from django.db import connection
    with connection.cursor() as cursor:
        cursor.execute('UPDATE ledger_spend_cap SET cap_m2z=200000 WHERE app_id=%s', [third_party])
    result = test_hold_foundation.call('hold', holder.public_id, third_party, 101000, 'insufficient', 'notice',
                                       1, 300, holder.kt_account_epoch, 4, 'review-model', 99999, '99999', 0,
                                       json.dumps({'provider': 'review-provider'}))
    assert result['status'] == 'insufficient_balance'
    holder.refresh_from_db()
    assert not holder.low_balance_notice_pending
    Creator.objects.filter(pk=holder.pk).update(low_balance_notice_attempted_at=timezone.now() - timedelta(hours=25))
    result = test_hold_foundation.call('hold', holder.public_id, third_party, 101000, 'later', 'later',
                                       1, 300, holder.kt_account_epoch, 4, 'review-model', 99999, '99999', 0,
                                       json.dumps({'provider': 'review-provider'}))
    assert result['status'] == 'insufficient_balance'
    holder.refresh_from_db()
    assert holder.low_balance_notice_pending


@pytest.mark.django_db(transaction=True)
def test_default_off_and_toggle_invalidate_queued_intent(holder, api_client):
    api_client.force_authenticate(holder)
    path = '/api/events/low-balance-preference/'
    assert api_client.get(path, {'expected_actor_id': holder.pk}).data == {'enabled': False, 'actor_id': holder.pk}
    assert api_client.patch(path, {'enabled': True, 'locale': 'es', 'expected_actor_id': holder.pk}, format='json').data == {'enabled': True, 'actor_id': holder.pk}
    queue(holder)
    assert api_client.patch(path, {'enabled': False, 'expected_actor_id': holder.pk}, format='json').data == {'enabled': False, 'actor_id': holder.pk}
    assert api_client.patch(path, {'enabled': True, 'expected_actor_id': holder.pk}, format='json').data == {'enabled': True, 'actor_id': holder.pk}
    holder.refresh_from_db()
    assert not holder.low_balance_notice_pending and holder.low_balance_notice_generation == 3
    assert holder.low_balance_notice_locale == 'es'
    assert not dispatch_one(holder.pk)
    assert not Event.objects.filter(receiving_user=holder, type='LOW_BALANCE_NOTICE').exists()
    assert api_client.patch(path, {'enabled': 'true', 'expected_actor_id': holder.pk}, format='json').status_code == 400
    assert api_client.patch(path, {'enabled': True, 'locale': 'invalid', 'expected_actor_id': holder.pk}, format='json').status_code == 400


@pytest.mark.parametrize('kind', ['none', 'unconfirmed', 'disabled', 'suppressed', 'eligible'])
@pytest.mark.django_db(transaction=True)
def test_delivery_respects_email_policy(holder, kind, settings):
    settings.EMAIL_BACKEND = 'django.core.mail.backends.locmem.EmailBackend'
    settings.CANONICAL_ORIGIN = 'https://free2z.cash'
    settings.DEFAULT_FROM_EMAIL = 'Free2Z <hello@free2z.com>'
    set_enabled(holder)
    if kind != 'none':
        address = Email.objects.create(user=holder, email='reader@example.org', token='some-token',
                                       expires_at=timezone.now() + timedelta(days=1),
                                       confirmed_at=None if kind == 'unconfirmed' else timezone.now(),
                                       get_notifications=kind != 'disabled')
        if kind == 'suppressed':
            OptOutEmail.objects.create(email=address.email)
    queue(holder)
    assert dispatch_one(holder.pk)
    if kind == 'eligible':
        assert len(mail.outbox) == 1
        assert 'List-Unsubscribe' in mail.outbox[0].extra_headers
        assert not Event.objects.filter(receiving_user=holder, type='LOW_BALANCE_NOTICE').exists()
    else:
        assert len(mail.outbox) == 0
        assert Event.objects.filter(receiving_user=holder, type='LOW_BALANCE_NOTICE').count() == 1


@pytest.mark.django_db(transaction=True)
def test_concurrent_worker_claims_only_once(holder):
    set_enabled(holder)
    queue(holder)
    barrier = Barrier(2)
    def worker():
        close_old_connections()
        barrier.wait()
        try:
            return dispatch_one(holder.pk)
        finally:
            close_old_connections()
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: worker(), range(2)))
    assert sorted(results) == [False, True]
    assert Event.objects.filter(receiving_user=holder, type='LOW_BALANCE_NOTICE').count() == 1


@pytest.mark.django_db(transaction=True)
def test_claimed_intent_cannot_survive_optout_and_reconsent(holder, api_client, mocker):
    from dj.apps.events import low_balance_notice
    api_client.force_authenticate(holder)
    path = '/api/events/low-balance-preference/'
    api_client.patch(path, {'enabled': True, 'expected_actor_id': holder.pk}, format='json')
    queue(holder)
    deliver = low_balance_notice.deliver_claim

    def revoke_then_reconsent(creator_id, generation, account_epoch):
        assert api_client.patch(path, {'enabled': False, 'expected_actor_id': holder.pk}, format='json').status_code == 200
        assert api_client.patch(path, {'enabled': True, 'expected_actor_id': holder.pk}, format='json').status_code == 200
        return deliver(creator_id, generation, account_epoch)

    mocker.patch.object(low_balance_notice, 'deliver_claim', side_effect=revoke_then_reconsent)
    assert not low_balance_notice.dispatch_one(holder.pk)
    holder.refresh_from_db()
    assert holder.low_balance_notice_attempted_at is not None
    assert not holder.low_balance_notice_pending
    assert not Event.objects.filter(receiving_user=holder, type='LOW_BALANCE_NOTICE').exists()


@pytest.mark.django_db(transaction=True)
def test_concurrent_real_gateway_hold_refusals_coalesce(holder, third_party):
    from django.db import connection
    from dj.apps.economy.epoch import pin_supported_policy
    set_enabled(holder)
    with connection.cursor() as cursor:
        cursor.execute('UPDATE ledger_spend_cap SET cap_m2z=200000 WHERE app_id=%s', [third_party])
    barrier = Barrier(2)

    def attempt(number):
        close_old_connections()
        try:
            barrier.wait()
            with transaction.atomic():
                pin_supported_policy()
                return test_hold_foundation.call(
                    'hold', holder.public_id, third_party, 101000, f'race-{number}', f'race-{number}',
                    1, 300, holder.kt_account_epoch, 4, 'review-model', 99999, '99999', 0,
                    json.dumps({'provider': 'review-provider'}),
                )['status']
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(attempt, range(2))) == ['insufficient_balance', 'insufficient_balance']
    holder.refresh_from_db()
    assert holder.low_balance_notice_pending
    assert dispatch_one(holder.pk)
    assert not dispatch_one(holder.pk)
    assert Event.objects.filter(receiving_user=holder, type='LOW_BALANCE_NOTICE').count() == 1


def test_default_off_does_not_queue_a_real_hold_refusal(holder, third_party):
    from django.db import connection
    with connection.cursor() as cursor:
        cursor.execute('UPDATE ledger_spend_cap SET cap_m2z=200000 WHERE app_id=%s', [third_party])
    result = test_hold_foundation.call('hold', holder.public_id, third_party, 101000, 'off', 'off',
                                       1, 300, holder.kt_account_epoch, 4, 'review-model', 99999, '99999', 0,
                                       json.dumps({'provider': 'review-provider'}))
    assert result['status'] == 'insufficient_balance'
    holder.refresh_from_db()
    assert not holder.low_balance_notice_pending


@pytest.mark.django_db(transaction=True)
def test_ambiguous_mail_failure_is_never_retried_or_replaced_by_site(holder, mocker, settings):
    from dj.apps.events.low_balance_notice import drain
    settings.CANONICAL_ORIGIN = 'https://free2z.cash'
    settings.DEFAULT_FROM_EMAIL = 'Free2Z <hello@free2z.com>'
    Email.objects.create(user=holder, email='reader@example.org', token='some-token',
                         expires_at=timezone.now() + timedelta(days=1), confirmed_at=timezone.now(),
                         get_notifications=True)
    set_enabled(holder)
    queue(holder)
    send = mocker.patch('dj.apps.events.low_balance_notice.EmailMultiAlternatives.send', side_effect=TimeoutError())
    assert drain() == 0
    assert drain() == 0
    assert send.call_count == 1
    holder.refresh_from_db()
    assert holder.low_balance_notice_attempted_at is not None and not holder.low_balance_notice_pending
    assert not Event.objects.filter(receiving_user=holder, type='LOW_BALANCE_NOTICE').exists()


@pytest.mark.django_db(transaction=True)
def test_reverse_refuses_existing_consent_without_changing_functions(holder):
    import importlib
    from django.db import DatabaseError, connection
    migration = importlib.import_module('dj.apps.ledger.migrations.0008_low_balance_notice')
    set_enabled(holder)
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_get_functiondef('ledger.hold_internal'::regproc)")
        original = cursor.fetchone()[0]
    with pytest.raises(DatabaseError, match='preference state exists'), transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(migration.REVERSE)
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_get_functiondef('ledger.hold_internal'::regproc)")
        assert cursor.fetchone()[0] == original
        cursor.execute("SELECT to_regprocedure('ledger.queue_low_balance_notice(bigint)') IS NOT NULL")
        assert cursor.fetchone()[0]


@pytest.mark.django_db(transaction=True)
def test_account_epoch_change_discards_old_pending_work(holder):
    set_enabled(holder)
    queue(holder)
    Creator.objects.filter(pk=holder.pk).update(kt_account_epoch=holder.kt_account_epoch + 1)
    assert not dispatch_one(holder.pk)
    holder.refresh_from_db()
    assert not holder.low_balance_notice_pending
    assert not Event.objects.filter(receiving_user=holder, type='LOW_BALANCE_NOTICE').exists()


def test_notice_storage_failure_cannot_change_hold_refusal(holder, third_party):
    from django.db import connection
    set_enabled(holder)
    with connection.cursor() as cursor:
        cursor.execute('UPDATE ledger_spend_cap SET cap_m2z=200000 WHERE app_id=%s', [third_party])
        cursor.execute("""CREATE FUNCTION public.reject_test_notice() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN IF NEW.low_balance_notice_pending THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$""")
        cursor.execute('CREATE TRIGGER reject_test_notice BEFORE UPDATE ON g12f_creator FOR EACH ROW EXECUTE FUNCTION public.reject_test_notice()')
    try:
        result = test_hold_foundation.call('hold', holder.public_id, third_party, 101000, 'failure', 'failure',
                                           1, 300, holder.kt_account_epoch, 4, 'review-model', 99999, '99999', 0,
                                           json.dumps({'provider': 'review-provider'}))
        assert result['status'] == 'insufficient_balance'
        holder.refresh_from_db()
        assert not holder.low_balance_notice_pending
    finally:
        with connection.cursor() as cursor:
            cursor.execute('DROP TRIGGER reject_test_notice ON g12f_creator')
            cursor.execute('DROP FUNCTION public.reject_test_notice()')


@pytest.mark.django_db(transaction=True)
def test_reverse_lock_timeout_preserves_functions(holder):
    import importlib
    from threading import Event as ThreadEvent, Thread
    from time import monotonic
    from django.db import DatabaseError, connection
    migration = importlib.import_module('dj.apps.ledger.migrations.0008_low_balance_notice')
    locked, release = ThreadEvent(), ThreadEvent()

    def lock_creator_table():
        close_old_connections()
        try:
            with transaction.atomic(), connection.cursor() as cursor:
                cursor.execute('LOCK TABLE g12f_creator IN ACCESS SHARE MODE')
                locked.set()
                assert release.wait(10)
        finally:
            close_old_connections()

    thread = Thread(target=lock_creator_table)
    thread.start()
    assert locked.wait(5)
    try:
        start = monotonic()
        with pytest.raises(DatabaseError), transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(migration.REVERSE)
        assert monotonic() - start < 6
    finally:
        release.set()
        thread.join(10)
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_regprocedure('ledger.queue_low_balance_notice(bigint)') IS NOT NULL")
        assert cursor.fetchone()[0]


@pytest.mark.django_db(transaction=True)
def test_email_uses_language_captured_at_opt_in(holder, api_client, settings):
    settings.EMAIL_BACKEND = 'django.core.mail.backends.locmem.EmailBackend'
    settings.CANONICAL_ORIGIN = 'https://free2z.cash'
    settings.DEFAULT_FROM_EMAIL = 'Free2Z <hello@free2z.com>'
    Email.objects.create(user=holder, email='reader@example.org', token='some-token',
                         expires_at=timezone.now() + timedelta(days=1), confirmed_at=timezone.now(),
                         get_notifications=True)
    api_client.force_authenticate(holder)
    assert api_client.patch('/api/events/low-balance-preference/', {'enabled': True, 'locale': 'es', 'expected_actor_id': holder.pk}, format='json').status_code == 200
    queue(holder)
    assert dispatch_one(holder.pk)
    assert 'Una aplicación conectada' in mail.outbox[0].body


@pytest.mark.django_db(transaction=True)
def test_registered_expiry_worker_drains_pending_notice(holder):
    from dj.apps.ledger.tasks import expire_holds
    set_enabled(holder)
    queue(holder)
    assert expire_holds.func(timestamp=0)['status'] == 'completed'
    assert Event.objects.filter(receiving_user=holder, type='LOW_BALANCE_NOTICE').count() == 1
    assert expire_holds.func(timestamp=0)['status'] == 'completed'
    assert Event.objects.filter(receiving_user=holder, type='LOW_BALANCE_NOTICE').count() == 1


@pytest.mark.django_db(transaction=True)
def test_notice_drain_stops_before_next_attempt_after_budget(holder, mocker):
    from dj.apps.events import low_balance_notice
    set_enabled(holder)
    queue(holder)
    mocker.patch.object(low_balance_notice, 'monotonic', side_effect=[0, 6])
    attempt = mocker.patch.object(low_balance_notice, 'dispatch_one')
    assert low_balance_notice.drain(budget_seconds=5) == 0
    attempt.assert_not_called()
    holder.refresh_from_db()
    assert holder.low_balance_notice_pending


def test_stale_full_creator_save_cannot_restore_revoked_consent(holder, api_client):
    api_client.force_authenticate(holder)
    path = '/api/events/low-balance-preference/'
    api_client.patch(path, {'enabled': True, 'expected_actor_id': holder.pk}, format='json')
    stale = Creator.objects.get(pk=holder.pk)
    api_client.patch(path, {'enabled': False, 'expected_actor_id': holder.pk}, format='json')
    stale.first_name = 'Updated'
    stale.save()
    stale.refresh_from_db()
    assert not stale.low_balance_notice_enabled
    assert stale.low_balance_notice_generation == 2


def test_dispatch_refuses_an_outer_transaction(holder):
    set_enabled(holder)
    queue(holder)
    with pytest.raises(RuntimeError, match='requires autocommit'):
        dispatch_one(holder.pk)
    holder.refresh_from_db()
    assert holder.low_balance_notice_pending


def test_preference_actor_mismatch_never_changes_other_account(holder, creator_factory, api_client):
    other = creator_factory()
    api_client.force_authenticate(other)
    path = '/api/events/low-balance-preference/'
    response = api_client.patch(path, {'enabled': True, 'expected_actor_id': holder.pk}, format='json')
    assert response.status_code == 409 and response.data['code'] == 'account_changed'
    assert api_client.patch(path, {'enabled': True}, format='json').status_code == 400
    assert api_client.get(path, {'expected_actor_id': holder.pk}).status_code == 409
    other.refresh_from_db()
    assert not other.low_balance_notice_enabled and other.low_balance_notice_generation == 0


@pytest.mark.parametrize('change', ['recovery', 'deactivation'])
@pytest.mark.django_db(transaction=True)
def test_preference_waits_for_creator_then_refuses_stale_authenticated_snapshot(holder, change):
    from threading import Event as ThreadEvent
    from django.db import connection
    from rest_framework.test import APIRequestFactory, force_authenticate
    from dj.apps.events.views import LowBalancePreferenceView

    snapshot = Creator.objects.get(pk=holder.pk)
    started = ThreadEvent()
    def writer():
        close_old_connections()
        try:
            request = APIRequestFactory().patch('/api/events/low-balance-preference/',
                {'enabled': True, 'expected_actor_id': holder.pk}, format='json')
            force_authenticate(request, user=snapshot)
            def witness(execute, sql, params, many, context):
                if 'FOR UPDATE' in sql and 'g12f_creator' in sql:
                    started.set()
                return execute(sql, params, many, context)
            with connection.execute_wrapper(witness):
                return LowBalancePreferenceView.as_view()(request)
        finally:
            close_old_connections()
    with ThreadPoolExecutor(max_workers=1) as pool:
        with transaction.atomic():
            Creator.objects.select_for_update().get(pk=holder.pk)
            future = pool.submit(writer)
            assert started.wait(5)
            if change == 'recovery':
                from dj.apps.ktauth.epoch import bump_account_epoch, EVENT_RECOVERY_ADDRESS_CHANGE
                bump_account_epoch(holder.pk, event=EVENT_RECOVERY_ADDRESS_CHANGE)
            else:
                Creator.objects.filter(pk=holder.pk).update(is_active=False)
        response = future.result(timeout=10)
    assert response.status_code == 409 and response.data['code'] == 'account_changed'
    holder.refresh_from_db()
    assert not holder.low_balance_notice_enabled and holder.low_balance_notice_generation == 0


@pytest.mark.django_db(transaction=True)
def test_optout_between_real_claim_and_delivery_blocks_old_generation(holder, api_client, mocker, settings):
    from threading import Event as ThreadEvent
    from dj.apps.events import low_balance_notice
    settings.CANONICAL_ORIGIN = 'https://free2z.cash'
    settings.DEFAULT_FROM_EMAIL = 'Free2Z <hello@free2z.com>'
    Email.objects.create(user=holder, email='reader@example.org', token='some-token',
        expires_at=timezone.now() + timedelta(days=1), confirmed_at=timezone.now(), get_notifications=True)
    api_client.force_authenticate(holder)
    path = '/api/events/low-balance-preference/'
    assert api_client.patch(path, {'enabled': True, 'expected_actor_id': holder.pk}, format='json').status_code == 200
    queue(holder)
    claimed, release = ThreadEvent(), ThreadEvent()
    deliver = low_balance_notice.deliver_claim
    def pause(creator_id, generation, epoch):
        claimed.set()
        assert release.wait(10)
        return deliver(creator_id, generation, epoch)
    mocker.patch.object(low_balance_notice, 'deliver_claim', side_effect=pause)
    send = mocker.patch('dj.apps.events.low_balance_notice.EmailMultiAlternatives.send')
    def worker():
        close_old_connections()
        try:
            return low_balance_notice.dispatch_one(holder.pk)
        finally:
            close_old_connections()
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(worker)
        assert claimed.wait(5)
        assert api_client.patch(path, {'enabled': False, 'expected_actor_id': holder.pk}, format='json').status_code == 200
        assert api_client.patch(path, {'enabled': True, 'expected_actor_id': holder.pk}, format='json').status_code == 200
        release.set()
        assert not future.result(timeout=10)
    assert send.call_count == 0
    assert not low_balance_notice.dispatch_one(holder.pk)
    assert send.call_count == 0
    assert not Event.objects.filter(receiving_user=holder, type='LOW_BALANCE_NOTICE').exists()
    holder.refresh_from_db()
    assert not holder.low_balance_notice_pending and holder.low_balance_notice_attempted_at is not None


def test_completion_scope_replay_and_stale_identity(holder, third_party):
    from datetime import timedelta
    from dj.apps.ledger.models import LedgerGatewayCall
    from dj.apps.ledger import api
    import uuid
    set_enabled(holder)
    account = api.ensure_account(holder.pk)
    first_party = uuid.UUID('00000000-0000-4000-8000-000000000001')
    call_id = test_gateway_calls.new_id()
    LedgerGatewayCall.objects.create(id=call_id, account_id=account, app_id=first_party,
        account_epoch=holder.kt_account_epoch, grant_generation=4, fingerprint='a' * 64,
        phase='streaming', request_meta=test_gateway_calls.REQUEST, expires_at=timezone.now()+timedelta(minutes=5))
    completion = {'model': 'review-model', 'provider': 'review-provider', 'finish_reason': 'stop',
                  'partial': False, 'error': {'code': 'insufficient_balance', 'message': 'balance'}}
    assert test_gateway_calls.complete(holder, first_party, call_id, completion=completion, no_hold=True)['status'] == 'recorded'
    holder.refresh_from_db()
    assert not holder.low_balance_notice_pending
    claimed = test_gateway_calls.claim(holder, third_party, key=None)
    assert test_gateway_calls.complete(holder, third_party, claimed['call_id'], completion=completion,
                                       no_hold=True, epoch=holder.kt_account_epoch+1)['status'] == 'not_found'
    assert test_gateway_calls.complete(holder, third_party, claimed['call_id'], completion=completion,
                                       no_hold=False)['status'] == 'recorded'
    holder.refresh_from_db()
    assert not holder.low_balance_notice_pending
    other = test_gateway_calls.claim(holder, third_party, key=None)
    assert test_gateway_calls.complete(holder, third_party, other['call_id'], completion=completion, no_hold=True)['status'] == 'recorded'
    holder.refresh_from_db()
    assert holder.low_balance_notice_pending
    Creator.objects.filter(pk=holder.pk).update(low_balance_notice_pending=False)
    assert test_gateway_calls.complete(holder, third_party, other['call_id'], completion=completion, no_hold=True)['status'] == 'replayed'
    holder.refresh_from_db()
    assert not holder.low_balance_notice_pending
    stale = test_gateway_calls.claim(holder, third_party, key=None)
    old_epoch = holder.kt_account_epoch
    Creator.objects.filter(pk=holder.pk).update(kt_account_epoch=old_epoch + 1)
    assert test_gateway_calls.complete(holder, third_party, stale['call_id'], completion=completion,
                                       no_hold=True, epoch=old_epoch)['status'] == 'recorded'
    holder.refresh_from_db()
    assert not holder.low_balance_notice_pending


@pytest.mark.django_db(transaction=True)
def test_optout_waits_for_inflight_send_and_no_send_follows_optout(holder, mocker, settings):
    from threading import Event as ThreadEvent
    from rest_framework.test import APIClient
    from django.db import connection
    from dj.apps.events import low_balance_notice
    settings.CANONICAL_ORIGIN = 'https://free2z.cash'
    settings.DEFAULT_FROM_EMAIL = 'Free2Z <hello@free2z.com>'
    Email.objects.create(user=holder, email='reader@example.org', token='some-token',
        expires_at=timezone.now() + timedelta(days=1), confirmed_at=timezone.now(), get_notifications=True)
    set_enabled(holder)
    queue(holder)
    sending, release, waiting, finished = (ThreadEvent() for _ in range(4))
    def send(*args, **kwargs):
        sending.set()
        assert release.wait(10)
        return 1
    provider = mocker.patch('dj.apps.events.low_balance_notice.EmailMultiAlternatives.send', side_effect=send)
    def deliver():
        close_old_connections()
        try:
            return low_balance_notice.dispatch_one(holder.pk)
        finally:
            close_old_connections()
    def disable():
        close_old_connections()
        try:
            client = APIClient()
            client.force_authenticate(Creator.objects.get(pk=holder.pk))
            def witness(execute, sql, params, many, context):
                if 'FOR UPDATE' in sql and 'g12f_creator' in sql:
                    waiting.set()
                return execute(sql, params, many, context)
            with connection.execute_wrapper(witness):
                response = client.patch('/api/events/low-balance-preference/',
                    {'enabled': False, 'expected_actor_id': holder.pk}, format='json')
            finished.set()
            return response.status_code
        finally:
            close_old_connections()
    with ThreadPoolExecutor(max_workers=2) as pool:
        sent = pool.submit(deliver)
        assert sending.wait(5)
        opted_out = pool.submit(disable)
        assert waiting.wait(5)
        assert not finished.is_set()
        release.set()
        assert sent.result(timeout=10)
        assert opted_out.result(timeout=10) == 200
    assert provider.call_count == 1
    assert not low_balance_notice.dispatch_one(holder.pk)
    assert provider.call_count == 1
