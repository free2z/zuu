"""Check the 2Z ledger's invariants and say what it found. Never fix anything.

READ-ONLY over every money table. Every statement here is a SELECT, except
one INSERT per invariant into ``ledger_reconcile_run`` (design §3.8, §11 --
the run log the drift alert reads). It moves no credits, heals no balance,
writes back no journal-only total. That is what makes it safe for the
``ledger-reconcile`` CronJob (``k8s/free2z/cron/BUILD.bazel``) to run it every
ten minutes, retry it, and overlap a manual run of it; running it twice
cannot fix, break or credit anything, because running it once does nothing
but look. ``tuzis/test_reconcile_ledger.py`` pins that.

WHAT IT CHECKS (docs/tuzis/ledger-v2.md §11)

  R1   every maintained account: ``balance == sum(credits) - sum(debits)``
       over the journal
  R2   every ``user`` account: ``g12f_creator.tuzis * 1000 == balance`` --
       during dual-write this is the invariant that proves the step-3
       self-heal has gone quiet
  R3   ``sum(balance)`` over ALL accounts == 0, journal-only balances
       recomputed from the journal (reported, not written back)
  R4–R7 open holds, spend windows, receipt/split integrity, clearing equality
       and the five-minute backlog threshold for queue and pending credits
  R13  ``journal(sys:reservation_clearing) == sum(amount * 1000)`` over
       ``ProviderReservation`` rows that are ``active`` AND have a
       ``spend / reservation / <pk>`` transfer (pre-rollout reservations
       have none, §10 step 2)

plus two rollout gauges: how many ``legacy_adjustment`` rows the self-heal
posted in the last hour and day (must reach zero and stay there once every
pod runs the dual-write image, §10 step 3; nonzero during the minutes of
the rollout), and how many reservations the new code journaled and the
OLD code then finalized (``legacy_finalized_reservations``, a rollback
artefact that explains an R13 drift; ``heal_ledger_drift --apply`` closes
them -- ``tuzis/ledger_audit.py``).

OUTPUT: one ``ledger_reconcile_drift`` JSON line per invariant with drift
(what a page-tier log metric counts) and, last, exactly one
``ledger_reconcile`` ``status=completed`` heartbeat line, whatever it found.
A bare run exits 0 with findings: they are alerted on, and a failed Job
would only retry an audit that already reported. ``--fail-on-drift`` is for
an operator's terminal.

It lives in ``tuzis``, not ``ledger``, on purpose: R13 names
``ProviderReservation``'s table, and the ledger app is self-contained (it
names no foreign table but ``g12f_creator``; ``ledger/tests/test_app_shape.py``).
"""
from __future__ import annotations

import json

from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from django.utils import timezone

from dj.apps.ledger import invariants
from dj.apps.ledger.models import Config, ReconcileRun
from dj.apps.tuzis import ledger_audit
from dj.apps.tuzis.ledger_audit import (  # noqa: F401  (re-exported: the tests import it from here)
    r13_reservation_clearing_equals_active_journaled_holds,
)
from dj.apps.tuzis.models import ProviderReservation

#The two JSON log events a run emits; the log metrics in
#monitoring/log-metrics/ filter on these exact strings.
RECONCILE_EVENT = 'ledger_reconcile'
DRIFT_EVENT = 'ledger_reconcile_drift'

SCOPE = 'full'
INVARIANTS = ('R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R13')


def _json_line(payload):
    return json.dumps(payload, separators=(',', ':'), sort_keys=True, default=str)


def drift_payload(invariant: str, found: dict) -> dict:
    """The ``ledger_reconcile_drift`` line for one drifted invariant. The
    single builder: ``gcp/tests/test_alert_policy_contract.py`` calls it to
    prove the metric's ``invariant`` label extractor names a key this line
    really carries."""
    return {
        'event': DRIFT_EVENT,
        'invariant': invariant,
        'scope': SCOPE,
        'accounts_checked': found['accounts_checked'],
        'drift_count': found['drift_count'],
        'drift_m2z': found['drift_m2z'],
        'detail': found['detail'],
    }


def _one(sql, params=None):
    with connection.cursor() as cursor:
        cursor.execute(sql, params)
        return cursor.fetchone()


