"""Absorb the rollout drift the lazy self-heal cannot reach. Explicit, never
scheduled, dry-run by default (; design §10 step 3).

The step-3 self-heal runs when an account is TOUCHED: every ledger function
compares ``ledger_account.balance`` with ``Creator.tuzis`` under the creator
lock and journals the difference as a ``legacy_adjustment``. Two things it
cannot reach, both found by the codex adversarial review of:

1. **A dormant account.** A pod on the previous image debits a user's
   ``tuzis`` after a new pod opened their account, and the user never comes
   back. R2 reports that account every ten minutes, forever, and a genuine
   later failure can arrive behind an incident that is already open. Step
   4's ``ledger_backfill`` will touch every creator; until then this command
   is the way to touch exactly the drifted ones.
2. **A reservation the new code journaled and the OLD code finalized** (a
   rollback: the old stale sweep or the old ``cleanup_idempotency`` releases
   a hold the new code had posted into ``sys:reservation_clearing``, without
   the closing leg). The user side heals on the next touch; the clearing
   side cannot, and R13 stands. See ``tuzis/ledger_audit.py``.

Both repairs are the ledger's own heal, applied to rows a human named, each
in its own short transaction under the same locks the request path takes:
the R2 pass is literally ``ledger.lock_account`` (open + lock + heal) after
``ledger.lock_creator``; the R13 pass posts, for a reservation the old code
settled, the ``sys:reservation_clearing -> sys:platform_revenue`` leg the new
``settle_reservation`` would have posted, and for one it released, a
``legacy_adjustment`` from ``sys:reservation_clearing`` back to
``sys:opening_equity`` (the user already got the credits back through the
old code, and the next touch journals THAT side from opening equity, so the
two legs net to nothing across the system: R3 holds before and after).

``reconcile_ledger`` stays read-only: it reports these, this command acts,
and only with ``--apply``. Nothing here is on a schedule.
"""
from __future__ import annotations

import json

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from dj.apps.ledger import api, invariants
from dj.apps.tuzis import ledger_audit
from dj.apps.tuzis.models import ProviderReservation

HEAL_EVENT = 'ledger_heal'


def _json_line(payload):
    return json.dumps(payload, separators=(',', ':'), sort_keys=True, default=str)


def heal_drifted_accounts(limit: int) -> tuple[int, int]:
    """Touch each R2-drifted user account so the self-heal runs. Returns
    ``(accounts healed, Σ |delta| m2Z)``."""
    healed = 0
    moved = 0
    for key, tuzis_m2z, balance in invariants.r2_tuzis_projection_equals_balance()[:limit]:
        owner_id = int(key.split(":", 1)[1])
        with transaction.atomic():
            locked = api.lock_creator(owner_id)
            if locked is None:
                continue
            before = api.account_row(api.user_account_id(owner_id)).balance
            after = api.lock_account(locked.id, locked.balance).balance
        if after != before:
            healed += 1
            moved += abs(after - before)
    return healed, moved


def close_legacy_finalized_reservations(limit: int) -> tuple[int, int]:
    """Post the closing leg for each reservation the old code finalized.
    Returns ``(rows closed, Σ m2Z)``."""
    closed = 0
    moved = 0
    clearing = api.system_account_id("sys:reservation_clearing")
    for pk, _status, _m2z in ledger_audit.legacy_finalized_reservations(limit):
        with transaction.atomic():
            row = ProviderReservation.objects.select_for_update().filter(pk=pk).first()
            if row is None or row.status == ProviderReservation.ACTIVE:
                continue
            # Re-check under the row lock: a concurrent run may have closed it.
            if not ledger_audit.legacy_finalized_reservations(pk=pk):
                continue
            m2z = api.to_m2z(row.amount)
            if row.status == "settled":
                result = api.post_transfer(
                    clearing, api.system_account_id("sys:platform_revenue"), m2z,
                    "spend", "reservation_settle", str(pk),
                    meta={"legacy_finalized": row.status, "healed_by": "heal_ledger_drift"},
                )
            else:
                result = api.post_transfer(
                    clearing, api.system_account_id("sys:opening_equity"), m2z,
                    "legacy_adjustment", "reservation", str(pk),
                    meta={"legacy_finalized": row.status, "healed_by": "heal_ledger_drift"},
                )
            if not result.posted:
                raise CommandError(f"closing leg for reservation {pk} refused: {result.status}")
        closed += 1
        moved += m2z
    return closed, moved


class Command(BaseCommand):
    help = (
        'Heal R2 drift on dormant accounts and close reservations the old code '
        'finalized (#2220). Dry run unless --apply.'
    )

    def add_arguments(self, parser):
        parser.add_argument('--apply', action='store_true', help='Actually heal; the default only reports.')
        parser.add_argument('--batch-size', type=int, default=500,
                            help='At most this many accounts and this many reservations per run.')

    def handle(self, *args, **options):
        limit = options['batch_size']
        if limit < 1:
            raise CommandError('--batch-size must be at least 1')
        drifted = invariants.r2_tuzis_projection_equals_balance()
        legacy_count, legacy_m2z = ledger_audit.legacy_finalized_totals()
        self.stdout.write(_json_line({
            'event': HEAL_EVENT,
            'status': 'dry_run' if not options['apply'] else 'starting',
            'r2_drifted_accounts': len(drifted),
            'r2_drift_m2z': sum(abs(e - a) for _, e, a in drifted),
            'legacy_finalized_reservations': legacy_count,
            'legacy_finalized_m2z': legacy_m2z,
        }))
        if not options['apply']:
            return
        healed, healed_m2z = heal_drifted_accounts(limit)
        closed, closed_m2z = close_legacy_finalized_reservations(limit)
        remaining_r2 = len(invariants.r2_tuzis_projection_equals_balance())
        remaining_legacy, _ = ledger_audit.legacy_finalized_totals()
        self.stdout.write(_json_line({
            'event': HEAL_EVENT,
            'status': 'completed',
            'healed_accounts': healed,
            'healed_m2z': healed_m2z,
            'closed_reservations': closed,
            'closed_m2z': closed_m2z,
            'remaining_r2_drifted_accounts': remaining_r2,
            'remaining_legacy_finalized_reservations': remaining_legacy,
        }))
        self.stdout.flush()
