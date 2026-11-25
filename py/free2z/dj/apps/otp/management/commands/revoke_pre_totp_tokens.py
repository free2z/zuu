"""Bounded post-rollout retirement of possibly password-only Knox tokens.

No trustworthy marker distinguishes a historical pre-OTP bearer from one
whose holder completed OTP locally. Knox AuthToken.created is the source of
truth for the cutoff. Conservatively retire ALL older tokens of currently
enrolled accounts. Never bump ownership epochs or revoke other identity grants.
Run only after every serving pod enforces TOTP; migrate must not run this.
"""
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from knox.models import AuthToken

from dj.apps.identity.models import AuthContext, credential_hash


class Command(BaseCommand):
    help = "Dry-run or retire one bounded batch of pre-TOTP Knox tokens."

    def add_arguments(self, parser):
        parser.add_argument('--before', required=True)
        parser.add_argument('--batch-size', type=int, default=500)
        parser.add_argument('--apply', action='store_true')

    def handle(self, *args, **options):
        try:
            cutoff = parse_datetime(options['before'])
        except ValueError:
            cutoff = None
        if (cutoff is None or timezone.is_naive(cutoff)
                or cutoff > timezone.now()):
            raise CommandError('--before must be an aware, non-future timestamp')
        size = options['batch_size']
        if not 1 <= size <= 5000:
            raise CommandError('--batch-size must be between 1 and 5000')
        with transaction.atomic():
            # Lock tokens only (not the nullable joins), retaining the same
            # immutable cutoff across repeated invocations. Never print digests.
            tokens = list(AuthToken.objects.filter(
                created__lt=cutoff, user__otpsecret__is_active=True,
            ).order_by('created', 'pk').select_for_update(of=('self',))[:size])
            if options['apply']:
                AuthContext.objects.filter(
                    credential_kind=AuthContext.Kind.KNOX,
                    credential_hash__in=[credential_hash(AuthContext.Kind.KNOX, t.pk) for t in tokens],
                ).delete()
                AuthToken.objects.filter(pk__in=[t.pk for t in tokens]).delete()
        self.stdout.write(f"{'Retired' if options['apply'] else 'Would retire'} {len(tokens)} tokens")
