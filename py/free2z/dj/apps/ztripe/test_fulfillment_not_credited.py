"""A charged buyer whose 2Z credit is refused is loud, and stays loud.

Two halves, one per alert:

* the webhook: every verified ``checkout.session.completed`` we answer with
  anything but 200 emits ONE fixed JSON event,
  ``stripe_checkout_fulfillment_not_credited``, which the page-tier
  ``stripe-checkout-fulfillment-not-credited`` metric counts. The per-reason
  ``stripe_checkout_rejected_<reason>`` names are an open-ended family no
  filter can keep up with.
* the scheduled reconcile: ``reconcile_stripe_fulfillment`` run bare (as the
  ``stripe-fulfillment-reconcile`` CronJob runs it) reports every rejected
  delivery that nothing has credited since, one JSON line each, ends with a
  heartbeat line, and writes nothing -- so the CronJob can run it every hour,
  retry it, and overlap a human, and never credit anybody twice.

Negative control for both halves: remove the ``_log_checkout_not_credited``
call in ``views.py`` (or the ``_unresolved_rejections`` loop in the command)
and the corresponding tests here go red.
"""

import json
import logging
from datetime import timedelta
from decimal import Decimal
from io import StringIO
from pathlib import Path

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from dj.apps.events.models import Event
from dj.apps.g12f.models import Creator
from dj.apps.ztripe.models import (
    CheckoutFulfillmentAudit,
    CheckoutIntent,
    StripeCheckoutRollout,
    StripeTransaction,
)
from dj.apps.ztripe.test_checkout_money_integrity import (  # noqa: F401
    LEGACY_SESSION_CREATED,
    TEST_STRIPE_ACCOUNT_ID,
    balance,
    completed_payload,
    post_signed,
    start_checkout,
    stripe_configuration,
)
from dj.apps.ztripe.fulfillment import checkout_metadata as intent_metadata
from dj.apps.ztripe.views import CHECKOUT_NOT_CREDITED_EVENT

_REPO_ROOT = Path(__file__).resolve().parents[5]


def _events(caplog, name):
    found = []
    for record in caplog.records:
        try:
            payload = json.loads(record.getMessage())
        except ValueError:
            continue
        if isinstance(payload, dict) and payload.get('event') == name:
            found.append((record, payload))
    return found


def _json_lines(output, name):
    found = []
    for line in output.splitlines():
        try:
            payload = json.loads(line)
        except ValueError:
            continue
        if isinstance(payload, dict) and payload.get('event') == name:
            found.append(payload)
    return found


def _reject_one(api_client, client, user, *, event_id, payment_intent):
    """A real, signed, PAID delivery that fulfillment refuses (wrong amount)."""
    _, create_args = start_checkout(api_client, user, 21, suffix=event_id[-8:])
    event = json.loads(completed_payload(
        user=user,
        metadata=create_args['metadata'],
        quantity=21,
        event_id=event_id,
        session_id=f'cs_test_{event_id[-8:]}',
        payment_intent=payment_intent,
    ))
    event['data']['object']['amount_total'] = 999
    return post_signed(client, json.dumps(event))




# --- the webhook half --------------------------------------------------------


@pytest.mark.django_db
def test_a_rejected_paid_checkout_emits_the_countable_event(
    api_client, client, creator_factory, caplog,
):
    caplog.set_level(logging.INFO, logger='dj.apps.ztripe.views')
    user = creator_factory(tuzis=Decimal('0'))

    response = _reject_one(
        api_client, client, user,
        event_id='evt_test_2103_rejected', payment_intent='pi_test_2103_r',
    )

    assert response.status_code == 400
    assert balance(user) == Decimal('0')
    events = _events(caplog, CHECKOUT_NOT_CREDITED_EVENT)
    assert len(events) == 1, caplog.text
    record, payload = events[0]
    assert record.levelno == logging.ERROR
    assert payload == {
        'event': 'stripe_checkout_fulfillment_not_credited',
        'outcome': 'rejected',
        'reason': 'signed_event_mismatch',
        'http_status': 400,
        'provider_event_id': 'evt_test_2103_rejected',
    }


@pytest.mark.django_db
def test_an_unproven_provider_event_emits_the_countable_event(
    client, creator_factory, settings, caplog,
):
    """503 before any audit row: only the log line can say a buyer is waiting."""
    caplog.set_level(logging.INFO, logger='dj.apps.ztripe.views')
    settings.STRIPE_EXPECTED_ACCOUNT_ID = ''
    user = creator_factory(tuzis=Decimal('0'))

    response = post_signed(client, completed_payload(
        user=user, metadata={}, quantity=100,
        event_id='evt_test_2103_unproven',
    ))

    assert response.status_code == 503
    assert CheckoutFulfillmentAudit.objects.count() == 0
    [(_, payload)] = _events(caplog, CHECKOUT_NOT_CREDITED_EVENT)
    assert payload['reason'] == 'provider_event_unproven'
    assert payload['http_status'] == 503
    assert payload['provider_event_id'] == 'evt_test_2103_unproven'


