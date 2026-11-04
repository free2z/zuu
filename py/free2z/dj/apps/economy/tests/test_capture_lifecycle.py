from dj.apps.economy.tests.test_integration import historical_note_observation
"""Actual writer boundaries with PostgreSQL; provider IO is mocked only."""
from datetime import timedelta

import pytest
import stripe
from django.db import transaction
from django.utils import timezone

from dj.apps.economy import funding, services as money
from dj.apps.economy.models import FundingReservation
from dj.apps.economy.tests.test_foundation import activate_for_test
from dj.apps.economy.tests.test_concurrency import isolated_epoch  # noqa: F401
from dj.apps.economy.tests.test_products import price  # noqa: F401
from dj.apps.g12f.models import Creator
from dj.apps.tuzis.models import IdempotencyKey
from dj.apps.ztripe import economic_events as events
from dj.apps.ztripe.fulfillment import checkout_metadata
from dj.apps.ztripe.models import CheckoutIntent
from dj.apps.ztripe.stripe_identity import StripeIdentity

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.ledger_drift_expected]
IDENTITY = StripeIdentity(account_id='acct_captureTest123', mode='payment', livemode=False)


@pytest.fixture(autouse=True)
def reject_unstubbed_capture_http(mocker):
    # Capture tests must mock provider reads/writes at their actual boundary.
    # A renamed boundary must fail locally, never contact the provider with a
    # fixture key or depend on a network refusal to make a test fail.
    mocker.patch('requests.sessions.Session.request',
        side_effect=AssertionError('capture test attempted unstubbed HTTP'))


@pytest.fixture
def checkout(creator_factory):
    buyer = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    checkout = CheckoutIntent.objects.create(user=buyer, tuzis=100, amount_cents=150, currency='usd',
        pricing_version='card-v3', stripe_account_id=IDENTITY.account_id, stripe_mode='payment',
        stripe_livemode=False, stripe_checkout_session_id='cs_original', state='open')
    reservation = money.reserve_funding(recipient_id=buyer.pk, purchaser_id=buyer.pk,
        amount_m2z=100_000, sale_nusd=1_500_000_000, idempotency_key=f'stripe-intent:{checkout.public_id}')
    return checkout, reservation


def provider(checkout, status='requires_capture'):
    session = {'id': checkout.stripe_checkout_session_id, 'created': int(checkout.created_at.timestamp()),
        'livemode': False, 'mode': 'payment', 'status': 'complete', 'client_reference_id': str(checkout.user_id),
        'amount_total': checkout.amount_cents, 'currency': 'usd', 'metadata': checkout_metadata(checkout),
        'payment_intent': 'pi_attached', 'payment_status': 'paid' if status == 'succeeded' else 'unpaid'}
    payment = {'id': 'pi_attached', 'livemode': False, 'amount': 150, 'currency': 'usd',
        'metadata': checkout_metadata(checkout), 'status': status,
        'amount_capturable': 150 if status == 'requires_capture' else 0,
        'amount_received': 150 if status == 'succeeded' else 0}
    event = {'id': 'evt_original_completion', 'type': 'checkout.session.completed', 'livemode': False,
        'data': {'object': session}}
    return session, payment, event


def test_subscribed_completion_captures_exact_session_and_fulfills_once(checkout, mocker):
    original, reservation = checkout
    unpaid, authorized, event = provider(original)
    paid, succeeded, _ = provider(original, 'succeeded')
    mocker.patch.object(events.stripe.checkout.Session, 'retrieve', side_effect=[unpaid, paid, paid])
    mocker.patch.object(events.stripe.PaymentIntent, 'retrieve', side_effect=[authorized, succeeded, succeeded])
    capture = mocker.patch.object(events.stripe.PaymentIntent, 'capture', return_value=succeeded)
    assert events.handle_checkout_capture(event, IDENTITY).status == 'credited'
    assert events.handle_checkout_capture(event, IDENTITY).status == 'duplicate'
    assert capture.call_count == 1
    assert capture.call_args.kwargs['idempotency_key'] == f'economy-capture:{reservation.pk}'
    reservation.refresh_from_db()
    assert reservation.state == 'issued'
    assert Creator.objects.get(pk=original.user_id).tuzis == 100
    from dj.apps.ztripe.native_return import checkout_session_digest, read_status_resolution
    assert read_status_resolution(original.user_id, checkout_session_digest(original.stripe_checkout_session_id)) == 'pi_attached'


