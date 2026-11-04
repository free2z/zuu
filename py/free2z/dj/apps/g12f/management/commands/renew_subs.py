"""
Daily backstop sweep for subscription renewals ( phase 3).

Renewals are now event-based: the Subscription post_save signal
(signals.py) schedules a g12f.renew_subscription job at
expires - RENEWAL_LEAD, and each successful renewal re-arms the chain.
This sweep exists for two reasons:

1. Migration path: subscriptions that predate the job system have no
   scheduled job yet. The sweep finds them as they enter the legacy
   renewal window (now <= expires <= now + 24h, unchanged) and enqueues
   a job for each — the job renews them, and from then on the signal
   keeps the chain alive. The fleet converts organically within one
   billing cycle, no one-shot backfill needed.

2. Belt-and-suspenders: if a chain job is ever lost, the sub's next
   window is still covered (the 24h window is at least as wide as the
   daily sweep interval, so no expiry time can slip between runs).

The sweep no longer charges anyone directly: it only defers jobs, so
every extension goes through renew_subscription's guarded, idempotent,
row-locked path. Overlap between the sweep and an existing chain job is
harmless — duplicates no-op via the task's expires window guard, so at
most one charge per cycle — and it does not even produce a
duplicate: `defer_renewal` carries a queueing_lock keyed by subscription
and cycle, so a sub whose chain job is still pending is counted as
`already_pending` and left alone. A sub with NO pending job (the migration case, or a lost
chain) gets one, which is the whole point of the backstop.

Rollout note: a `todo` renewal job enqueued BEFORE  carries
`queueing_lock = NULL`, and NULLs are distinct in procrastinate's partial
unique index, so it holds no lock. The first sweep after the deploy
therefore reports `already_pending=0` and gives every sub that already had
a healthy (unlocked) chain job a locked twin; the pair no-ops through the
task's guards (one charge per cycle, as ever) and the next cycle's job
carries the lock. That tick is not the steady state -- do not read it as
"the lock is not working".
"""
import json
import logging
from datetime import timedelta

from django.utils import timezone

from django.core.management.base import BaseCommand

from dj.apps.g12f.models import Subscription
from dj.apps.g12f.tasks import defer_renewal

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = 'Enqueue renewal jobs for all subs in the renewal window'

    def handle(self, *args, **kwargs):
        total = Subscription.objects.all().count()
        # Same window as the legacy hourly sweep: within 24h of expiry,
        # not yet expired. Do NOT widen or narrow this — it defines when
        # renewals may happen.
        expires_in_next_day = Subscription.objects.filter(
            star__is_active=True,
            expires__lte=timezone.now() + timedelta(hours=24),
            expires__gte=timezone.now(),
        )
        # Only the pk and the expiry (it keys the queueing_lock) are
        # needed to defer; streaming them keeps this bounded no matter how
        # many subs share a renewal window.
        enqueued = 0
        already_pending = 0
        for pk, expires in expires_in_next_day.order_by('pk').values_list(
                'pk', 'expires').iterator(chunk_size=500):
            if defer_renewal(pk, expires):
                enqueued += 1
            else:
                already_pending += 1

        #  evidence, emitted every run including the zero case. Note
        # `enqueued` + `already_pending` counts every sub in the window,
        # NOT only unconverted ones: a sub with a healthy chain job lands
        # in `already_pending` (its queueing_lock refused the duplicate),
        # and one whose job has already been CONSUMED this window (it ran
        # and is retrying, or it ran and no-oped) is re-enqueued here. The
        # number that actually decides  is
        # `backstops.subscriptions_without_job` in the job-health sweep
        # (dj.apps.jobs) — that one is zero exactly when the fleet is
        # fully converted. Do not read `enqueued` as "work the backstop
        # rescued".
        logger.info(json.dumps({
            'severity': 'INFO',
            'message': (
                f'renew_subs backstop sweep: total={total} '
                f'enqueued={enqueued} already_pending={already_pending}'),
            'event': 'renew_subs_backstop_sweep',
            'subscriptions_total': total,
            'enqueued': enqueued,
            'already_pending': already_pending,
        }))
