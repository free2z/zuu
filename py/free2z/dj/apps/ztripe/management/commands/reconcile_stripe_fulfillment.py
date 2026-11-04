"""Audit durable checkout evidence without inventing historical provider facts.

READ-ONLY, ALWAYS. Nothing below writes a row, credits a ledger or calls
Stripe: every statement is a SELECT. That is what makes it safe for the
``stripe-fulfillment-reconcile`` CronJob (``k8s/free2z/cron/BUILD.bazel``) to
run it every hour, retry it, and overlap a manual run of it. Running it
twice can never credit twice, because running it once credits nothing;
``test_scheduled_reconcile_is_read_only_and_repeatable`` pins that.

TWO WAYS TO RUN IT

* **Bare** (``manage.py reconcile_stripe_fulfillment``, what the CronJob runs --
  the shared CronJob template takes a command name and no arguments). Once
  durable intents exist, classifying unlinked historical transactions needs the
  operator-recorded ``--legacy-before`` instant, which no schedule can know, so
  a bare run SKIPS that one classification and says so. Everything else runs:
  fulfilled-intent drift, stale intents and, the reason it is scheduled,
  **unresolved rejected fulfillments** -- a verified
  ``checkout.session.completed`` that fulfillment refused and that nothing has
  credited since. Each is one JSON line
  (``stripe_fulfillment_unresolved_rejection``) that a page-tier log metric
  counts, and every completed run ends in one ``stripe_fulfillment_reconcile``
  JSON line that the heartbeat metric counts. A bare run exits 0 with findings:
  the findings are alerted on, and a failed Job would only retry an audit that
  already reported.
* **With ``--legacy-before`` and ``--fail-on-drift``** -- the operator's
  "reconciliation is complete" run. It classifies everything and exits nonzero
  on any finding. ``--fail-on-drift`` still refuses to run without
  ``--legacy-before`` once intents exist: a skipped classification must never
  read as zero drift.
"""

import json
from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from dj.apps.pricing.constants import (
    historical_card_quantity,
)
from dj.apps.ztripe.models import (
    CheckoutFulfillmentAudit,
    CheckoutIntent,
    StripeTransaction,
)
from dj.apps.ztripe.stripe_identity import (
    StripeIdentityConfigurationError,
    configured_stripe_identity,
)


#The two JSON log events a run emits; the log metrics in monitoring/log-metrics/
#filter on these exact strings.
RECONCILE_EVENT = 'stripe_fulfillment_reconcile'
UNRESOLVED_REJECTION_EVENT = 'stripe_fulfillment_unresolved_rejection'


def _json_line(payload):
    return json.dumps(payload, separators=(',', ':'), sort_keys=True)


def _iso(value):
    return value.isoformat() if value is not None else None


