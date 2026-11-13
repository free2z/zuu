"""#399: the original charged quote survives retries and is receipt-bound."""
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from django.utils import timezone

from dj.apps.ztripe.models import CheckoutIntent, StripeTransaction
from dj.apps.tuzis.models import IdempotencyKey
from dj.apps.ztripe.test_checkout_money_integrity import (
    stripe_configuration, completed_payload, post_signed, balance,
)

# Reuse the existing account-bound, test-only provider fixture.
__all__ = ['stripe_configuration']
KEY = 'native-card-purchase-399'


def provider(**kwargs):
    return SimpleNamespace(id='cs_test_native399',
        url='https://checkout.stripe.com/c/pay/cs_test_native399',
        mode='payment', livemode=False, account=None, status='open', payment_status='unpaid',
        amount_total=kwargs['line_items'][0]['price_data']['unit_amount'], currency='usd',
        client_reference_id=kwargs['client_reference_id'], metadata=kwargs['metadata'],
        expires_at=kwargs['expires_at'])


def create(api, user, **changes):
    api.force_authenticate(user=user)
    data = dict(quantity=2000, currentPath='/wallet/fund', returnMode='web', expected_actor_id=user.pk)
    data.update(changes)
    return api.post('/api/stripe/create-checkout-session/', data, format='json', HTTP_IDEMPOTENCY_KEY=KEY)


@pytest.mark.django_db
def test_original_quote_replays_without_another_provider_call(api_client, creator_factory):
    user = creator_factory()
    with patch('dj.apps.ztripe.views.stripe.checkout.Session.create', side_effect=provider) as call:
        first = create(api_client, user)
        assert first.status_code == 200, first.content
        original = first.json()
        assert original['quote']['amount_cents'] == 2200
        assert original['quote']['tuzis'] == 2000
        assert original['expires_at'] > timezone.now().timestamp()
        again = create(api_client, user)
        assert again.json() == original
        assert create(api_client, user, quantity=1).status_code == 409
        assert call.call_count == 1
    assert CheckoutIntent.objects.count() == 1
    receipt = api_client.post('/api/stripe/native-return/status/', {'status_token': original['status_token']}, format='json')
    assert receipt.json() == {'status': 'processing'}
    before = balance(user)
    payload = completed_payload(user=user, metadata=call.call_args.kwargs['metadata'], quantity=2000,
        session_id=original['id'])
    assert post_signed(api_client, payload).status_code == 200
    for _ in range(2):
        assert post_signed(api_client, payload).status_code == 200
        receipt = api_client.post('/api/stripe/native-return/status/', {'status_token': original['status_token']}, format='json')
        assert receipt.json() == {'status': 'credited', 'tuzis_credited': 2000}
    assert balance(user) == before + 2000
    api_client.force_authenticate(user=creator_factory())
    assert api_client.post('/api/stripe/native-return/status/', {'status_token': original['status_token']}, format='json').status_code == 410


@pytest.mark.django_db
def test_lost_worker_never_reauthorizes_a_provider_call(api_client, creator_factory):
    user = creator_factory()
    with patch('dj.apps.ztripe.views.stripe.checkout.Session.create', side_effect=RuntimeError('worker lost')):
        with pytest.raises(RuntimeError):
            create(api_client, user)
    IdempotencyKey.objects.filter(scope='stripe-checkout').update(created_at=timezone.now() - timedelta(days=400))
    with patch('dj.apps.ztripe.views.stripe.checkout.Session.create') as call:
        assert create(api_client, user).status_code == 409
        call.assert_not_called()
    from django.core.management import call_command
    call_command('cleanup_idempotency')
    assert IdempotencyKey.objects.filter(scope='stripe-checkout').count() == 1


@pytest.mark.django_db
@pytest.mark.parametrize('field,value', [
    ('amount_total', 2000), ('amount_total', True), ('currency', 'eur'),
    ('client_reference_id', '99999999'), ('metadata', {}),
    ('status', 'complete'), ('payment_status', 'paid'), ('expires_at', 1),
    ('amount_total', None), ('currency', None), ('client_reference_id', None),
    ('metadata', None), ('status', None), ('payment_status', None), ('expires_at', None),
    ('url', None), ('url', False), ('url', 'https://checkout.stripe.com/c/pay/cs_other399'),
])
def test_provider_response_must_bind_all_reviewed_terms(api_client, creator_factory, field, value):
    user = creator_factory()
    def forged(**kwargs):
        result = provider(**kwargs)
        setattr(result, field, value)
        return result
    with patch('dj.apps.ztripe.views.stripe.checkout.Session.create', side_effect=forged) as call, patch(
        'dj.apps.ztripe.views.stripe.checkout.Session.expire') as expire:
        response = create(api_client, user)
        assert response.status_code == 502
        expire.assert_called_once()
        assert create(api_client, user).status_code == 502
        assert call.call_count == 1
    assert not StripeTransaction.objects.exists()


@pytest.mark.django_db
def test_nominal_historical_row_cannot_be_used_as_a_credit_receipt(api_client, creator_factory):
    from dj.apps.ztripe.native_return import make_status_token
    user = creator_factory()
    api_client.force_authenticate(user=user)
    StripeTransaction.objects.create(user=user, amount=2200, tuzis_credited=2000, stripe_charge_id='pi_nominal399')
    response = api_client.post('/api/stripe/native-return/status/',
        {'status_token': make_status_token(user.pk, 'pi_nominal399')}, format='json')
    assert response.json() == {'status': 'processing'}