def test_signed_webhook_manual_capture_runs_outside_request_transaction(checkout, client, settings, mocker):
    import json
    from django.db import connection
    from dj.apps.ztripe.test_webhook_signature import SIGNING_SECRET, sign

    original, reservation = checkout
    unpaid, authorized, event = provider(original)
    paid, succeeded, _ = provider(original, 'succeeded')
    settings.NAMESPACE = 'prod'
    settings.STRIPE_SIGNING_SECRET = SIGNING_SECRET
    settings.STRIPE_SECRET_KEY = 'sk_test_capture_boundary'
    settings.STRIPE_EXPECTED_ACCOUNT_ID = IDENTITY.account_id
    settings.STRIPE_EXPECTED_LIVEMODE = 'false'
    settings.STRIPE_CHECKOUT_ENABLED = 'true'
    settings.STRIPE_WEBHOOK_ENDPOINT_ID = 'we_captureBoundary'
    seen = []

    def outside_transaction(value):
        def response(*args, **kwargs):
            assert connection.in_atomic_block is False
            assert connection.get_autocommit() is True
            seen.append(value)
            return value
        return response

    sessions = iter([unpaid, paid, paid])
    payments = iter([authorized, succeeded, succeeded])
    mocker.patch.object(events.stripe.Event, 'retrieve', side_effect=outside_transaction(event))
    mocker.patch.object(events.stripe.checkout.Session, 'retrieve',
        side_effect=lambda *args, **kwargs: outside_transaction(next(sessions))(*args, **kwargs))
    mocker.patch.object(events.stripe.PaymentIntent, 'retrieve',
        side_effect=lambda *args, **kwargs: outside_transaction(next(payments))(*args, **kwargs))
    capture = mocker.patch.object(events.stripe.PaymentIntent, 'capture',
        side_effect=outside_transaction(succeeded))
    payload = json.dumps(event)
    response = client.post('/api/stripe/webhook/', data=payload,
        content_type='application/json', HTTP_STRIPE_SIGNATURE=sign(payload))
    assert response.status_code == 200, response.content
    assert response.json()['status'] == 'credited'
    replay = client.post('/api/stripe/webhook/', data=payload,
        content_type='application/json', HTTP_STRIPE_SIGNATURE=sign(payload))
    assert replay.status_code == 200, replay.content
    assert replay.json()['status'] == 'duplicate'
    assert capture.call_count == 1
    assert len(seen) == 9  # original event + capture proof; replay event + session/PI
    reservation.refresh_from_db()
    assert reservation.state == 'issued'
    assert Creator.objects.get(pk=original.user_id).tuzis == 100


def test_actual_policy_contention_retries_without_stranding_paid_purchase(creator_factory):
    import psycopg
    from django.db import connection, OperationalError
    from dj.apps.ztripe.fulfillment import fulfill_checkout_completed
    from dj.apps.ztripe.models import StripeTransaction
    buyer = creator_factory(tuzis=0)
    original = CheckoutIntent.objects.create(user=buyer, tuzis=100, amount_cents=150, currency='usd',
        pricing_version='card-v3', stripe_account_id=IDENTITY.account_id, stripe_mode='payment',
        stripe_livemode=False, stripe_checkout_session_id='cs_original', state='open')
    _, _, event = provider(original, 'succeeded')
    config = connection.settings_dict
    with psycopg.connect(host=config['HOST'], port=config['PORT'], dbname=config['NAME'],
        user=config['USER'], password=config['PASSWORD']) as blocker:
        blocker.execute('SELECT id FROM economy_economicpolicy WHERE id FOR UPDATE')
        with pytest.raises(OperationalError) as failure:
            fulfill_checkout_completed(event, provider_identity=IDENTITY)
        assert failure.value.__cause__.sqlstate == '55P03'
        assert not FundingReservation.objects.exists() and not StripeTransaction.objects.exists()
    assert fulfill_checkout_completed(event, provider_identity=IDENTITY).outcome == 'credited'
    assert Creator.objects.get(pk=buyer.pk).tuzis == 100