@pytest.mark.django_db
def test_a_fulfillment_crash_emits_the_event_and_still_fails(
    client, creator_factory, caplog, monkeypatch,
):
    caplog.set_level(logging.INFO, logger='dj.apps.ztripe.views')
    user = creator_factory(tuzis=Decimal('0'))

    def boom(*args, **kwargs):
        raise RuntimeError('database went away')

    monkeypatch.setattr(
        'dj.apps.ztripe.views.fulfill_checkout_completed', boom,
    )
    with pytest.raises(RuntimeError):
        post_signed(client, completed_payload(
            user=user, metadata={}, quantity=100,
            event_id='evt_test_2103_crash',
        ))

    [(_, payload)] = _events(caplog, CHECKOUT_NOT_CREDITED_EVENT)
    assert payload['reason'] == 'fulfillment_exception'
    assert payload['http_status'] == 500


@pytest.mark.django_db
def test_a_credited_checkout_and_its_redelivery_emit_nothing(
    api_client, client, creator_factory, caplog,
):
    """The page must stay at zero in normal operation, duplicates included."""
    caplog.set_level(logging.INFO, logger='dj.apps.ztripe.views')
    user = creator_factory(tuzis=Decimal('0'))
    _, create_args = start_checkout(api_client, user, 21, suffix='ok2103')
    payload = completed_payload(
        user=user, metadata=create_args['metadata'], quantity=21,
        event_id='evt_test_2103_ok', session_id='cs_test_ok2103',
        payment_intent='pi_test_2103_ok',
    )

    assert post_signed(client, payload).status_code == 200
    assert post_signed(client, payload).status_code == 200

    assert balance(user) == Decimal('21')
    assert _events(caplog, CHECKOUT_NOT_CREDITED_EVENT) == []




# --- the scheduled reconcile half ---------------------------------------------


def _run_bare():
    output = StringIO()
    call_command('reconcile_stripe_fulfillment', stdout=output)
    return output.getvalue()


def _money_state():
    return {
        'balances': sorted(
            (pk, str(tuzis))
            for pk, tuzis in Creator.objects.values_list('pk', 'tuzis')
        ),
        'transactions': sorted(
            StripeTransaction.objects.values_list(
                'pk', 'user_id', 'amount', 'tuzis_credited',
                'stripe_charge_id',
            )
        ),
        'audits': sorted(
            CheckoutFulfillmentAudit.objects.values_list(
                'pk', 'outcome', 'reason', 'attempts', 'last_seen_at',
            )
        ),
        'intents': sorted(
            CheckoutIntent.objects.values_list('pk', 'state', 'updated_at')
        ),
        'bought_events': Event.objects.filter(type='BOUGHT_TUZI').count(),
    }


@pytest.mark.django_db
def test_bare_reconcile_reports_an_unresolved_rejection_and_a_heartbeat(
    api_client, client, creator_factory,
):
    user = creator_factory(tuzis=Decimal('0'))
    assert _reject_one(
        api_client, client, user,
        event_id='evt_test_2103_unresolved', payment_intent='pi_test_2103_u',
    ).status_code == 400
    intent = CheckoutIntent.objects.get()
    # Stripe's retry of the SAME event: still one finding, not two.
    event = json.loads(completed_payload(
        user=user, metadata=intent_metadata(intent), quantity=21,
        event_id='evt_test_2103_unresolved',
        session_id='cs_test_resolved', payment_intent='pi_test_2103_u',
    ))
    event['data']['object']['amount_total'] = 999
    assert post_signed(client, json.dumps(event)).status_code == 400
    assert CheckoutFulfillmentAudit.objects.get().attempts == 2
    assert intent.state == CheckoutIntent.State.OPEN

    output = _run_bare()

    assert 'legacy-classification skipped' in output
    [finding] = _json_lines(output, 'stripe_fulfillment_unresolved_rejection')
    assert finding['provider_event_id'] == 'evt_test_2103_unresolved'
    assert finding['reasons'] == ['signed_event_mismatch']
    assert finding['intent'] == str(intent.public_id)
    [heartbeat] = _json_lines(output, 'stripe_fulfillment_reconcile')
    assert heartbeat['status'] == 'completed'
    assert heartbeat['unresolved_rejections'] == 1
    assert heartbeat['legacy_classified'] is False


