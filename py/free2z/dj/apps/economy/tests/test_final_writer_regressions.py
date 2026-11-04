from dj.apps.economy.tests.test_integration import historical_note_observation
"""Final review: actual handlers/ledger, injected crashes and mocked provider IO."""
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
import stripe
from django.db import transaction
from django.utils import timezone

from dj.apps.economy import funding
from dj.apps.economy.models import EconomicPolicy, FundingReservation
from dj.apps.economy.tests.test_concurrency import isolated_epoch  # noqa: F401
from dj.apps.economy.tests.test_foundation import activate_for_test
from dj.apps.economy.tests.test_capture_lifecycle import IDENTITY
from dj.apps.purchases.models import PurchaseIntent
from dj.apps.purchases import views as purchases
from dj.apps.tuzis.models import IdempotencyKey
from dj.apps.tuzis import zec
from dj.apps.ztripe import views as checkout_views
from dj.apps.ztripe.models import CheckoutIntent

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.ledger_drift_expected]


def card_body(buyer):
    return {'rail': 'card', 'quantity_2z': 100, 'platform': 'web',
        'return_url': 'https://free2z.cash/wallet', 'expected_actor_id': buyer.pk}


def fake_session():
    return SimpleNamespace(id='cs_recovered', url='https://checkout.stripe.com/c/pay/cs_recovered',
        mode='payment', livemode=False, account=None)


@pytest.mark.parametrize('rail', ['card'])
def test_cutover_after_preflight_requires_original_actor_before_pinned_admission(
    api_client, creator_factory, settings, mocker, rail):
    buyer = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    settings.STRIPE_CHECKOUT_ALLOWED_HOSTS = ['checkout.stripe.com']
    settings.CANONICAL_ORIGIN = 'https://free2z.cash'
    api_client.force_authenticate(user=buyer)
    # Only the unlocked preflight observes0. All actual policy SQL sees1.
    manager = EconomicPolicy.objects
    original = manager.get
    calls = 0
    def preflight_then_current(*args, **kwargs):
        nonlocal calls
        calls += 1
        return SimpleNamespace(version=0) if calls == 1 else original(*args, **kwargs)
    mocker.patch.object(manager, 'get', side_effect=preflight_then_current)
    mocker.patch.object(purchases, '_checkout_identity', return_value=(IDENTITY, None))
    provider = mocker.patch.object(checkout_views.stripe.checkout.Session, 'create')
    body = card_body(buyer)
    body.pop('expected_actor_id')
    body['rail'] = rail
    if rail == 'zcash':
        body.pop('return_url')
    response = api_client.post('/api/sdk/v1/purchases', body, format='json', HTTP_IDEMPOTENCY_KEY='pin-cutover')
    assert response.status_code == 409 and response.json()['error']['code'] == 'actor_identity_changed'
    assert not PurchaseIntent.objects.exists() and not FundingReservation.objects.exists()
    provider.assert_not_called()


def test_sdk_stale_worker_recovery_uses_persisted_recovery_compatible_expiry(
    api_client, creator_factory, settings, mocker, monkeypatch):
    buyer = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    settings.STRIPE_CHECKOUT_ALLOWED_HOSTS = ['checkout.stripe.com']
    settings.CANONICAL_ORIGIN = 'https://free2z.cash'
    api_client.force_authenticate(user=buyer)
    mocker.patch.object(purchases, '_checkout_identity', return_value=(IDENTITY, None))
    crash = mocker.patch.object(purchases.PurchaseIntentCreateView, '_open_session', side_effect=RuntimeError('worker died'))
    interrupted = api_client.post('/api/sdk/v1/purchases', card_body(buyer), format='json', HTTP_IDEMPOTENCY_KEY='crash-recover')
    assert interrupted.status_code == 500
    original = PurchaseIntent.objects.get()
    frozen_expiry = original.quote['stripe_session_expires_at']
    assert frozen_expiry == int(original.created_at.timestamp()) + 23 * 3600
    assert int(original.expires_at.timestamp()) == frozen_expiry
    mocker.stop(crash)
    later = original.created_at + timedelta(minutes=16)
    monkeypatch.setattr(timezone, 'now', lambda: later)
    provider = mocker.patch.object(checkout_views.stripe.checkout.Session, 'create', return_value=fake_session())
    response = api_client.post('/api/sdk/v1/purchases', card_body(buyer), format='json', HTTP_IDEMPOTENCY_KEY='crash-recover')
    assert response.status_code == 201
    assert provider.call_args.kwargs['expires_at'] == frozen_expiry
    assert 30 * 60 <= frozen_expiry - int(later.timestamp()) <= 24 * 3600
    assert PurchaseIntent.objects.count() == CheckoutIntent.objects.count() == FundingReservation.objects.count() == 1