def test_transient_capture_validation_never_cancels_valid_authorization(checkout, mocker):
    from django.db import OperationalError
    original, reservation = checkout
    session, payment, event = provider(original)
    mocker.patch.object(events.stripe.checkout.Session, 'retrieve', return_value=session)
    mocker.patch.object(events.stripe.PaymentIntent, 'retrieve', return_value=payment)
    mocker.patch.object(money, 'validate_reserved_funding_for_capture', side_effect=OperationalError('retry'))
    cancel = mocker.patch.object(events.stripe.PaymentIntent, 'cancel')
    capture = mocker.patch.object(events.stripe.PaymentIntent, 'capture')
    with pytest.raises(OperationalError):
        events.handle_checkout_capture(event, IDENTITY)
    cancel.assert_not_called()
    capture.assert_not_called()
    reservation.refresh_from_db()
    assert reservation.state == 'reserved'


def test_copied_metadata_payment_not_original_session_cannot_capture(checkout, mocker):
    original, _ = checkout
    session, payment, _ = provider(original)
    payment = dict(payment, id='pi_copied')
    event = {'id': 'evt_copied', 'type': 'payment_intent.amount_capturable_updated', 'livemode': False,
        'data': {'object': {'id': 'pi_copied'}}}
    mocker.patch.object(events.stripe.PaymentIntent, 'retrieve', return_value=payment)
    mocker.patch.object(events.stripe.checkout.Session, 'retrieve', return_value=session)
    capture = mocker.patch.object(events.stripe.PaymentIntent, 'capture')
    with pytest.raises(events.StripeWebhookReadinessError, match='not attached'):
        events.handle_capture_event(event, IDENTITY)
    capture.assert_not_called()


def test_capture_timeout_retry_observes_succeeded_without_resending(checkout, mocker):
    original, _ = checkout
    unpaid, authorized, event = provider(original)
    paid, succeeded, _ = provider(original, 'succeeded')
    mocker.patch.object(events.stripe.checkout.Session, 'retrieve', side_effect=[unpaid, paid])
    mocker.patch.object(events.stripe.PaymentIntent, 'retrieve', side_effect=[authorized, succeeded])
    capture = mocker.patch.object(events.stripe.PaymentIntent, 'capture', side_effect=stripe.error.APIConnectionError('timeout'))
    with pytest.raises(stripe.error.APIConnectionError):
        events.handle_checkout_capture(event, IDENTITY)
    assert events.handle_checkout_capture(event, IDENTITY).status == 'credited'
    assert capture.call_count == 1


def test_refused_capture_cancel_proof_releases_capacity(checkout, mocker):
    original, reservation = checkout
    session, authorized, event = provider(original)
    mocker.patch.object(events.stripe.checkout.Session, 'retrieve', return_value=session)
    mocker.patch.object(events.stripe.PaymentIntent, 'retrieve', return_value=authorized)
    mocker.patch.object(money, 'validate_reserved_funding_for_capture', side_effect=money.EconomicRefusal('limit'))
    mocker.patch.object(events.stripe.PaymentIntent, 'cancel', return_value=dict(authorized, status='canceled', amount_received=0))
    capture = mocker.patch.object(events.stripe.PaymentIntent, 'capture')
    assert events.handle_checkout_capture(event, IDENTITY).status == 'authorization_cancelled'
    capture.assert_not_called()
    reservation.refresh_from_db()
    assert reservation.state == 'released'
    assert IdempotencyKey.objects.filter(scope='stripe-authorization-terminal').exists()
    money.reserve_funding(recipient_id=original.user_id, purchaser_id=original.user_id,
        amount_m2z=200_000_000, sale_nusd=2_000_000_000_000, idempotency_key='new-after-cancel')


