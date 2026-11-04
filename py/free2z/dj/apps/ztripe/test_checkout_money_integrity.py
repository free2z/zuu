"""Contract tests for durable card quotes and exact webhook fulfillment."""

import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal
from io import StringIO
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
import redis
import stripe
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import (
    IntegrityError,
    close_old_connections,
    connection,
    transaction,
)
from django.test import Client
from django.utils import timezone

from dj.apps.g12f.models import Creator
from dj.apps.pricing.constants import card_charge_cents
from dj.apps.ztripe.models import (
    CheckoutFulfillmentAudit,
    CheckoutIntent,
    StripeCheckoutRollout,
    StripeTransaction,
    StripeWebhookReadiness,
)
from dj.apps.ztripe.test_webhook_signature import SIGNING_SECRET, sign


# The card-v3 tier list, including quantity 1 (the  regression: charged
# 101c, credited 0 2Z) and 500/501, where the $0.50 floor hands over to the 10%.
# Values are written out literally so a formula change cannot silently move
# what these tests claim a buyer is charged.
EXPECTED_CHARGE_CENTS = {
    1: 51, 2: 52, 19: 69, 20: 70, 21: 71, 50: 100, 100: 150,
    500: 550, 501: 552, 1_000: 1_100, 2_000: 2_200,
}
QUANTITIES = sorted(EXPECTED_CHARGE_CENTS)
TEST_STRIPE_ACCOUNT_ID = 'acct_testMoneyIntegrity'
LEGACY_SESSION_CREATED = 1_700_000_000
LEGACY_CUTOFF_EPOCH = 1_735_689_600
LEGACY_CUTOFF = str(LEGACY_CUTOFF_EPOCH)


def balance(user):
    return Creator.objects.values_list('tuzis', flat=True).get(pk=user.pk)


def start_checkout(api_client, user, quantity, suffix='money'):
    api_client.force_authenticate(user=user)
    with patch('dj.apps.ztripe.views.stripe.checkout.Session.create') as create:
        create.return_value.id = f'cs_test_{suffix}'
        create.return_value.url = (
            f'https://checkout.stripe.com/c/pay/cs_test_{suffix}'
        )
        create.return_value.mode = 'payment'
        create.return_value.livemode = False
        create.return_value.account = None
        response = api_client.post(
            '/api/stripe/create-checkout-session/',
            {'quantity': quantity, 'currentPath': '/wallet/fund'},
            format='json',
        )
    return response, create.call_args.kwargs


def completed_payload(
    *, user, metadata, quantity, event_id='evt_test_money',
    session_id='cs_test_money', payment_intent='pi_test_money',
    amount_total=None, currency='usd', payment_status='paid',
    mode='payment', livemode=False, event_account=None,
    session_created=LEGACY_SESSION_CREATED,
):
    event = {
        'id': event_id,
        'object': 'event',
        'type': 'checkout.session.completed',
        'livemode': livemode,
        'data': {'object': {
            'id': session_id,
            'object': 'checkout.session',
            'created': session_created,
            'client_reference_id': str(user.pk),
            'payment_status': payment_status,
            'mode': mode,
            'livemode': livemode,
            'amount_total': (
                card_charge_cents(quantity)
                if amount_total is None
                else amount_total
            ),
            'currency': currency,
            'payment_intent': payment_intent,
            'metadata': metadata,
        }},
    }
    if event_account is not None:
        event['account'] = event_account
    return json.dumps(event)


def post_signed(client, payload):
    return client.post(
        '/api/stripe/webhook/',
        data=payload,
        content_type='application/json',
        HTTP_STRIPE_SIGNATURE=sign(payload),
    )


@pytest.fixture(autouse=True)
def stripe_configuration(settings, db):
    # These are PROD money-path contracts; outside prod a live declaration is
    # refused earlier by the  guard (test_live_credentials_guard.py).
    settings.NAMESPACE = 'prod'
    settings.STRIPE_SIGNING_SECRET = SIGNING_SECRET
    settings.STRIPE_SECRET_KEY = 'sk_test_money_integrity'
    settings.STRIPE_EXPECTED_ACCOUNT_ID = TEST_STRIPE_ACCOUNT_ID
    settings.STRIPE_EXPECTED_LIVEMODE = 'false'
    settings.STRIPE_CHECKOUT_ENABLED = 'true'
    settings.STRIPE_WEBHOOK_ENDPOINT_ID = 'we_testMoneyIntegrity'
    StripeCheckoutRollout.objects.get_or_create(
        singleton=1,
        defaults={
            'legacy_session_created_at_or_before_epoch': LEGACY_CUTOFF_EPOCH,
        },
    )
    with patch(
        'dj.apps.ztripe.views.stripe.Account.retrieve',
        return_value={'id': TEST_STRIPE_ACCOUNT_ID},
    ), patch(
        'dj.apps.ztripe.views.stripe.WebhookEndpoint.retrieve',
        return_value={
            'id': 'we_testMoneyIntegrity',
            'status': 'enabled',
            'livemode': False,
            'url': 'http://localhost:3000/api/stripe/webhook/',
            'enabled_events': ['checkout.session.completed'],
        },
    ), patch(
        'dj.apps.ztripe.views.webhook_is_ready', return_value=True,
    ), patch(
        'dj.apps.ztripe.views.verify_and_record_checkout_event',
    ), patch(
        'dj.apps.ztripe.management.commands.check_stripe_checkout_identity.'
        'prove_webhook_endpoint',
    ), patch(
        'dj.apps.ztripe.management.commands.check_stripe_checkout_identity.'
        'webhook_is_ready',
        return_value=True,
    ):
        yield


@pytest.mark.django_db
@pytest.mark.parametrize('quantity', QUANTITIES)
def test_checkout_persists_and_returns_the_exact_authoritative_quote(
    api_client, creator_factory, quantity,
):
    user = creator_factory()
    response, create_args = start_checkout(
        api_client, user, quantity, suffix=f'q{quantity}',
    )

    assert response.status_code == 200, response.content
    payload = response.json()
    intent = CheckoutIntent.objects.get(public_id=payload['quote']['checkout_intent_id'])
    assert payload['quote'] == {
        'checkout_intent_id': str(intent.public_id),
        'tuzis': quantity,
        'amount_cents': card_charge_cents(quantity),
        'currency': 'usd',
        'pricing_version': 'card-v3',
    }
    assert payload['quote']['amount_cents'] == EXPECTED_CHARGE_CENTS[quantity]
    assert intent.user_id == user.pk
    assert intent.stripe_account_id == TEST_STRIPE_ACCOUNT_ID
    assert intent.stripe_mode == 'payment'
    assert intent.stripe_livemode is False
    assert intent.stripe_checkout_session_id == f'cs_test_q{quantity}'
    assert intent.state == CheckoutIntent.State.OPEN
    assert create_args['line_items'][0]['price_data']['unit_amount'] == (
        payload['quote']['amount_cents']
    )
    assert create_args['line_items'][0]['price_data']['currency'] == 'usd'
    assert create_args['adaptive_pricing'] == {'enabled': False}
    assert create_args['metadata'] == {
        'checkout_intent_id': str(intent.public_id),
        'user_id': str(user.pk),
        'tuzis': str(quantity),
        'amount_cents': str(card_charge_cents(quantity)),
        'currency': 'usd',
        'pricing_version': 'card-v3',
        'stripe_account_id': TEST_STRIPE_ACCOUNT_ID,
        'stripe_mode': 'payment',
        'stripe_livemode': 'false',
    }
    assert create_args['payment_intent_data']['metadata'] == create_args['metadata']
    assert create_args['idempotency_key'] == (
        f'free2z-checkout-intent-{intent.public_id}'
    )
    assert create_args['api_key'] == 'sk_test_money_integrity'
    assert create_args['max_network_retries'] == 0


@pytest.mark.django_db(transaction=True)
def test_checkout_commits_intent_before_provider_call_without_open_transaction(
    api_client, creator_factory,
):
    user = creator_factory()
    api_client.force_authenticate(user=user)

    def create_session(**kwargs):
        assert connection.in_atomic_block is False
        intent = CheckoutIntent.objects.get()
        assert kwargs['metadata']['checkout_intent_id'] == str(intent.public_id)
        return SimpleNamespace(
            id='cs_test_committed_before_provider',
            url=(
                'https://checkout.stripe.com/c/pay/'
                'cs_test_committed_before_provider'
            ),
            mode='payment',
            livemode=False,
            account=None,
        )

    with patch(
        'dj.apps.ztripe.views.stripe.checkout.Session.create',
        side_effect=create_session,
    ):
        response = api_client.post(
            '/api/stripe/create-checkout-session/',
            {'quantity': 21, 'currentPath': '/wallet/fund'},
            format='json',
        )

    assert response.status_code == 200
    assert CheckoutIntent.objects.get().state == CheckoutIntent.State.OPEN