@pytest.mark.parametrize('sdk', [False, True])
def test_documented_first_attempt_parameter_rejection_releases_unused_capacity(
    api_client, creator_factory, settings, mocker, sdk):
    buyer = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    settings.STRIPE_CHECKOUT_ALLOWED_HOSTS = ['checkout.stripe.com']
    settings.CANONICAL_ORIGIN = 'https://free2z.cash'
    api_client.force_authenticate(user=buyer)
    mocker.patch.object(checkout_views, '_prove_checkout_identity', return_value=(IDENTITY, None))
    mocker.patch.object(purchases, '_checkout_identity', return_value=(IDENTITY, None))
    provider = mocker.patch.object(checkout_views.stripe.checkout.Session, 'create',
        side_effect=stripe.error.InvalidRequestError('unknown parameter', 'adaptive_pricing',
            code='parameter_unknown', http_status=400))
    route = '/api/sdk/v1/purchases' if sdk else '/api/stripe/create-checkout-session/'
    body = card_body(buyer) if sdk else {'quantity': 100, 'currentPath': '/wallet', 'expected_actor_id': buyer.pk}
    response = api_client.post(route, body, format='json', HTTP_IDEMPOTENCY_KEY='definite-refusal')
    assert response.status_code == 502
    assert FundingReservation.objects.get().state == 'released'
    assert IdempotencyKey.objects.filter(scope='stripe-create-refusal').count() == 1
    if sdk:
        # A worker may die after release, before finishing its caller receipt.
        original = PurchaseIntent.objects.get()
        IdempotencyKey.objects.filter(key='definite-refusal').update(response_status=None,
            response_body={'purchase_id': str(original.pk)},
            created_at=timezone.now() - timedelta(minutes=16))
        replay = api_client.post(route, body, format='json', HTTP_IDEMPOTENCY_KEY='definite-refusal')
        assert replay.status_code == 502 and provider.call_count == 1
        assert PurchaseIntent.objects.count() == 1
    provider.side_effect = None
    provider.return_value = fake_session()
    retry = api_client.post(route, body, format='json', HTTP_IDEMPOTENCY_KEY='new-fixed-request')
    assert retry.status_code == (201 if sdk else 200)
    assert FundingReservation.objects.filter(state='reserved').count() == 1


def test_parameter_error_after_ambiguous_creation_does_not_release_capacity(
    api_client, creator_factory, settings, mocker):
    buyer = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    settings.STRIPE_CHECKOUT_ALLOWED_HOSTS = ['checkout.stripe.com']
    api_client.force_authenticate(user=buyer)
    mocker.patch.object(checkout_views, '_prove_checkout_identity', return_value=(IDENTITY, None))
    mocker.patch.object(checkout_views.stripe.checkout.Session, 'create', side_effect=[
        stripe.error.APIConnectionError('unknown'),
        stripe.error.InvalidRequestError('unknown parameter', 'adaptive_pricing', code='parameter_unknown', http_status=400)])
    response = api_client.post('/api/stripe/create-checkout-session/',
        {'quantity': 100, 'currentPath': '/wallet', 'expected_actor_id': buyer.pk}, format='json')
    assert response.status_code == 502 and FundingReservation.objects.get().state == 'reserved'
    assert not IdempotencyKey.objects.filter(scope='stripe-create-refusal').exists()