class Command(BaseCommand):
    help = (
        'Measure historical Stripe fulfillment drift. Legacy transaction rows '
        'lack provider currency/account evidence and are never auto-repaired.'
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--repair',
            action='store_true',
            help='Refused: historical rows do not contain enough provider evidence.',
        )
        parser.add_argument(
            '--fail-on-drift',
            action='store_true',
            help='Exit nonzero if unresolved financial or intent drift remains.',
        )
        parser.add_argument(
            '--legacy-before',
            metavar='ISO_TIMESTAMP',
            help=(
                'Only treat unlinked transactions before this recorded '
                'pre-rollout cutoff as card-v1. Required with --repair.'
            ),
        )
        parser.add_argument(
            '--intent-stale-minutes',
            type=int,
            default=60,
            help='Report non-final CheckoutIntents older than this age.',
        )

    @staticmethod
    def _unresolved_rejections():
        """Rejected verified deliveries that nothing has credited since.

        One finding per provider event (Stripe redelivers the same ``evt_``
        id, and one delivery can leave several decision rows), or per audit
        row when the event id itself was unusable. There is NO time window:
        age is not recovery, and a buyer is not less out of pocket because
        Stripe stopped retrying. A rejection leaves this list only on
        evidence that it was settled:

        * the same provider event later produced a successful audit (the
          cause was fixed and the event resent), or
        * its intent is FULFILLED **by the same PaymentIntent** -- an intent
          fulfilled by a different Session/PaymentIntent is exactly the
          inconsistent provider state a ``checkout_session_mismatch``
          rejection describes, and does not settle this payment, or
        * an operator listed its ``evt_`` id in
          ``settings.STRIPE_FULFILLMENT_SETTLED_EVENT_IDS`` (refunded
          out-of-band, via a reviewed ConfigMap change).
        """
        rejected = (
            CheckoutFulfillmentAudit.objects.filter(
                outcome=CheckoutFulfillmentAudit.Outcome.REJECTED,
            )
            .select_related('intent')
            .order_by('pk')
        )
        successful_events = set(
            CheckoutFulfillmentAudit.objects.filter(
                outcome__in=[
                    CheckoutFulfillmentAudit.Outcome.CREDITED,
                    CheckoutFulfillmentAudit.Outcome.DUPLICATE,
                ],
            )
            .exclude(provider_event_id=None)
            .values_list('provider_event_id', flat=True)
        )
        settled_events = settings.STRIPE_FULFILLMENT_SETTLED_EVENT_IDS
        findings = {}
        for audit in rejected:
            if audit.provider_event_id in successful_events:
                continue
            if audit.provider_event_id in settled_events:
                continue
            intent = audit.intent
            if (
                intent is not None
                and intent.state == CheckoutIntent.State.FULFILLED
                and audit.received_payment_intent_id
                and intent.stripe_payment_intent_id
                == audit.received_payment_intent_id
            ):
                continue
            key = audit.provider_event_id or f'audit:{audit.pk}'
            finding = findings.get(key)
            if finding is None:
                findings[key] = {
                    'audit_id': audit.pk,
                    'provider_event_id': audit.provider_event_id,
                    'reasons': [audit.reason],
                    'intent': (
                        str(intent.public_id) if intent is not None else None
                    ),
                    'first_seen_at': audit.first_seen_at,
                    'last_seen_at': audit.last_seen_at,
                    'attempts': audit.attempts,
                }
                continue
            if audit.reason not in finding['reasons']:
                finding['reasons'].append(audit.reason)
            finding['first_seen_at'] = min(
                finding['first_seen_at'], audit.first_seen_at,
            )
            finding['last_seen_at'] = max(
                finding['last_seen_at'], audit.last_seen_at,
            )
            finding['attempts'] += audit.attempts
        return list(findings.values())

    @staticmethod
    def _audit_contract_matches_intent(audit, intent, stripe_transaction):
        return (
            audit.stripe_transaction_id == stripe_transaction.pk
            and audit.reason == 'exact_intent'
            and audit.adjustment_tuzis == 0
            and bool(audit.provider_event_id)
            and audit.received_session_created_epoch is not None
            and audit.received_session_created_epoch > 0
            and audit.expected_legacy_session_created_at_or_before_epoch is None
            and audit.received_checkout_session_id
            == intent.stripe_checkout_session_id
            and audit.received_payment_intent_id
            == intent.stripe_payment_intent_id
            and audit.received_user_id == intent.user_id
            and audit.received_tuzis == intent.tuzis
            and audit.received_amount_cents == intent.amount_cents
            and audit.received_currency == intent.currency
            and audit.received_pricing_version == intent.pricing_version
        )

    @staticmethod
    def _audit_identity_matches_intent(audit, intent):
        return (
            audit.expected_stripe_account_id == intent.stripe_account_id
            and audit.expected_stripe_mode == intent.stripe_mode
            and audit.expected_stripe_livemode is intent.stripe_livemode
            and audit.received_stripe_mode == intent.stripe_mode
            and audit.received_stripe_livemode is intent.stripe_livemode
            and audit.received_event_livemode is intent.stripe_livemode
            and audit.received_event_account_id in {
                '', intent.stripe_account_id,
            }
            and audit.received_metadata_account_id
            == intent.stripe_account_id
            and audit.received_metadata_mode == intent.stripe_mode
            and audit.received_metadata_livemode is intent.stripe_livemode
        )

    def handle(self, *args, **options):
        try:
            self.provider_identity = configured_stripe_identity()
        except StripeIdentityConfigurationError as exc:
            raise CommandError(
                'Stripe account/mode identity is not safely configured'
            ) from exc
        self.stdout.write(
            'stripe-identity '
            f'account={self.provider_identity.account_id} '
            f'mode={self.provider_identity.mode} '
            f'livemode={str(self.provider_identity.livemode).lower()}'
        )
        repair = options['repair']
        if repair:
            raise CommandError(
                'automatic legacy repair is disabled: StripeTransaction does '
                'not preserve signed currency/account evidence'
            )
        raw_legacy_before = options['legacy_before']
        if repair and not raw_legacy_before:
            raise CommandError(
                '--repair requires the recorded pre-rollout --legacy-before '
                'timestamp; post-rollout unlinked rows are not safe to infer'
            )
        earliest_intent = CheckoutIntent.objects.order_by(
            'created_at'
        ).values_list('created_at', flat=True).first()
        classify_legacy = earliest_intent is None or bool(raw_legacy_before)
        if not classify_legacy and options['fail_on_drift']:
            raise CommandError(
                '--legacy-before is required once CheckoutIntents exist; '
                'unlinked post-rollout rows are ambiguous'
            )
        if not classify_legacy:
            # The bare, scheduled run. Unlinked rows are counted as
            # `unlinked_unclassified` and judged as nothing -- neither legacy
            # drift nor post-cutoff drift -- because only the operator's
            # recorded cutoff can tell those apart.
            self.stdout.write(
                'legacy-classification skipped: --legacy-before not given '
                'and CheckoutIntents exist'
            )
        legacy_before = None
        if raw_legacy_before:
            legacy_before = parse_datetime(raw_legacy_before)
            if legacy_before is None or timezone.is_naive(legacy_before):
                raise CommandError(
                    '--legacy-before must be an ISO-8601 timestamp with timezone'
                )
            if earliest_intent is not None and legacy_before > earliest_intent:
                raise CommandError(
                    '--legacy-before is later than the first CheckoutIntent; '
                    'that could classify card-v2 rows as historical'
                )
        stale_minutes = options['intent_stale_minutes']
        if stale_minutes < 1:
            raise CommandError('--intent-stale-minutes must be at least 1')
        # First, before the O(history) audit below: if that ever outgrows
        # the CronJob's deadline, the findings the page counts have already
        # been written.
        unresolved_rejections = self._unresolved_rejections()
        for finding in unresolved_rejections:
            self.stdout.write(_json_line({
                'event': UNRESOLVED_REJECTION_EVENT,
                'audit_id': finding['audit_id'],
                'provider_event_id': finding['provider_event_id'],
                'reasons': finding['reasons'],
                'intent': finding['intent'],
                'first_seen_at': _iso(finding['first_seen_at']),
                'last_seen_at': _iso(finding['last_seen_at']),
                'attempts': finding['attempts'],
            }))
        # The CronJob's stdout is a pipe, so Python block-buffers it: without
        # this, a run killed at activeDeadlineSeconds during the scan below
        # discards the findings it already "wrote" and the page never fires.
        self.stdout.flush()
        stats = {
            'transactions': 0,
            'intent_linked': 0,
            'legacy': 0,
            'exact': 0,
            'undercredited': 0,
            'overcredited': 0,
            'invalid_amount': 0,
            'post_cutoff_unlinked': 0,
            'unlinked_unclassified': 0,
        }
        linked_payment_intents = set(
            CheckoutIntent.objects.exclude(stripe_payment_intent_id=None)
            .values_list('stripe_payment_intent_id', flat=True)
        )
        for row in StripeTransaction.objects.select_related('user').order_by('pk'):
            stats['transactions'] += 1
            if row.stripe_charge_id in linked_payment_intents:
                stats['intent_linked'] += 1
                continue
            if not classify_legacy:
                stats['unlinked_unclassified'] += 1
                continue
            if legacy_before is not None and row.timestamp >= legacy_before:
                stats['post_cutoff_unlinked'] += 1
                continue
            stats['legacy'] += 1
            expected = historical_card_quantity(row.amount)
            if expected is None:
                stats['invalid_amount'] += 1
                self.stdout.write(
                    f'invalid transaction={row.pk} amount_cents={row.amount}'
                )
                continue
            stats['exact'] += 1
            drift = expected - row.tuzis_credited
            if drift > 0:
                stats['undercredited'] += 1
                self.stdout.write(
                    f'undercredited transaction={row.pk} '
                    f'credited={row.tuzis_credited} expected={expected}'
                )
            elif drift < 0:
                stats['overcredited'] += 1
                self.stdout.write(
                    f'overcredited transaction={row.pk} '
                    f'credited={row.tuzis_credited} expected={expected}'
                )

        intent_drift = 0
        identity_drift = 0
        evidence_drift = 0
        fulfilled_intents = 0
        for intent in CheckoutIntent.objects.filter(
            state=CheckoutIntent.State.FULFILLED
        ).order_by('pk'):
            fulfilled_intents += 1
            row = StripeTransaction.objects.filter(
                stripe_charge_id=intent.stripe_payment_intent_id
            ).first()
            successful_audits = list(intent.fulfillment_audits.filter(
                outcome__in=[
                    CheckoutFulfillmentAudit.Outcome.CREDITED,
                    CheckoutFulfillmentAudit.Outcome.DUPLICATE,
                ]
            ))
            contract_matches = [
                self._audit_contract_matches_intent(audit, intent, row)
                for audit in successful_audits
            ] if row is not None else [False for _ in successful_audits]
            identity_matches = [
                self._audit_identity_matches_intent(audit, intent)
                for audit in successful_audits
            ]
            if (
                row is None
                or row.user_id != intent.user_id
                or row.amount != intent.amount_cents
                or row.tuzis_credited != intent.tuzis
                or not any(contract_matches)
            ):
                intent_drift += 1
                self.stdout.write(f'intent-drift intent={intent.public_id}')
            if not any(identity_matches):
                identity_drift += 1
                self.stdout.write(
                    f'intent-identity-drift intent={intent.public_id}'
                )
            if not any(
                contract_ok and identity_ok
                for contract_ok, identity_ok in zip(
                    contract_matches, identity_matches, strict=True,
                )
            ):
                evidence_drift += 1
                self.stdout.write(
                    f'intent-evidence-drift intent={intent.public_id}'
                )

        stale_before = timezone.now() - timedelta(
            minutes=stale_minutes,
        )
        stale_intents = CheckoutIntent.objects.filter(
            state__in=[CheckoutIntent.State.CREATING, CheckoutIntent.State.OPEN],
            created_at__lt=stale_before,
        ).count()
        coverage = {
            **stats,
            'intents': CheckoutIntent.objects.count(),
            'fulfilled_intents': fulfilled_intents,
            'intent_drift': intent_drift,
            'identity_drift': identity_drift,
            'evidence_drift': evidence_drift,
            'stale_intents': stale_intents,
            'unresolved_rejections': len(unresolved_rejections),
        }
        self.stdout.write(
            'coverage ' + ' '.join(
                f'{key}={value}' for key, value in coverage.items()
            )
        )
        # The heartbeat: exactly one per run that got this far, whatever it
        # found. `stripe-fulfillment-reconcile-absent` alerts on its absence.
        self.stdout.write(_json_line({
            'event': RECONCILE_EVENT,
            'status': 'completed',
            'legacy_classified': classify_legacy,
            **coverage,
        }))
        unresolved_undercredit = stats['undercredited']
        unresolved = (
            unresolved_undercredit
            + stats['overcredited']
            + stats['invalid_amount']
            + stats['post_cutoff_unlinked']
            + intent_drift
            + identity_drift
            + evidence_drift
            + stale_intents
            + len(unresolved_rejections)
        )
        if options['fail_on_drift'] and unresolved:
            raise CommandError(f'{unresolved} unresolved Stripe drift finding(s)')