@pytest.mark.django_db
@pytest.mark.parametrize(
    ('setting', 'value'),
    [
        ('STRIPE_EXPECTED_ACCOUNT_ID', ''),
        ('STRIPE_EXPECTED_ACCOUNT_ID', 'not-an-account'),
        ('STRIPE_EXPECTED_LIVEMODE', ''),
        ('STRIPE_EXPECTED_LIVEMODE', 'False'),
        ('STRIPE_EXPECTED_LIVEMODE', 'true'),
    ],
)
def test_unproven_checkout_configuration_never_creates_a_payable_session(
    api_client, creator_factory, settings, setting, value,
):
    setattr(settings, setting, value)
    user = creator_factory()
    api_client.force_authenticate(user=user)
    with patch('dj.apps.ztripe.views.stripe.Account.retrieve') as retrieve, patch(
        'dj.apps.ztripe.views.stripe.checkout.Session.create'
    ) as create:
        response = api_client.post(
            '/api/stripe/create-checkout-session/',
            {'quantity': 21, 'currentPath': '/wallet/fund'},
            format='json',
        )

    assert response.status_code == 500  # a real outage, never the designed 503
    assert CheckoutIntent.objects.count() == 0
    retrieve.assert_not_called()
    create.assert_not_called()


@pytest.mark.django_db
def test_staged_off_checkout_never_calls_stripe_or_creates_an_intent(
    api_client, creator_factory, settings,
):
    settings.STRIPE_CHECKOUT_ENABLED = 'false'
    user = creator_factory()
    api_client.force_authenticate(user=user)
    with patch('dj.apps.ztripe.views.stripe.Account.retrieve') as account, patch(
        'dj.apps.ztripe.views.stripe.WebhookEndpoint.retrieve'
    ) as endpoint, patch(
        'dj.apps.ztripe.views.stripe.checkout.Session.create'
    ) as create:
        response = api_client.post(
            '/api/stripe/create-checkout-session/',
            {'quantity': 21, 'currentPath': '/wallet/fund'},
            format='json',
        )

    assert response.status_code == 503
    assert CheckoutIntent.objects.count() == 0
    account.assert_not_called()
    endpoint.assert_not_called()
    create.assert_not_called()


@pytest.mark.django_db
def test_stale_webhook_readiness_never_creates_a_payable_session(
    api_client, creator_factory,
):
    user = creator_factory()
    api_client.force_authenticate(user=user)
    with patch(
        'dj.apps.ztripe.views.webhook_is_ready', return_value=False,
    ), patch(
        'dj.apps.ztripe.views.stripe.checkout.Session.create'
    ) as create:
        response = api_client.post(
            '/api/stripe/create-checkout-session/',
            {'quantity': 21, 'currentPath': '/wallet/fund'},
            format='json',
        )

    assert response.status_code == 500  # a real outage, never the designed 503
    assert CheckoutIntent.objects.count() == 0
    create.assert_not_called()


@pytest.mark.django_db
def test_staged_off_deploy_still_settles_a_provider_proven_legacy_payment(
    client, creator_factory, settings,
):
    settings.STRIPE_CHECKOUT_ENABLED = 'false'
    settings.STRIPE_EXPECTED_ACCOUNT_ID = ''
    settings.STRIPE_EXPECTED_LIVEMODE = ''
    settings.STRIPE_WEBHOOK_ENDPOINT_ID = ''
    user = creator_factory(tuzis=Decimal('0'))
    payload = completed_payload(
        user=user,
        metadata={},
        quantity=21,
        event_id='evt_test_staged_legacy',
        session_id='cs_test_staged_legacy',
        payment_intent='pi_test_staged_legacy',
        amount_total=122,
    )
    event = json.loads(payload)

    with patch(
        'dj.apps.ztripe.views.stripe.Account.retrieve',
        return_value={'id': 'acct_stagedLegacyProof'},
    ) as account, patch(
        'dj.apps.ztripe.webhook_readiness.stripe.Event.retrieve',
        return_value=event,
    ) as retrieve:
        response = post_signed(client, payload)

    assert response.status_code == 200, response.content
    assert balance(user) == Decimal('21')
    account.assert_called_once_with(
        api_key='sk_test_money_integrity', max_network_retries=0,
    )
    retrieve.assert_called_once_with(
        'evt_test_staged_legacy',
        api_key='sk_test_money_integrity',
        max_network_retries=0,
    )
    audit = CheckoutFulfillmentAudit.objects.get(
        provider_event_id='evt_test_staged_legacy',
    )
    assert audit.reason == 'legacy_exact'
    assert audit.expected_stripe_account_id == 'acct_stagedLegacyProof'
    assert audit.expected_stripe_livemode is False
    assert StripeWebhookReadiness.objects.count() == 0


@pytest.mark.django_db
def test_staged_off_provider_delivery_establishes_configured_readiness(
    client, creator_factory, settings,
):
    """Provisioning can finish before the externally controlled activation."""
    from dj.apps.ztripe.webhook_readiness import (
        verify_and_record_checkout_event as record_readiness,
    )

    settings.STRIPE_CHECKOUT_ENABLED = 'false'
    user = creator_factory(tuzis=Decimal('0'))
    payload = completed_payload(
        user=user,
        metadata={},
        quantity=21,
        event_id='evt_test_staged_readiness',
        session_id='cs_test_staged_readiness',
        payment_intent='pi_test_staged_readiness',
        amount_total=122,
    )
    event = json.loads(payload)

    with patch(
        'dj.apps.ztripe.views.verify_and_record_checkout_event',
        side_effect=record_readiness,
    ) as verify, patch(
        'dj.apps.ztripe.webhook_readiness.stripe.Event.retrieve',
        return_value=event,
    ):
        response = post_signed(client, payload)

    assert response.status_code == 200, response.content
    verify.assert_called_once()
    readiness = StripeWebhookReadiness.objects.get(singleton=1)
    assert readiness.stripe_account_id == TEST_STRIPE_ACCOUNT_ID
    assert readiness.webhook_endpoint_id == 'we_testMoneyIntegrity'
    assert balance(user) == Decimal('21')


@pytest.mark.django_db
def test_staged_nonfinancial_canary_establishes_readiness_without_credit(
    client, settings,
):
    settings.STRIPE_CHECKOUT_ENABLED = 'false'
    event = {
        'id': 'evt_test_staged_customer_canary',
        'object': 'event',
        'type': 'customer.created',
        'livemode': False,
        'data': {'object': {
            'id': 'cus_test_staged_customer_canary',
            'object': 'customer',
            'livemode': False,
        }},
    }
    payload = json.dumps(event)

    with patch(
        'dj.apps.ztripe.webhook_readiness.stripe.Event.retrieve',
        return_value=event,
    ):
        response = post_signed(client, payload)

    assert response.status_code == 200, response.content
    assert StripeWebhookReadiness.objects.filter(singleton=1).exists()
    assert StripeTransaction.objects.count() == 0
    assert CheckoutFulfillmentAudit.objects.count() == 0


@pytest.mark.django_db(transaction=True)
def test_staged_webhook_provider_calls_run_outside_request_transaction(
    client, creator_factory, settings,
):
    settings.STRIPE_CHECKOUT_ENABLED = 'false'
    settings.STRIPE_EXPECTED_ACCOUNT_ID = ''
    settings.STRIPE_EXPECTED_LIVEMODE = ''
    settings.STRIPE_WEBHOOK_ENDPOINT_ID = ''
    user = creator_factory(tuzis=Decimal('0'))
    payload = completed_payload(
        user=user,
        metadata={},
        quantity=21,
        event_id='evt_test_staged_no_outer_transaction',
        session_id='cs_test_staged_no_outer_transaction',
        payment_intent='pi_test_staged_no_outer_transaction',
        amount_total=122,
    )
    event = json.loads(payload)

    def prove_account(**kwargs):
        assert connection.in_atomic_block is False
        return {'id': 'acct_stagedOutsideTransaction'}

    def prove_event(*args, **kwargs):
        assert connection.in_atomic_block is False
        return event

    with patch(
        'dj.apps.ztripe.views.stripe.Account.retrieve',
        side_effect=prove_account,
    ), patch(
        'dj.apps.ztripe.webhook_readiness.stripe.Event.retrieve',
        side_effect=prove_event,
    ):
        response = post_signed(client, payload)

    assert response.status_code == 200, response.content
    assert balance(user) == Decimal('21')