@pytest.mark.django_db
def test_a_rejection_that_was_later_credited_is_resolved(
    api_client, client, creator_factory, settings,
):
    """The runbook's fix -- restore config, resend the event -- clears it."""
    user = creator_factory(tuzis=Decimal('0'))
    _, create_args = start_checkout(api_client, user, 21, suffix='fix2103')
    payload = completed_payload(
        user=user, metadata=create_args['metadata'], quantity=21,
        event_id='evt_test_2103_fixed', session_id='cs_test_fix2103',
        payment_intent='pi_test_2103_fixed',
    )
    settings.STRIPE_EXPECTED_ACCOUNT_ID = 'acct_transientWrongAccount'
    assert post_signed(client, payload).status_code == 400
    assert len(_json_lines(
        _run_bare(), 'stripe_fulfillment_unresolved_rejection',
    )) == 1

    settings.STRIPE_EXPECTED_ACCOUNT_ID = TEST_STRIPE_ACCOUNT_ID
    assert post_signed(client, payload).status_code == 200

    output = _run_bare()
    assert _json_lines(output, 'stripe_fulfillment_unresolved_rejection') == []
    [heartbeat] = _json_lines(output, 'stripe_fulfillment_reconcile')
    assert heartbeat['unresolved_rejections'] == 0
    assert balance(user) == Decimal('21')


@pytest.mark.django_db
def test_an_intentless_rejection_is_resolved_by_its_event_being_credited(
    client, creator_factory,
):
    """A legacy (metadata-free) Session has no intent to mark FULFILLED.

    The only evidence that its rejection was settled is a later successful
    audit for the same provider event -- so that check must stand on its own.
    """
    user = creator_factory(tuzis=Decimal('0'))
    payload = completed_payload(
        user=user, metadata={}, quantity=1, amount_total=101,
        event_id='evt_test_2103_legacy', payment_intent='pi_test_2103_legacy',
    )
    # Test-only lever: the durable cutoff is immutable in prod. Moving it
    # below this Session's creation makes the legacy path refuse it.
    rollout = StripeCheckoutRollout.objects.get(singleton=1)
    real_cutoff = rollout.legacy_session_created_at_or_before_epoch
    StripeCheckoutRollout.objects.filter(pk=rollout.pk).update(
        legacy_session_created_at_or_before_epoch=LEGACY_SESSION_CREATED - 1,
    )
    assert post_signed(client, payload).status_code == 400
    rejected = CheckoutFulfillmentAudit.objects.get()
    assert rejected.intent is None
    assert rejected.reason == 'legacy_session_after_cutoff'
    assert len(_json_lines(
        _run_bare(), 'stripe_fulfillment_unresolved_rejection',
    )) == 1

    StripeCheckoutRollout.objects.filter(pk=rollout.pk).update(
        legacy_session_created_at_or_before_epoch=real_cutoff,
    )
    assert post_signed(client, payload).status_code == 200
    assert balance(user) == Decimal('1')

    assert _json_lines(
        _run_bare(), 'stripe_fulfillment_unresolved_rejection',
    ) == []


@pytest.mark.django_db
def test_age_alone_never_resolves_a_rejection_only_an_explicit_settlement(
    api_client, client, creator_factory, settings,
):
    """Stripe stopping its retries is not the buyer being made whole."""
    user = creator_factory(tuzis=Decimal('0'))
    _reject_one(
        api_client, client, user,
        event_id='evt_test_2103_aged', payment_intent='pi_test_2103_aged',
    )
    CheckoutFulfillmentAudit.objects.update(
        first_seen_at=timezone.now() - timedelta(days=90),
        last_seen_at=timezone.now() - timedelta(days=87),
    )
    assert len(_json_lines(
        _run_bare(), 'stripe_fulfillment_unresolved_rejection',
    )) == 1

    # Refunded in Stripe; the operator records that through the ConfigMap.
    settings.STRIPE_FULFILLMENT_SETTLED_EVENT_IDS = frozenset({
        'evt_test_2103_aged',
    })
    assert _json_lines(
        _run_bare(), 'stripe_fulfillment_unresolved_rejection',
    ) == []


