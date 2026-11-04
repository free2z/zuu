"""Provider-backed activation contract for exact Stripe checkout."""

from copy import deepcopy
from datetime import timedelta
from unittest.mock import patch

import pytest
from django.utils import timezone

from dj.apps.ztripe.models import StripeWebhookReadiness
from dj.apps.ztripe.stripe_identity import configured_stripe_identity
from dj.apps.ztripe.webhook_readiness import (
    StripeWebhookEndpointMismatch,
    StripeWebhookReadinessError,
    prove_webhook_endpoint,
    verify_and_record_checkout_event,
    verify_and_record_readiness_canary,
    webhook_is_ready,
)


def _event(amount=122):
    return {
        'id': 'evt_test_readiness',
        'type': 'checkout.session.completed',
        'livemode': False,
        'data': {'object': {
            'id': 'cs_test_readiness',
            'created': 1_700_000_000,
            'client_reference_id': '7',
            'payment_status': 'paid',
            'mode': 'payment',
            'livemode': False,
            'amount_total': amount,
            'currency': 'usd',
            'payment_intent': 'pi_test_readiness',
            'metadata': {},
        }},
    }


def _canary_event():
    return {
        'id': 'evt_test_readiness_canary',
        'type': 'customer.created',
        'livemode': False,
        'data': {'object': {
            'id': 'cus_test_readiness_canary',
            'object': 'customer',
            'livemode': False,
        }},
    }


@pytest.fixture
def identity_settings(settings):
    settings.STRIPE_SECRET_KEY = 'sk_test_readiness_secret'
    settings.STRIPE_SIGNING_SECRET = 'whsec_readiness_secret'
    settings.STRIPE_EXPECTED_ACCOUNT_ID = 'acct_testReadiness'
    settings.STRIPE_EXPECTED_LIVEMODE = 'false'
    settings.STRIPE_WEBHOOK_ENDPOINT_ID = 'we_testReadiness'
    return configured_stripe_identity()


@pytest.mark.django_db
def test_retrieved_signed_checkout_event_binds_current_keys_without_storing_them(
    settings, identity_settings,
):
    event = _event()
    with patch(
        'dj.apps.ztripe.webhook_readiness.stripe.Event.retrieve',
        return_value=deepcopy(event),
    ) as retrieve:
        verify_and_record_checkout_event(event, identity_settings)

    retrieve.assert_called_once_with(
        'evt_test_readiness',
        api_key='sk_test_readiness_secret',
        max_network_retries=0,
    )
    readiness = StripeWebhookReadiness.objects.get(singleton=1)
    assert readiness.stripe_account_id == 'acct_testReadiness'
    assert readiness.webhook_endpoint_id == 'we_testReadiness'
    assert 'readiness_secret' not in readiness.secret_key_fingerprint
    assert 'readiness_secret' not in readiness.signing_secret_fingerprint
    assert webhook_is_ready(identity_settings) is True

    settings.STRIPE_SIGNING_SECRET = 'whsec_rotated_without_delivery'
    assert webhook_is_ready(identity_settings) is False


@pytest.mark.django_db
def test_nonfinancial_provider_canary_establishes_current_readiness(
    identity_settings,
):
    event = _canary_event()
    with patch(
        'dj.apps.ztripe.webhook_readiness.stripe.Event.retrieve',
        return_value=deepcopy(event),
    ):
        verify_and_record_readiness_canary(event, identity_settings)

    assert webhook_is_ready(identity_settings) is True


@pytest.mark.django_db
def test_old_delivery_proof_expires_before_stripe_retry_window(
    identity_settings,
):
    event = _canary_event()
    with patch(
        'dj.apps.ztripe.webhook_readiness.stripe.Event.retrieve',
        return_value=deepcopy(event),
    ):
        verify_and_record_readiness_canary(event, identity_settings)
    StripeWebhookReadiness.objects.filter(singleton=1).update(
        verified_at=timezone.now() - timedelta(hours=25),
    )

    assert webhook_is_ready(identity_settings) is False


def test_endpoint_must_subscribe_to_settlement_and_nonfinancial_canary(
    identity_settings, settings,
):
    endpoint = {
        'id': 'we_testReadiness',
        'status': 'enabled',
        'livemode': False,
        'url': f"{settings.CANONICAL_ORIGIN}/api/stripe/webhook/",
        'enabled_events': [
            'checkout.session.completed',
            'customer.created',
        ],
    }
    with patch(
        'dj.apps.ztripe.webhook_readiness.stripe.WebhookEndpoint.retrieve',
        return_value=endpoint,
    ):
        prove_webhook_endpoint(identity_settings)

    endpoint['enabled_events'] = ['checkout.session.completed']
    with patch(
        'dj.apps.ztripe.webhook_readiness.stripe.WebhookEndpoint.retrieve',
        return_value=endpoint,
    ), pytest.raises(StripeWebhookReadinessError, match='unexpected'):
        prove_webhook_endpoint(identity_settings)


@pytest.mark.django_db
def test_event_retrieval_mismatch_cannot_activate_checkout(identity_settings):
    signed = _event(amount=122)
    provider = _event(amount=9_999)

    with patch(
        'dj.apps.ztripe.webhook_readiness.stripe.Event.retrieve',
        return_value=provider,
    ), pytest.raises(StripeWebhookReadinessError, match='differs'):
        verify_and_record_checkout_event(signed, identity_settings)

    assert StripeWebhookReadiness.objects.count() == 0


