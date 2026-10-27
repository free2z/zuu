"""Provider-authenticated reconciliation using owned Postgres and fixtures."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
import json
import signal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import time
from types import SimpleNamespace

import pytest
import stripe
from django.db import close_old_connections, connection, transaction
from django.utils import timezone
from django.urls import reverse

from dj.apps.economy import services as money
from dj.apps.economy.models import EconomicPolicy, FundingReservation
from dj.apps.economy.tests.test_foundation import activate_for_test
from dj.apps.ledger.models import Account, PurchaseRefund, Transfer
from dj.apps.tuzis.models import IdempotencyKey
from dj.apps.ztripe import economic_events as events
from dj.apps.ztripe.models import StripeTransaction
from dj.apps.ztripe.stripe_identity import StripeIdentity

pytestmark = pytest.mark.django_db
IDENTITY = StripeIdentity(account_id='acct_testactual1234', mode='payment', livemode=False)


@pytest.fixture
def funded(creator_factory):
    buyer = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    reservation = money.reserve_funding(recipient_id=buyer.pk, purchaser_id=buyer.pk,
        amount_m2z=1_000_000, sale_nusd=10_000_000_000, idempotency_key='actual-card-intent:1')
    money.issue_reserved_funding(reservation_id=reservation.pk, rail='stripe', receipt={
        'provider_reference': 'pi_actual', 'captured_at': timezone.now().isoformat(), 'amount_cents': 1000,
        'stripe_account_id': IDENTITY.account_id, 'stripe_livemode': IDENTITY.livemode})
    StripeTransaction.objects.create(user=buyer, amount=1000, tuzis_credited=1000, stripe_charge_id='pi_actual')
    return buyer, PurchaseRefund.objects.get(ref_kind='funding_reservation', ref_id=str(reservation.pk))


def page(values, *, has_more=False):
    return SimpleNamespace(data=list(values), has_more=has_more)


def reader_fixture(*, refunds=(), disputes=(), captured_refunded=None, refund_has_more=False,
                   dispute_has_more=False, charge_error=None):
    charge = {'id': 'ch_actual', 'payment_intent': 'pi_actual', 'livemode': False,
        'currency': 'usd', 'amount': 1000,
        'amount_refunded': sum(row['amount'] for row in refunds if row['status'] == 'succeeded')
            if captured_refunded is None else captured_refunded}
    movements = {row['id']: row for dispute in disputes for row in dispute['balance_transactions']}
    refunds_by_id = {row['id']: row for row in refunds if row.get('balance_transaction')}
    failed_refunds_by_id = {row['failure_balance_transaction']: row for row in refunds
        if row.get('failure_balance_transaction')}
    def balance_transaction(identifier):
        if identifier in movements:
            return movements[identifier]
        if identifier in failed_refunds_by_id:
            failed = failed_refunds_by_id[identifier]
            return {'id': identifier, 'source': failed['id'], 'currency': 'usd',
                'amount': failed['amount'], 'type': 'refund_failure'}
        return {
            'id': identifier, 'source': refunds_by_id[identifier.removeprefix('txn_refund_')]['id'],
            'currency': 'usd', 'amount': -refunds_by_id[identifier.removeprefix('txn_refund_')]['amount'], 'type': 'refund'}
    def charge_retrieve(_charge_id):
        if charge_error:
            raise charge_error
        return charge
    reader = SimpleNamespace(charge=charge_retrieve,
        refunds=lambda _charge_id: page(refunds, has_more=refund_has_more),
        balance_transaction=balance_transaction,
        disputes=lambda _charge_id: page([{'id': row['id']} for row in disputes], has_more=dispute_has_more),
        dispute=lambda identifier: next(row for row in disputes if row['id'] == identifier))
    return reader


def boundary(mocker, *, refunds=(), disputes=(), captured_refunded=None,
              refund_has_more=False, dispute_has_more=False, charge_error=None):
    reader = reader_fixture(refunds=refunds, disputes=disputes, captured_refunded=captured_refunded,
        refund_has_more=refund_has_more, dispute_has_more=dispute_has_more, charge_error=charge_error)
    mocker.patch.object(events, 'financial_provider_reader', return_value=reader)


def refund(identifier, amount):
    return {'id': identifier, 'charge': 'ch_actual', 'currency': 'usd', 'amount': amount,
        'status': 'succeeded', 'balance_transaction': f'txn_refund_{identifier}'}


def event(event_id, kind='refund.updated', *, dispute_id='du_actual', created=100):
    obj = {'id': 're_actual', 'charge': 'ch_actual', 'payment_intent': 'pi_actual'}
    if kind.startswith('charge.dispute.'):
        obj = {'id': dispute_id, 'charge': 'ch_actual', 'payment_intent': 'pi_actual', 'status': 'needs_response'}
    return {'id': event_id, 'type': kind, 'created': created, 'livemode': False,
        'data': {'object': obj}}


def disputed(movements=(), *, amount=250, status='needs_response'):
    return {'id': 'du_actual', 'charge': 'ch_actual', 'currency': 'usd', 'livemode': False,
        'amount': amount, 'status': status, 'balance_transactions': list(movements)}


def movement(identifier, amount):
    return {'id': identifier, 'source': 'du_actual', 'currency': 'usd', 'amount': amount,
        'fee': 1500 if amount < 0 else 0, 'net': amount - (1500 if amount < 0 else 0)}


def test_default_off_records_plan_without_ledger_mutation(funded, mocker, settings):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = False
    boundary(mocker, refunds=[refund('re_success', 100)])
    result = events.handle_financial_event(event('evt_dry'), IDENTITY)
    assert result.status == 'pending_resolution' and result.reason == 'financial_reconciliation_disabled'
    cursor.refresh_from_db()
    buyer.refresh_from_db()
    assert cursor.refunded_m2z == 0 and buyer.tuzis == 1000
    record = IdempotencyKey.objects.get(scope='stripe-financial-event', key='evt_dry')
    assert record.response_body['plan']['target_m2z'] == '100000'
    assert record.response_body['plan']['provider_movement_proven'] is True


def test_partial_refunds_are_cumulative_order_independent_and_replay_safe(funded, mocker, settings):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    one = refund('re_first', 100)
    two = refund('re_second', 200)
    boundary(mocker, refunds=[one])
    assert events.handle_financial_event(event('evt_one'), IDENTITY).status == 'reconciled'
    cursor.refresh_from_db()
    assert cursor.refunded_m2z == 100_000

    # A redelivered event can observe newer provider state even when its Stripe
    # creation timestamp is unchanged. Read-start ordering safely applies it.
    boundary(mocker, refunds=[one, two])
    reordered = events.handle_financial_event(event('evt_one'), IDENTITY)
    cursor.refresh_from_db()
    assert reordered.status == 'reconciled' and reordered.reason == 'verified_provider_movement_applied'
    assert cursor.refunded_m2z == 300_000

    events.handle_financial_event(event('evt_two', created=200), IDENTITY)
    cursor.refresh_from_db()
    assert cursor.refunded_m2z == 300_000
    assert Transfer.objects.filter(ref_kind='funding_reservation', ref_id=cursor.ref_id,
        code__in=['clawback', 'clawback_debt']).count() == 2

    events.handle_financial_event(event('evt_two', created=200), IDENTITY)
    cursor.refresh_from_db()
    assert cursor.refunded_m2z == 300_000
    assert Transfer.objects.filter(ref_kind='funding_reservation', ref_id=cursor.ref_id,
        code__in=['clawback', 'clawback_debt']).count() == 2


def test_identical_applied_snapshot_stays_pending_after_operator_changes_cursor(funded, mocker, settings, caplog):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    boundary(mocker, refunds=[refund('re_operator_cursor', 100)])
    signed = event('evt_operator_cursor')
    first = events.handle_financial_event(signed, IDENTITY)
    assert first.status == 'reconciled'

    # Simulate an operator repair/clawback that changes the live SQL cursor
    # without changing the provider snapshot already stored as applied.
    PurchaseRefund.objects.filter(pk=cursor.pk).update(refunded_m2z=200_000)
    replay = events.handle_financial_event(signed, IDENTITY)

    cursor.refresh_from_db()
    record = IdempotencyKey.objects.get(scope='stripe-financial-event', key='evt_operator_cursor')
    assert replay.status == 'pending_resolution'
    assert replay.reason == 'provider_snapshot_cursor_mismatch'
    assert cursor.refunded_m2z == 200_000
    assert record.response_body['status'] == 'pending_resolution'
    assert record.response_body['reason'] == 'provider_snapshot_cursor_mismatch'
    assert any(row.message == 'stripe_financial_reconciliation_pending' and
        row.reason == 'provider_snapshot_cursor_mismatch' for row in caplog.records)


def test_account_bound_legacy_stripe_transaction_without_journal_stays_unresolved(creator_factory, mocker, settings):
    from dj.apps.ztripe.models import CheckoutIntent

    buyer = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    purchase = StripeTransaction.objects.create(user=buyer, amount=1000,
        tuzis_credited=1000, stripe_charge_id='pi_actual')
    CheckoutIntent.objects.create(user=buyer, tuzis=1000, amount_cents=1000,
        currency='usd', pricing_version='fixture-v1', stripe_account_id=IDENTITY.account_id,
        stripe_mode='payment', stripe_livemode=False, stripe_checkout_session_id='cs_actual',
        stripe_payment_intent_id='pi_actual', state=CheckoutIntent.State.FULFILLED,
        fulfilled_at=timezone.now())

    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    boundary(mocker, refunds=[refund('re_partial', 100)])
    result = events.handle_financial_event(event('evt_stripe_transaction'), IDENTITY)
    buyer.refresh_from_db()
    assert result.status == 'pending_resolution' and result.reason == 'original_issuance_unproven'
    assert buyer.tuzis == 0
    assert not PurchaseRefund.objects.filter(ref_kind='stripe_transaction', ref_id=str(purchase.pk)).exists()


def test_proven_legacy_issuance_without_original_account_proof_is_preserved(creator_factory, mocker, settings):
    from dj.apps.ledger import api as usage

    buyer = creator_factory(tuzis=0)
    purchase = StripeTransaction.objects.create(user=buyer, amount=1000,
        tuzis_credited=1000, stripe_charge_id='pi_actual')
    # This is a true pre-cutover native ledger receipt: use the existing
    # credit_purchase function while the test policy is still disabled, then
    # install the production writer fence exactly as every other integration
    # fixture does. No old SQL or bypassed journal insert is used.
    usage.credit_purchase(buyer.pk, 1_000_000, 'stripe', 'stripe_transaction',
        str(purchase.pk), 'legacy-stripe-issuance')
    with transaction.atomic():
        activate_for_test()
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    cursor = PurchaseRefund.objects.get(ref_kind='stripe_transaction', ref_id=str(purchase.pk))
    boundary(mocker, refunds=[refund('re_partial', 100)])

    result = events.handle_financial_event(event('evt_account_unknown'), IDENTITY)

    cursor.refresh_from_db()
    record = IdempotencyKey.objects.get(scope='stripe-financial-event', key='evt_account_unknown')
    assert result.status == 'pending_resolution' and result.reason == 'original_provider_account_unproven'
    assert record.response_body['plan']['issuance_proven'] is True
    assert record.response_body['plan']['issuance_ref_kind'] == 'stripe_transaction'
    assert record.response_body['plan']['issuance_ref_id'] == str(cursor.ref_id)
    assert record.response_body['plan']['issued_m2z'] == '1000000'
    buyer.refresh_from_db()
    assert cursor.refunded_m2z == 0 and buyer.tuzis == 1000


def test_applied_snapshot_survives_changed_event_replay_as_separate_evidence(funded, mocker, settings):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    first_refund = refund('re_first_snapshot', 100)
    boundary(mocker, refunds=[first_refund])
    applied = events.handle_financial_event(event('evt_evidence'), IDENTITY)
    assert applied.status == 'reconciled'
    original = list(IdempotencyKey.objects.filter(scope='stripe-financial-evidence', user_id=buyer.pk,
        response_body__snapshot__signed_event__provider_event_id='evt_evidence'))
    assert len(original) == 1
    original_body = original[0].response_body
    operation = original_body['outcomes'][0]['ledger_operation']
    assert operation['cursor_ref_kind'] == cursor.ref_kind
    assert operation['cursor_ref_id'] == cursor.ref_id
    assert operation['idempotency_key'].startswith('stripe-financial:pi_actual:')
    assert operation['transfer_key']['transfer_id'] is None
    assert operation['transfer_key']['detail']['clawed'] == 100_000
    assert Transfer.objects.filter(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id,
        code='clawback', amount=100_000).exists()
    assert original_body['snapshot']['provider_snapshot']['refund_movement_ids'] == ['txn_refund_re_first_snapshot']

    changed_refund = refund('re_changed_snapshot', 200)
    boundary(mocker, refunds=[first_refund, changed_refund])
    pending = events.handle_financial_event(event('evt_evidence'), IDENTITY)
    assert pending.status == 'reconciled' and pending.reason == 'verified_provider_movement_applied'
    rows = list(IdempotencyKey.objects.filter(scope='stripe-financial-evidence', user_id=buyer.pk,
        response_body__snapshot__signed_event__provider_event_id='evt_evidence').order_by('pk'))
    assert len(rows) == 2
    assert rows[0].response_body == original_body
    assert rows[0].response_body['outcomes'][0]['ledger_operation']['idempotency_key'] == operation['idempotency_key']
    assert rows[1].response_body['snapshot']['provider_snapshot']['refund_ids'] == [
        're_changed_snapshot', 're_first_snapshot']
    assert rows[1].response_body['outcomes'][0]['reason'] == 'verified_provider_movement_applied'


def test_failed_refund_transition_restores_only_returned_principal(funded, mocker, settings):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    first = refund('re_first_live', 100)
    second = refund('re_second_live', 200)
    boundary(mocker, refunds=[first])
    assert events.handle_financial_event(event('evt_first_live', created=100), IDENTITY).status == 'reconciled'
    boundary(mocker, refunds=[first, second])
    assert events.handle_financial_event(event('evt_second_live', created=200), IDENTITY).status == 'reconciled'
    cursor.refresh_from_db()
    assert cursor.refunded_m2z == 300_000

    failed = dict(second, status='failed', balance_transaction=None,
        failure_balance_transaction='txn_failed_second')
    boundary(mocker, refunds=[first, failed])
    result = events.handle_financial_event(event('evt_second_failed', created=300), IDENTITY)
    cursor.refresh_from_db()
    buyer.refresh_from_db()
    assert result.status == 'reconciled'
    assert cursor.refunded_m2z == 100_000 and buyer.tuzis == 900
    assert Transfer.objects.filter(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id,
        code='restore', amount=200_000).count() == 1


@pytest.mark.parametrize('initial_refund_cents', [0, 100])
def test_no_credit_change_retains_failed_refund_evidence(funded, mocker, settings, initial_refund_cents):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    stable = [refund('re_stable', initial_refund_cents)] if initial_refund_cents else []
    boundary(mocker, refunds=stable)
    assert events.handle_financial_event(event('evt_before_failure'), IDENTITY).status == 'reconciled'
    succeeded = refund('re_failed_between_reads', 200)
    failed = dict(succeeded, status='failed', balance_transaction=None,
        failure_balance_transaction='txn_failed_between_reads')
    boundary(mocker, refunds=[*stable, failed])
    observed = events.handle_financial_event(event('evt_observed_failure'), IDENTITY)
    assert observed.status == 'reconciled'
    state = IdempotencyKey.objects.get(scope='stripe-financial-state', key='pi_actual')
    failure_plan = state.response_body

    # A later read can coherently return an older success status and its debit
    # movement. A completed failure already proves that principal returned.
    boundary(mocker, refunds=[*stable, succeeded])
    stale = events.handle_financial_event(event('evt_stale_success'), IDENTITY)
    cursor.refresh_from_db()
    buyer.refresh_from_db()
    assert stale.status == 'pending_resolution' and stale.reason == 'provider_snapshot_regressed'
    assert cursor.refunded_m2z == initial_refund_cents * 1000
    assert buyer.tuzis == 1000 - initial_refund_cents
    assert not Transfer.objects.filter(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id,
        code='clawback', amount=200_000).exists()
    assert failure_plan['applied_plan']['refund_failure_balance_transactions'][0][
        'balance_transaction_id'] == 'txn_failed_between_reads'
    state.refresh_from_db()
    assert state.response_body == failure_plan


def test_failed_refund_without_proven_reversal_stays_pending(funded, mocker, settings):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    prior = refund('re_failed_without_reversal', 200)
    boundary(mocker, refunds=[prior])
    assert events.handle_financial_event(event('evt_failed_prior', created=100), IDENTITY).status == 'reconciled'

    failed = dict(prior, status='failed', balance_transaction=None, failure_balance_transaction=None)
    boundary(mocker, refunds=[failed])
    result = events.handle_financial_event(event('evt_failed_no_reversal', created=200), IDENTITY)

    cursor.refresh_from_db()
    buyer.refresh_from_db()
    assert result.status == 'pending_resolution' and result.reason == 'provider_snapshot_regressed'
    assert cursor.refunded_m2z == 200_000 and buyer.tuzis == 800
    assert not Transfer.objects.filter(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id,
        code='restore').exists()


def test_lower_target_without_return_evidence_stays_pending(funded, mocker, settings):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    boundary(mocker, refunds=[refund('re_still_succeeded', 100)])
    assert events.handle_financial_event(event('evt_refund_still_succeeded', created=100), IDENTITY).status == 'reconciled'

    # A complete list that merely omits a previously successful refund is not
    # proof that principal returned; status and movement evidence are required.
    boundary(mocker, refunds=[])
    result = events.handle_financial_event(event('evt_unexplained_lower_target', created=200), IDENTITY)
    cursor.refresh_from_db()
    buyer.refresh_from_db()
    assert result.status == 'pending_resolution' and result.reason == 'provider_snapshot_regressed'
    assert cursor.refunded_m2z == 100_000 and buyer.tuzis == 900
    assert not Transfer.objects.filter(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id,
        code='restore').exists()


def test_ledger_replay_without_cursor_transition_stays_pending(funded, mocker, settings):
    from types import SimpleNamespace
    from dj.apps.ledger import api as usage

    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    boundary(mocker, refunds=[refund('re_replay_control', 100)])
    mocker.patch.object(usage, 'refund_purchase', return_value=SimpleNamespace(
        status='replayed', refunded_m2z=100_000, clawed=0, debt_added=0))

    result = events.handle_financial_event(event('evt_ledger_replay', created=100), IDENTITY)

    cursor.refresh_from_db()
    buyer.refresh_from_db()
    state = IdempotencyKey.objects.filter(scope='stripe-financial-state', key='pi_actual').first()
    assert result.status == 'pending_resolution' and result.reason == 'ledger_transition_not_applied'
    assert cursor.refunded_m2z == 0 and buyer.tuzis == 1000
    assert state is not None and 'snapshot_fingerprint' not in state.response_body


def test_older_started_snapshot_cannot_restore_after_newer_read_applies(funded, mocker, settings):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    first = refund('re_race_first', 100)
    second = refund('re_race_second', 200)
    started = {'evt_read_first': '2026-10-16T10:00:00+00:00',
        'evt_read_second': '2026-10-16T10:00:01+00:00'}
    mocker.patch.object(events, '_financial_snapshot_started_at', side_effect=[
        started['evt_read_first'], started['evt_read_second']])
    original_apply = events._apply_financial_plan
    deferred = {}

    def defer_first(**kwargs):
        if kwargs['plan']['provider_event_id'] == 'evt_read_first':
            deferred.update(kwargs)
            return events.EventOutcome('deferred_for_test')
        return original_apply(**kwargs)

    mocker.patch.object(events, '_apply_financial_plan', side_effect=defer_first)
    boundary(mocker, refunds=[first])
    events.handle_financial_event(event('evt_read_first', created=200), IDENTITY)
    boundary(mocker, refunds=[first, second])
    newer = events.handle_financial_event(event('evt_read_second', created=100), IDENTITY)
    assert newer.status == 'reconciled'

    stale = original_apply(**deferred)
    cursor.refresh_from_db()
    buyer.refresh_from_db()
    assert stale.status == 'retry' and stale.reason == 'provider_snapshot_read_superseded'
    assert cursor.refunded_m2z == 300_000 and buyer.tuzis == 700
    assert not Transfer.objects.filter(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id,
        code='restore').exists()


def test_dispute_principal_excludes_fees_and_reinstatement_restores_only_dispute(funded, mocker, settings):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    partial = refund('re_partial', 100)
    boundary(mocker, refunds=[partial], disputes=[disputed([movement('txn_withdraw', -250)])])
    events.handle_financial_event(event('evt_withdraw', 'charge.dispute.funds_withdrawn'), IDENTITY)
    cursor.refresh_from_db()
    assert cursor.refunded_m2z == 350_000

    # Balance transaction principal returns; the 1500-cent fee never becomes
    # utility debt or a second debit. The original successful refund remains.
    restored = disputed([movement('txn_withdraw', -250), movement('txn_reinstate', 250)], status='won')
    boundary(mocker, refunds=[partial], disputes=[restored])
    result = events.handle_financial_event(event('evt_reinstated', 'charge.dispute.closed', created=200), IDENTITY)
    cursor.refresh_from_db()
    assert result.status == 'reconciled' and cursor.refunded_m2z == 100_000
    account = Account.objects.get(owner=buyer, kind='user')
    assert account.frozen is True  # Manual supported resolution still owns unfreezing.


def test_capped_refund_and_dispute_overlap_restores_to_current_cumulative_target(funded, mocker, settings):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    partial = refund('re_overlap_partial', 100)
    withdrawn = disputed([movement('txn_overlap_withdraw', -1000)], amount=1000)
    boundary(mocker, refunds=[partial], disputes=[withdrawn])
    first = events.handle_financial_event(
        event('evt_overlap_withdrawn', 'charge.dispute.funds_withdrawn', created=100), IDENTITY)
    cursor.refresh_from_db()
    assert first.status == 'reconciled' and cursor.refunded_m2z == 1_000_000

    reinstated = disputed([movement('txn_overlap_withdraw', -1000),
        movement('txn_overlap_return', 1000)], amount=1000, status='won')
    boundary(mocker, refunds=[partial], disputes=[reinstated])
    result = events.handle_financial_event(
        event('evt_overlap_reinstated', 'charge.dispute.closed', created=200), IDENTITY)

    cursor.refresh_from_db()
    buyer.refresh_from_db()
    assert result.status == 'reconciled'
    assert cursor.refunded_m2z == 100_000 and buyer.tuzis == 900
    assert Transfer.objects.filter(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id,
        code='restore', amount=900_000).count() == 1


def test_dispute_return_and_new_refund_reconcile_the_net_cumulative_change(funded, mocker, settings):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    withdrawn = disputed([movement('txn_mixed_withdraw', -250)])
    boundary(mocker, disputes=[withdrawn])
    first = events.handle_financial_event(
        event('evt_mixed_withdrawn', 'charge.dispute.funds_withdrawn', created=100), IDENTITY)
    cursor.refresh_from_db()
    assert first.status == 'reconciled' and cursor.refunded_m2z == 250_000

    # A new refund increases outflow while the older dispute return decreases
    # it. The net target remains provider-backed and must not be refused.
    partial = refund('re_mixed_new_refund', 100)
    reinstated = disputed([movement('txn_mixed_withdraw', -250),
        movement('txn_mixed_return', 250)])
    boundary(mocker, refunds=[partial], disputes=[reinstated])
    result = events.handle_financial_event(
        event('evt_mixed_return_plus_refund', 'charge.dispute.closed', created=200), IDENTITY)

    cursor.refresh_from_db()
    buyer.refresh_from_db()
    assert result.status == 'reconciled'
    assert cursor.refunded_m2z == 100_000 and buyer.tuzis == 900
    assert Transfer.objects.filter(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id,
        code='restore', amount=150_000).count() == 1


@pytest.mark.parametrize('category', ['refund', 'dispute'])
def test_same_category_returns_and_new_outflows_restore_only_net_principal(funded, mocker, settings, category):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    old_refund = refund('re_old_500', 500)
    withdrawal = movement('txn_old_500', -500)
    if category == 'refund':
        boundary(mocker, refunds=[old_refund])
    else:
        boundary(mocker, disputes=[disputed([withdrawal], amount=500)])
    assert events.handle_financial_event(event('evt_old_500'), IDENTITY).status == 'reconciled'
    cursor.refresh_from_db()
    assert cursor.refunded_m2z == 500_000

    if category == 'refund':
        returned = dict(old_refund, status='failed', balance_transaction=None,
            failure_balance_transaction='txn_old_500_failure')
        boundary(mocker, refunds=[returned, refund('re_new_100', 100)])
    else:
        # A separate dispute withdraws 100 while the original returns 500.
        newer = {'id': 'du_new', 'charge': 'ch_actual', 'currency': 'usd', 'livemode': False,
            'amount': 100, 'status': 'needs_response', 'balance_transactions': [
                dict(movement('txn_new_100', -100), source='du_new')]}
        boundary(mocker, disputes=[disputed([withdrawal, movement('txn_return_500', 500)],
            amount=500, status='won'), newer])
    result = events.handle_financial_event(event('evt_net_100'), IDENTITY)
    cursor.refresh_from_db()
    buyer.refresh_from_db()
    assert result.status == 'reconciled'
    assert cursor.refunded_m2z == 100_000 and buyer.tuzis == 900
    assert Transfer.objects.filter(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id,
        code='restore', amount=400_000).count() == 1
    # Re-reading the same state must not restore the gross 500 or repeat 400.
    assert events.handle_financial_event(event('evt_net_100'), IDENTITY).status == 'reconciled'
    cursor.refresh_from_db()
    assert cursor.refunded_m2z == 100_000
    assert Transfer.objects.filter(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id,
        code='restore').count() == 1


def test_real_sql_replayed_transition_does_not_claim_unreached_target(funded, mocker, settings):
    from dj.apps.ledger import api as usage

    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    boundary(mocker, refunds=[refund('re_sql_replay', 100)])
    original_apply = events._apply_financial_plan
    deferred = {}

    def defer(**kwargs):
        deferred.update(kwargs)
        return events.EventOutcome('deferred_for_test')

    mocker.patch.object(events, '_apply_financial_plan', side_effect=defer)
    events.handle_financial_event(event('evt_sql_replay'), IDENTITY)
    plan = deferred['plan']
    snapshot = money._digest({'payment_intent_id': plan['payment_intent_id'],
        'refund_movement_ids': plan['refund_movement_ids'],
        'dispute_movement_ids': plan['dispute_movement_ids'], 'target_m2z': plan['target_m2z']})
    idem = f"stripe-financial:pi_actual:{money._digest({
        'snapshot': snapshot, 'operation': 'refund', 'preimage_refunded_m2z': '0'})}"
    # Consume that exact transition through installed SQL, then perform an
    # independent supported restoration. Reusing its key returns the old
    # result without changing the cursor: the application must observe that.
    with transaction.atomic():
        money.pin_policy()
        usage.refund_purchase(buyer.pk, cursor.ref_kind, cursor.ref_id, 100_000,
            'stripe:test', idem)
        usage.restore_purchase(buyer.pk, cursor.ref_kind, cursor.ref_id, 0, 'test:independent-restore')
    result = original_apply(**deferred)
    cursor.refresh_from_db()
    buyer.refresh_from_db()
    assert result.status == 'pending_resolution' and result.reason == 'ledger_transition_not_applied'
    assert cursor.refunded_m2z == 0 and buyer.tuzis == 1000
    state = IdempotencyKey.objects.get(scope='stripe-financial-state', key='pi_actual')
    assert 'snapshot_fingerprint' not in state.response_body


def test_failed_refund_restore_keeps_new_dispute_frozen(funded, mocker, settings):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    partial = refund('re_freeze_return', 500)
    boundary(mocker, refunds=[partial])
    first = events.handle_financial_event(event('evt_freeze_refund', created=100), IDENTITY)
    cursor.refresh_from_db()
    assert first.status == 'reconciled' and cursor.refunded_m2z == 500_000

    failed = dict(partial, status='failed', balance_transaction=None,
        failure_balance_transaction='txn_freeze_refund_failure')
    dispute = disputed([movement('txn_new_outstanding_dispute', -250)])
    boundary(mocker, refunds=[failed], disputes=[dispute])
    result = events.handle_financial_event(
        event('evt_freeze_refund_and_dispute', 'charge.dispute.funds_withdrawn', created=200), IDENTITY)

    cursor.refresh_from_db()
    buyer.refresh_from_db()
    assert result.status == 'reconciled' and cursor.refunded_m2z == 250_000
    assert buyer.tuzis == 750 and Account.objects.get(owner=buyer, kind='user').frozen is True
    restored = Transfer.objects.get(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id, code='restore')
    assert restored.amount == 250_000
    evidence = IdempotencyKey.objects.get(scope='stripe-financial-evidence', user_id=buyer.pk,
        response_body__snapshot__signed_event__provider_event_id='evt_freeze_refund_and_dispute')
    assert evidence.response_body['outcomes'][0]['ledger_operation']['freeze_idempotency_key']


@pytest.mark.django_db(transaction=True)
@pytest.mark.ledger_drift_expected
def test_distinct_concurrent_withdrawal_then_reinstatement_refreshes_locked_cursor(funded, mocker, settings):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    local = threading.local()
    snapshots = {
        'withdraw': [disputed([movement('txn_concurrent_withdraw', -250)])],
        'restore': [disputed([movement('txn_concurrent_withdraw', -250),
            movement('txn_concurrent_restore', 250)], status='won')],
    }
    read_times = {'withdraw': '2026-10-16T10:00:00+00:00',
        'restore': '2026-10-16T10:00:01+00:00'}
    mocker.patch.object(events, '_financial_snapshot_started_at', side_effect=lambda: read_times[local.snapshot])
    mocker.patch.object(events, 'financial_provider_reader', side_effect=lambda _identity:
        reader_fixture(disputes=snapshots[local.snapshot]))
    entered = threading.Barrier(2, timeout=10)
    withdrawal_committed = threading.Event()
    original_apply = events._apply_financial_plan

    def ordered_apply(**kwargs):
        created = kwargs['plan']['event_created']
        entered.wait(timeout=10)
        if created == 200:
            assert withdrawal_committed.wait(timeout=10)
        result = original_apply(**kwargs)
        if created == 100:
            withdrawal_committed.set()
        return result

    mocker.patch.object(events, '_apply_financial_plan', side_effect=ordered_apply)

    def handle(name, event_value):
        close_old_connections()
        local.snapshot = name
        try:
            return events.handle_financial_event(event_value, IDENTITY)
        finally:
            connection.close()

    withdrawal = event('evt_concurrent_withdraw', 'charge.dispute.funds_withdrawn', created=100)
    reinstatement = event('evt_concurrent_restore', 'charge.dispute.closed', created=200)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(handle, 'withdraw', withdrawal)
        second = pool.submit(handle, 'restore', reinstatement)
        outcomes = [first.result(timeout=20), second.result(timeout=20)]

    cursor.refresh_from_db()
    buyer.refresh_from_db()
    assert [item.status for item in outcomes] == ['reconciled', 'reconciled']
    assert cursor.refunded_m2z == 0 and buyer.tuzis == 1000
    assert Transfer.objects.filter(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id,
        code='clawback').count() == 1
    assert Transfer.objects.filter(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id,
        code='restore').count() == 1
    assert Account.objects.get(owner=buyer, kind='user').frozen is True
    _reset_test_writer_boundary()


@pytest.mark.django_db(transaction=True)
@pytest.mark.ledger_drift_expected
def test_duplicate_snapshot_advances_watermark_before_concurrent_stale_snapshot(funded, mocker, settings):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    withdrawal = [disputed([movement('txn_watermark_withdraw', -250)])]
    reinstatement = [disputed([movement('txn_watermark_withdraw', -250),
        movement('txn_watermark_restore', 250)], status='won')]
    boundary(mocker, disputes=withdrawal)
    assert events.handle_financial_event(
        event('evt_watermark_initial', 'charge.dispute.funds_withdrawn', created=100), IDENTITY).status == 'reconciled'

    local = threading.local()
    snapshots = {'duplicate': withdrawal, 'stale': reinstatement}
    initial_state = IdempotencyKey.objects.get(scope='stripe-financial-state', key='pi_actual')
    base_read_time = datetime.fromisoformat(initial_state.response_body['snapshot_read_started_at'])
    read_times = {'duplicate': (base_read_time + timedelta(seconds=2)).isoformat(),
        'stale': (base_read_time + timedelta(seconds=1)).isoformat()}
    mocker.patch.object(events, '_financial_snapshot_started_at', side_effect=lambda: read_times[local.snapshot])
    mocker.patch.object(events, 'financial_provider_reader', side_effect=lambda _identity:
        reader_fixture(disputes=snapshots[local.snapshot]))
    entered = threading.Barrier(2, timeout=10)
    duplicate_finished = threading.Event()
    original_apply = events._apply_financial_plan

    def ordered_apply(**kwargs):
        created = kwargs['plan']['event_created']
        entered.wait(timeout=10)
        if created == 200:
            assert duplicate_finished.wait(timeout=10)
        result = original_apply(**kwargs)
        if created == 300:
            duplicate_finished.set()
        return result

    mocker.patch.object(events, '_apply_financial_plan', side_effect=ordered_apply)

    def handle(name, event_value):
        close_old_connections()
        local.snapshot = name
        try:
            return events.handle_financial_event(event_value, IDENTITY)
        finally:
            connection.close()

    newest_duplicate = event('evt_watermark_same', 'charge.dispute.updated', created=300)
    delayed_change = event('evt_watermark_stale', 'charge.dispute.closed', created=200)
    with ThreadPoolExecutor(max_workers=2) as pool:
        duplicate_future = pool.submit(handle, 'duplicate', newest_duplicate)
        stale_future = pool.submit(handle, 'stale', delayed_change)
        duplicate_result = duplicate_future.result(timeout=20)
        stale_result = stale_future.result(timeout=20)

    cursor.refresh_from_db()
    buyer.refresh_from_db()
    assert duplicate_result.reason == 'provider_snapshot_already_applied'
    assert stale_result.status == 'retry' and stale_result.reason == 'provider_snapshot_read_superseded'
    assert cursor.refunded_m2z == 250_000 and buyer.tuzis == 750
    watermark = IdempotencyKey.objects.get(scope='stripe-financial-state', key='pi_actual')
    assert watermark.response_body['latest_event_created'] == 300
    assert watermark.response_body['snapshot_read_started_at'] == read_times['duplicate']
    assert Transfer.objects.filter(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id,
        code='clawback').count() == 1
    assert Transfer.objects.filter(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id,
        code='restore').count() == 0
    _reset_test_writer_boundary()


def test_same_snapshot_at_300_advances_watermark_before_different_snapshot_at_200(funded, mocker, settings):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    mocker.patch.object(events, '_financial_snapshot_started_at', side_effect=[
        '2026-10-16T10:00:00+00:00', '2026-10-16T10:00:02+00:00',
        '2026-10-16T10:00:01+00:00', '2026-10-16T10:00:03+00:00'])
    withdrawal = [disputed([movement('txn_sequential_withdraw', -250)])]
    boundary(mocker, disputes=withdrawal)
    first = events.handle_financial_event(
        event('evt_sequential_100', 'charge.dispute.funds_withdrawn', created=100), IDENTITY)
    later_duplicate = events.handle_financial_event(
        event('evt_sequential_300', 'charge.dispute.updated', created=300), IDENTITY)
    reinstated = [disputed([movement('txn_sequential_withdraw', -250),
        movement('txn_sequential_restore', 250)], status='won')]
    boundary(mocker, disputes=reinstated)
    stale = events.handle_financial_event(
        event('evt_sequential_200', 'charge.dispute.closed', created=200), IDENTITY)

    cursor.refresh_from_db()
    buyer.refresh_from_db()
    assert first.status == later_duplicate.status == 'reconciled'
    assert later_duplicate.reason == 'provider_snapshot_already_applied'
    assert stale.status == 'retry' and stale.reason == 'provider_snapshot_read_superseded'
    assert cursor.refunded_m2z == 250_000 and buyer.tuzis == 750
    state = IdempotencyKey.objects.get(scope='stripe-financial-state', key='pi_actual')
    assert state.response_body['latest_event_created'] == 300
    assert state.response_body['snapshot_read_started_at'] == '2026-10-16T10:00:02+00:00'
    assert not Transfer.objects.filter(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id,
        code='restore').exists()

    # A retry starts a fresh read; the same positive evidence can then restore
    # funds even though event.created is older than the duplicate event.
    retried = events.handle_financial_event(
        event('evt_sequential_200', 'charge.dispute.closed', created=200), IDENTITY)
    cursor.refresh_from_db()
    buyer.refresh_from_db()
    state.refresh_from_db()
    assert retried.status == 'reconciled'
    assert cursor.refunded_m2z == 0 and buyer.tuzis == 1000
    assert state.response_body['snapshot_read_started_at'] == '2026-10-16T10:00:03+00:00'
    assert Transfer.objects.filter(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id,
        code='clawback').count() == 1
    assert Transfer.objects.filter(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id,
        code='restore').count() == 1


def _reset_test_writer_boundary():
    # Transactional concurrency tests commit the test-only writer boundary;
    # restore the same inert installed state used by the existing control.
    with connection.cursor() as db:
        db.execute('ALTER TABLE economy_economicpolicy DISABLE TRIGGER economy_policy_guard')
        db.execute('UPDATE economy_economicpolicy SET version=0,fenced=false')
        db.execute('ALTER TABLE economy_economicpolicy ENABLE TRIGGER economy_policy_guard')
        db.execute('ALTER TABLE ledger_config DISABLE TRIGGER ledger_boundary_config_guard')
        db.execute('UPDATE ledger_config SET writer_boundary=false,heal_enabled=true')
        db.execute('ALTER TABLE ledger_config ENABLE TRIGGER ledger_boundary_config_guard')
        db.execute('TRUNCATE ledger_transfer,ledger_ai_usage')


def test_dispute_status_without_balance_movement_never_confiscates(funded, mocker, settings):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    boundary(mocker, disputes=[disputed([], status='lost')])
    result = events.handle_financial_event(event('evt_status_only', 'charge.dispute.closed'), IDENTITY)
    cursor.refresh_from_db()
    buyer.refresh_from_db()
    assert result.status == 'reconciled'
    assert cursor.refunded_m2z == 0 and buyer.tuzis == 1000
    assert not Transfer.objects.filter(ref_kind='funding_reservation', ref_id=cursor.ref_id,
        code__in=['clawback', 'clawback_debt']).exists()


def test_stale_provider_snapshot_cannot_overwrite_later_reinstatement(funded, mocker, settings):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    mocker.patch.object(events, '_financial_snapshot_started_at', side_effect=[
        '2026-10-16T10:00:00+00:00', '2026-10-16T10:00:01+00:00'])
    boundary(mocker, disputes=[disputed([movement('txn_withdraw', -250),
        movement('txn_reinstate', 250)], status='won')])
    latest = events.handle_financial_event(event('evt_latest', 'charge.dispute.closed', created=300), IDENTITY)
    assert latest.status == 'reconciled'

    # A later-started request can still receive a stale provider read. It must
    # not erase the already applied reinstatement movement or re-debit credits.
    boundary(mocker, disputes=[disputed([movement('txn_withdraw', -250)])])
    stale = events.handle_financial_event(event('evt_old', 'charge.dispute.funds_withdrawn', created=200), IDENTITY)
    cursor.refresh_from_db()
    buyer.refresh_from_db()
    assert stale.status == 'pending_resolution' and stale.reason == 'provider_snapshot_regressed'
    assert cursor.refunded_m2z == 0 and buyer.tuzis == 1000
    assert not Transfer.objects.filter(ref_kind='funding_reservation', ref_id=cursor.ref_id,
        code__in=['clawback', 'clawback_debt']).exists()


def test_success_label_without_refund_balance_movement_stays_unresolved(funded, mocker, settings):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    unproven = {'id': 're_missing_movement', 'charge': 'ch_actual', 'currency': 'usd',
        'amount': 100, 'status': 'succeeded', 'balance_transaction': None}
    boundary(mocker, refunds=[unproven], captured_refunded=100)
    result = events.handle_financial_event(event('evt_refund_status_only'), IDENTITY)
    cursor.refresh_from_db()
    buyer.refresh_from_db()
    record = IdempotencyKey.objects.get(scope='stripe-financial-event', key='evt_refund_status_only')
    assert result.status == 'pending_resolution' and result.reason == 'provider_movement_unproven'
    assert record.response_body['plan']['provider_movement_proven'] is False
    assert cursor.refunded_m2z == 0 and buyer.tuzis == 1000


def test_provider_timeout_preserves_evidence_and_retries(funded, mocker, settings, caplog):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    boundary(mocker, charge_error=events.ProviderReadUnavailable('provider_read_timeout'))

    result = events.handle_financial_event(event('evt_provider_timeout'), IDENTITY)

    assert result.status == 'retry' and result.reason == 'provider_read_timeout'
    record = IdempotencyKey.objects.get(scope='stripe-financial-event', key='evt_provider_timeout')
    assert record.response_body['observation']['provider_event_id'] == 'evt_provider_timeout'
    assert record.response_body['plan']['provider_snapshot_complete'] is False
    evidence = IdempotencyKey.objects.get(scope='stripe-financial-evidence',
        user_id=buyer.pk, pk=record.response_body['evidence_id'])
    snapshot = evidence.response_body['snapshot']
    assert snapshot['signed_event']['provider_event_id'] == 'evt_provider_timeout'
    assert snapshot['plan']['provider_read_reason'] == 'provider_read_timeout'
    assert evidence.response_body['outcomes'][0]['status'] == 'pending_resolution'
    assert any(row.message == 'stripe_financial_reconciliation_pending' and
        row.reason == 'provider_read_unavailable' for row in caplog.records)
    cursor.refresh_from_db()
    buyer.refresh_from_db()
    assert cursor.refunded_m2z == 0 and buyer.tuzis == 1000


def test_shared_provider_budget_discards_result_after_elapsed_deadline(mocker, tmp_path):
    worker = tmp_path / 'late_result_worker.py'
    worker.write_text('import json,sys\njson.load(sys.stdin)\nprint(\'{"status":"ok","value":"late"}\')\n')
    mocker.patch.object(events, '_PROVIDER_READ_WORKER', worker)
    clock = mocker.Mock(side_effect=[0.0, 0.0, 0.0, 11.0])
    budget = events.FinancialProviderReadBudget(seconds=10, clock=clock)
    with pytest.raises(events.ProviderReadUnavailable, match='provider_read_budget_exhausted'):
        budget.read({})
    assert budget.calls == 1


def test_provider_read_budget_refuses_expired_and_excess_calls(mocker, tmp_path):
    worker = tmp_path / 'budget_worker.py'
    worker.write_text('import json,sys\njson.load(sys.stdin)\nprint(\'{"status":"ok","value":"read"}\')\n')
    mocker.patch.object(events, '_PROVIDER_READ_WORKER', worker)
    budget = events.FinancialProviderReadBudget(max_calls=1, seconds=2)
    assert budget.read({}) == 'read'
    with pytest.raises(events.ProviderReadUnavailable, match='provider_read_budget_exhausted'):
        budget.read({})
    assert budget.calls == 1
    expired = events.FinancialProviderReadBudget(seconds=0)
    with pytest.raises(events.ProviderReadUnavailable, match='provider_read_budget_exhausted'):
        expired.read({})
    assert expired.calls == 0


def test_provider_read_admission_is_bounded(mocker):
    for _ in range(events.FINANCIAL_PROVIDER_READ_WORKERS):
        assert events._financial_provider_read_slots.acquire(blocking=False)
    spawn = mocker.spy(events.subprocess, 'Popen')
    try:
        with pytest.raises(events.ProviderReadUnavailable, match='provider_read_unavailable'):
            events.FinancialProviderReadBudget().read({})
        spawn.assert_not_called()
    finally:
        for _ in range(events.FINANCIAL_PROVIDER_READ_WORKERS):
            events._financial_provider_read_slots.release()


def test_installed_stripe_worker_kills_dns_and_response_stalls_then_recovers(settings, mocker, tmp_path):
    """Real SDK calls, stalled local sockets and DNS; no provider access."""
    settings.STRIPE_SECRET_KEY = 'sk_test_local_fixture_only'
    disconnected = []
    headers_seen = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *_args):
            pass

        def do_GET(self):
            headers_seen.append(self.headers['Stripe-Version'])
            if self.path.endswith('evt_ok'):
                body = b'{"id":"evt_ok","object":"event"}'
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path.endswith('evt_body_stall'):
                self.send_response(200)
                self.send_header('Content-Length', '10000')
                self.end_headers()
                self.wfile.write(b'{"id":')
                self.wfile.flush()
            self.connection.settimeout(3)
            disconnected.append(self.connection.recv(1) == b'')
            self.close_connection = True

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    production_worker = str(events._PROVIDER_READ_WORKER)
    wrapper = tmp_path / 'local_stripe_worker.py'
    wrapper.write_text(f"""import runpy, signal, socket, time, stripe