@pytest.mark.django_db
def test_staged_legacy_account_proof_failure_is_retryable_and_mints_nothing(
    client, creator_factory, settings,
):
    settings.STRIPE_CHECKOUT_ENABLED = 'false'
    settings.STRIPE_EXPECTED_ACCOUNT_ID = ''
    settings.STRIPE_EXPECTED_LIVEMODE = ''
    settings.STRIPE_WEBHOOK_ENDPOINT_ID = ''
    user = creator_factory(tuzis=Decimal('0'))
    payload = completed_payload(
        user=user,
        metadata={},
        quantity=21,
        event_id='evt_test_staged_unproven',
        session_id='cs_test_staged_unproven',
        payment_intent='pi_test_staged_unproven',
        amount_total=122,
    )

    with patch(
        'dj.apps.ztripe.views.stripe.Account.retrieve',
        side_effect=stripe.error.APIConnectionError('unavailable'),
    ), patch(
        'dj.apps.ztripe.webhook_readiness.stripe.Event.retrieve',
    ) as retrieve:
        response = post_signed(client, payload)

    assert response.status_code == 503
    assert balance(user) == Decimal('0')
    assert StripeTransaction.objects.count() == 0
    assert CheckoutFulfillmentAudit.objects.count() == 0
    retrieve.assert_not_called()


@pytest.mark.django_db
def test_credential_must_prove_the_exact_account_before_session_creation(
    api_client, creator_factory, settings,
):
    settings.STRIPE_EXPECTED_ACCOUNT_ID = 'acct_otherStripeAccount'
    user = creator_factory()
    api_client.force_authenticate(user=user)
    with patch(
        'dj.apps.ztripe.views.webhook_is_ready', return_value=False,
    ), patch(
        'dj.apps.ztripe.views.stripe.checkout.Session.create'
    ) as create:
        response = api_client.post(
            '/api/stripe/create-checkout-session/',
            {'quantity': 21, 'currentPath': '/wallet/fund'},
            format='json',
        )

    assert response.status_code == 500  # a real outage, never the designed 503
    assert CheckoutIntent.objects.count() == 0
    create.assert_not_called()


@pytest.mark.django_db
def test_checkout_uses_cached_delivery_proof_not_serial_provider_preflights(
    api_client, creator_factory,
):
    user = creator_factory()
    api_client.force_authenticate(user=user)
    with patch(
        'dj.apps.ztripe.views.stripe.Account.retrieve',
        side_effect=stripe.error.APIConnectionError('unavailable'),
    ) as account, patch(
        'dj.apps.ztripe.views.stripe.WebhookEndpoint.retrieve',
        side_effect=stripe.error.APIConnectionError('unavailable'),
    ) as endpoint, patch(
        'dj.apps.ztripe.views.stripe.checkout.Session.create'
    ) as create:
        create.return_value.id = 'cs_test_cached_provider_proof'
        create.return_value.url = (
            'https://checkout.stripe.com/c/pay/cs_test_cached_provider_proof'
        )
        create.return_value.mode = 'payment'
        create.return_value.livemode = False
        create.return_value.account = None
        response = api_client.post(
            '/api/stripe/create-checkout-session/',
            {'quantity': 21, 'currentPath': '/wallet/fund'},
            format='json',
        )

    assert response.status_code == 200
    account.assert_not_called()
    endpoint.assert_not_called()
    create.assert_called_once()


@pytest.mark.django_db
def test_checkout_has_a_narrow_per_buyer_provider_call_budget(
    api_client, creator_factory,
):
    from django.core.cache import cache

    cache.clear()
    api_client.force_authenticate(user=creator_factory())
    with patch(
        'dj.apps.ztripe.views.stripe.checkout.Session.create',
    ) as create:
        create.side_effect = [
            SimpleNamespace(
                id=f'cs_test_throttled_checkout_{index}',
                url=(
                    'https://checkout.stripe.com/c/pay/'
                    f'cs_test_throttled_checkout_{index}'
                ),
                mode='payment',
                livemode=False,
                account=None,
            )
            for index in range(6)
        ]
        statuses = [
            api_client.post(
                '/api/stripe/create-checkout-session/',
                {'quantity': 21, 'currentPath': '/wallet/fund'},
                format='json',
            ).status_code
            for _ in range(7)
        ]

    assert statuses == [200] * 6 + [429]
    assert create.call_count == 6


@pytest.mark.django_db
def test_checkout_admission_store_outage_fails_closed_before_stripe(
    api_client, creator_factory,
):
    from dj.free2z.throttling import StripeCheckoutUserRateThrottle

    api_client.force_authenticate(user=creator_factory())
    unavailable = Mock()
    unavailable.get.side_effect = redis.exceptions.ConnectionError('redis down')
    with patch.object(
        StripeCheckoutUserRateThrottle, 'cache', unavailable,
    ), patch(
        'dj.apps.ztripe.views.stripe.checkout.Session.create',
    ) as create:
        response = api_client.post(
            '/api/stripe/create-checkout-session/',
            {'quantity': 21, 'currentPath': '/wallet/fund'},
            format='json',
        )

    assert response.status_code == 500  # a real outage, never the designed 503
    create.assert_not_called()


def test_deployment_preflight_proves_account_without_printing_its_id():
    output = StringIO()
    with patch(
        'dj.apps.ztripe.management.commands.check_stripe_checkout_identity.'
        'stripe.Account.retrieve',
        return_value={'id': TEST_STRIPE_ACCOUNT_ID},
    ) as retrieve:
        call_command(
            'check_stripe_checkout_identity',
            require_legacy_cutoff=True,
            stdout=output,
        )

    assert (
        'mode=payment livemode=false legacy_cutoff=verified'
        in output.getvalue()
    )
    assert TEST_STRIPE_ACCOUNT_ID not in output.getvalue()
    assert retrieve.call_args.kwargs['max_network_retries'] == 0


def test_deployment_preflight_rejects_a_different_credential_account():
    with patch(
        'dj.apps.ztripe.management.commands.check_stripe_checkout_identity.'
        'stripe.Account.retrieve',
        return_value={'id': 'acct_otherStripeAccount'},
    ), pytest.raises(CommandError, match='unexpected account'):
        call_command('check_stripe_checkout_identity', stdout=StringIO())


def test_deployment_preflight_requires_the_durable_legacy_cutoff():
    StripeCheckoutRollout.objects.all().delete()
    with patch(
        'dj.apps.ztripe.management.commands.check_stripe_checkout_identity.'
        'stripe.Account.retrieve',
        return_value={'id': TEST_STRIPE_ACCOUNT_ID},
    ), pytest.raises(CommandError, match='cutoff is not safely configured'):
        call_command(
            'check_stripe_checkout_identity',
            require_legacy_cutoff=True,
            stdout=StringIO(),
        )


def test_rollout_check_mode_is_read_only_and_fails_when_uninitialized():
    """`--check` is what cloudbuild.yaml's migrate step triages a failure with.

    It must NEVER create the row: if a failed initializer could be laundered
    into a success by the very check that is supposed to audit it, the deploy
    would proceed on a cutoff stamped at an arbitrary later time, reopening
    the metadata-free trust window a hotfix is not allowed to move.
    """
    StripeCheckoutRollout.objects.all().delete()

    with pytest.raises(CommandError, match='does not exist'):
        call_command(
            'initialize_stripe_checkout_rollout', check=True, stdout=StringIO(),
        )

    assert not StripeCheckoutRollout.objects.exists()


def test_rollout_check_mode_passes_without_touching_an_existing_cutoff():
    StripeCheckoutRollout.objects.all().delete()
    call_command('initialize_stripe_checkout_rollout', stdout=StringIO())
    before = StripeCheckoutRollout.objects.get(singleton=1)

    output = StringIO()
    call_command(
        'initialize_stripe_checkout_rollout', check=True, stdout=output,
    )

    after = StripeCheckoutRollout.objects.get(singleton=1)
    assert 'present' in output.getvalue()
    assert (
        after.legacy_session_created_at_or_before_epoch
        == before.legacy_session_created_at_or_before_epoch
    )
    assert after.initialized_at == before.initialized_at