def _counts():
    row = _one(
        "SELECT count(*) FILTER (WHERE NOT journal_only),"
        "       count(*) FILTER (WHERE kind = 'user'),"
        "       count(*)"
        "  FROM ledger_account"
    )
    active = _one(
        f"SELECT count(*) FROM {ProviderReservation._meta.db_table} WHERE status = 'active'"
    )[0]
    # Ledger rollout step 4 (`ledger_backfill`, ) opens an account for
    # every creator; after it this reads 0, and a creator who signs up later
    # is opened lazily on first touch (the opening transfer is their tuzis,
    # under the creator lock), so a small nonzero count is new sign-ups, not
    # drift. It is a gauge, not an invariant: nothing alerts on it.
    without = _one(
        "SELECT count(*) FROM g12f_creator c WHERE NOT EXISTS"
        " (SELECT 1 FROM ledger_account a WHERE a.kind = 'user' AND a.owner_id = c.id)"
    )[0]
    return {'maintained': int(row[0]), 'user': int(row[1]), 'all': int(row[2]),
            'active_reservations': int(active), 'creators_without_account': int(without)}


def _legacy_adjustments():
    out = {}
    for label, interval in (('1h', '1 hour'), ('24h', '1 day')):
        row = _one(
            "SELECT count(*), coalesce(sum(amount), 0) FROM ledger_transfer"
            f" WHERE code = 'legacy_adjustment' AND created_at >= now() - interval '{interval}'"
        )
        out[f'legacy_adjustments_{label}'] = int(row[0])
        out[f'legacy_adjustments_m2z_{label}'] = int(row[1])
    return out


def _l2_findings(limit):
    from dj.apps.ledger.partitions import partition_drift
    r8 = partition_drift()
    r4 = invariants.r4_held_equals_open_holds()
    r5 = invariants.r5_spend_windows_equal_holds_and_usage()
    r6 = invariants.r6_usage_receipts_and_splits()
    journal, pending, stale = invariants.r7_clearing_equals_queued_and_pending()
    with connection.cursor() as cursor:
        cursor.execute('SELECT (SELECT count(*) FROM ledger_account), '
                       '(SELECT count(*) FROM ledger_spend_window), '
                       '(SELECT count(*) FROM ledger_ai_usage), '
                       '(SELECT count(*) FROM ledger_ai_split_queue)+(SELECT count(*) FROM ledger_dev_markup_pending)')
        accounts, windows, usage, queued = cursor.fetchone()
    return {
        'R4': dict(accounts_checked=accounts, drift_count=len(r4),
                   drift_m2z=sum(abs(int(expected)-int(actual)) for _, expected, actual in r4),
                   detail=[dict(account=key, expected=int(expected), held=int(actual)) for key, expected, actual in r4[:limit]]),
        'R5': dict(accounts_checked=windows, drift_count=len(r5),
                   drift_m2z=sum(abs(int(eh)-int(ah))+abs(int(es)-int(actual)) for _, _, _, eh, ah, es, actual in r5),
                   detail=[dict(app=str(app), account=account, window=window.isoformat(),
                                expected_held=int(eh), held=int(ah), expected_spent=int(es), spent=int(actual))
                           for app, account, window, eh, ah, es, actual in r5[:limit]]),
        'R6': dict(accounts_checked=usage, drift_count=len(r6), drift_m2z=0,
                   detail=[dict(hold=str(hold)) for hold in r6[:limit]]),
        'R8': dict(accounts_checked=8, drift_count=len(r8), drift_m2z=0, detail=r8[:limit]),
        'R7': dict(accounts_checked=queued, drift_count=int(journal != pending)+int(stale),
                   drift_m2z=abs(journal-pending),
                   detail=[dict(clearing=journal, pending=pending, backlog_older_than_five_minutes=stale)]
                          if journal != pending or stale else []),
    }