def test_actual_expired_session_releases_but_unknown_provider_outcome_does_not(checkout, mocker):
    original, reservation = checkout
    CheckoutIntent.objects.filter(pk=original.pk).update(created_at=timezone.now() - timedelta(days=1))
    session, _, _ = provider(original)
    session = dict(session, status='expired', payment_intent=None)
    mocker.patch.object(events.stripe.checkout.Session, 'retrieve', return_value=session)
    events.reconcile_expired_card_authorizations(creator_id=original.user_id, identity=IDENTITY)
    reservation.refresh_from_db()
    assert reservation.state == 'released'
    assert IdempotencyKey.objects.filter(scope='stripe-session-terminal').exists()


@pytest.mark.parametrize('proof', [[":"], {}, True, 42, None])
def test_untrusted_memo_proof_cannot_abort_wallet_scan(creator_factory, proof):
    import json
    buyer = creator_factory(tuzis=0)
    assert funding.funding_note_recipient(memo_plain=json.dumps({'act': 'buy_2z', 'id': buyer.username,
        'proof': proof}), username=buyer.username).pk == buyer.pk


def test_old_surrounding_text_memo_preserves_legacy_recipient(creator_factory):
    buyer = creator_factory(tuzis=0)
    assert funding.funding_note_recipient(memo_plain=f'Payment: {{"act":"buy_2z","id":"{buyer.username}"}}',
        username=buyer.username).pk == buyer.pk


def test_legacy_card_handler_rejects_original_actor_a_with_cookie_b(api_client, creator_factory, settings, mocker):
    from dj.apps.ztripe import views
    settings.STRIPE_CHECKOUT_ALLOWED_HOSTS = ['checkout.stripe.com']
    intended, actual = creator_factory(tuzis=0), creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    api_client.force_authenticate(user=actual)
    create = mocker.patch.object(views.stripe.checkout.Session, 'create')
    response = api_client.post('/api/stripe/create-checkout-session/',
        {'quantity': 100, 'currentPath': '/wallet', 'expected_actor_id': intended.pk}, format='json')
    assert response.status_code == 409 and response.json()['code'] == 'actor_changed'
    assert not FundingReservation.objects.exists()
    create.assert_not_called()


def test_legacy_card_handler_revalidates_original_auth_epoch_under_actor_lock(api_client, creator_factory, settings, mocker):
    from dj.apps.ztripe import views
    settings.STRIPE_CHECKOUT_ALLOWED_HOSTS = ['checkout.stripe.com']
    buyer = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    # This authenticated snapshot predates the actual revocation.
    Creator.objects.filter(pk=buyer.pk).update(kt_account_epoch=buyer.kt_account_epoch + 1)
    api_client.force_authenticate(user=buyer)
    mocker.patch.object(views, '_prove_checkout_identity', return_value=(IDENTITY, None))
    create = mocker.patch.object(views.stripe.checkout.Session, 'create')
    response = api_client.post('/api/stripe/create-checkout-session/',
        {'quantity': 100, 'currentPath': '/wallet', 'expected_actor_id': buyer.pk}, format='json')
    assert response.status_code == 409 and response.json()['code'] == 'actor_authentication_changed'
    assert not FundingReservation.objects.exists()
    create.assert_not_called()