def test_rollout_initializer_never_advances_the_legacy_cutoff():
    StripeCheckoutRollout.objects.all().delete()
    first = timezone.now()
    with patch(
        'dj.apps.ztripe.management.commands.'
        'initialize_stripe_checkout_rollout.timezone.now',
        return_value=first,
    ):
        call_command('initialize_stripe_checkout_rollout', stdout=StringIO())
    cutoff = StripeCheckoutRollout.objects.get(
        singleton=1,
    ).legacy_session_created_at_or_before_epoch
    assert cutoff == int(first.timestamp()) + 7200

    with patch(
        'dj.apps.ztripe.management.commands.'
        'initialize_stripe_checkout_rollout.timezone.now',
        return_value=first + timedelta(days=30),
    ):
        call_command('initialize_stripe_checkout_rollout', stdout=StringIO())
    assert (
        StripeCheckoutRollout.objects.get(
            singleton=1,
        ).legacy_session_created_at_or_before_epoch
        == cutoff
    )


@pytest.mark.django_db
def test_fractional_quantity_never_creates_an_intent_or_provider_session(
    api_client, creator_factory,
):
    user = creator_factory()
    api_client.force_authenticate(user=user)
    with patch('dj.apps.ztripe.views.stripe.checkout.Session.create') as create:
        response = api_client.post(
            '/api/stripe/create-checkout-session/',
            {'quantity': 1.9},
            format='json',
        )
    assert response.status_code == 400
    assert CheckoutIntent.objects.count() == 0
    create.assert_not_called()


@pytest.mark.django_db
def test_provider_failure_leaves_a_durable_failed_intent(
    api_client, creator_factory,
):
    user = creator_factory()
    api_client.force_authenticate(user=user)
    with patch(
        'dj.apps.ztripe.views.stripe.checkout.Session.create',
        side_effect=stripe.error.APIConnectionError('unavailable'),
    ):
        response = api_client.post(
            '/api/stripe/create-checkout-session/',
            {'quantity': 19, 'currentPath': '/wallet/fund'},
            format='json',
        )

    assert response.status_code == 502
    intent = CheckoutIntent.objects.get()
    assert intent.state == CheckoutIntent.State.PROVIDER_FAILED
    assert intent.tuzis == 19
    assert intent.stripe_checkout_session_id is None


@pytest.mark.django_db
def test_invalid_provider_response_never_opens_the_intent(
    api_client, creator_factory,
):
    user = creator_factory()
    api_client.force_authenticate(user=user)
    with patch('dj.apps.ztripe.views.stripe.checkout.Session.create') as create:
        create.return_value.id = ''
        create.return_value.url = 'javascript:alert(1)'
        create.return_value.mode = 'payment'
        create.return_value.livemode = False
        create.return_value.account = None
        response = api_client.post(
            '/api/stripe/create-checkout-session/',
            {'quantity': 20, 'currentPath': '/wallet/fund'},
            format='json',
        )

    assert response.status_code == 502
    assert CheckoutIntent.objects.get().state == (
        CheckoutIntent.State.PROVIDER_FAILED
    )


@pytest.mark.django_db
def test_realistic_stripe_fragment_is_accepted_but_a_lookalike_host_is_not(
    api_client, creator_factory,
):
    user = creator_factory()
    api_client.force_authenticate(user=user)
    with patch('dj.apps.ztripe.views.stripe.checkout.Session.create') as create:
        create.return_value.id = 'cs_test_hosted_fragment'
        create.return_value.url = (
            'https://checkout.stripe.com/c/pay/cs_test_hosted_fragment'
            '#fidkdWxOYHwnPyd1'
        )
        create.return_value.mode = 'payment'
        create.return_value.livemode = False
        create.return_value.account = None
        good = api_client.post(
            '/api/stripe/create-checkout-session/',
            {'quantity': 20, 'currentPath': '/wallet/fund'},
            format='json',
        )
    assert good.status_code == 200, good.content

    with patch('dj.apps.ztripe.views.stripe.checkout.Session.create') as create:
        create.return_value.id = 'cs_test_lookalike_host'
        create.return_value.url = (
            'https://checkout.stripe.com.attacker.example/c/pay/test'
        )
        create.return_value.mode = 'payment'
        create.return_value.livemode = False
        create.return_value.account = None
        evil = api_client.post(
            '/api/stripe/create-checkout-session/',
            {'quantity': 20, 'currentPath': '/wallet/fund'},
            format='json',
        )

    assert evil.status_code == 502
    assert 'url' not in evil.json()


@pytest.mark.django_db
@pytest.mark.parametrize(
    ('field', 'value'),
    [
        ('mode', 'subscription'),
        ('livemode', True),
        ('account', 'acct_wrongCheckoutAccount'),
    ],
)
def test_provider_session_identity_mismatch_is_hidden_and_expired(
    api_client, creator_factory, field, value,
):
    user = creator_factory()
    api_client.force_authenticate(user=user)
    with patch('dj.apps.ztripe.views.stripe.checkout.Session.create') as create, patch(
        'dj.apps.ztripe.views.stripe.checkout.Session.expire'
    ) as expire_session:
        create.return_value.id = 'cs_test_identity_mismatch'
        create.return_value.url = (
            'https://checkout.stripe.com/c/pay/cs_test_identity_mismatch'
        )
        create.return_value.mode = 'payment'
        create.return_value.livemode = False
        create.return_value.account = None
        setattr(create.return_value, field, value)
        response = api_client.post(
            '/api/stripe/create-checkout-session/',
            {'quantity': 20, 'currentPath': '/wallet/fund'},
            format='json',
        )

    assert response.status_code == 502
    assert 'url' not in response.json()
    assert CheckoutIntent.objects.get().state == (
        CheckoutIntent.State.PROVIDER_FAILED
    )
    expire_session.assert_called_once_with(
        'cs_test_identity_mismatch',
        api_key='sk_test_money_integrity',
        max_network_retries=0,
    )


@pytest.mark.django_db
@pytest.mark.parametrize('quantity', QUANTITIES)
def test_signed_webhook_credits_the_bound_quantity_exactly(
    api_client, client, creator_factory, quantity,
):
    user = creator_factory(tuzis=Decimal('0'))
    response, create_args = start_checkout(
        api_client, user, quantity, suffix=f'fulfill{quantity}',
    )
    assert response.status_code == 200
    payload = completed_payload(
        user=user,
        metadata=create_args['metadata'],
        quantity=quantity,
        event_id=f'evt_test_fulfill_{quantity}',
        session_id=f'cs_test_fulfill{quantity}',
        payment_intent=f'pi_test_fulfill_{quantity}',
    )

    fulfilled = post_signed(client, payload)

    assert fulfilled.status_code == 200, fulfilled.content
    assert balance(user) == Decimal(quantity)
    stripe_transaction = StripeTransaction.objects.get(
        stripe_charge_id=f'pi_test_fulfill_{quantity}'
    )
    # The charge/credit round trip, end to end and in exact cents: what Stripe
    # was told to bill, what the buyer was quoted, and what was credited.
    assert stripe_transaction.amount == EXPECTED_CHARGE_CENTS[quantity]
    assert stripe_transaction.amount == card_charge_cents(quantity)
    assert stripe_transaction.amount == (
        create_args['line_items'][0]['price_data']['unit_amount']
    )
    assert stripe_transaction.tuzis_credited == quantity
    intent = CheckoutIntent.objects.get(
        public_id=response.json()['quote']['checkout_intent_id']
    )
    assert intent.state == CheckoutIntent.State.FULFILLED
    assert intent.stripe_payment_intent_id == f'pi_test_fulfill_{quantity}'
    audit = CheckoutFulfillmentAudit.objects.get(
        provider_event_id=f'evt_test_fulfill_{quantity}'
    )
    assert audit.outcome == CheckoutFulfillmentAudit.Outcome.CREDITED
    assert audit.stripe_transaction_id == stripe_transaction.pk
    assert audit.expected_stripe_account_id == TEST_STRIPE_ACCOUNT_ID
    assert audit.expected_stripe_mode == 'payment'
    assert audit.expected_stripe_livemode is False
    assert audit.received_event_account_id == ''
    assert audit.received_session_created_epoch == LEGACY_SESSION_CREATED
    assert audit.received_stripe_mode == 'payment'
    assert audit.received_stripe_livemode is False
    assert audit.received_event_livemode is False
    assert audit.received_metadata_account_id == TEST_STRIPE_ACCOUNT_ID