def test_legacy_fenced_ironwood_note_advances_only_after_actual_ledger_issuance(creator_factory):
    from dj.apps.economy.models import CapturedZecNote, ZecNoteDisposition
    buyer = creator_factory(tuzis=0)
    EconomicPolicy.objects.filter(pk=True).update(fenced=True)
    plain = '{"action":"buy_2z","id":"legacy"}'
    args = dict(creator=buyer, txid='7' * 64, pool='ironwood', output_index=0,
        amount_zec=Decimal('0.01000000'), tuzis_per_zec=Decimal('9000'),
        confirmations=3, memo=plain.encode().ljust(512, b'\0').hex(), memo_plain=plain)
    pending = zec.credit_zec_purchase(**args)
    assert not pending.credited
    note = CapturedZecNote.objects.get()
    assert pending.reason == 'economic_writers_fenced'
    assert ZecNoteDisposition.objects.filter(note=note, kind='observed').exists()
    assert not ZecNoteDisposition.objects.filter(note=note, kind='issued').exists()
    EconomicPolicy.objects.filter(pk=True).update(fenced=False)
    receipt = zec.credit_zec_purchase(**args)
    assert receipt.tuzis_credited == 90
    # A subsequent fenced pass adopts the actual clearing journal, without
    # treating the username-only memo as purchaser authorization or issuing twice.
    EconomicPolicy.objects.filter(pk=True).update(fenced=True)
    adopted = zec.credit_zec_purchase(**args)
    assert not adopted.credited and adopted.reason == 'economic_writers_fenced'
    assert ZecNoteDisposition.objects.filter(note=note, kind='legacy_issued', receipt=receipt).exists()
    buyer.refresh_from_db()
    assert buyer.tuzis == 90


def test_nominal_legacy_note_receipt_without_clearing_proof_stays_resolution(creator_factory):
    from dj.apps.tuzis.models import ZecCreditReceipt
    buyer = creator_factory(tuzis=0)
    note = historical_note_observation(creator_id=buyer.pk, txid='8' * 64, pool='ironwood',
        output_index=0, amount_zec=Decimal('.01'), memo_plain='legacy note')
    receipt = ZecCreditReceipt.objects.create(creator=buyer, txid='8' * 64, pool='ironwood',
        output_index=0, amount_zec=Decimal('.01'), tuzis_per_zec=9000, tuzis_credited=90)
    funding.mark_original_zec_note_issued(receipt)
    note.refresh_from_db()
    assert note.response_body['status'] == 'pending_resolution'
    assert len(funding.funding_resolution_statuses(creator_id=buyer.pk)) == 1