def test_legacy_card_creation_timeout_retries_identical_original_instruction(api_client, creator_factory, settings, mocker):
    from types import SimpleNamespace
    from dj.apps.ztripe import views
    settings.STRIPE_CHECKOUT_ALLOWED_HOSTS = ['checkout.stripe.com']
    buyer = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    api_client.force_authenticate(user=buyer)
    mocker.patch.object(views, '_prove_checkout_identity', return_value=(IDENTITY, None))
    create = mocker.patch.object(views.stripe.checkout.Session, 'create', side_effect=[
        stripe.error.APIConnectionError('response lost'),
        SimpleNamespace(id='cs_recovered', url='https://checkout.stripe.com/c/pay/cs_recovered',
            mode='payment', livemode=False, account=None)])
    response = api_client.post('/api/stripe/create-checkout-session/',
        {'quantity': 100, 'currentPath': '/wallet', 'expected_actor_id': buyer.pk}, format='json')
    assert response.status_code == 200
    assert create.call_count == 2 and create.call_args_list[0] == create.call_args_list[1]
    assert CheckoutIntent.objects.count() == 1 and FundingReservation.objects.count() == 1
    original = CheckoutIntent.objects.get()
    assert original.state == 'open' and original.stripe_checkout_session_id == 'cs_recovered'


def test_exhausted_card_create_ambiguity_blocks_new_firstparty_purchase(api_client, creator_factory, settings, mocker):
    from dj.apps.ztripe import views
    settings.STRIPE_CHECKOUT_ALLOWED_HOSTS = ['checkout.stripe.com']
    buyer = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    api_client.force_authenticate(user=buyer)
    mocker.patch.object(views, '_prove_checkout_identity', return_value=(IDENTITY, None))
    create = mocker.patch.object(views.stripe.checkout.Session, 'create', side_effect=stripe.error.APIConnectionError('unknown'))
    body = {'quantity': 100, 'currentPath': '/wallet', 'expected_actor_id': buyer.pk}
    assert api_client.post('/api/stripe/create-checkout-session/', body, format='json').status_code == 502
    assert create.call_count == 2
    retry = api_client.post('/api/stripe/create-checkout-session/', body, format='json')
    assert retry.status_code == 409 and retry.json()['code'] == 'checkout_original_instruction_unresolved'
    assert create.call_count == 2 and CheckoutIntent.objects.count() == 1
    assert FundingReservation.objects.get().state == 'reserved'


@pytest.mark.parametrize('wrong_actor', [True, False])
def test_paid_viewer_join_validates_original_actor_and_locked_auth_epoch(api_client, creator_factory, mocker, wrong_actor):
    from dj.apps.dyte.models import CreatorMeeting, PAY_PER_VIEW
    host = creator_factory(tuzis=1000)
    viewer = creator_factory(tuzis=1000)
    intended = creator_factory(tuzis=1000) if wrong_actor else viewer
    CreatorMeeting.objects.create(creator=host, meeting_id='actual-paid-room', meeting_type=PAY_PER_VIEW,
        is_public=True, live_now=True, price_per_minute=1)
    with transaction.atomic():
        activate_for_test()
    if not wrong_actor:
        Creator.objects.filter(pk=viewer.pk).update(kt_account_epoch=viewer.kt_account_epoch + 1)
    api_client.force_authenticate(user=viewer)
    client = mocker.patch('dj.apps.dyte.views.DyteClient').return_value
    admission = mocker.patch('dj.apps.economy.products.prepare_livestream_admission')
    response = api_client.post(f'/api/dyte/{host.username}/{PAY_PER_VIEW}',
        {'role': 'viewer', 'expected_actor_id': intended.pk}, format='json')
    assert response.status_code == 409
    assert response.data['code'] == ('actor_changed' if wrong_actor else 'actor_authentication_changed')
    client.add_participant.assert_not_called()
    admission.assert_not_called()