@pytest.mark.django_db
@pytest.mark.parametrize(
    ('mutation', 'value'),
    [
        ('amount_total', 999),
        ('currency', 'eur'),
        ('client_reference_id', '999999'),
        ('payment_status', 'unpaid'),
        ('mode', 'subscription'),
        ('livemode', True),
        ('event.livemode', True),
        ('event.account', 'acct_wrongConnectedAccount'),
        ('metadata.tuzis', '101'),
        ('metadata.amount_cents', '999'),
        ('metadata.currency', 'eur'),
        ('metadata.pricing_version', 'card-v999'),
        ('metadata.user_id', '999999'),
        ('metadata.stripe_account_id', 'acct_wrongMetadataAccount'),
        ('metadata.stripe_mode', 'subscription'),
        ('metadata.stripe_livemode', 'true'),
        ('metadata.checkout_intent_id', str(uuid.UUID(int=0))),
    ],
)
def test_signed_but_mismatched_contract_fails_closed_and_is_audited(
    api_client, client, creator_factory, mutation, value,
):
    user = creator_factory(tuzis=Decimal('0'))
    response, create_args = start_checkout(api_client, user, 100)
    assert response.status_code == 200
    event = json.loads(completed_payload(
        user=user,
        metadata=create_args['metadata'],
        quantity=100,
        event_id=f'evt_test_reject_{mutation.replace(".", "_")}',
    ))
    target = event['data']['object']
    if mutation.startswith('metadata.'):
        target['metadata'][mutation.split('.', 1)[1]] = value
    elif mutation.startswith('event.'):
        event[mutation.split('.', 1)[1]] = value
    else:
        target[mutation] = value
    payload = json.dumps(event)

    rejected = post_signed(client, payload)

    assert rejected.status_code == 400, rejected.content
    assert balance(user) == Decimal('0')
    assert StripeTransaction.objects.count() == 0
    audit = CheckoutFulfillmentAudit.objects.get()
    assert audit.outcome == CheckoutFulfillmentAudit.Outcome.REJECTED


@pytest.mark.django_db
def test_partial_authoritative_metadata_cannot_downgrade_to_legacy(
    client, creator_factory,
):
    user = creator_factory(tuzis=Decimal('0'))
    payload = completed_payload(
        user=user,
        metadata={'tuzis': '100'},
        quantity=100,
        event_id='evt_test_partial_metadata',
    )
    response = post_signed(client, payload)
    assert response.status_code == 400
    assert balance(user) == Decimal('0')
    assert CheckoutFulfillmentAudit.objects.get().reason == (
        'partial_authoritative_metadata'
    )


@pytest.mark.django_db
def test_signed_event_without_a_session_creation_time_cannot_credit(
    api_client, client, creator_factory,
):
    user = creator_factory(tuzis=Decimal('0'))
    _, create_args = start_checkout(api_client, user, 21)
    event = json.loads(completed_payload(
        user=user,
        metadata=create_args['metadata'],
        quantity=21,
        event_id='evt_test_missing_session_created',
        payment_intent='pi_test_missing_session_created',
    ))
    del event['data']['object']['created']

    response = post_signed(client, json.dumps(event))

    assert response.status_code == 400
    assert balance(user) == Decimal('0')
    assert StripeTransaction.objects.count() == 0
    assert CheckoutFulfillmentAudit.objects.get().reason == (
        'session_created_invalid'
    )


@pytest.mark.django_db
def test_webhook_identity_configuration_failure_is_retryable_and_mints_nothing(
    client, creator_factory, settings,
):
    settings.STRIPE_EXPECTED_ACCOUNT_ID = ''
    user = creator_factory(tuzis=Decimal('0'))
    payload = completed_payload(
        user=user,
        metadata={},
        quantity=100,
        event_id='evt_test_identity_not_configured',
    )

    response = post_signed(client, payload)

    assert response.status_code == 503
    assert balance(user) == Decimal('0')
    assert StripeTransaction.objects.count() == 0
    assert CheckoutFulfillmentAudit.objects.count() == 0


@pytest.mark.django_db
def test_signed_exact_event_account_identity_is_accepted_and_audited(
    api_client, client, creator_factory,
):
    user = creator_factory(tuzis=Decimal('0'))
    _, create_args = start_checkout(api_client, user, 21)
    payload = completed_payload(
        user=user,
        metadata=create_args['metadata'],
        quantity=21,
        event_id='evt_test_exact_event_account',
        payment_intent='pi_test_exact_event_account',
        event_account=TEST_STRIPE_ACCOUNT_ID,
    )

    response = post_signed(client, payload)

    assert response.status_code == 200
    assert balance(user) == Decimal('21')
    assert CheckoutFulfillmentAudit.objects.get().received_event_account_id == (
        TEST_STRIPE_ACCOUNT_ID
    )


@pytest.mark.django_db
@pytest.mark.parametrize(
    ('mutation', 'value'),
    [
        ('mode', 'subscription'),
        ('livemode', True),
        ('event_livemode', True),
        ('event_account', 'acct_wrongLegacyAccount'),
    ],
)
def test_legacy_fulfillment_still_requires_signed_provider_identity(
    client, creator_factory, mutation, value,
):
    user = creator_factory(tuzis=Decimal('0'))
    kwargs = {
        'user': user,
        'metadata': {},
        'quantity': 100,
        'event_id': f'evt_test_legacy_identity_{mutation}',
        'payment_intent': f'pi_test_legacy_identity_{mutation}',
        'amount_total': 205,
    }
    if mutation == 'event_livemode':
        event = json.loads(completed_payload(**kwargs))
        event['livemode'] = value
        payload = json.dumps(event)
    else:
        kwargs[mutation] = value
        payload = completed_payload(**kwargs)

    response = post_signed(client, payload)

    assert response.status_code == 400
    assert balance(user) == Decimal('0')
    assert CheckoutFulfillmentAudit.objects.get().reason == (
        'provider_identity_mismatch'
    )


@pytest.mark.django_db
def test_exact_intent_from_a_different_configured_account_cannot_credit(
    api_client, client, creator_factory,
):
    user = creator_factory(tuzis=Decimal('0'))
    _, create_args = start_checkout(api_client, user, 21)
    intent = CheckoutIntent.objects.get()
    intent.stripe_account_id = 'acct_oldUnexpectedAccount'
    intent.save(update_fields=['stripe_account_id', 'updated_at'])
    metadata = {
        **create_args['metadata'],
        'stripe_account_id': intent.stripe_account_id,
    }
    payload = completed_payload(
        user=user,
        metadata=metadata,
        quantity=21,
        event_id='evt_test_intent_account_drift',
        payment_intent='pi_test_intent_account_drift',
    )

    response = post_signed(client, payload)

    assert response.status_code == 400
    assert balance(user) == Decimal('0')
    assert CheckoutFulfillmentAudit.objects.get().reason == (
        'intent_provider_identity_mismatch'
    )


@pytest.mark.django_db
def test_rejected_event_can_succeed_after_configuration_is_restored(
    api_client, client, creator_factory, settings,
):
    user = creator_factory(tuzis=Decimal('0'))
    _, create_args = start_checkout(api_client, user, 21)
    intent = CheckoutIntent.objects.get()
    payload = completed_payload(
        user=user,
        metadata=create_args['metadata'],
        quantity=21,
        event_id='evt_test_configuration_restored',
        payment_intent='pi_test_configuration_restored',
    )

    settings.STRIPE_EXPECTED_ACCOUNT_ID = 'acct_transientWrongAccount'
    assert post_signed(client, payload).status_code == 400
    assert balance(user) == Decimal('0')
    rejected = CheckoutFulfillmentAudit.objects.get(
        provider_event_id='evt_test_configuration_restored',
        outcome=CheckoutFulfillmentAudit.Outcome.REJECTED,
    )
    assert rejected.reason == 'intent_provider_identity_mismatch'

    settings.STRIPE_EXPECTED_ACCOUNT_ID = TEST_STRIPE_ACCOUNT_ID
    assert post_signed(client, payload).status_code == 200
    assert balance(user) == Decimal('21')
    successful = CheckoutFulfillmentAudit.objects.get(
        provider_event_id='evt_test_configuration_restored',
        outcome=CheckoutFulfillmentAudit.Outcome.CREDITED,
    )
    assert successful.stripe_transaction_id is not None
    assert successful.idempotency_key != rejected.idempotency_key
    with pytest.raises(IntegrityError), transaction.atomic():
        CheckoutFulfillmentAudit.objects.create(
            idempotency_key='stripe-decision:duplicate-success-control',
            provider_event_id='evt_test_configuration_restored',
            intent=intent,
            stripe_transaction=successful.stripe_transaction,
            outcome=CheckoutFulfillmentAudit.Outcome.DUPLICATE,
            reason='exact_intent',
            received_session_created_epoch=LEGACY_SESSION_CREATED,
            expected_stripe_account_id=TEST_STRIPE_ACCOUNT_ID,
            expected_stripe_mode='payment',
            expected_stripe_livemode=False,
        )

    output = StringIO()
    call_command(
        'reconcile_stripe_fulfillment',
        legacy_before=(intent.created_at - timedelta(seconds=1)).isoformat(),
        fail_on_drift=True,
        stdout=output,
    )
    assert 'intent_drift=0' in output.getvalue()
    assert 'identity_drift=0' in output.getvalue()