class Command(BaseCommand):
    help = (
        'Check the 2Z ledger invariants (R1–R8, R13) and report drift. '
        'Read-only: it never heals, writes back or credits.'
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--fail-on-drift', action='store_true',
            help='Exit nonzero if any invariant reports drift (for an operator, not the CronJob).',
        )
        parser.add_argument(
            '--detail-limit', type=int, default=20,
            help='How many drifted accounts to record per invariant (default 20).',
        )

    def handle(self, *args, **options):
        limit = options['detail_limit']
        if limit < 1:
            raise CommandError('--detail-limit must be at least 1')
        started = timezone.now()
        config = Config.objects.filter(id=True).values(
            'dual_write', 'heal_enabled', 'dual_write_since').first()
        if config is None:
            raise CommandError('ledger_config has no row; the ledger migration has not run')
        owns_snapshot = not connection.in_atomic_block
        with transaction.atomic():
            if owns_snapshot:
                with connection.cursor() as cursor:
                    cursor.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
            counts = _counts()

            r1 = invariants.r1_maintained_balance_equals_journal()
            r2 = invariants.r2_tuzis_projection_equals_balance()
            r3 = invariants.r3_all_accounts_sum_to_zero(write_back=False)
            r13_journal, r13_held = r13_reservation_clearing_equals_active_journaled_holds()
            # The reverse mixed-fleet gauge (tuzis/ledger_audit.py): reservations the
            # new code journaled and the OLD code finalized, which is what an R13
            # drift after a rollback is made of. Reported so the page can be read.
            legacy_finalized, legacy_finalized_m2z = ledger_audit.legacy_finalized_totals()

            findings = {
                'R1': dict(
                    accounts_checked=counts['maintained'], drift_count=len(r1),
                    drift_m2z=sum(abs(expected - actual) for _, expected, actual in r1),
                    detail=[{'account': k, 'journal': e, 'balance': a} for k, e, a in r1[:limit]],
                ),
                'R2': dict(
                    accounts_checked=counts['user'], drift_count=len(r2),
                    drift_m2z=sum(abs(expected - actual) for _, expected, actual in r2),
                    detail=[{'account': k, 'tuzis_m2z': e, 'balance': a} for k, e, a in r2[:limit]],
                ),
                'R3': dict(
                    accounts_checked=counts['all'], drift_count=int(r3 != 0), drift_m2z=abs(r3),
                    detail=[{'sum_m2z': r3}] if r3 else [],
                ),
                'R13': dict(
                    accounts_checked=counts['active_reservations'],
                    drift_count=int(r13_journal != r13_held), drift_m2z=abs(r13_journal - r13_held),
                    detail=(
                        [{'reservation_clearing_journal_m2z': r13_journal, 'active_journaled_m2z': r13_held,
                          'legacy_finalized_reservations': legacy_finalized,
                          'legacy_finalized_m2z': legacy_finalized_m2z}]
                        if r13_journal != r13_held else []
                    ),
                ),
            }
            findings.update(_l2_findings(limit))
        finished = timezone.now()
        for name in INVARIANTS:
            found = findings[name]
            ReconcileRun.objects.create(
                started_at=started, finished_at=finished, scope=SCOPE, invariant=name,
                accounts_checked=found['accounts_checked'], drift_count=found['drift_count'],
                drift_m2z=found['drift_m2z'], detail=found['detail'] or None,
            )
            if found['drift_count']:
                self.stdout.write(_json_line(drift_payload(name, found)))
        # The CronJob's stdout is a pipe, so Python block-buffers it: without
        # this a run killed at activeDeadlineSeconds discards the findings it
        # already "wrote" and the page never fires.
        self.stdout.flush()

        heal = _legacy_adjustments()
        total_drift = sum(f['drift_count'] for f in findings.values())
        # The heartbeat: exactly one per run that got this far, whatever it
        # found. `ledger-reconcile-absent` alerts on its absence.
        self.stdout.write(_json_line({
            'event': RECONCILE_EVENT,
            'status': 'completed',
            'scope': SCOPE,
            'dual_write': config['dual_write'],
            'heal_enabled': config['heal_enabled'],
            'dual_write_since': config['dual_write_since'],
            'accounts': counts['all'],
            'user_accounts': counts['user'],
            'active_reservations': counts['active_reservations'],
            'creators_without_account': counts['creators_without_account'],
            'drift_total': total_drift,
            **{f'{name.lower()}_drift': findings[name]['drift_count'] for name in INVARIANTS},
            **{f'{name.lower()}_drift_m2z': findings[name]['drift_m2z'] for name in INVARIANTS},
            **heal,
            'legacy_finalized_reservations': legacy_finalized,
            'legacy_finalized_m2z': legacy_finalized_m2z,
            'duration_ms': int((finished - started).total_seconds() * 1000),
        }))
        self.stdout.flush()
        if options['fail_on_drift'] and total_drift:
            raise CommandError(f'{total_drift} ledger invariant(s) report drift')