def test_paid_viewer_actor_mismatch_cannot_become_new_owner_host_start(api_client, creator_factory, mocker):
    from dj.apps.dyte.models import PAY_PER_VIEW
    owner = creator_factory(tuzis=1000)
    original_viewer = creator_factory(tuzis=1000)
    api_client.force_authenticate(user=owner)
    client = mocker.patch('dj.apps.dyte.views.DyteClient').return_value
    response = api_client.post(f'/api/dyte/{owner.username}/{PAY_PER_VIEW}',
        {'expected_actor_id': original_viewer.pk}, format='json')
    assert response.status_code == 409 and response.data['code'] == 'actor_changed'
    client.create_meeting.assert_not_called()
    client.add_participant.assert_not_called()


@pytest.mark.usefixtures('price')
def test_periodic_zec_expiry_repairs_dead_and_missing_jobs_without_observed_payment(creator_factory, monkeypatch):
    from procrastinate.contrib.django.models import ProcrastinateJob
    from dj.apps.purchases import tasks
    actors = [creator_factory(tuzis=0) for _ in range(3)]
    with transaction.atomic():
        activate_for_test()
    dead, missing, observed = [retired_zec_instruction(creator=actor,
        quantity_2z=100, platform='web') for actor in actors]
    dead_job = ProcrastinateJob.objects.get(task_name='purchases.expire_zec_intent',
        args={'purchase_id': str(dead.pk)})
    # Genuine queue status/event transition: simulate a killed worker's doing row.
    ProcrastinateJob.objects.filter(pk=dead_job.pk).update(status='doing', worker_id=None)
    ProcrastinateJob.objects.filter(task_name='purchases.expire_zec_intent',
        args={'purchase_id': str(missing.pk)}).delete()
    observed.rail_data=dict(observed.rail_data,payment_observed=True)
    observed.save(update_fields=['rail_data'])
    note = historical_note_observation(creator_id=observed.creator_id, txid='a1'*32,
        pool='ironwood', output_index=0, amount_zec=observed.quote['amount_zec'],
        memo_plain=observed.rail_data['memo'])
    monkeypatch.setattr(timezone, 'now', lambda: observed.expires_at + timedelta(minutes=1))
    result = tasks.reconcile_zec_expiry(timestamp=0)
    assert result['expired'] == result['attempted'] == 2 and result['deferred'] == 0
    assert ProcrastinateJob.objects.get(pk=dead_job.pk).status == 'doing'
    assert FundingReservation.objects.get(idempotency_key=f'zec-intent:{dead.pk}').state == 'released'
    assert FundingReservation.objects.get(idempotency_key=f'zec-intent:{missing.pk}').state == 'released'
    assert FundingReservation.objects.get(idempotency_key=f'zec-intent:{observed.pk}').state == 'reserved'
    # Retained old observed rows remain a historical claim; live processing
    # uses their raw wallet note independently of quote expiry.
    assert note.response_body['status']=='pending_resolution'


@pytest.mark.usefixtures('price')
def test_periodic_zec_expiry_bounds_batch_and_tick_without_losing_remaining_rows(creator_factory, monkeypatch):
    from dj.apps.purchases import tasks
    buyer = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    intents = [retired_zec_instruction(creator=buyer, quantity_2z=100, platform='web')
        for _ in range(3)]
    monkeypatch.setattr(timezone, 'now', lambda: intents[-1].expires_at + timedelta(minutes=1))
    assert tasks.EXPIRY_BATCH_SIZE == 50 and tasks.EXPIRY_TICK_SECONDS == 30
    assert tasks.reconcile_zec_expiry.lock is None
    assert tasks.reconcile_zec_expiry.queueing_lock == 'purchases-zec-expiry-reconcile'
    monkeypatch.setattr(tasks, 'EXPIRY_BATCH_SIZE', 2)
    with monkeypatch.context() as budget:
        readings = iter([0, 31])
        budget.setattr(tasks, 'monotonic', lambda: next(readings))
        result = tasks.reconcile_zec_expiry(timestamp=0)
    assert result['attempted'] == result['expired'] == 0 and result['budget_exhausted']
    assert FundingReservation.objects.filter(state='reserved').count() == 3
    assert tasks.reconcile_zec_expiry(timestamp=0)['expired'] == 2
    assert FundingReservation.objects.filter(state='reserved').count() == 1
    assert tasks.reconcile_zec_expiry(timestamp=0)['expired'] == 1