@pytest.mark.django_db
def test_an_intent_fulfilled_by_another_payment_does_not_settle_this_one(
    api_client, client, creator_factory,
):
    """Two paid Sessions for one intent: crediting A must not hide B."""
    user = creator_factory(tuzis=Decimal('0'))
    _, create_args = start_checkout(api_client, user, 21, suffix='twin2103')
    assert post_signed(client, completed_payload(
        user=user, metadata=create_args['metadata'], quantity=21,
        event_id='evt_test_2103_twin_a', session_id='cs_test_twin2103',
        payment_intent='pi_test_2103_twin_a',
    )).status_code == 200
    assert post_signed(client, completed_payload(
        user=user, metadata=create_args['metadata'], quantity=21,
        event_id='evt_test_2103_twin_b', session_id='cs_test_twin2103b',
        payment_intent='pi_test_2103_twin_b',
    )).status_code == 400
    assert CheckoutIntent.objects.get().state == CheckoutIntent.State.FULFILLED

    [finding] = _json_lines(
        _run_bare(), 'stripe_fulfillment_unresolved_rejection',
    )
    assert finding['provider_event_id'] == 'evt_test_2103_twin_b'
    assert finding['reasons'] == ['checkout_session_mismatch']


@pytest.mark.django_db
def test_scheduled_reconcile_is_read_only_and_repeatable(
    api_client, client, creator_factory,
):
    """Running it twice cannot double-credit: running it once credits nothing.

    Mixed state on purpose -- one credited checkout, one unresolved
    rejection, one stale open intent, one legacy transaction -- so every
    branch of the command runs. Then two back-to-back runs must leave every
    money-bearing row byte-identical, must issue no write statement at all,
    and must report the same findings both times.
    """
    paid = creator_factory(tuzis=Decimal('0'))
    _, create_args = start_checkout(api_client, paid, 21, suffix='paid2103')
    assert post_signed(client, completed_payload(
        user=paid, metadata=create_args['metadata'], quantity=21,
        event_id='evt_test_2103_paid', session_id='cs_test_paid2103',
        payment_intent='pi_test_2103_paid',
    )).status_code == 200
    refused = creator_factory(tuzis=Decimal('0'))
    _reject_one(
        api_client, client, refused,
        event_id='evt_test_2103_refused', payment_intent='pi_test_2103_x',
    )
    StripeTransaction.objects.create(
        user=creator_factory(tuzis=Decimal('0')),
        amount=101, tuzis_credited=0, stripe_charge_id='pi_legacy_2103',
    )
    before = _money_state()

    with CaptureQueriesContext(connection) as queries:
        first = _run_bare()
        second = _run_bare()

    writes = [
        q['sql'] for q in queries.captured_queries
        if not q['sql'].lstrip().upper().startswith('SELECT')
    ]
    assert writes == []
    assert _money_state() == before
    assert balance(paid) == Decimal('21')
    assert balance(refused) == Decimal('0')
    assert (
        _json_lines(first, 'stripe_fulfillment_unresolved_rejection')
        == _json_lines(second, 'stripe_fulfillment_unresolved_rejection')
    )
    assert len(_json_lines(first, 'stripe_fulfillment_unresolved_rejection')) == 1
    [heartbeat] = _json_lines(second, 'stripe_fulfillment_reconcile')
    assert heartbeat['unlinked_unclassified'] == 1
    assert heartbeat['intent_linked'] == 1


class _FlushRecorder(StringIO):
    """What a pipe would actually have delivered: only what was flushed."""

    delivered = ''

    def flush(self):
        super().flush()
        self.delivered = self.getvalue()


@pytest.mark.django_db
def test_findings_are_flushed_before_the_historical_scan_can_die(
    api_client, client, creator_factory, monkeypatch,
):
    """A run killed mid-scan (activeDeadlineSeconds) must still have paged."""
    user = creator_factory(tuzis=Decimal('0'))
    _reject_one(
        api_client, client, user,
        event_id='evt_test_2103_killed', payment_intent='pi_test_2103_k',
    )

    def killed(*args, **kwargs):
        raise RuntimeError('deadline exceeded mid-scan')

    monkeypatch.setattr(StripeTransaction.objects, 'select_related', killed)
    out = _FlushRecorder()
    with pytest.raises(RuntimeError):
        call_command('reconcile_stripe_fulfillment', stdout=out)

    [finding] = _json_lines(
        out.delivered, 'stripe_fulfillment_unresolved_rejection',
    )
    assert finding['provider_event_id'] == 'evt_test_2103_killed'


@pytest.mark.django_db
def test_fail_on_drift_still_requires_the_operator_cutoff(creator_factory):
    """A skipped classification must never read as a zero-drift sign-off."""
    CheckoutIntent.objects.create(
        user=creator_factory(), tuzis=1, amount_cents=102, currency='usd',
        pricing_version='card-v2', stripe_account_id=TEST_STRIPE_ACCOUNT_ID,
        stripe_mode='payment', stripe_livemode=False,
    )
    with pytest.raises(CommandError, match='--legacy-before is required'):
        call_command(
            'reconcile_stripe_fulfillment', fail_on_drift=True,
            stdout=StringIO(),
        )