@pytest.mark.parametrize('sdk', [False, True])
def test_attributable_creation_refusal_cleanup_retries_after_actual_fence_clears(
    api_client, creator_factory, settings, mocker, sdk):
    from dj.apps.ztripe import economic_events
    buyer = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    settings.STRIPE_CHECKOUT_ALLOWED_HOSTS = ['checkout.stripe.com']
    settings.CANONICAL_ORIGIN = 'https://free2z.cash'
    api_client.force_authenticate(user=buyer)
    mocker.patch.object(checkout_views, '_prove_checkout_identity', return_value=(IDENTITY, None))
    mocker.patch.object(purchases, '_checkout_identity', return_value=(IDENTITY, None))
    def refuse_while_fenced(**kwargs):
        EconomicPolicy.objects.filter(pk=True).update(fenced=True)
        raise stripe.error.InvalidRequestError('unknown parameter', 'adaptive_pricing',
            code='parameter_unknown', http_status=400)
    provider = mocker.patch.object(checkout_views.stripe.checkout.Session, 'create', side_effect=refuse_while_fenced)
    retrieve = mocker.patch.object(checkout_views.stripe.checkout.Session, 'retrieve')
    route = '/api/sdk/v1/purchases' if sdk else '/api/stripe/create-checkout-session/'
    body = card_body(buyer) if sdk else {'quantity': 100, 'currentPath': '/wallet', 'expected_actor_id': buyer.pk}
    assert api_client.post(route, body, format='json', HTTP_IDEMPOTENCY_KEY='fenced-refusal').status_code == 502
    reservation = FundingReservation.objects.get()
    assert reservation.state == 'reserved'
    proof = IdempotencyKey.objects.get(scope='stripe-create-refusal')
    assert proof.response_body.get('cleanup_status') is None
    EconomicPolicy.objects.filter(pk=True).update(fenced=False)
    original_save = IdempotencyKey.save
    def crash_after_financial_release(instance, *args, **kwargs):
        if instance.scope == 'stripe-create-refusal' and instance.response_body.get('cleanup_status') == 'released':
            raise RuntimeError('crash after release')
        return original_save(instance, *args, **kwargs)
    crash = mocker.patch.object(IdempotencyKey, 'save', new=crash_after_financial_release)
    with pytest.raises(RuntimeError, match='crash after release'):
        economic_events.reconcile_expired_card_authorizations(creator_id=buyer.pk, identity=IDENTITY)
    reservation.refresh_from_db()
    proof.refresh_from_db()
    assert reservation.state == 'released' and proof.response_body.get('cleanup_status') is None
    mocker.stop(crash)
    economic_events.reconcile_expired_card_authorizations(creator_id=buyer.pk, identity=IDENTITY)
    reservation.refresh_from_db()
    proof.refresh_from_db()
    assert reservation.state == 'released' and proof.response_body['cleanup_status'] == 'released'
    assert provider.call_count == 1
    retrieve.assert_not_called()


@pytest.mark.parametrize('amount', ['.001', '.00000099'])
def test_proven_legacy_issuance_is_excluded_before_pending_queue_limit(creator_factory, amount):
    buyer = creator_factory(tuzis=0)
    older = historical_note_observation(creator_id=buyer.pk, txid='a' * 64, pool='ironwood',
        output_index=0, amount_zec=Decimal('.01'), memo_plain='unknown historical payment')
    for index in range(51):
        txid = f'{index:064x}'
        note = historical_note_observation(creator_id=buyer.pk, txid=txid, pool='ironwood',
            output_index=0, amount_zec=Decimal(amount), memo_plain='legacy payment')
        zec.credit_zec_purchase(creator=buyer, txid=txid, pool='ironwood', output_index=0,
            amount_zec=Decimal(amount), tuzis_per_zec=Decimal('9000'), confirmations=3)
        note.refresh_from_db()
        note.response_body['status'] = 'pending_resolution'
        note.save(update_fields=['response_body'])
    pending = funding.funding_resolution_statuses(creator_id=buyer.pk, limit=50)
    assert [row['resolution_id'] for row in pending] == [f'zec-note:{older.pk}']
    # Historical malformed JSON is unproven, never a crashing numeric cast.
    note.response_body['note']['amount_zec'] = '1E999999999'
    # Emulate an already persisted malformed historical record as the private
    # DB owner. The live immutable provenance guard correctly forbids this edit.
    from dj.apps.economy.tests.test_foundation import sql
    sql('ALTER TABLE tuzis_idempotencykey DISABLE TRIGGER economy_note_observation_identity')
    try:
        note.save(update_fields=['response_body'])
    finally:
        sql('ALTER TABLE tuzis_idempotencykey ENABLE TRIGGER economy_note_observation_identity')
    assert [row['resolution_id'] for row in funding.funding_resolution_statuses(creator_id=buyer.pk)] == [
        f'zec-note:{note.pk}', f'zec-note:{older.pk}']