@pytest.mark.django_db
def test_invalid_event_id_cannot_credit_even_with_an_exact_signed_contract(
    api_client, client, creator_factory,
):
    user = creator_factory(tuzis=Decimal('0'))
    _, create_args = start_checkout(api_client, user, 21)
    event = json.loads(completed_payload(
        user=user,
        metadata=create_args['metadata'],
        quantity=21,
    ))
    event['id'] = '../not-a-stripe-event'

    response = post_signed(client, json.dumps(event))

    assert response.status_code == 400
    assert balance(user) == Decimal('0')
    assert StripeTransaction.objects.count() == 0
    assert CheckoutFulfillmentAudit.objects.get().reason == (
        'invalid_provider_event_id'
    )


@pytest.mark.django_db
def test_same_and_distinct_event_replays_credit_once_and_remain_auditable(
    api_client, client, creator_factory,
):
    user = creator_factory(tuzis=Decimal('0'))
    _, create_args = start_checkout(api_client, user, 21)
    payload = completed_payload(
        user=user,
        metadata=create_args['metadata'],
        quantity=21,
        event_id='evt_test_replay_one',
        payment_intent='pi_test_replay_one',
    )
    assert post_signed(client, payload).status_code == 200
    assert post_signed(client, payload).status_code == 200
    first = CheckoutFulfillmentAudit.objects.get(
        provider_event_id='evt_test_replay_one'
    )
    first.refresh_from_db()
    assert first.outcome == CheckoutFulfillmentAudit.Outcome.CREDITED
    assert first.attempts == 2

    second_event = json.loads(payload)
    second_event['id'] = 'evt_test_replay_two'
    second_payload = json.dumps(second_event)
    assert post_signed(client, second_payload).status_code == 200
    assert balance(user) == Decimal('21')
    assert CheckoutFulfillmentAudit.objects.get(
        provider_event_id='evt_test_replay_two'
    ).outcome == CheckoutFulfillmentAudit.Outcome.DUPLICATE


@pytest.mark.django_db
@pytest.mark.parametrize(
    ('quantity', 'historical_cents'),
    [(1, 101), (2, 102), (19, 119), (20, 121), (21, 122),
     (100, 205), (2000, 2200)],
)
def test_predeployment_session_credits_exact_historical_quantity(
    client, creator_factory, quantity, historical_cents,
):
    user = creator_factory(tuzis=Decimal('0'))
    payload = completed_payload(
        user=user,
        metadata={},
        quantity=quantity,
        event_id=f'evt_test_legacy_{quantity}',
        payment_intent=f'pi_test_legacy_{quantity}',
        amount_total=historical_cents,
    )
    response = post_signed(client, payload)
    assert response.status_code == 200, response.content
    assert balance(user) == Decimal(quantity)
    assert StripeTransaction.objects.get(
        stripe_charge_id=f'pi_test_legacy_{quantity}'
    ).tuzis_credited == quantity
    audit = CheckoutFulfillmentAudit.objects.get(
        provider_event_id=f'evt_test_legacy_{quantity}'
    )
    assert audit.received_session_created_epoch == LEGACY_SESSION_CREATED
    assert (
        audit.expected_legacy_session_created_at_or_before_epoch
        == LEGACY_CUTOFF_EPOCH
    )


@pytest.mark.django_db
def test_impossible_legacy_amount_is_rejected_without_credit(
    client, creator_factory,
):
    user = creator_factory(tuzis=Decimal('0'))
    payload = completed_payload(
        user=user,
        metadata={},
        quantity=19,
        event_id='evt_test_legacy_impossible',
        payment_intent='pi_test_legacy_impossible',
        amount_total=120,
    )

    response = post_signed(client, payload)

    assert response.status_code == 400
    assert balance(user) == Decimal('0')
    assert StripeTransaction.objects.count() == 0
    assert CheckoutFulfillmentAudit.objects.get().reason == (
        'legacy_amount_not_exact'
    )


@pytest.mark.django_db
def test_legacy_fulfillment_requires_an_initialized_deployment_cutoff(
    client, creator_factory,
):
    StripeCheckoutRollout.objects.all().delete()
    user = creator_factory(tuzis=Decimal('0'))
    payload = completed_payload(
        user=user,
        metadata={},
        quantity=21,
        event_id='evt_test_legacy_cutoff_config',
        payment_intent='pi_test_legacy_cutoff_config',
        amount_total=122,
    )

    response = post_signed(client, payload)

    assert response.status_code == 503
    assert balance(user) == Decimal('0')
    assert StripeTransaction.objects.count() == 0
    assert CheckoutFulfillmentAudit.objects.count() == 0


@pytest.mark.django_db
def test_legacy_session_in_the_inclusive_cutoff_second_credits(
    client, creator_factory,
):
    user = creator_factory(tuzis=Decimal('0'))
    payload = completed_payload(
        user=user,
        metadata={},
        quantity=21,
        event_id='evt_test_legacy_in_cutoff_second',
        payment_intent='pi_test_legacy_in_cutoff_second',
        amount_total=122,
        session_created=LEGACY_CUTOFF_EPOCH,
    )

    response = post_signed(client, payload)

    assert response.status_code == 200
    assert balance(user) == Decimal('21')
    audit = CheckoutFulfillmentAudit.objects.get()
    assert audit.received_session_created_epoch == LEGACY_CUTOFF_EPOCH
    assert (
        audit.expected_legacy_session_created_at_or_before_epoch
        == LEGACY_CUTOFF_EPOCH
    )


@pytest.mark.django_db
def test_legacy_session_after_the_inclusive_cutoff_cannot_credit(
    client, creator_factory,
):
    user = creator_factory(tuzis=Decimal('0'))
    payload = completed_payload(
        user=user,
        metadata={},
        quantity=21,
        event_id='evt_test_legacy_after_cutoff',
        payment_intent='pi_test_legacy_after_cutoff',
        amount_total=122,
        session_created=LEGACY_CUTOFF_EPOCH + 1,
    )

    response = post_signed(client, payload)

    assert response.status_code == 400
    assert balance(user) == Decimal('0')
    assert StripeTransaction.objects.count() == 0
    audit = CheckoutFulfillmentAudit.objects.get()
    assert audit.reason == 'legacy_session_after_cutoff'
    assert audit.received_session_created_epoch == LEGACY_CUTOFF_EPOCH + 1
    assert (
        audit.expected_legacy_session_created_at_or_before_epoch
        == LEGACY_CUTOFF_EPOCH
    )


@pytest.mark.django_db
def test_credit_marker_ledger_event_and_audit_roll_back_together(
    api_client, client, creator_factory,
):
    user = creator_factory(tuzis=Decimal('0'))
    _, create_args = start_checkout(api_client, user, 100)
    payload = completed_payload(
        user=user,
        metadata=create_args['metadata'],
        quantity=100,
        event_id='evt_test_atomic_failure',
        payment_intent='pi_test_atomic_failure',
    )

    with patch(
        'dj.apps.ztripe.fulfillment.Event.objects.create',
        side_effect=RuntimeError('simulated event failure'),
    ), pytest.raises(RuntimeError, match='simulated event failure'):
        post_signed(client, payload)

    assert balance(user) == Decimal('0')
    assert StripeTransaction.objects.count() == 0
    assert CheckoutFulfillmentAudit.objects.count() == 0
    intent = CheckoutIntent.objects.get()
    assert intent.state == CheckoutIntent.State.OPEN

    assert post_signed(client, payload).status_code == 200
    assert balance(user) == Decimal('100')