@pytest.mark.django_db
def test_unretrievable_event_cannot_activate_checkout(identity_settings):
    import stripe

    with patch(
        'dj.apps.ztripe.webhook_readiness.stripe.Event.retrieve',
        side_effect=stripe.error.APIConnectionError('unavailable'),
    ), pytest.raises(StripeWebhookReadinessError, match='could not be bound'):
        verify_and_record_checkout_event(_event(), identity_settings)

    assert StripeWebhookReadiness.objects.count() == 0


# --------------------------------------------------------------------------
#a failed endpoint proof names its cause
# --------------------------------------------------------------------------

def _good_endpoint(settings, livemode=False):
    return {
        'id': 'we_testReadiness',
        'status': 'enabled',
        'livemode': livemode,
        'url': f"{settings.CANONICAL_ORIGIN}/api/stripe/webhook/",
        'enabled_events': ['checkout.session.completed', 'customer.created'],
    }


def _prove(endpoint, identity):
    with patch(
        'dj.apps.ztripe.webhook_readiness.stripe.WebhookEndpoint.retrieve',
        return_value=endpoint,
    ):
        prove_webhook_endpoint(identity)


def test_every_failed_endpoint_clause_is_named_with_its_value(
    identity_settings, settings,
):
    """Five clauses used to share one sentence; each is now distinguishable."""
    settings.CANONICAL_ORIGIN = 'https://stage.example'
    endpoint = _good_endpoint(settings)
    endpoint.update({
        'id': 'we_somethingElse',
        'status': 'disabled',
        'livemode': True,
        'url': 'https://stage.example/api/old-webhook/',
        'enabled_events': ['checkout.session.completed'],
    })
    with pytest.raises(StripeWebhookEndpointMismatch) as caught:
        _prove(endpoint, identity_settings)

    message = str(caught.value)
    assert 'unexpected' in message  # the old phrase survives for grep
    assert "id='we_somethingElse'" in message
    assert "status='disabled'" in message
    assert 'livemode=True (expected False' in message
    assert "url='https://stage.example/api/old-webhook/'" in message
    assert "missing events: ['customer.created']" in message
    assert len(caught.value.clauses) == 5
    # Same origin, different path: a URL edit, not a shared credential.
    assert caught.value.reason == 'webhook_endpoint_mismatch'
    assert caught.value.diagnosis is None


def test_one_failed_clause_names_only_that_clause(identity_settings, settings):
    endpoint = _good_endpoint(settings)
    endpoint['status'] = 'disabled'
    with pytest.raises(StripeWebhookEndpointMismatch) as caught:
        _prove(endpoint, identity_settings)
    assert caught.value.clauses == ["status='disabled' (expected 'enabled')"]


def test_live_endpoint_of_another_origin_is_named_as_shared_live_credentials(
    settings,
):
    """Stage on prod's live key: the exact state  found, named as such."""
    settings.STRIPE_SECRET_KEY = 'sk_live_readiness_secret'
    settings.STRIPE_SIGNING_SECRET = 'whsec_readiness_secret'
    settings.STRIPE_EXPECTED_ACCOUNT_ID = 'acct_testReadiness'
    settings.STRIPE_EXPECTED_LIVEMODE = 'true'
    settings.STRIPE_WEBHOOK_ENDPOINT_ID = 'we_testReadiness'
    settings.CANONICAL_ORIGIN = 'https://stage.free2z.cash'
    identity = configured_stripe_identity()
    endpoint = _good_endpoint(settings, livemode=True)
    endpoint['url'] = 'https://free2z.cash/api/stripe/webhook/'

    with pytest.raises(StripeWebhookEndpointMismatch) as caught:
        _prove(endpoint, identity)

    assert caught.value.reason == 'endpoint_belongs_to_another_origin'
    message = str(caught.value)
    assert 'https://stage.free2z.cash' in message
    assert 'https://free2z.cash' in message
    assert 'LIVE-MODE' in message
    assert "stage using production's live-mode Stripe credentials" in message
    assert 'sk_live_readiness_secret' not in message
    assert 'whsec_readiness_secret' not in message


def test_test_mode_endpoint_of_another_origin_does_not_claim_live_keys(
    identity_settings, settings,
):
    settings.CANONICAL_ORIGIN = 'https://test.free2z.cash'
    endpoint = _good_endpoint(settings)
    endpoint['url'] = 'https://stage.free2z.cash/api/stripe/webhook/'
    with pytest.raises(StripeWebhookEndpointMismatch) as caught:
        _prove(endpoint, identity_settings)
    assert caught.value.reason == 'endpoint_belongs_to_another_origin'
    assert 'test-mode' in str(caught.value)
    assert 'LIVE-MODE' not in str(caught.value)


def test_a_provider_value_cannot_forge_a_second_log_line(
    identity_settings, settings,
):
    endpoint = _good_endpoint(settings)
    endpoint['status'] = 'disabled\nSTRIPE CHECKOUT READINESS OK'
    with pytest.raises(StripeWebhookReadinessError) as caught:
        _prove(endpoint, identity_settings)
    assert '\n' not in str(caught.value)


def test_unretrievable_endpoint_is_not_reported_as_a_mismatch(
    identity_settings,
):
    """A timeout is transient; only a mismatch may page immediately."""
    import stripe

    with patch(
        'dj.apps.ztripe.webhook_readiness.stripe.WebhookEndpoint.retrieve',
        side_effect=stripe.error.APIConnectionError('unavailable'),
    ), pytest.raises(StripeWebhookReadinessError) as caught:
        prove_webhook_endpoint(identity_settings)
    assert not isinstance(caught.value, StripeWebhookEndpointMismatch)
