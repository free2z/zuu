"""The readiness canary creates no financial objects and cannot attest itself."""
from datetime import timedelta

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.utils import timezone


from dj.apps.ztripe.management.commands import refresh_stripe_checkout_readiness
from dj.apps.ztripe.models import StripeWebhookReadiness
from dj.apps.ztripe.stripe_identity import configured_stripe_identity

_WARN = refresh_stripe_checkout_readiness.READINESS_WARN_AGE


_COMMAND = 'refresh_stripe_checkout_readiness'


@pytest.fixture
def identity_settings(settings):
    # Exercise the canary checks with production namespace semantics and a mocked provider.
    settings.NAMESPACE = 'prod'
    settings.STRIPE_SECRET_KEY = 'sk_test_canarySecret'
    settings.STRIPE_SIGNING_SECRET = 'whsec_canarySecret'
    settings.STRIPE_EXPECTED_ACCOUNT_ID = 'acct_testCanary'
    settings.STRIPE_EXPECTED_LIVEMODE = 'false'
    settings.STRIPE_WEBHOOK_ENDPOINT_ID = 'we_testCanary'
    return configured_stripe_identity()


class _Customer:
    def __init__(self, livemode=False, customer_id='cus_testCanary'):
        self.livemode = livemode
        self.id = customer_id


@pytest.fixture
def stripe_calls(mocker):
    """Stub the provider boundary only. Nothing here touches the network."""
    mocker.patch.object(
        refresh_stripe_checkout_readiness, 'prove_webhook_endpoint',
    )
    created = mocker.patch.object(
        refresh_stripe_checkout_readiness.stripe.Customer, 'create',
        return_value=_Customer(),
    )
    deleted = mocker.patch.object(
        refresh_stripe_checkout_readiness.stripe.Customer, 'delete',
    )
    return created, deleted


def _record_proof(identity, age):
    """Write the proof row the webhook view would have written, aged."""
    from dj.apps.ztripe.webhook_readiness import _fingerprint
    from django.conf import settings as django_settings

    StripeWebhookReadiness.objects.update_or_create(
        singleton=1,
        defaults={
            'stripe_account_id': identity.account_id,
            'stripe_livemode': identity.livemode,
            'webhook_endpoint_id': django_settings.STRIPE_WEBHOOK_ENDPOINT_ID,
            'secret_key_fingerprint': _fingerprint(
                django_settings.STRIPE_SECRET_KEY),
            'signing_secret_fingerprint': _fingerprint(
                django_settings.STRIPE_SIGNING_SECRET),
            'provider_event_id': 'evt_testCanary',
        },
    )
    # verified_at is auto_now, so age it with an explicit UPDATE.
    StripeWebhookReadiness.objects.filter(singleton=1).update(
        verified_at=timezone.now() - age)


_FINANCIAL_PARAMS = frozenset({
    'source', 'payment_method', 'invoice_settings', 'default_source',
    'balance', 'coupon', 'promotion_code', 'tax', 'cash_balance',
    'items', 'price', 'plan', 'amount', 'currency', 'line_items',
})


@pytest.mark.django_db
def test_canary_customer_carries_nothing_that_could_move_money(
    identity_settings, stripe_calls,
):
    created, _ = stripe_calls

    call_command(_COMMAND, no_color=True)

    kwargs = created.call_args.kwargs
    assert not _FINANCIAL_PARAMS.intersection(kwargs), kwargs
    assert kwargs['metadata'] == {'free2z_readiness_canary': 'true'}
    assert kwargs['max_network_retries'] == 0


@pytest.mark.django_db
def test_canary_customer_is_deleted_again(identity_settings, stripe_calls):
    created, deleted = stripe_calls

    call_command(_COMMAND, no_color=True)

    assert deleted.call_args.args == ('cus_testCanary',)


@pytest.mark.django_db
def test_every_invocation_gets_a_fresh_idempotency_key(
    identity_settings, stripe_calls,
):
    """A reused key makes Stripe replay, and replaying emits no new event.

    The dangerous case is not the scheduled tick, it is the operator who has
    just fixed a broken webhook endpoint and reruns the Job by hand. If that
    run collides with a key the schedule already spent, Stripe returns the
    saved response, no `customer.created` is emitted, this command prints its
    success line, exits 0 — and readiness expires anyway.
    """
    created, _ = stripe_calls

    call_command(_COMMAND, no_color=True)
    call_command(_COMMAND, no_color=True)
    call_command(_COMMAND, no_color=True)

    keys = [c.kwargs['idempotency_key'] for c in created.call_args_list]
    assert len(set(keys)) == 3, keys
    assert all(key.startswith('f2z-readiness-canary-') for key in keys), keys


@pytest.mark.django_db
def test_wrong_mode_customer_fails_closed(identity_settings, stripe_calls):
    stripe_calls[0].return_value = _Customer(livemode=True)

    with pytest.raises(CommandError):
        call_command(_COMMAND, no_color=True)


@pytest.mark.django_db
def test_unproven_endpoint_creates_no_customer(
    identity_settings, stripe_calls, mocker,
):
    created, _ = stripe_calls
    mocker.patch.object(
        refresh_stripe_checkout_readiness, 'prove_webhook_endpoint',
        side_effect=(
            refresh_stripe_checkout_readiness.StripeWebhookReadinessError(
                'nope')),
    )

    with pytest.raises(CommandError):
        call_command(_COMMAND, no_color=True)
    assert created.call_count == 0


@pytest.mark.django_db
def test_command_never_writes_its_own_readiness_proof(
    identity_settings, stripe_calls,
):
    """The proof must come from the provider, never from us."""
    _record_proof(identity_settings, _WARN + timedelta(minutes=1))
    before = StripeWebhookReadiness.objects.get(singleton=1).verified_at

    call_command(_COMMAND, no_color=True)

    row = StripeWebhookReadiness.objects.get(singleton=1)
    assert row.verified_at == before
    assert StripeWebhookReadiness.objects.count() == 1
