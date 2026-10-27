"""
Event-based subscription renewal tests ( phase 3), against real
Postgres. MONEY PATH — these tests are the double-charge protection
evidence ( class).

Same conventions as test_publish_zpage.py: enqueue assertions hit the
real procrastinate_jobs table through the Django connection (no queue
mocking), tasks are exercised as plain callables, and anything that
relies on transaction.on_commit (the post_save signal enqueue, the
task's own extend-then-re-arm) uses django_db(transaction=True).

Economics under test (must mirror the legacy hourly sweep exactly):
renewal window is now <= expires <= now + 24h; expired subs lapse and
are never charged; ineligible-but-in-window subs are retried hourly
without charging; a renewal debits the fan and credits the star by
member_price once and pushes expires 30 days out.
"""
from datetime import timedelta
from decimal import Decimal
import threading
import uuid

import pytest
from django.core.management import call_command
from django.db import connection, transaction
from django.utils import timezone

from procrastinate.contrib.django.models import ProcrastinateJob

from dj.apps.events.models import Event
from dj.apps.g12f.models import Creator, Subscription
from dj.apps.g12f.tasks import (
    RENEWAL_LAST_LOOK,
    RENEWAL_LEAD,
    RENEWAL_RETRY,
    renew_subscription,
    renewal_queueing_lock,
)
from dj.apps.tuzis import ledger


def _make_sub(fan, star, **kwargs):
    defaults = dict(
        fan=fan,
        star=star,
        expires=timezone.now() + timedelta(hours=1),  # inside the window
        max_price=star.member_price or Decimal("10"),  # 0 = free -> 10 cap
    )
    defaults.update(kwargs)
    return Subscription.objects.create(**defaults)


def _renew_jobs(sub):
    return ProcrastinateJob.objects.filter(
        task_name="g12f.renew_subscription",
        args={"subscription_id": sub.pk},
    )


def _sub_events(sub):
    return Event.objects.filter(
        type__in=["SUBSCRIPTION_RECEIVED", "SUBSCRIPTION_SENT"],
        payee=sub.star,
        contributor=sub.fan,
    )


def _run_as_worker(sub):
    """Consume the sub's oldest pending job the way the billing worker does.

    Calling the task as a plain callable leaves the job row in ``todo``, and
    a ``todo`` row holds the subscription's ``queueing_lock`` --
    so a bare call cannot show the chain re-arming, because the successor is
    refused by the row that "is running". The worker moves the row to
    ``doing`` before the task body runs and to ``succeeded`` after, and that
    is what releases the lock. Same status writes the jobs tests use.
    """
    job = _renew_jobs(sub).filter(status="todo").order_by(
        "scheduled_at", "id").first()
    assert job is not None, "no pending renewal job to run"
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE procrastinate_jobs SET status='doing' WHERE id=%s",
            [job.id])
    try:
        renew_subscription(subscription_id=sub.pk)
    finally:
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE procrastinate_jobs SET status='succeeded' "
                "WHERE id=%s", [job.id])
    return job


# ---------------------------------------------------------------------------
# Enqueue points: the Subscription post_save signal
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_creating_subscription_schedules_renewal_at_lead(creator_factory):
    fan, star = creator_factory(), creator_factory()
    expires = timezone.now() + timedelta(days=30)

    sub = _make_sub(fan, star, expires=expires)

    job = _renew_jobs(sub).order_by("-id").first()
    assert job is not None
    assert job.status == "todo"
    assert job.queue_name == "billing"
    # The renewal moment: exactly where the legacy hourly sweep's
    # 24h window would have opened.
    assert job.scheduled_at == expires - RENEWAL_LEAD