@pytest.mark.usefixtures('price')
def test_periodic_zec_expiry_retains_fenced_and_locked_original_but_other_buyers_progress(creator_factory, monkeypatch):
    import psycopg
    from django.db import connection
    from dj.apps.economy.models import EconomicPolicy
    from dj.apps.purchases import tasks
    actors = [creator_factory(tuzis=0) for _ in range(2)]
    with transaction.atomic():
        activate_for_test()
    first, second = [retired_zec_instruction(creator=actor, quantity_2z=100, platform='web')
        for actor in actors]
    monkeypatch.setattr(timezone, 'now', lambda: second.expires_at + timedelta(minutes=1))
    EconomicPolicy.objects.filter(pk=True).update(fenced=True)
    result = tasks.reconcile_zec_expiry(timestamp=0)
    assert result['fenced'] and result['expired'] == 0
    assert FundingReservation.objects.filter(state='reserved').count() == 2
    EconomicPolicy.objects.filter(pk=True).update(fenced=False)
    with psycopg.connect(**connection.get_connection_params()) as blocker:
        blocker.execute('SELECT id FROM g12f_creator WHERE id=%s FOR UPDATE', [first.creator_id])
        result = tasks.reconcile_zec_expiry(timestamp=0)
        assert result['deferred'] == 1 and result['expired'] == 1 and not result['fenced']
        assert FundingReservation.objects.get(idempotency_key=f'zec-intent:{first.pk}').state == 'reserved'
        assert FundingReservation.objects.get(idempotency_key=f'zec-intent:{second.pk}').state == 'released'
    assert tasks.reconcile_zec_expiry(timestamp=0)['expired'] == 1


@pytest.mark.usefixtures('price')
def test_next_periodic_zec_expiry_claims_after_dead_doing_sweep_and_releases_original(creator_factory, monkeypatch):
    import time
    import json
    from attr import evolve
    from asgiref.sync import async_to_sync
    from procrastinate.contrib.django import app
    from procrastinate.contrib.django.models import ProcrastinateJob
    from procrastinate.job_context import JobContext
    from procrastinate.worker import Worker
    from dj.apps.purchases import tasks
    buyer = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    intent = retired_zec_instruction(creator=buyer, quantity_2z=100, platform='web')
    monkeypatch.setattr(timezone, 'now', lambda: intent.expires_at + timedelta(minutes=1))
    first_id = tasks.reconcile_zec_expiry.defer(timestamp=1)
    first_worker = async_to_sync(app.job_manager.register_worker)()
    first = async_to_sync(app.job_manager.fetch_job)(queues=['billing'], worker_id=first_worker)
    assert first.id == first_id
    # Preserve the killed DOING job; the next tick must be claimable without
    # relying on its NEVER reclaim policy or calling a function around the lock.
    ProcrastinateJob.objects.filter(pk=first_id).update(worker_id=None)
    next_id = tasks.reconcile_zec_expiry.defer(timestamp=2)
    next_worker = async_to_sync(app.job_manager.register_worker)()
    job = async_to_sync(app.job_manager.fetch_job)(queues=['billing'], worker_id=next_worker)
    assert job is not None and job.id == next_id
    # DjangoConnector returns JSON text; production psycopg-pool connector
    # decodes this identical stored payload before worker execution.
    job = evolve(job, task_kwargs=json.loads(job.task_kwargs))
    worker = Worker(app=app, queues=['billing'], install_signal_handlers=False)
    context = JobContext(app=app, worker_queues=['billing'], job=job,
        start_timestamp=time.time(), abort_reason=lambda: None)
    async_to_sync(worker._process_job)(context)
    assert ProcrastinateJob.objects.get(pk=next_id).status == 'succeeded'
    assert ProcrastinateJob.objects.get(pk=first_id).status == 'doing'
    assert FundingReservation.objects.get(idempotency_key=f'zec-intent:{intent.pk}').state == 'released'