@pytest.mark.django_db(transaction=True)
def test_concurrent_duplicate_delivery_credits_once(
    api_client, creator_factory,
):
    user = creator_factory(tuzis=Decimal('0'))
    _, create_args = start_checkout(api_client, user, 100)
    payload = completed_payload(
        user=user,
        metadata=create_args['metadata'],
        quantity=100,
        event_id='evt_test_concurrent',
        payment_intent='pi_test_concurrent',
    )

    def deliver():
        close_old_connections()
        try:
            return post_signed(Client(), payload).status_code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(lambda _: deliver(), range(2)))

    assert statuses == [200, 200]
    assert balance(user) == Decimal('100')
    assert StripeTransaction.objects.filter(
        stripe_charge_id='pi_test_concurrent'
    ).count() == 1
    audit = CheckoutFulfillmentAudit.objects.get(
        provider_event_id='evt_test_concurrent'
    )
    assert audit.attempts == 2


@pytest.mark.django_db
def test_reconciliation_reports_legacy_drift_but_refuses_unprovable_repair(
    creator_factory,
):
    user = creator_factory(tuzis=Decimal('0'))
    row = StripeTransaction.objects.create(
        user=user,
        amount=101,
        tuzis_credited=0,
        stripe_charge_id='pi_legacy_undercredit',
    )
    output = StringIO()
    with pytest.raises(CommandError):
        call_command(
            'reconcile_stripe_fulfillment',
            fail_on_drift=True,
            stdout=output,
        )
    assert 'undercredited' in output.getvalue()
    assert balance(user) == Decimal('0')

    with pytest.raises(CommandError, match='automatic legacy repair is disabled'):
        call_command(
            'reconcile_stripe_fulfillment',
            repair=True,
            legacy_before=(timezone.now() + timedelta(minutes=1)).isoformat(),
            stdout=StringIO(),
        )
    row.refresh_from_db()
    assert row.tuzis_credited == 0
    assert balance(user) == Decimal('0')
    assert CheckoutFulfillmentAudit.objects.count() == 0


@pytest.mark.django_db
def test_reconciliation_does_not_mutate_unprovable_or_overcredited_rows(
    creator_factory,
):
    user = creator_factory(tuzis=Decimal('0'))
    invalid = StripeTransaction.objects.create(
        user=user,
        amount=120,
        tuzis_credited=0,
        stripe_charge_id='pi_legacy_invalid',
    )
    overcredited = StripeTransaction.objects.create(
        user=user,
        amount=101,
        tuzis_credited=2,
        stripe_charge_id='pi_legacy_overcredited',
    )

    with pytest.raises(CommandError, match='automatic legacy repair is disabled'):
        call_command(
            'reconcile_stripe_fulfillment',
            repair=True,
            legacy_before=(
                timezone.now() + timedelta(minutes=1)
            ).isoformat(),
            fail_on_drift=True,
            stdout=StringIO(),
        )

    invalid.refresh_from_db()
    overcredited.refresh_from_db()
    assert invalid.tuzis_credited == 0
    assert overcredited.tuzis_credited == 2
    assert balance(user) == Decimal('0')
    assert CheckoutFulfillmentAudit.objects.count() == 0
@pytest.mark.django_db
def test_reconciliation_reports_fulfilled_intent_drift(
    creator_factory,
):
    user = creator_factory(tuzis=Decimal('0'))
    intent = CheckoutIntent.objects.create(
        user=user,
        tuzis=100,
        amount_cents=205,
        currency='usd',
        pricing_version='card-v2',
        stripe_account_id=TEST_STRIPE_ACCOUNT_ID,
        stripe_mode='payment',
        stripe_livemode=False,
        stripe_checkout_session_id='cs_test_drift',
        stripe_payment_intent_id='pi_test_drift',
        state=CheckoutIntent.State.FULFILLED,
        fulfilled_at=timezone.now(),
    )
    StripeTransaction.objects.create(
        user=user,
        amount=205,
        tuzis_credited=99,
        stripe_charge_id='pi_test_drift',
    )
    output = StringIO()

    with pytest.raises(CommandError, match='unresolved Stripe drift'):
        call_command(
            'reconcile_stripe_fulfillment',
            legacy_before=(intent.created_at - timedelta(seconds=1)).isoformat(),
            fail_on_drift=True,
            stdout=output,
        )

    assert f'intent-drift intent={intent.public_id}' in output.getvalue()


@pytest.mark.django_db
def test_reconciliation_does_not_combine_split_audit_evidence(
    creator_factory,
):
    user = creator_factory(tuzis=Decimal('0'))
    intent = CheckoutIntent.objects.create(
        user=user,
        tuzis=100,
        amount_cents=205,
        currency='usd',
        pricing_version='card-v2',
        stripe_account_id='acct_oldUnexpectedAccount',
        stripe_mode='payment',
        stripe_livemode=False,
        stripe_checkout_session_id='cs_test_identity_drift',
        stripe_payment_intent_id='pi_test_identity_drift',
        state=CheckoutIntent.State.FULFILLED,
        fulfilled_at=timezone.now(),
    )
    row = StripeTransaction.objects.create(
        user=user,
        amount=205,
        tuzis_credited=100,
        stripe_charge_id='pi_test_identity_drift',
    )
    CheckoutFulfillmentAudit.objects.create(
        idempotency_key='stripe-event:evt_test_identity_drift',
        provider_event_id='evt_test_identity_drift',
        intent=intent,
        stripe_transaction=row,
        outcome=CheckoutFulfillmentAudit.Outcome.CREDITED,
        reason='exact_intent',
        received_checkout_session_id='cs_test_identity_drift',
        received_payment_intent_id='pi_test_identity_drift',
        received_session_created_epoch=LEGACY_SESSION_CREATED,
        received_user_id=user.pk,
        received_tuzis=100,
        received_amount_cents=205,
        received_currency='usd',
        received_pricing_version='card-v2',
        expected_stripe_account_id='acct_oldUnexpectedAccount',
        expected_stripe_mode='payment',
        expected_stripe_livemode=False,
        received_stripe_mode='payment',
        received_stripe_livemode=False,
        received_event_livemode=False,
        received_metadata_account_id='acct_tamperedAuditAccount',
        received_metadata_mode='payment',
        received_metadata_livemode=False,
    )
    CheckoutFulfillmentAudit.objects.create(
        idempotency_key='stripe-event:evt_test_contract_drift',
        provider_event_id='evt_test_contract_drift',
        intent=intent,
        stripe_transaction=row,
        outcome=CheckoutFulfillmentAudit.Outcome.DUPLICATE,
        reason='exact_intent',
        received_checkout_session_id='cs_test_identity_drift',
        received_payment_intent_id='pi_test_identity_drift',
        received_session_created_epoch=LEGACY_SESSION_CREATED,
        received_user_id=user.pk,
        received_tuzis=100,
        received_amount_cents=999,
        received_currency='usd',
        received_pricing_version='card-v2',
        expected_stripe_account_id='acct_oldUnexpectedAccount',
        expected_stripe_mode='payment',
        expected_stripe_livemode=False,
        received_stripe_mode='payment',
        received_stripe_livemode=False,
        received_event_livemode=False,
        received_metadata_account_id='acct_oldUnexpectedAccount',
        received_metadata_mode='payment',
        received_metadata_livemode=False,
    )
    output = StringIO()

    with pytest.raises(CommandError, match='unresolved Stripe drift'):
        call_command(
            'reconcile_stripe_fulfillment',
            legacy_before=(intent.created_at - timedelta(seconds=1)).isoformat(),
            fail_on_drift=True,
            stdout=output,
        )

    assert f'intent-evidence-drift intent={intent.public_id}' in output.getvalue()
    assert 'evidence_drift=1' in output.getvalue()
    assert 'identity_drift=0' in output.getvalue()
    assert 'intent_drift=0' in output.getvalue()