@pytest.mark.django_db(transaction=True)
def test_subscribe_endpoint_charges_once_and_schedules_renewal(
        api_client, creator_factory):
    fan, star = creator_factory(), creator_factory()
    api_client.force_authenticate(fan)

    resp = api_client.post(
        f"/api/tuzis/subscribe/{star.username}",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert resp.status_code == 200

    fan.refresh_from_db()
    star.refresh_from_db()
    assert fan.tuzis == Decimal("990")
    assert star.tuzis == Decimal("1010")

    sub = Subscription.objects.get(fan=fan, star=star)
    # get_or_create and extend() both save inside the view's one
    # transaction.atomic(), so two post_save callbacks fire from one commit.
    # each reads the COMMITTED row, so both ask for the same
    # renewal moment and the queueing_lock collapses them to ONE pending
    # job -- no throwaway job keyed on the get_or_create default `expires`
    # (now) and scheduled 24h in the past. `.get()` is the assertion.
    job = _renew_jobs(sub).filter(status="todo").get()
    assert job.queue_name == "billing"
    assert job.scheduled_at == sub.expires - RENEWAL_LEAD


@pytest.mark.django_db(transaction=True)
def test_legacy_subscribe_can_resubscribe_after_cancellation(
        api_client, creator_factory):
    fan, star = creator_factory(), creator_factory()
    api_client.force_authenticate(fan)

    first = api_client.post(
        f"/api/tuzis/subscribe/{star.username}",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert first.status_code == 200
    cancelled = api_client.delete(f"/api/tuzis/subscribe/{star.username}")
    assert cancelled.status_code == 200

    # Exercise the real post-cancellation charge path rather than the
    # debounce no-op. Cancellation intentionally leaves max_price at zero so
    # the next one-time purchase must not be treated as an invalid renewal.
    Subscription.objects.filter(fan=fan, star=star).update(
        last_charged_at=timezone.now() - timedelta(hours=1),
    )
    second = api_client.post(
        f"/api/tuzis/subscribe/{star.username}",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )

    assert second.status_code == 200, second.content
    fan.refresh_from_db()
    assert fan.tuzis == Decimal("980")


@pytest.mark.django_db(transaction=True)
def test_legacy_subscribe_accepts_a_creator_price_increase(
        api_client, creator_factory):
    fan, star = creator_factory(), creator_factory()
    api_client.force_authenticate(fan)

    first = api_client.post(
        f"/api/tuzis/subscribe/{star.username}",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert first.status_code == 200
    Creator.objects.filter(pk=star.pk).update(member_price=Decimal("20"))
    Subscription.objects.filter(fan=fan, star=star).update(
        last_charged_at=timezone.now() - timedelta(hours=1),
    )

    second = api_client.post(
        f"/api/tuzis/subscribe/{star.username}",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )

    assert second.status_code == 200, second.content
    fan.refresh_from_db()
    assert fan.tuzis == Decimal("970")


@pytest.mark.django_db(transaction=True)
def test_cancellation_save_schedules_nothing(creator_factory):
    fan, star = creator_factory(), creator_factory()
    sub = _make_sub(fan, star)
    jobs_before = _renew_jobs(sub).count()

    # CreatorSubscribeView.delete models cancellation as max_price=0
    sub.max_price = 0
    sub.save()

    assert _renew_jobs(sub).count() == jobs_before


@pytest.mark.django_db(transaction=True)
def test_reactivation_save_rearms_the_chain(creator_factory):
    fan, star = creator_factory(), creator_factory()
    sub = _make_sub(fan, star, max_price=0)
    assert not _renew_jobs(sub).exists()  # cancelled: nothing scheduled

    # PATCH re-raises the cap: the save must re-arm the chain
    sub.max_price = star.member_price
    sub.save()

    job = _renew_jobs(sub).order_by("-id").first()
    assert job is not None
    assert job.scheduled_at == sub.expires - RENEWAL_LEAD


# ---------------------------------------------------------------------------
# The task: renewal + self-perpetuating chain
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_due_funded_sub_renews_once_and_schedules_next(creator_factory):
    fan, star = creator_factory(), creator_factory()
    expires = timezone.now() + timedelta(hours=1)
    sub = _make_sub(fan, star, expires=expires)
    ProcrastinateJob.objects.all().delete()  # isolate the task's effects

    renew_subscription(subscription_id=sub.pk)

    fan.refresh_from_db()
    star.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("990")   # debited exactly once
    assert star.tuzis == Decimal("1010")  # credited exactly once
    assert sub.expires == expires + timedelta(days=30)
    assert _sub_events(sub).count() == 2  # one RECEIVED + one SENT

    # Chain re-armed: exactly one next job at the new renewal moment
    jobs = _renew_jobs(sub)
    assert jobs.count() == 1
    job = jobs.get()
    assert job.status == "todo"
    assert job.queue_name == "billing"
    assert job.scheduled_at == sub.expires - RENEWAL_LEAD


@pytest.mark.django_db(transaction=True)
def test_duplicate_jobs_charge_exactly_once(creator_factory):
    """
    The -class protection: two task invocations for the same sub
    (duplicate jobs, sweep/chain overlap, retried job after a crash
    between commit and ack) must produce exactly one extension and one
    charge. The second run hits the expires > now + LEAD idempotency
    guard.
    """
    fan, star = creator_factory(), creator_factory()
    expires = timezone.now() + timedelta(hours=1)
    sub = _make_sub(fan, star, expires=expires)
    ProcrastinateJob.objects.all().delete()

    renew_subscription(subscription_id=sub.pk)
    renew_subscription(subscription_id=sub.pk)  # duplicate

    fan.refresh_from_db()
    star.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("990")            # ONE debit
    assert star.tuzis == Decimal("1010")          # ONE credit
    assert sub.expires == expires + timedelta(days=30)  # ONE extension
    assert _sub_events(sub).count() == 2          # ONE pair of events
    assert _renew_jobs(sub).count() == 1          # ONE next job


@pytest.mark.django_db(transaction=True)
def test_renewal_and_opposing_donation_share_creator_lock_order(
    creator_factory, monkeypatch,
):
    """A renewal must not pre-lock its fan before a lower-pk star.

    The donation holds the lower row before renewal starts, then moves money in
    the opposite direction. If renewal had already locked the higher fan row
    through select_related, these two operations would form a deterministic
    deadlock. With subscription-only locking followed by ordered creator locks,
    the donation completes and renewal follows it.
    """
    star = creator_factory(tuzis=Decimal("100"), member_price=Decimal("10"))
    fan = creator_factory(tuzis=Decimal("100"))
    assert star.pk < fan.pk
    expires = timezone.now() + timedelta(hours=1)
    sub = _make_sub(fan, star, expires=expires)
    ProcrastinateJob.objects.all().delete()

    low_locked = threading.Event()
    renewal_attempted_ordered_lock = threading.Event()
    results = {}
    original_lock_in_order = ledger.lock_in_order

    def observed_lock_in_order(*creators):
        renewal_attempted_ordered_lock.set()
        return original_lock_in_order(*creators)

    monkeypatch.setattr(ledger, "lock_in_order", observed_lock_in_order)

    def donate_back():
        try:
            with transaction.atomic():
                locked_star = Creator.objects.select_for_update().get(pk=star.pk)
                locked_fan = Creator.objects.get(pk=fan.pk)
                low_locked.set()
                assert renewal_attempted_ordered_lock.wait(timeout=10)
                ledger.transfer(locked_star, locked_fan, Decimal("1"))
            results["donation"] = "done"
        except Exception as error:
            results["donation"] = error
        finally:
            connection.close()

    def renew():
        try:
            assert low_locked.wait(timeout=10)
            renew_subscription(subscription_id=sub.pk)
            results["renewal"] = "done"
        except Exception as error:
            results["renewal"] = error
        finally:
            connection.close()

    donation_thread = threading.Thread(target=donate_back)
    renewal_thread = threading.Thread(target=renew)
    donation_thread.start()
    renewal_thread.start()
    for thread in (donation_thread, renewal_thread):
        thread.join(timeout=30)
        assert not thread.is_alive(), "money operations deadlocked"

    assert results == {"donation": "done", "renewal": "done"}
    assert Creator.objects.get(pk=fan.pk).tuzis == Decimal("91")
    assert Creator.objects.get(pk=star.pk).tuzis == Decimal("109")
    sub.refresh_from_db()
    assert sub.expires == expires + timedelta(days=30)


@pytest.mark.django_db
def test_cancelled_sub_is_noop_no_charge_no_next_job(creator_factory):
    fan, star = creator_factory(), creator_factory()
    expires = timezone.now() + timedelta(hours=1)
    sub = _make_sub(fan, star, expires=expires, max_price=0)

    renew_subscription(subscription_id=sub.pk)

    fan.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("1000")
    assert sub.expires == expires
    assert not _sub_events(sub).exists()
    assert not _renew_jobs(sub).exists()


@pytest.mark.django_db
def test_inactive_creator_sub_is_noop_no_charge_no_next_job(creator_factory):
    fan, star = creator_factory(), creator_factory()
    expires = timezone.now() + timedelta(hours=1)
    sub = _make_sub(fan, star, expires=expires)
    star.is_active = False
    star.save(update_fields=["is_active"])
    ProcrastinateJob.objects.all().delete()

    renew_subscription(subscription_id=sub.pk)

    fan.refresh_from_db()
    star.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("1000")
    assert star.tuzis == Decimal("1000")
    assert sub.expires == expires
    assert not _sub_events(sub).exists()
    assert not _renew_jobs(sub).exists()


@pytest.mark.django_db
def test_inactive_fan_sub_is_not_charged_and_retries_hourly(creator_factory):
    """
    : a moderation-deactivated fan cannot log in to cancel, so the
    renewal job must freeze their outgoing recurring spend instead of
    draining the account every cycle.

     changed the second half. The freeze must leave an hourly retry
    behind rather than returning: deactivation is reversible, `is_active`
    changes with no Subscription save so no signal re-arms the chain, and the
    daily backstop covers a 24h window ONCE A DAY -- equal to the window, not
    wider -- so a plain return consumes the last job this cycle ever gets.
    Unlike the inactive-CREATOR gate, which correctly ends the chain: a
    deactivated creator must not be paid at all.

    NEGATIVE CONTROL: fails against unfixed code — without the fan gate the
    charge goes through (fan debited, star credited, expires pushed 30d,
    events created). The job assertion additionally fails against 's
    original `return`.
    """
    fan, star = creator_factory(), creator_factory()
    # Far enough from expiry that the  clamp does not bite: the hourly
    # cadence is what is under test here, the clamp has its own tests in
    # test_renewal_retry.py.
    expires = timezone.now() + timedelta(hours=20)
    sub = _make_sub(fan, star, expires=expires)
    fan.is_active = False
    fan.save(update_fields=["is_active"])
    ProcrastinateJob.objects.all().delete()
    before = timezone.now()

    renew_subscription(subscription_id=sub.pk)

    fan.refresh_from_db()
    star.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("1000")
    assert star.tuzis == Decimal("1000")
    assert sub.expires == expires
    assert not _sub_events(sub).exists()

    retry = _renew_jobs(sub).get()
    assert retry.queue_name == "billing"
    assert before + RENEWAL_RETRY <= retry.scheduled_at \
        <= timezone.now() + RENEWAL_RETRY


@pytest.mark.django_db
def test_inactive_fan_retry_chain_self_terminates_at_expiry(creator_factory):
    """Bounded, not infinite.

    The fan gate sits AFTER the lapsed and not-due guards precisely so an
    account that is never reinstated stops generating jobs instead of
    retrying hourly forever. Move it back above them and this goes red.
    """
    fan, star = creator_factory(), creator_factory()
    expires = timezone.now() - timedelta(minutes=1)
    sub = _make_sub(fan, star, expires=expires)
    fan.is_active = False
    fan.save(update_fields=["is_active"])
    ProcrastinateJob.objects.all().delete()

    renew_subscription(subscription_id=sub.pk)

    fan.refresh_from_db()
    assert fan.tuzis == Decimal("1000")
    assert not _renew_jobs(sub).exists()


@pytest.mark.django_db
def test_inactive_fan_retry_is_a_noop_while_still_banned(creator_factory):
    """Each retry re-checks and re-arms; none of them charges.

    Until  this test pinned the duplicate-amplification limit from
     as a characterization: each execution deferred its OWN successor,
    so three executions left three pending retries and the "~24 attempts per
    cycle" bound was per queued job, not per subscription. `defer_renewal`
    now carries a per-subscription `queueing_lock`, so the second and third
    executions find the first one's retry still pending and enqueue nothing.
    One subscription, one chain, whatever the duplicate count.

    NEGATIVE CONTROL: without the lock this is 3 (measured; the number the
    old version of this test asserted).
    """
    fan, star = creator_factory(), creator_factory()
    expires = timezone.now() + timedelta(hours=20)
    sub = _make_sub(fan, star, expires=expires)
    fan.is_active = False
    fan.save(update_fields=["is_active"])
    ProcrastinateJob.objects.all().delete()

    for _ in range(3):
        renew_subscription(subscription_id=sub.pk)

    fan.refresh_from_db()
    star.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("1000")
    assert star.tuzis == Decimal("1000")
    assert sub.expires == expires
    assert not _sub_events(sub).exists()
    # Three executions -> ONE pending successor .
    assert _renew_jobs(sub).filter(status="todo").count() == 1


@pytest.mark.django_db
def test_inactive_fan_retry_never_overshoots_the_window(creator_factory):
    """The other  limit, closed by.

    `RENEWAL_RETRY` used to be a flat hour with no relationship to `expires`,
    so a subscription inside the last hour scheduled its next look AFTER the
    window had closed, where the lapsed guard made it a guaranteed no-op and
    a fan reinstated in that final interval was never seen. The retry is now
    clamped to `expires - RENEWAL_LAST_LOOK`, so the last look of the cycle
    is a real look, five minutes before the window closes.

    NEGATIVE CONTROL: without the clamp `scheduled_at` is `now + 1h`, thirty
    minutes past `expires` (the assertion the old version of this test made).
    """
    fan, star = creator_factory(), creator_factory()
    expires = timezone.now() + timedelta(minutes=30)
    sub = _make_sub(fan, star, expires=expires)
    fan.is_active = False
    fan.save(update_fields=["is_active"])
    ProcrastinateJob.objects.all().delete()

    renew_subscription(subscription_id=sub.pk)

    retry = _renew_jobs(sub).get()
    # Inside the window, at the last look: a lifted ban is seen and charged.
    assert retry.scheduled_at == sub.expires - RENEWAL_LAST_LOOK
    assert retry.scheduled_at < sub.expires


@pytest.mark.django_db(transaction=True)
def test_reinstated_fan_renews_without_any_subscription_save(creator_factory):
    """: the whole point of leaving a retry behind.

    Reactivation saves the CREATOR, not the Subscription, so the post_save
    renewal signal never fires and nothing re-arms the chain. The retry job
    the freeze deferred is the only thing that comes back to look — and
    against 's original `return` there is nothing to come back at all.
    """
    fan, star = creator_factory(), creator_factory()
    expires = timezone.now() + timedelta(hours=20)
    sub = _make_sub(fan, star, expires=expires)
    fan.is_active = False
    fan.save(update_fields=["is_active"])
    ProcrastinateJob.objects.all().delete()

    renew_subscription(subscription_id=sub.pk)
    fan.refresh_from_db()
    assert fan.tuzis == Decimal("1000")
    # A retry is pending: this is what will still be there after the ban is
    # lifted, and it is what a plain `return` would not have left.
    assert _renew_jobs(sub).exists()

    Creator.objects.filter(pk=fan.pk).update(is_active=True)

    # What that retry job does when it comes due. No Subscription was saved
    # in between, and no sweep ran.
    renew_subscription(subscription_id=sub.pk)

    fan.refresh_from_db()
    star.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("990")
    assert star.tuzis == Decimal("1010")
    assert sub.expires == expires + timedelta(days=30)


@pytest.mark.django_db
def test_sweep_backstop_still_covers_a_deactivated_fan(creator_factory):
    """Regression guard on the sweep, not a control for the task.

    The obvious "fix" is to add `fan__is_active=True` to the backstop filter.
    That would remove the backstop from exactly the subscription whose chain
    the freeze is keeping alive, so a lost retry job could never be repaired.
    The task is the authority and re-checks under the row lock; the sweep
    only defers.
    """
    fan, star = creator_factory(), creator_factory()
    sub = _make_sub(fan, star, expires=timezone.now() + timedelta(hours=12))
    fan.is_active = False
    fan.save(update_fields=["is_active"])
    ProcrastinateJob.objects.all().delete()

    call_command("renew_subs")

    assert _renew_jobs(sub).count() == 1


@pytest.mark.django_db(transaction=True)
def test_fan_deactivated_while_awaiting_lock_is_noop(creator_factory, monkeypatch):
    """
     post-lock gate: the fan can be deactivated between the task's
    first read (which sees them still active) and its acquisition of the
    balance lock. Deterministic version of that race: hold the fan row
    from another connection while renewal passes its pre-lock gates and
    blocks inside lock_in_order; commit the deactivation; the refreshed
    row must then stop the charge at the post-lock gate.

    NEGATIVE CONTROL: fails against unfixed code for the same reason as
    test_inactive_fan_sub_is_not_charged_and_retries_hourly — and against a
    variant that has only the pre-lock gate, which this race bypasses.

    : the late gate must also RE-ARM, not just decline. A ban that lands
    in this exact window would otherwise cost the subscription its whole
    chain, which is the one case where the pre-lock gate cannot help.
    """
    star = creator_factory(tuzis=Decimal("100"), member_price=Decimal("10"))
    fan = creator_factory(tuzis=Decimal("100"))
    expires = timezone.now() + timedelta(hours=1)
    sub = _make_sub(fan, star, expires=expires)
    ProcrastinateJob.objects.all().delete()

    fan_deactivated = threading.Event()
    release_lock = threading.Event()
    renewal_attempted_ordered_lock = threading.Event()
    results = {}
    original_lock_in_order = ledger.lock_in_order

    def observed_lock_in_order(*creators):
        # The task's pre-lock gates have passed on a still-active fan;
        # acquiring these rows now blocks behind the holder below.
        renewal_attempted_ordered_lock.set()
        return original_lock_in_order(*creators)

    monkeypatch.setattr(ledger, "lock_in_order", observed_lock_in_order)

    def hold_lock_and_deactivate():
        try:
            with transaction.atomic():
                Creator.objects.select_for_update().get(pk=fan.pk)
                fan.is_active = False
                fan.save(update_fields=["is_active"])
                fan_deactivated.set()
                assert release_lock.wait(timeout=10)
            results["holder"] = "done"
        except Exception as error:
            results["holder"] = error
        finally:
            connection.close()

    def renew():
        try:
            renew_subscription(subscription_id=sub.pk)
            results["renewal"] = "done"
        except Exception as error:
            results["renewal"] = error
        finally:
            connection.close()

    # The holder acquires the fan lock FIRST: we wait for its
    # (uncommitted) deactivation before starting renewal, so renewal's
    # first read cannot see is_active=False and its only remaining
    # defence is the refreshed-row gate after the lock.
    holder_thread = threading.Thread(target=hold_lock_and_deactivate)
    holder_thread.start()
    try:
        assert fan_deactivated.wait(timeout=10)

        renewal_thread = threading.Thread(target=renew)
        renewal_thread.start()
        # Renewal passed the pre-lock gates and is now blocked on the
        # balance lock held by the holder.
        assert renewal_attempted_ordered_lock.wait(timeout=10)
        # Committing the deactivation releases the lock; renewal must
        # re-read the fan, see is_active=False, and no-op without
        # charging or scheduling anything.
        release_lock.set()

        renewal_thread.join(timeout=30)
        assert not renewal_thread.is_alive(), "renewal deadlocked on the lock"
    finally:
        release_lock.set()
        holder_thread.join(timeout=30)

    assert results == {"holder": "done", "renewal": "done"}
    fan.refresh_from_db()
    star.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("100")
    assert star.tuzis == Decimal("100")
    assert sub.expires == expires
    assert not _sub_events(sub).exists()
    assert _renew_jobs(sub).count() == 1


@pytest.mark.django_db
def test_insufficient_funds_no_charge_hourly_retry(creator_factory):
    """
    Legacy sweep behavior replicated: a short fan is skipped without
    charge or state change, and gets another chance each hour until the
    window closes at expiry (fan balance can change without any
    Subscription save, so the signal cannot re-arm this case).
    """
    fan = creator_factory(tuzis=Decimal("5"))
    star = creator_factory()  # member_price 10 > 5
    # 20h out: the hourly cadence is under test, not the  clamp.
    expires = timezone.now() + timedelta(hours=20)
    sub = _make_sub(fan, star, expires=expires)
    before = timezone.now()

    renew_subscription(subscription_id=sub.pk)

    fan.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("5")
    assert sub.expires == expires
    assert not _sub_events(sub).exists()

    jobs = _renew_jobs(sub)
    assert jobs.count() == 1
    retry = jobs.get()
    assert retry.queue_name == "billing"
    assert before + RENEWAL_RETRY <= retry.scheduled_at \
        <= timezone.now() + RENEWAL_RETRY


@pytest.mark.django_db
def test_free_membership_renews_without_moving_2z(creator_factory):
    """: price 0 is a FREE membership. Its renewal extends 30 days, never
    fails, and moves no 2Z -- no ledger Transfer, no balance change (this
    replaced the NULL-price test: member_price is NOT NULL now)."""
    from dj.apps.ledger.models import Transfer

    fan = creator_factory()
    star = creator_factory(member_price=Decimal("0"))
    # A fan who paid 10 under the old price keeps their 10 ceiling; 0 is
    # under any ceiling.
    sub = _make_sub(fan, star, max_price=Decimal("10"))
    old_expires = sub.expires
    transfers = Transfer.objects.count()

    renew_subscription(subscription_id=sub.pk)

    fan.refresh_from_db()
    star.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("1000")
    assert star.tuzis == Decimal("1000")
    assert Transfer.objects.count() == transfers
    assert sub.expires >= old_expires + timedelta(days=29)
    assert sub.last_charged_at is not None
    assert set(_sub_events(sub).values_list("amount", flat=True)) == {
        Decimal("0")}


@pytest.mark.django_db
def test_free_membership_renews_for_a_fan_with_no_2z(creator_factory):
    fan = creator_factory(tuzis=Decimal("0"))
    star = creator_factory(member_price=Decimal("0"))
    sub = _make_sub(fan, star, max_price=Decimal("10"))
    old_expires = sub.expires

    renew_subscription(subscription_id=sub.pk)

    fan.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("0")
    assert sub.expires >= old_expires + timedelta(days=29)


@pytest.mark.django_db
def test_cancelled_free_membership_does_not_renew(creator_factory):
    """max_price 0 is still cancellation, even when the price is 0 too."""
    fan = creator_factory()
    star = creator_factory(member_price=Decimal("0"))
    sub = _make_sub(fan, star, max_price=Decimal("0"))
    old_expires = sub.expires

    renew_subscription(subscription_id=sub.pk)

    sub.refresh_from_db()
    assert sub.expires == old_expires
    assert not _sub_events(sub).exists()


@pytest.mark.django_db
def test_already_renewed_far_future_is_noop_and_rearms(creator_factory):
    # Idempotency guard in isolation: something already renewed this
    # sub (expires way past now + LEAD) — stale job must not charge.
    # it re-arms the chain at the committed expires - LEAD
    # (under plain django_db the signal's on_commit never fired, so this
    # is the only job the sub has -- exactly the stale-holder repair).
    fan, star = creator_factory(), creator_factory()
    expires = timezone.now() + timedelta(days=29)
    sub = _make_sub(fan, star, expires=expires)

    renew_subscription(subscription_id=sub.pk)

    fan.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("1000")
    assert sub.expires == expires
    assert not _sub_events(sub).exists()
    rearmed = _renew_jobs(sub).get()
    assert rearmed.status == "todo"
    assert rearmed.scheduled_at == expires - RENEWAL_LEAD


@pytest.mark.django_db
def test_lapsed_sub_is_noop(creator_factory):
    # The sweep never renewed expired subs (expires >= now filter):
    # a lapsed sub stays lapsed, no charge, chain ends.
    fan, star = creator_factory(), creator_factory()
    expires = timezone.now() - timedelta(hours=1)
    sub = _make_sub(fan, star, expires=expires)

    renew_subscription(subscription_id=sub.pk)

    fan.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("1000")
    assert sub.expires == expires
    assert not _sub_events(sub).exists()
    assert not _renew_jobs(sub).exists()


@pytest.mark.django_db
def test_missing_sub_is_noop():
    # Stale job for a deleted subscription: must not raise
    renew_subscription(subscription_id=987654321)


# ---------------------------------------------------------------------------
# The demoted sweep: migration path + backstop
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_sweep_enqueues_jobs_for_window_subs_only(creator_factory):
    """
    Legacy subs have no chain job (under plain django_db the signal's
    on_commit never fires, which conveniently simulates exactly that).
    The daily sweep must enqueue a renewal job for every sub inside the
    legacy window — and nothing else — converting the fleet organically.
    It must never charge directly.
    """
    fan, star = creator_factory(), creator_factory()
    fan2, star2 = creator_factory(), creator_factory()
    fan3, star3 = creator_factory(), creator_factory()
    due = _make_sub(fan, star, expires=timezone.now() + timedelta(hours=12))
    future = _make_sub(
        fan2, star2, expires=timezone.now() + timedelta(days=20))
    lapsed = _make_sub(
        fan3, star3, expires=timezone.now() - timedelta(hours=1))
    assert not ProcrastinateJob.objects.exists()

    call_command("renew_subs")

    assert _renew_jobs(due).count() == 1
    assert _renew_jobs(due).get().queue_name == "billing"
    assert not _renew_jobs(future).exists()
    assert not _renew_jobs(lapsed).exists()
    # The sweep is a dispatcher now: it never touches balances itself
    fan.refresh_from_db()
    assert fan.tuzis == Decimal("1000")


@pytest.mark.django_db(transaction=True)
def test_sweep_then_worker_renews_and_rearms_chain(creator_factory):
    """
    End-to-end migration path: legacy sub with no job -> sweep enqueues
    -> task renews through the guarded path -> chain is self-armed for
    the next cycle. Overlap with a duplicate sweep run stays one charge --
    and one JOB: the second sweep's defer is refused by the
    queueing_lock while the first is pending.
    """
    fan, star = creator_factory(), creator_factory()
    expires = timezone.now() + timedelta(hours=12)
    sub = _make_sub(fan, star, expires=expires)
    ProcrastinateJob.objects.all().delete()  # simulate a legacy sub

    call_command("renew_subs")
    call_command("renew_subs")  # a second sweep overlap must be harmless
    assert _renew_jobs(sub).count() == 1

    # The worker consumes it (todo -> doing -> succeeded, releasing the
    # lock) and the task extends. A stale duplicate arriving afterwards
    # -- the callable, as any duplicate job would run -- must not charge.
    consumed = _run_as_worker(sub)
    renew_subscription(subscription_id=sub.pk)

    fan.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("990")  # exactly one charge
    assert sub.expires == expires + timedelta(days=30)
    # 1 consumed sweep job + exactly 1 new chain job at the next renewal
    # moment, carrying the lock for the next cycle.
    assert _renew_jobs(sub).count() == 2
    next_job = _renew_jobs(sub).exclude(pk=consumed.pk).get()
    assert next_job.status == "todo"
    assert next_job.scheduled_at == sub.expires - RENEWAL_LEAD
    assert next_job.queueing_lock == renewal_queueing_lock(sub.pk, sub.expires)
