"""Safely prove the deployed Stripe credential before enabling checkout."""

import stripe
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from stripe._http_client import RequestsClient

from dj.apps.ztripe.stripe_identity import (
    StripeIdentityConfigurationError,
    configured_legacy_checkout_cutoff,
    configured_stripe_identity,
)
from dj.apps.ztripe.webhook_readiness import (
    StripeWebhookReadinessError,
    prove_webhook_endpoint,
    webhook_is_ready,
)


class Command(BaseCommand):
    help = (
        'Perform a read-only, bounded Stripe account lookup and prove the '
        'configured checkout account/mode identity without printing secrets.'
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--require-legacy-cutoff',
            action='store_true',
            help=(
                'Also prove the bounded metadata-free Session cutoff after '
                'the final old pod has stopped creating Sessions.'
            ),
        )

    def handle(self, *args, **options):
        try:
            identity = configured_stripe_identity()
        except StripeIdentityConfigurationError as exc:
            raise CommandError('Stripe checkout identity is not configured') from exc

        stripe.api_key = settings.STRIPE_SECRET_KEY
        stripe.max_network_retries = 0
        stripe.default_http_client = RequestsClient(timeout=(3.05, 5))
        try:
            account = stripe.Account.retrieve(
                api_key=settings.STRIPE_SECRET_KEY,
                max_network_retries=0,
            )
        except stripe.error.StripeError as exc:
            raise CommandError('Stripe account proof failed') from exc
        try:
            account_id = account['id']
        except (KeyError, TypeError):
            account_id = getattr(account, 'id', None)
        if account_id != identity.account_id:
            raise CommandError('Stripe credential belongs to an unexpected account')
        try:
            prove_webhook_endpoint(identity)
        except StripeWebhookReadinessError as exc:
            # The cause in the message: Django prints only the message of a
            # CommandError, so `from exc` alone hides it.
            raise CommandError(
                f'Stripe webhook endpoint is not safely configured: {exc}'
            ) from exc
        if not webhook_is_ready(identity):
            raise CommandError(
                'Stripe webhook has no account-bound checkout delivery proof'
            )
        cutoff_verified = False
        if options['require_legacy_cutoff']:
            try:
                configured_legacy_checkout_cutoff()
            except StripeIdentityConfigurationError as exc:
                raise CommandError(
                    'Stripe legacy checkout cutoff is not safely configured'
                ) from exc
            cutoff_verified = True
        self.stdout.write(
            self.style.SUCCESS(
                'Stripe checkout identity verified: '
                f'mode={identity.mode} '
                f'livemode={str(identity.livemode).lower()}'
                + (' legacy_cutoff=verified' if cutoff_verified else '')
            )
        )