@pytest.mark.django_db
def test_reconciliation_requires_audit_to_link_the_exact_transaction(
    creator_factory,
):
    user = creator_factory(tuzis=Decimal('0'))
    intent = CheckoutIntent.objects.create(
        user=user,
        tuzis=100,
        amount_cents=205,
        currency='usd',
        pricing_version='card-v2',
        stripe_account_id=TEST_STRIPE_ACCOUNT_ID,
        stripe_mode='payment',
        stripe_livemode=False,
        stripe_checkout_session_id='cs_test_audit_transaction_link',
        stripe_payment_intent_id='pi_test_audit_transaction_link',
        state=CheckoutIntent.State.FULFILLED,
        fulfilled_at=timezone.now(),
    )
    StripeTransaction.objects.create(
        user=user,
        amount=205,
        tuzis_credited=100,
        stripe_charge_id='pi_test_audit_transaction_link',
    )
    wrong_row = StripeTransaction.objects.create(
        user=user,
        amount=205,
        tuzis_credited=100,
        stripe_charge_id='pi_test_other_transaction',
    )
    CheckoutFulfillmentAudit.objects.create(
        idempotency_key='stripe-event:evt_test_wrong_transaction_link',
        provider_event_id='evt_test_wrong_transaction_link',
        intent=intent,
        stripe_transaction=wrong_row,
        outcome=CheckoutFulfillmentAudit.Outcome.CREDITED,
        reason='exact_intent',
        received_checkout_session_id='cs_test_audit_transaction_link',
        received_payment_intent_id='pi_test_audit_transaction_link',
        received_session_created_epoch=LEGACY_SESSION_CREATED,
        received_user_id=user.pk,
        received_tuzis=100,
        received_amount_cents=205,
        received_currency='usd',
        received_pricing_version='card-v2',
        expected_stripe_account_id=TEST_STRIPE_ACCOUNT_ID,
        expected_stripe_mode='payment',
        expected_stripe_livemode=False,
        received_stripe_mode='payment',
        received_stripe_livemode=False,
        received_event_livemode=False,
        received_metadata_account_id=TEST_STRIPE_ACCOUNT_ID,
        received_metadata_mode='payment',
        received_metadata_livemode=False,
    )
    output = StringIO()

    with pytest.raises(CommandError, match='unresolved Stripe drift'):
        call_command(
            'reconcile_stripe_fulfillment',
            legacy_before=(intent.created_at - timedelta(seconds=1)).isoformat(),
            fail_on_drift=True,
            stdout=output,
        )

    assert f'intent-drift intent={intent.public_id}' in output.getvalue()
    assert f'intent-evidence-drift intent={intent.public_id}' in output.getvalue()
    assert 'intent_drift=1' in output.getvalue()
    assert 'evidence_drift=1' in output.getvalue()


@pytest.mark.django_db
def test_reconciliation_preserves_consistent_historical_account_identity(
    creator_factory,
):
    user = creator_factory(tuzis=Decimal('0'))
    old_account = 'acct_historicalAccount'
    intent = CheckoutIntent.objects.create(
        user=user,
        tuzis=100,
        amount_cents=205,
        currency='usd',
        pricing_version='card-v2',
        stripe_account_id=old_account,
        stripe_mode='payment',
        stripe_livemode=False,
        stripe_checkout_session_id='cs_test_historical_identity',
        stripe_payment_intent_id='pi_test_historical_identity',
        state=CheckoutIntent.State.FULFILLED,
        fulfilled_at=timezone.now(),
    )
    row = StripeTransaction.objects.create(
        user=user,
        amount=205,
        tuzis_credited=100,
        stripe_charge_id='pi_test_historical_identity',
    )
    CheckoutFulfillmentAudit.objects.create(
        idempotency_key='stripe-event:evt_test_historical_identity',
        provider_event_id='evt_test_historical_identity',
        intent=intent,
        stripe_transaction=row,
        outcome=CheckoutFulfillmentAudit.Outcome.CREDITED,
        reason='exact_intent',
        received_checkout_session_id='cs_test_historical_identity',
        received_payment_intent_id='pi_test_historical_identity',
        received_session_created_epoch=LEGACY_SESSION_CREATED,
        received_user_id=user.pk,
        received_tuzis=100,
        received_amount_cents=205,
        received_currency='usd',
        received_pricing_version='card-v2',
        expected_stripe_account_id=old_account,
        expected_stripe_mode='payment',
        expected_stripe_livemode=False,
        received_stripe_mode='payment',
        received_stripe_livemode=False,
        received_event_livemode=False,
        received_metadata_account_id=old_account,
        received_metadata_mode='payment',
        received_metadata_livemode=False,
    )
    output = StringIO()

    call_command(
        'reconcile_stripe_fulfillment',
        legacy_before=(intent.created_at - timedelta(seconds=1)).isoformat(),
        fail_on_drift=True,
        stdout=output,
    )

    assert 'identity_drift=0' in output.getvalue()
    assert 'intent_drift=0' in output.getvalue()


@pytest.mark.django_db
def test_database_rejects_a_fulfilled_intent_without_provider_evidence(
    creator_factory,
):
    user = creator_factory()
    with pytest.raises(IntegrityError), transaction.atomic():
        CheckoutIntent.objects.create(
            user=user,
            tuzis=1,
            amount_cents=102,
            currency='usd',
            pricing_version='card-v2',
            stripe_account_id=TEST_STRIPE_ACCOUNT_ID,
            stripe_mode='payment',
            stripe_livemode=False,
            state=CheckoutIntent.State.FULFILLED,
        )


@pytest.mark.django_db
def test_database_rejects_legacy_success_without_cutoff_evidence(
    creator_factory,
):
    user = creator_factory()
    row = StripeTransaction.objects.create(
        user=user,
        amount=122,
        tuzis_credited=21,
        stripe_charge_id='pi_test_missing_legacy_cutoff_evidence',
    )
    with pytest.raises(IntegrityError), transaction.atomic():
        CheckoutFulfillmentAudit.objects.create(
            idempotency_key='stripe-event:evt_test_missing_legacy_cutoff',
            provider_event_id='evt_test_missing_legacy_cutoff',
            stripe_transaction=row,
            outcome=CheckoutFulfillmentAudit.Outcome.CREDITED,
            reason='legacy_exact',
            received_session_created_epoch=LEGACY_SESSION_CREATED,
            expected_stripe_account_id=TEST_STRIPE_ACCOUNT_ID,
            expected_stripe_mode='payment',
            expected_stripe_livemode=False,
        )


@pytest.mark.django_db
def test_repair_is_refused_even_with_no_durable_intents(creator_factory):
    creator_factory()
    with pytest.raises(CommandError, match='automatic legacy repair is disabled'):
        call_command('reconcile_stripe_fulfillment', repair=True)


@pytest.mark.django_db
def test_cutoff_cannot_cross_the_first_durable_intent(creator_factory):
    user = creator_factory()
    intent = CheckoutIntent.objects.create(
        user=user,
        tuzis=1,
        amount_cents=102,
        currency='usd',
        pricing_version='card-v2',
        stripe_account_id=TEST_STRIPE_ACCOUNT_ID,
        stripe_mode='payment',
        stripe_livemode=False,
    )

    with pytest.raises(CommandError, match='later than the first'):
        call_command(
            'reconcile_stripe_fulfillment',
            legacy_before=(intent.created_at + timedelta(seconds=1)).isoformat(),
        )


@pytest.mark.django_db
def test_post_cutoff_unlinked_v2_transaction_is_flagged_not_repaired(
    creator_factory,
):
    user = creator_factory(tuzis=Decimal('2'))
    row = StripeTransaction.objects.create(
        user=user,
        amount=102,
        tuzis_credited=1,
        stripe_charge_id='pi_v2_fulfilled_by_old_pod',
    )
    cutoff = (row.timestamp - timedelta(seconds=1)).isoformat()
    output = StringIO()

    with pytest.raises(CommandError, match='unresolved Stripe drift'):
        call_command(
            'reconcile_stripe_fulfillment',
            legacy_before=cutoff,
            fail_on_drift=True,
            stdout=output,
        )

    row.refresh_from_db()
    assert row.tuzis_credited == 1
    assert balance(user) == Decimal('2')
    assert 'post_cutoff_unlinked=1' in output.getvalue()
    assert CheckoutFulfillmentAudit.objects.count() == 0


@pytest.mark.django_db
def test_stale_nonfinal_intent_is_an_unresolved_reconciliation_finding(
    creator_factory,
):
    user = creator_factory()
    intent = CheckoutIntent.objects.create(
        user=user,
        tuzis=21,
        amount_cents=123,
        currency='usd',
        pricing_version='card-v2',
        stripe_account_id=TEST_STRIPE_ACCOUNT_ID,
        stripe_mode='payment',
        stripe_livemode=False,
        stripe_checkout_session_id='cs_test_stale',
        state=CheckoutIntent.State.OPEN,
    )
    CheckoutIntent.objects.filter(pk=intent.pk).update(
        created_at=timezone.now() - timedelta(minutes=61),
    )
    intent.refresh_from_db()
    output = StringIO()

    with pytest.raises(CommandError, match='unresolved Stripe drift'):
        call_command(
            'reconcile_stripe_fulfillment',
            legacy_before=(intent.created_at - timedelta(seconds=1)).isoformat(),
            fail_on_drift=True,
            stdout=output,
        )

    assert 'stale_intents=1' in output.getvalue()
