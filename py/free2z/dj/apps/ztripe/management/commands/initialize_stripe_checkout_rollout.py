"""Initialize the metadata-free Stripe bridge exactly once."""

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from dj.apps.ztripe.models import StripeCheckoutRollout


ROLLING_DEPLOYMENT_GRACE_SECONDS = 2 * 60 * 60


def _validated_cutoff(rollout: StripeCheckoutRollout) -> int:
    cutoff = rollout.legacy_session_created_at_or_before_epoch
    if not isinstance(cutoff, int) or isinstance(cutoff, bool) or cutoff <= 0:
        raise CommandError('Stripe checkout rollout cutoff is invalid')
    return cutoff


class Command(BaseCommand):
    help = (
        'Create the immutable card-v1 Checkout Session cutoff before the '
        'first exact-checkout rollout, or verify the existing cutoff.'
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--check',
            action='store_true',
            help=(
                'Read-only. Exit 0 only if a valid cutoff already exists; '
                'never create one. cloudbuild.yaml uses this to decide '
                'whether an initialization failure is safe to continue past: '
                'the deploy proceeds when the invariant is already '
                'established and aborts when it is not.'
            ),
        )

    def handle(self, *args, **options):
        if options['check']:
            try:
                rollout = StripeCheckoutRollout.objects.get(singleton=1)
            except StripeCheckoutRollout.DoesNotExist as exc:
                raise CommandError(
                    'Stripe checkout rollout cutoff does not exist'
                ) from exc
            _validated_cutoff(rollout)
            self.stdout.write(
                self.style.SUCCESS(
                    'Stripe checkout rollout cutoff present; bridge ready.'
                )
            )
            return

        proposed = int(timezone.now().timestamp()) + ROLLING_DEPLOYMENT_GRACE_SECONDS
        with transaction.atomic():
            rollout, created = StripeCheckoutRollout.objects.select_for_update().get_or_create(
                singleton=1,
                defaults={
                    'legacy_session_created_at_or_before_epoch': proposed,
                },
            )
            _validated_cutoff(rollout)

        state = 'initialized' if created else 'unchanged'
        self.stdout.write(
            self.style.SUCCESS(
                f'Stripe checkout rollout cutoff {state}; immutable bridge ready.'
            )
        )