worker = runpy.run_path({production_worker!r})
original_client = stripe.StripeClient
def local_client(*args, **kwargs):
    assert kwargs['max_network_retries'] == 0
    assert kwargs['http_client']._timeout == 1
    kwargs['base_addresses'] = {{'api': 'http://127.0.0.1:{server.server_port}'}}
    return original_client(*args, **kwargs)
stripe.StripeClient = local_client
original_read = worker['read_provider']
def read(request):
    if request['args'] == ['evt_dns_stall']:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        socket.getaddrinfo = lambda *a, **kw: time.sleep(10)
    return original_read(request)
worker['main'].__globals__['read_provider'] = read
worker['main']()
""")
    mocker.patch.object(events, '_PROVIDER_READ_WORKER', wrapper)
    spawn = mocker.spy(events.subprocess, 'Popen')
    children = []
    original_spawn = events.subprocess.Popen

    def track_child(*args, **kwargs):
        child = original_spawn(*args, **kwargs)
        children.append(child)
        return child

    mocker.patch.object(events.subprocess, 'Popen', side_effect=track_child)
    try:
        for index in range(events.FINANCIAL_PROVIDER_READ_WORKERS + 2):
            reader = events.StripeFinancialProvider(IDENTITY,
                budget=events.FinancialProviderReadBudget(seconds=0.8))
            started = time.monotonic()
            with pytest.raises(events.ProviderReadUnavailable, match='provider_read_budget_exhausted'):
                reader.event('evt_body_stall' if index % 2 else 'evt_header_stall')
            assert time.monotonic() - started < 1
            assert children[-1].poll() is not None
        with pytest.raises(events.ProviderReadUnavailable, match='provider_read_budget_exhausted'):
            events.StripeFinancialProvider(IDENTITY,
                budget=events.FinancialProviderReadBudget(seconds=0.8)).event('evt_dns_stall')
        assert children[-1].returncode == -signal.SIGKILL
        reader = events.StripeFinancialProvider(IDENTITY)
        assert reader.event('evt_ok')['id'] == 'evt_ok'
        assert reader.budget.calls == 1
        assert disconnected == [True] * 6
        assert headers_seen == [events.STRIPE_API_VERSION] * 7
        assert all(child.poll() is not None and child.stdin.closed and child.stdout.closed
            for child in children)
        assert all(settings.STRIPE_SECRET_KEY not in str(call.args) for call in spawn.call_args_list)
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)


@pytest.mark.parametrize("failure", ["large_response", "private_exception"])
def test_worker_limits_output_and_redacts_failures(settings, mocker, tmp_path, failure):
    settings.STRIPE_SECRET_KEY = 'sk_test_do_not_expose'
    worker = tmp_path / 'large_response_worker.py'
    worker.write_text(f"""import runpy