@pytest.mark.django_db(transaction=True)
def test_concurrent_activation_keeps_one_original_instruction(api_client, creator_factory):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from django.db import close_old_connections
    from rest_framework.test import APIClient
    user = creator_factory()
    entered, release = Event(), Event()
    def blocked(**kwargs):
        entered.set()
        assert release.wait(timeout=10)
        return provider(**kwargs)
    def first():
        close_old_connections()
        try:
            return create(APIClient(), user)
        finally:
            close_old_connections()
    with patch('dj.apps.ztripe.views.stripe.checkout.Session.create', side_effect=blocked) as call:
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(first)
            try:
                assert entered.wait(timeout=10)
                duplicate = create(api_client, user)
                assert duplicate.status_code == 409
                record = IdempotencyKey.objects.get(scope='stripe-checkout')
                assert record.response_body['checkout_intent_id'] == str(CheckoutIntent.objects.get().public_id)
            finally:
                release.set()
            assert future.result(timeout=10).status_code == 200
        assert create(api_client, user).status_code == 200
        assert call.call_count == 1


@pytest.mark.django_db
def test_replay_preserves_the_session_after_rollout_switch_changes(api_client, creator_factory, settings):
    user = creator_factory()
    with patch('dj.apps.ztripe.views.stripe.checkout.Session.create', side_effect=provider) as call:
        original = create(api_client, user)
        settings.STRIPE_CHECKOUT_ENABLED = 'false'
        assert create(api_client, user).json() == original.json()
        assert call.call_count == 1


@pytest.mark.django_db
def test_expired_correlation_renews_only_the_original_receipt_token(api_client, creator_factory):
    from dj.apps.ztripe.native_return import read_status_token
    user = creator_factory()
    with patch('dj.apps.ztripe.views.stripe.checkout.Session.create', side_effect=provider) as call:
        original = create(api_client, user).json()
        with patch('django.core.signing.time.time', return_value=timezone.now().timestamp() + 3 * 86400):
            assert read_status_token(original['status_token'], user.pk) is None
            replay = create(api_client, user).json()
            assert read_status_token(replay['status_token'], user.pk)['checkout_intent_id'] == original['quote']['checkout_intent_id']
        assert replay['quote'] == original['quote']
        assert replay['id'] == original['id']
        assert replay['expires_at'] == original['expires_at']
        assert call.call_count == 1


@pytest.mark.django_db
def test_preflight_refusal_retries_same_key_without_an_existing_instruction(api_client, creator_factory, settings):
    user = creator_factory()
    settings.STRIPE_CHECKOUT_ENABLED = 'false'
    with patch('dj.apps.ztripe.views.stripe.checkout.Session.create', side_effect=provider) as call:
        assert create(api_client, user).status_code == 503
        assert not CheckoutIntent.objects.exists()
        assert not IdempotencyKey.objects.filter(scope='stripe-checkout').exists()
        settings.STRIPE_CHECKOUT_ENABLED = 'true'
        assert create(api_client, user).status_code == 200
        assert call.call_count == 1


@pytest.mark.django_db
def test_real_stripe_sdk_response_keeps_the_exact_metadata_contract(api_client, creator_factory):
    import stripe
    user = creator_factory()
    def sdk_response(**kwargs):
        return stripe.StripeObject.construct_from(vars(provider(**kwargs)), 'sk_test_fixture')
    with patch('dj.apps.ztripe.views.stripe.checkout.Session.create', side_effect=sdk_response):
        response = create(api_client, user)
    assert response.status_code == 200, response.content
    assert response.json()['quote']['amount_cents'] == 2200


@pytest.mark.django_db
def test_account_rotation_or_changed_quote_blocks_reopening_the_original_session(api_client, creator_factory, settings):
    user = creator_factory()
    with patch('dj.apps.ztripe.views.stripe.checkout.Session.create', side_effect=provider) as call:
        original = create(api_client, user)
        assert original.status_code == 200
        account = settings.STRIPE_EXPECTED_ACCOUNT_ID
        settings.STRIPE_EXPECTED_ACCOUNT_ID = 'acct_otherMerchant399'
        assert create(api_client, user).status_code == 409
        settings.STRIPE_EXPECTED_ACCOUNT_ID = account
        assert create(api_client, user).json() == original.json()
        CheckoutIntent.objects.update(pricing_version='tampered')
        assert create(api_client, user).status_code == 409
        assert call.call_count == 1


@pytest.mark.django_db
def test_designed_mobile_fallback_replays_same_web_terms_and_only_one_session(api_client, creator_factory, settings):
    settings.ZUULI_NATIVE_CHECKOUT_ENABLED = False
    user = creator_factory()
    with patch('dj.apps.ztripe.views.stripe.checkout.Session.create', side_effect=provider) as call:
        refused = create(api_client, user, returnMode='zuuli_mobile')
        assert refused.status_code == 503
        assert refused.json()['code'] == 'native_checkout_unavailable'
        assert not CheckoutIntent.objects.exists()
        order = create(api_client, user, returnMode='web')
        assert order.status_code == 200
        for _ in range(3):  # confirmation, opener failure retry, restarted client
            assert create(api_client, user, returnMode='web').json() == order.json()
        assert create(api_client, user, returnMode='zuuli_mobile').status_code == 409
        assert call.call_count == CheckoutIntent.objects.count() == 1