@pytest.mark.usefixtures('price')
def test_periodic_zec_expiry_rotates_past_full_blocked_batch_after_killed_marker_commit(creator_factory, monkeypatch):
    import psycopg
    from django.db import connection
    from dj.apps.purchases import tasks
    from dj.apps.purchases.models import PurchaseIntent
    old_actor = creator_factory(tuzis=0)
    later_actor = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    old = [retired_zec_instruction(creator=old_actor, quantity_2z=100, platform='web')
        for _ in range(51)]
    later = retired_zec_instruction(creator=later_actor, quantity_2z=100, platform='web')
    clock = later.expires_at + timedelta(minutes=1)
    monkeypatch.setattr(timezone, 'now', lambda: clock)
    with psycopg.connect(**connection.get_connection_params()) as blocker:
        blocker.execute('SELECT id FROM g12f_creator WHERE id=%s FOR UPDATE', [old_actor.pk])
        with monkeypatch.context() as killed:
            # The selected marker transaction commits; cleanup never starts.
            readings = iter([0, 31])
            killed.setattr(tasks, 'monotonic', lambda: next(readings))
            result = tasks.reconcile_zec_expiry(timestamp=1)
        assert result['budget_exhausted'] and result['expired'] == 0
        assert PurchaseIntent.objects.filter(rail_data__has_key='expiry_cleanup_attempted_at').count() == 50
        assert FundingReservation.objects.filter(state='reserved').count() == 52
        clock += timedelta(minutes=1)
        with monkeypatch.context() as bounded:
            # Next batch starts with the two originals beyond the blocked
            # old batch; one real lock timeout, then the later buyer succeeds.
            readings = iter([0, 0, 0, 31])
            bounded.setattr(tasks, 'monotonic', lambda: next(readings))
            result = tasks.reconcile_zec_expiry(timestamp=2)
        assert result['deferred'] == 1 and result['expired'] == 1
        assert FundingReservation.objects.get(idempotency_key=f'zec-intent:{later.pk}').state == 'released'
        assert all(row.state == 'reserved' for row in FundingReservation.objects.filter(purchaser_id=old_actor.pk))
        later.refresh_from_db()
        assert later.rail_data['memo'] and later.rail_data['payment_observed'] is False
        assert len(old) == 51


@pytest.mark.usefixtures('price')
def test_zec_expiry_retry_marker_never_casts_legacy_or_overwrites_observed_note(creator_factory, monkeypatch):
    from dj.apps.purchases import tasks
    from dj.apps.purchases.models import PurchaseIntent
    buyer = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    first = retired_zec_instruction(creator=buyer, quantity_2z=100, platform='web')
    original_quote, original_memo = first.quote, first.rail_data['memo']
    PurchaseIntent.objects.filter(pk=first.pk).update(rail_data=dict(first.rail_data,
        expiry_cleanup_attempted_at={'malformed': '1e999999999999999999'}))
    monkeypatch.setattr(timezone, 'now', lambda: first.expires_at + timedelta(minutes=1))
    assert tasks.reconcile_zec_expiry(timestamp=0)['expired'] == 1
    first.refresh_from_db()
    assert first.quote == original_quote and first.rail_data['memo'] == original_memo
    assert first.rail_data['payment_observed'] is False


def retired_zec_instruction(*, creator, quantity_2z=100, platform='web'):
    """Legacy persisted rows/jobs for cleanup tests, never a live quote API."""
    from dj.apps.economy.tests.test_integration import original_zec_intent
    from dj.apps.jobs.transactional import defer_in_transaction
    from dj.apps.purchases.tasks import expire_zec_intent
    intent=original_zec_intent(creator)
    defer_in_transaction(expire_zec_intent.configure(schedule_at=intent.expires_at),purchase_id=str(intent.pk))
    return intent