worker = runpy.run_path({str(events._PROVIDER_READ_WORKER)!r})
def huge_response(request):
    if {failure!r} == 'private_exception':
        raise RuntimeError('sk_test_do_not_expose private provider response')
    return {{'private': 'x' * (1024 * 1024 + 1)}}
worker['main'].__globals__['read_provider'] = huge_response
worker['main']()
""")
    mocker.patch.object(events, '_PROVIDER_READ_WORKER', worker)
    with pytest.raises(events.ProviderReadUnavailable, match='^provider_read_unavailable$'):
        events.StripeFinancialProvider(IDENTITY).event('evt_large')


def test_provider_read_budget_exhaustion_keeps_incomplete_evidence(funded, mocker, settings):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    reader = reader_fixture()
    reader.refunds = lambda _charge_id: (_ for _ in ()).throw(
        events.ProviderReadUnavailable('provider_read_budget_exhausted'))
    mocker.patch.object(events, 'financial_provider_reader', return_value=reader)

    result = events.handle_financial_event(event('evt_read_budget'), IDENTITY)

    assert result.status == 'retry' and result.reason == 'provider_read_budget_exhausted'
    record = IdempotencyKey.objects.get(scope='stripe-financial-event', key='evt_read_budget')
    assert record.response_body['plan']['provider_movement_proven'] is False
    assert record.response_body['plan']['movement_reason'] == 'provider_read_budget_exhausted'
    evidence = IdempotencyKey.objects.get(scope='stripe-financial-evidence',
        user_id=buyer.pk, pk=record.response_body['evidence_id'])
    assert evidence.response_body['snapshot']['provider_snapshot']['provider_snapshot_complete'] is False
    cursor.refresh_from_db()
    buyer.refresh_from_db()
    assert cursor.refunded_m2z == 0 and buyer.tuzis == 1000


def test_restoration_blocked_by_funding_cap_preserves_cursor_and_evidence(funded, mocker, settings):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    boundary(mocker, disputes=[disputed([movement('txn_withdraw', -250)])])
    events.handle_financial_event(event('evt_withdraw', 'charge.dispute.funds_withdrawn'), IDENTITY)
    EconomicPolicy.objects.filter(id=True).update(account_daily_limit_m2z=1_100_000)

    boundary(mocker, disputes=[disputed([movement('txn_withdraw', -250), movement('txn_reinstate', 250)], status='won')])
    result = events.handle_financial_event(event('evt_cap_block', 'charge.dispute.closed', created=200), IDENTITY)
    cursor.refresh_from_db()
    assert result.status == 'pending_resolution'
    assert result.reason == 'restoration_blocked_by_funding_limit'
    assert cursor.refunded_m2z == 250_000
    record = IdempotencyKey.objects.get(scope='stripe-financial-event', key='evt_cap_block')
    assert record.response_body['plan']['target_m2z'] == '0'
    assert record.response_body['reason'] == 'restoration_blocked_by_funding_limit'


def test_captured_receipt_without_issuance_stays_attributable(creator_factory, mocker, settings):
    buyer = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    # Simulate a provider capture recorded for this buyer but no issued cursor.
    unissued = money.reserve_funding(recipient_id=buyer.pk, purchaser_id=buyer.pk,
        amount_m2z=1_000, sale_nusd=10_000_000, idempotency_key='unissued-card')
    FundingReservation.objects.filter(pk=unissued.pk).update(state='resolution', external_receipt={
        'provider_reference': 'pi_actual', 'amount_cents': 1000, 'resolution_reason': 'funding_requires_resolution',
        'stripe_account_id': IDENTITY.account_id, 'stripe_livemode': IDENTITY.livemode})
    StripeTransaction.objects.filter(stripe_charge_id='pi_actual').delete()
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    boundary(mocker, refunds=[refund('re_success', 100)])
    result = events.handle_financial_event(event('evt_unissued'), IDENTITY)
    assert result.status == 'pending_resolution' and result.reason == 'original_issuance_unproven'
    record = IdempotencyKey.objects.get(scope='stripe-financial-event', key='evt_unissued')
    assert record.response_body['plan']['issuance_proven'] is False
    assert FundingReservation.objects.get(pk=unissued.pk).state == 'resolution'


@pytest.mark.django_db(transaction=True)
@pytest.mark.ledger_drift_expected
def test_concurrent_duplicate_event_posts_one_sql_clawback(funded, mocker, settings):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    boundary(mocker, refunds=[refund('re_success', 100)])

    def apply():
        close_old_connections()
        try:
            return events.handle_financial_event(event('evt_concurrent'), IDENTITY).status
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda _: apply(), range(2)))
    cursor.refresh_from_db()
    assert outcomes == ['reconciled', 'reconciled']
    assert cursor.refunded_m2z == 100_000
    assert Transfer.objects.filter(ref_kind='funding_reservation', ref_id=cursor.ref_id,
        code__in=['clawback', 'clawback_debt']).count() == 1
    # This transaction=True test commits the test-only writer boundary; return
    # it to the installed inert state before Django flushes this database.
    with connection.cursor() as db:
        db.execute('ALTER TABLE economy_economicpolicy DISABLE TRIGGER economy_policy_guard')
        db.execute('UPDATE economy_economicpolicy SET version=0,fenced=false')
        db.execute('ALTER TABLE economy_economicpolicy ENABLE TRIGGER economy_policy_guard')
        db.execute('ALTER TABLE ledger_config DISABLE TRIGGER ledger_boundary_config_guard')
        db.execute('UPDATE ledger_config SET writer_boundary=false,heal_enabled=true')
        db.execute('ALTER TABLE ledger_config ENABLE TRIGGER ledger_boundary_config_guard')
        db.execute('TRUNCATE ledger_transfer,ledger_ai_usage')


def test_dry_run_command_is_bounded_and_read_only(funded, mocker, settings, capsys):
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = False
    boundary(mocker, refunds=[refund('re_success', 100)])
    events.handle_financial_event(event('evt_command'), IDENTITY)
    from django.core.management import call_command
    call_command('stripe_financial_reconciliation_dry_run', creator_id=buyer.pk, limit=10)
    output = capsys.readouterr().out
    assert 'evt_command' in output and '100000' in output
    cursor.refresh_from_db()
    assert cursor.refunded_m2z == 0


def test_dry_run_prioritizes_pending_and_paginates_stable_event_history(funded, capsys):
    buyer, cursor = funded
    resolved = [IdempotencyKey(scope='stripe-financial-event', user_id=buyer.pk,
        key=f'evt_resolved_{index:03}', response_status=200,
        response_body={'observation': {'provider_event_id': f'evt_resolved_{index:03}'},
            'status': 'reconciled', 'reason': 'no_cursor_change'}) for index in range(105)]
    IdempotencyKey.objects.bulk_create(resolved)
    IdempotencyKey.objects.create(scope='stripe-financial-event', user_id=buyer.pk,
        key='evt_latest_pending', response_status=200,
        response_body={'observation': {'provider_event_id': 'evt_latest_pending'},
            'status': 'pending_resolution', 'reason': 'provider_read_unavailable'})
    from django.core.management import call_command

    call_command('stripe_financial_reconciliation_dry_run', creator_id=buyer.pk, limit=5)
    pending_rows = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert len(pending_rows) == 1 and pending_rows[0]['provider_event_id'] == 'evt_latest_pending'
    assert pending_rows[0]['status'] == 'pending_resolution'

    call_command('stripe_financial_reconciliation_dry_run', creator_id=buyer.pk,
        limit=5, status='resolved')
    first_page = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert len(first_page) == 5 and first_page[-1]['next_after_id'] == int(
        first_page[-1]['resolution_id'].split(':')[1])
    after_id = int(first_page[-1]['resolution_id'].split(':')[1])
    call_command('stripe_financial_reconciliation_dry_run', creator_id=buyer.pk,
        limit=5, status='resolved', after_id=after_id)
    second_page = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert len(second_page) == 5 and int(second_page[0]['resolution_id'].split(':')[1]) > after_id
    cursor.refresh_from_db()
    buyer.refresh_from_db()
    assert cursor.refunded_m2z == 0 and buyer.tuzis == 1000


def test_signed_webhook_financial_event_uses_retrieved_provider_object(funded, mocker, settings, client):
    buyer, cursor = funded
    settings.STRIPE_SIGNING_SECRET = 'whsec_issue2546_fixture'
    settings.STRIPE_SECRET_KEY = 'sk_test_issue2546_fixture'
    settings.STRIPE_EXPECTED_ACCOUNT_ID = IDENTITY.account_id
    settings.STRIPE_EXPECTED_LIVEMODE = 'false'
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = False
    received = event('evt_signed', 'refund.updated')
    payload = json.dumps(received, separators=(',', ':'))
    canonical = dict(received, account=None)
    mocker.patch.object(events.StripeFinancialProvider, 'event', return_value=canonical)
    boundary(mocker, refunds=[refund('re_success', 100)])

    forged = client.post(reverse('stripe-webhook'), data=payload, content_type='application/json',
        HTTP_STRIPE_SIGNATURE='t=1,v1=deadbeef')
    assert forged.status_code == 400
    assert not IdempotencyKey.objects.filter(scope='stripe-financial-event', key='evt_signed').exists()

    wrong = event('evt_wrong_account', 'refund.updated')
    wrong_payload = json.dumps(wrong, separators=(',', ':'))
    wrong_signature = stripe.WebhookSignature.generate_signature_header(wrong_payload, settings.STRIPE_SIGNING_SECRET)
    mocker.patch.object(events.StripeFinancialProvider, 'event',
        return_value=dict(wrong, account='acct_wrongAccount123'))
    mismatch = client.post(reverse('stripe-webhook'), data=wrong_payload, content_type='application/json',
        HTTP_STRIPE_SIGNATURE=wrong_signature)
    assert mismatch.status_code == 503
    assert not IdempotencyKey.objects.filter(scope='stripe-financial-event', key='evt_wrong_account').exists()

    wrong_object = event('evt_wrong_object', 'refund.updated')
    wrong_object_payload = json.dumps(wrong_object, separators=(',', ':'))
    wrong_object_signature = stripe.WebhookSignature.generate_signature_header(
        wrong_object_payload, settings.STRIPE_SIGNING_SECRET)
    mismatched_canonical = dict(wrong_object, account=None)
    mismatched_canonical['data'] = {'object': dict(wrong_object['data']['object'], id='re_spoofed')}
    mocker.patch.object(events.StripeFinancialProvider, 'event', return_value=mismatched_canonical)
    mismatched = client.post(reverse('stripe-webhook'), data=wrong_object_payload,
        content_type='application/json', HTTP_STRIPE_SIGNATURE=wrong_object_signature)
    assert mismatched.status_code == 503
    assert not IdempotencyKey.objects.filter(scope='stripe-financial-event', key='evt_wrong_object').exists()

    signature = stripe.WebhookSignature.generate_signature_header(payload, settings.STRIPE_SIGNING_SECRET)
    retrieve = mocker.patch.object(events.StripeFinancialProvider, 'event', return_value=canonical)
    response = client.post(reverse('stripe-webhook'), data=payload, content_type='application/json',
        HTTP_STRIPE_SIGNATURE=signature)
    assert response.status_code == 200, response.content
    assert response.json()['reason'] == 'financial_reconciliation_disabled'
    assert retrieve.call_count == 1
    cursor.refresh_from_db()
    buyer.refresh_from_db()
    assert cursor.refunded_m2z == 0 and buyer.tuzis == 1000


@pytest.mark.parametrize(('timeout', 'pending_reason'), [
    (True, 'provider_read_budget_exhausted'),
    (False, 'provider_read_unavailable'),
])
def test_signed_event_retrieval_failure_keeps_unverified_evidence_and_retries(
        funded, mocker, settings, client, caplog, timeout, pending_reason):
    buyer, cursor = funded
    settings.STRIPE_SIGNING_SECRET = 'whsec_issue2546_fixture'
    settings.STRIPE_SECRET_KEY = 'sk_test_issue2546_fixture'
    settings.STRIPE_EXPECTED_ACCOUNT_ID = IDENTITY.account_id
    settings.STRIPE_EXPECTED_LIVEMODE = 'false'
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    received = event('evt_retrieve_timeout', 'refund.updated')
    payload = json.dumps(received, separators=(',', ':'))
    signature = stripe.WebhookSignature.generate_signature_header(payload, settings.STRIPE_SIGNING_SECRET)
    canonical = dict(received, account=None)
    base_budget = events.FinancialProviderReadBudget
    mocker.patch.object(events, 'FinancialProviderReadBudget',
        side_effect=lambda **kwargs: base_budget(seconds=0.05, **kwargs))
    def retrieve_then_succeed(*_args, **_kwargs):
        raise events.ProviderReadUnavailable(pending_reason)
    retrieve = mocker.patch.object(events.StripeFinancialProvider, '_request', side_effect=retrieve_then_succeed)
    boundary(mocker, refunds=[refund('re_retry_after_retrieve_timeout', 100)])

    timed_out = client.post(reverse('stripe-webhook'), data=payload, content_type='application/json',
        HTTP_STRIPE_SIGNATURE=signature)

    assert timed_out.status_code == 503
    assert timed_out.json()['status'] == 'retry'
    record = IdempotencyKey.objects.get(scope='stripe-financial-event', key='evt_retrieve_timeout')
    assert record.response_body['status'] == 'pending_resolution'
    assert record.response_body['reason'] == pending_reason
    evidence = IdempotencyKey.objects.get(scope='stripe-financial-evidence', user_id=buyer.pk,
        pk=record.response_body['evidence_id'])
    snapshot = evidence.response_body['snapshot']
    assert snapshot['signed_event']['provider_event_retrieved'] is False
    assert snapshot['signed_event']['signed_account_claim'] is None
    assert snapshot['provider_snapshot'] == {'provider_event_retrieved': False,
        'provider_read_reason': pending_reason}
    assert snapshot['plan']['provider_event_account_verified'] is False
    assert snapshot['plan']['provider_event_livemode_verified'] is False
    assert not any(key in snapshot for key in ('provider_event', 'canonical_event'))
    assert any(row.message == 'stripe_financial_reconciliation_pending' and
        row.reason == pending_reason for row in caplog.records)
    cursor.refresh_from_db()
    buyer.refresh_from_db()
    assert cursor.refunded_m2z == 0 and buyer.tuzis == 1000

    # Stripe's retry is retrieved and validated normally, then reconciles from
    # the canonical event and the bounded financial provider reads.
    mocker.patch.object(events.StripeFinancialProvider, 'event', return_value=canonical)
    retried = client.post(reverse('stripe-webhook'), data=payload, content_type='application/json',
        HTTP_STRIPE_SIGNATURE=signature)
    assert retried.status_code == 200, retried.content
    assert retried.json()['status'] == 'reconciled'
    cursor.refresh_from_db()
    assert cursor.refunded_m2z == 100_000
    assert retrieve.call_count == 1


@pytest.mark.parametrize('failure', ['terminate_race', 'kill_race', 'close_error'])
def test_provider_cleanup_releases_exited_admission_and_closes_both_streams(mocker, failure):
    child = mocker.Mock(returncode=0, pid=12345)
    child.communicate.return_value = (b'{"status":"ok","value":"ready"}', None)
    child.poll.return_value = None
    timeout = events.subprocess.TimeoutExpired('owned-fixture', 0.1)
    if failure == 'terminate_race':
        child.terminate.side_effect = ProcessLookupError()
    elif failure == 'kill_race':
        child.wait.side_effect = [timeout, 0]
        child.kill.side_effect = ProcessLookupError()
    else:
        child.stdin.close.side_effect = OSError('fixture close failed')
    mocker.patch.object(events.subprocess, 'Popen', return_value=child)
    if failure == 'close_error':
        with pytest.raises(events.ProviderReadUnavailable, match='^provider_read_cleanup_failed$'):
            events.FinancialProviderReadBudget().read({})
    else:
        assert events.FinancialProviderReadBudget().read({}) == 'ready'
    child.stdin.close.assert_called_once()
    child.stdout.close.assert_called_once()
    acquired = 0
    try:
        for _ in range(events.FINANCIAL_PROVIDER_READ_WORKERS):
            assert events._financial_provider_read_slots.acquire(blocking=False)
            acquired += 1
    finally:
        for _ in range(acquired):
            events._financial_provider_read_slots.release()


@pytest.mark.parametrize(('sqlstate', 'message', 'http_status', 'reason'), [
    ('40P01', 'fixture deadlock', 503, 'ledger_temporarily_unavailable'),
    ('57014', 'fixture statement timeout', 503, 'ledger_temporarily_unavailable'),
    ('23514', 'economic_writers_fenced', 200, 'economic_policy_unavailable'),
    ('23514', 'usage_daily_funding_limit', 200, 'restoration_blocked_by_funding_limit'),
    ('40P01', 'usage_daily_funding_limit', 503, 'ledger_temporarily_unavailable'),
])
def test_signed_reconciliation_retries_transient_sql_failure(
        funded, mocker, settings, client, caplog, sqlstate, message, http_status, reason):
    from dj.apps.ledger import api as usage
    buyer, cursor = funded
    settings.STRIPE_SIGNING_SECRET = 'whsec_local_retry_fixture'
    settings.STRIPE_SECRET_KEY = 'sk_test_local_retry_fixture'
    settings.STRIPE_EXPECTED_ACCOUNT_ID = IDENTITY.account_id
    settings.STRIPE_EXPECTED_LIVEMODE = 'false'
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    received = event('evt_sql_retry')
    payload = json.dumps(received, separators=(',', ':'))
    signature = stripe.WebhookSignature.generate_signature_header(payload, settings.STRIPE_SIGNING_SECRET)
    mocker.patch.object(events.StripeFinancialProvider, 'event', return_value=dict(received, account=None))
    boundary(mocker, refunds=[refund('re_sql_retry', 100)])
    original = usage.refund_purchase

    def reject(*_args, **_kwargs):
        with connection.cursor() as db:
            db.execute("DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = %s, MESSAGE = %s; END $$",
                [sqlstate, message])

    mocker.patch.object(usage, 'refund_purchase', side_effect=reject)
    refused = client.post(reverse('stripe-webhook'), data=payload, content_type='application/json',
        HTTP_STRIPE_SIGNATURE=signature)
    assert refused.status_code == http_status, refused.content
    assert refused.json()['reason'] == reason
    record = IdempotencyKey.objects.get(scope='stripe-financial-event', key='evt_sql_retry')
    assert record.response_body['status'] == 'pending_resolution'
    assert record.response_body['reason'] == reason
    assert any(row.message == 'stripe_financial_reconciliation_pending' and row.reason == reason
        for row in caplog.records)
    cursor.refresh_from_db()
    assert cursor.refunded_m2z == 0
    assert not IdempotencyKey.objects.filter(scope='stripe-financial-state', user_id=buyer.pk).exists()
    mocker.patch.object(usage, 'refund_purchase', side_effect=original)
    retried = client.post(reverse('stripe-webhook'), data=payload, content_type='application/json',
        HTTP_STRIPE_SIGNATURE=signature)
    assert retried.status_code == 200, retried.content
    assert retried.json()['status'] == 'reconciled'
    cursor.refresh_from_db()
    assert cursor.refunded_m2z == 100_000
    assert Transfer.objects.filter(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id, code='clawback').count() == 1


@pytest.mark.django_db(transaction=True)
@pytest.mark.ledger_drift_expected
def test_direct_sql_writer_and_reconciliation_share_creator_first_lock_order(funded, mocker, settings):
    from dj.apps.ledger import api as usage
    buyer, cursor = funded
    settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED = True
    boundary(mocker, refunds=[refund('re_direct_overlap', 300)])
    direct_locked = threading.Event()
    release_direct = threading.Event()
    applying = threading.Event()
    reconciliation_pid = []
    original_apply = events._apply_financial_plan

    def observed_apply(**kwargs):
        with connection.cursor() as db:
            db.execute('SELECT pg_backend_pid()')
            reconciliation_pid.append(db.fetchone()[0])
        applying.set()
        return original_apply(**kwargs)

    mocker.patch.object(events, '_apply_financial_plan', side_effect=observed_apply)

    def direct_writer():
        close_old_connections()
        try:
            with transaction.atomic():
                money.pin_policy()
                creator = usage.lock_creator(buyer.pk)
                usage.lock_account(buyer.pk, creator.balance)
                direct_locked.set()
                assert release_direct.wait(timeout=10)
                return usage.refund_purchase(buyer.pk, cursor.ref_kind, cursor.ref_id,
                    100_000, 'fixture:direct', 'fixture:direct-writer').status
        finally:
            connection.close()

    def reconcile():
        close_old_connections()
        try:
            assert direct_locked.wait(timeout=10)
            return events.handle_financial_event(event('evt_direct_overlap'), IDENTITY).status
        finally:
            connection.close()

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            direct = pool.submit(direct_writer)
            reconciliation = pool.submit(reconcile)
            try:
                assert applying.wait(timeout=10)
                deadline = time.monotonic() + 5
                while True:
                    with connection.cursor() as db:
                        db.execute('SELECT cardinality(pg_blocking_pids(%s))', [reconciliation_pid[0]])
                        if db.fetchone()[0]:
                            break
                    assert time.monotonic() < deadline, 'reconciliation never reached the held Creator lock'
                    time.sleep(0.01)
            finally:
                release_direct.set()
            assert direct.result(timeout=10) == 'posted'
            assert reconciliation.result(timeout=10) == 'reconciled'
        cursor.refresh_from_db()
        assert cursor.refunded_m2z == 300_000
        assert Transfer.objects.filter(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id,
            code='clawback').count() == 2
    finally:
        release_direct.set()
        _reset_test_writer_boundary()


@pytest.mark.parametrize('failure', ['slow_reap', 'failed_kill'])
def test_unreaped_provider_children_quarantine_bounded_admission(mocker, failure):
    slots = threading.BoundedSemaphore(events.FINANCIAL_PROVIDER_READ_WORKERS)
    mocker.patch.object(events, '_financial_provider_read_slots', slots)
    children = []
    for index in range(events.FINANCIAL_PROVIDER_READ_WORKERS):
        child = mocker.Mock(returncode=None, pid=12340 + index)
        child.poll.return_value = None
        timeout = events.subprocess.TimeoutExpired('owned-fixture', 0.1)
        child.communicate.side_effect = timeout
        child.wait.side_effect = timeout
        if failure == 'failed_kill':
            child.kill.side_effect = OSError('fixture cannot signal owned child')
        children.append(child)
    spawn = mocker.patch.object(events.subprocess, 'Popen', side_effect=children)
    for _ in children:
        with pytest.raises(events.ProviderReadUnavailable, match='^provider_read_cleanup_failed$'):
            events.FinancialProviderReadBudget().read({})
    for _ in range(3):
        with pytest.raises(events.ProviderReadUnavailable, match='^provider_read_unavailable$'):
            events.FinancialProviderReadBudget().read({})
    assert spawn.call_count == events.FINANCIAL_PROVIDER_READ_WORKERS
    for child in children:
        child.kill.assert_called_once()
        child.stdin.close.assert_called_once()
        child.stdout.close.assert_called_once()
    assert not slots.acquire(blocking=False)
