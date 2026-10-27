"""
The renewal retry stays inside the window and never amplifies . MONEY PATH, against real Postgres.

Two properties of ``RENEWAL_RETRY``, each pinned by a test that FAILS
without the change (the negative-control outputs are in the PR body):

1. **No overshoot.** A non-chargeable subscription inside its last hour used
   to schedule its retry AFTER ``expires``, where the lapsed guard made it a
   guaranteed no-op; a fan who topped up in that final interval was never
   charged and the creator never paid, with every job recorded successful.
   The retry is now ``min(now + RENEWAL_RETRY, expires - RENEWAL_LAST_LOOK)``
   and nothing at all inside the last look. The assertion is on the LEDGER
   (the fan is debited, the star credited), not on a job existing -- a job
   scheduled past ``expires`` exists and does nothing.
2. **No amplification.** Every defer of ``g12f.renew_subscription`` goes
   through ``defer_renewal`` with ``queueing_lock="renew-sub-<pk>-<expires>"``,
   so N executions of one non-chargeable subscription leave ONE pending
   retry, not N chains of ~24 each on the two-slot billing worker -- while a
   job for a DIFFERENT cycle (``expires`` moved) is never refused.

Same conventions as test_renew_subscription.py: real ``procrastinate_jobs``
rows through the Django connection, tasks exercised as plain callables, and
``transaction=True`` wherever ``transaction.on_commit`` has to fire. "The
retry runs when it comes due" is modelled by pinning the task module's clock
to the job's ``scheduled_at`` -- the honest way to show that a retry the old
code scheduled past ``expires`` would have charged nothing.
"""
from datetime import timedelta
from decimal import Decimal
import threading
from types import SimpleNamespace

import pytest
from django.core.management import call_command
from django.db import OperationalError, connection, transaction
from django.utils import timezone

from procrastinate.contrib.django.models import ProcrastinateJob

from dj.apps.events.models import Event
from dj.apps.g12f import tasks as renewal_tasks
from dj.apps.g12f.models import Creator, Subscription
from dj.apps.g12f.tasks import (
    RENEWAL_LAST_LOOK,
    RENEWAL_LEAD,
    RENEWAL_RETRY,
    defer_renewal,
    renew_subscription,
    renewal_queueing_lock,
    renewal_retry_at,
)


def _make_sub(fan, star, **kwargs):
    defaults = dict(
        fan=fan,
        star=star,
        expires=timezone.now() + timedelta(hours=1),
        max_price=star.member_price or Decimal("10"),
    )
    defaults.update(kwargs)
    return Subscription.objects.create(**defaults)


def _renew_jobs(sub):
    return ProcrastinateJob.objects.filter(
        task_name="g12f.renew_subscription",
        args={"subscription_id": sub.pk},
    )


def _pending(sub):
    return _renew_jobs(sub).filter(status="todo")


def _sub_events(sub):
    return Event.objects.filter(
        type__in=["SUBSCRIPTION_RECEIVED", "SUBSCRIPTION_SENT"],
        payee=sub.star,
        contributor=sub.fan,
    )


def _pin_task_clock(monkeypatch, when):
    """Make the task believe it is ``when`` -- i.e. run it as the worker
    would at the moment the job is scheduled for. Only the task module's
    clock moves; ``Subscription.extend`` and the ledger keep the real one,
    so the money side of the assertion is untouched."""
    monkeypatch.setattr(
        renewal_tasks, "timezone", SimpleNamespace(now=lambda: when))


def _run_pending_job_when_due(sub, monkeypatch):
    """Consume the sub's pending job at its ``scheduled_at``, the way the
    billing worker would: the row goes ``todo -> doing`` before the body
    runs (which is what frees the queueing_lock for a successor) and
    ``-> succeeded`` after. A job scheduled in the past is due now, so the
    clock is ``max(scheduled_at, now)``: the worker runs a job at its
    moment or as soon after it as it can, never before.

    The clock pin lives in its own ``monkeypatch.context()`` so that ONLY
    the clock is unwound afterwards -- a bare ``monkeypatch.undo()`` here
    would also silently drop every patch the calling test set up before it
    (review round 2)."""
    job = _pending(sub).order_by("scheduled_at", "id").first()
    assert job is not None, "no pending renewal job to run"
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE procrastinate_jobs SET status='doing' WHERE id=%s",
            [job.id])
    try:
        with monkeypatch.context() as clock:
            if job.scheduled_at is not None:  # an immediate job: due now
                _pin_task_clock(
                    clock, max(job.scheduled_at, timezone.now()))
            renew_subscription(subscription_id=sub.pk)
    finally:
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE procrastinate_jobs SET status='succeeded' "
                "WHERE id=%s", [job.id])
    return job


# ---------------------------------------------------------------------------
# 1. No overshoot: the last look is a real look, and it charges
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_fan_who_tops_up_inside_the_last_hour_is_charged(
        creator_factory, monkeypatch):
    """Issue  test 1. A sub 30 minutes from expiry, fan short on 2Z;
    the fan tops up after the skip; the retry -- run when it comes due --
    must CHARGE. Asserted on the ledger.

    NEGATIVE CONTROL: with the flat ``now + 1h`` retry the job is scheduled
    30 minutes past ``expires``; run at that moment it hits the lapsed guard,
    the fan keeps 1000 and the star is never paid.
    """
    fan = creator_factory(tuzis=Decimal("5"))
    star = creator_factory()  # member_price 10 > 5
    expires = timezone.now() + timedelta(minutes=30)
    sub = _make_sub(fan, star, expires=expires)
    ProcrastinateJob.objects.all().delete()

    renew_subscription(subscription_id=sub.pk)  # skip: short on funds

    fan.refresh_from_db()
    assert fan.tuzis == Decimal("5")
    assert _pending(sub).count() == 1

    # The fan tops up. No Subscription save, no sweep: the pending retry is
    # the only thing that will ever look again.
    Creator.objects.filter(pk=fan.pk).update(tuzis=Decimal("1000"))

    retry = _run_pending_job_when_due(sub, monkeypatch)

    # The ledger first: this is the assertion that matters, and the one the
    # flat retry fails (a job scheduled past `expires` exists and charges
    # nothing).
    fan.refresh_from_db()
    star.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("990"), "the fan was not charged"
    assert star.tuzis == Decimal("1010"), "the creator was not paid"
    assert sub.expires == expires + timedelta(days=30)
    assert _sub_events(sub).count() == 2
    #...because the retry was inside the window, at the last look.
    assert retry.scheduled_at == expires - RENEWAL_LAST_LOOK
    # And the chain is re-armed for the next cycle, under the lock.
    next_job = _pending(sub).get()
    assert next_job.scheduled_at == sub.expires - RENEWAL_LEAD
    assert next_job.queueing_lock == renewal_queueing_lock(sub.pk, sub.expires)


@pytest.mark.django_db
def test_retry_is_hourly_until_the_clamp_bites(creator_factory):
    """Far from expiry the cadence is the legacy hour, unchanged; close to
    it, the clamp: ``min(now + 1h, expires - 5m)``, exactly."""
    fan = creator_factory(tuzis=Decimal("5"))
    star = creator_factory()
    far = _make_sub(fan, star, expires=timezone.now() + timedelta(hours=20))
    near = _make_sub(
        fan, creator_factory(), expires=timezone.now() + timedelta(minutes=30))
    ProcrastinateJob.objects.all().delete()
    before = timezone.now()

    renew_subscription(subscription_id=far.pk)
    renew_subscription(subscription_id=near.pk)

    far_retry = _pending(far).get()
    assert before + RENEWAL_RETRY <= far_retry.scheduled_at \
        <= timezone.now() + RENEWAL_RETRY
    near_retry = _pending(near).get()
    assert near_retry.scheduled_at == near.expires - RENEWAL_LAST_LOOK


def test_renewal_retry_at_is_clamped_and_never_in_the_past():
    now = timezone.now()
    # Far out: the plain hour.
    assert renewal_retry_at(now, now + timedelta(hours=20)) \
        == now + RENEWAL_RETRY
    # Inside the last hour: clamped to the last look, still in the future.
    at = renewal_retry_at(now, now + timedelta(minutes=30))
    assert at == now + timedelta(minutes=25)
    assert at > now
    # Exactly at the boundary and inside the last look: nothing.
    assert renewal_retry_at(now, now + RENEWAL_LAST_LOOK) is None
    assert renewal_retry_at(now, now + timedelta(minutes=3)) is None
    assert renewal_retry_at(now, now) is None
    assert renewal_retry_at(now, now - timedelta(minutes=1)) is None


# ---------------------------------------------------------------------------
# 3. Inside the last look: the chain ends, and does not loop
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_no_funds_inside_the_last_look_ends_the_chain_without_a_loop(
        creator_factory, monkeypatch):
    """Issue  test 3. A sub three minutes from expiry with no funds:
    no charge, ZERO pending jobs, and the lapsed outcome reached once by a
    straggler -- never a job scheduled in the past, which procrastinate
    would run immediately (the tight loop  warned a naive clamp
    would become).

    NEGATIVE CONTROL: the flat retry leaves one pending job, scheduled 57
    minutes past ``expires``.
    """
    fan = creator_factory(tuzis=Decimal("5"))
    star = creator_factory()
    expires = timezone.now() + timedelta(minutes=3)
    sub = _make_sub(fan, star, expires=expires)
    ProcrastinateJob.objects.all().delete()

    renew_subscription(subscription_id=sub.pk)

    fan.refresh_from_db()
    assert fan.tuzis == Decimal("5")
    assert not _renew_jobs(sub).exists()

    # A straggler (say, a backstop job) arriving after expiry: the lapsed
    # guard, once, and still nothing scheduled.
    with monkeypatch.context() as clock:
        _pin_task_clock(clock, expires + timedelta(seconds=1))
        renew_subscription(subscription_id=sub.pk)

    fan.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("5")
    assert sub.expires == expires
    assert not _sub_events(sub).exists()
    assert not _renew_jobs(sub).exists()
    assert not ProcrastinateJob.objects.filter(
        task_name="g12f.renew_subscription",
        scheduled_at__lt=timezone.now(),
    ).exists(), "a renewal retry was scheduled in the past"


# ---------------------------------------------------------------------------
# 2. No amplification: one pending retry per subscription
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_three_executions_of_a_short_fan_leave_one_pending_retry(
        creator_factory):
    """Issue  test 2, on the pre-existing ineligible branch (the
    inactive-fan branch has its own copy in test_renew_subscription.py).

    NEGATIVE CONTROL: 3 without the queueing_lock -- each execution deferred
    its own successor.
    """
    fan = creator_factory(tuzis=Decimal("5"))
    star = creator_factory()
    expires = timezone.now() + timedelta(hours=20)
    sub = _make_sub(fan, star, expires=expires)
    ProcrastinateJob.objects.all().delete()

    for _ in range(3):
        renew_subscription(subscription_id=sub.pk)

    fan.refresh_from_db()
    assert fan.tuzis == Decimal("5")
    assert not _sub_events(sub).exists()
    assert _pending(sub).count() == 1
    assert _pending(sub).get().queueing_lock \
        == renewal_queueing_lock(sub.pk, sub.expires)


@pytest.mark.django_db
def test_two_subscriptions_do_not_share_a_lock(creator_factory):
    """The lock is per subscription, not per task: a short fan with two
    subscriptions still gets one pending retry EACH."""
    fan = creator_factory(tuzis=Decimal("5"))
    first = _make_sub(
        fan, creator_factory(), expires=timezone.now() + timedelta(hours=20))
    second = _make_sub(
        fan, creator_factory(), expires=timezone.now() + timedelta(hours=20))
    ProcrastinateJob.objects.all().delete()

    renew_subscription(subscription_id=first.pk)
    renew_subscription(subscription_id=second.pk)

    assert _pending(first).count() == 1
    assert _pending(second).count() == 1
    assert _pending(first).get().queueing_lock \
        != _pending(second).get().queueing_lock


# ---------------------------------------------------------------------------
# Every enqueue point carries the lock
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_subscription_save_hook_carries_the_lock_and_collapses_repeats(
        creator_factory):
    """A burst of saves (the authenticated PATCH can save the same value
    repeatedly, throttled only globally) leaves one pending chain job.

    NEGATIVE CONTROL: without the lock the second save enqueues a second
    job (2).
    """
    fan, star = creator_factory(), creator_factory()
    sub = _make_sub(fan, star, expires=timezone.now() + timedelta(days=30))

    job = _pending(sub).get()
    assert job.queueing_lock == renewal_queueing_lock(sub.pk, sub.expires)
    assert job.scheduled_at == sub.expires - RENEWAL_LEAD

    sub.save()
    sub.save()

    # One job, the SAME job, at the same moment: a save never moves the
    # chain job, which is already at the moment the save asks for.
    still = _pending(sub).get()
    assert still.pk == job.pk
    assert still.scheduled_at == job.scheduled_at


@pytest.mark.django_db(transaction=True)
def test_subscribe_transaction_enqueues_one_job_for_the_committed_expires(
        creator_factory):
    """Both subscribe routes (``tuzis/views.py``) do ``get_or_create`` --
    ``expires`` defaults to now -- and then ``extend()`` inside ONE
    ``transaction.atomic()``, so two post_save callbacks fire from a single
    commit. Each must ask for the COMMITTED row's renewal moment: exactly one
    pending job, at ``expires - RENEWAL_LEAD``, and nothing due in the past.

    NEGATIVE CONTROL: with the callback closing over each save's own
    ``instance.expires`` the first enqueues a throwaway job keyed on the
    get_or_create default and scheduled 24h in the past (2 pending, one of
    them dispatched immediately on the two-slot billing lane ahead of real
    renewals).
    """
    fan, star = creator_factory(), creator_factory()
    ProcrastinateJob.objects.all().delete()

    with transaction.atomic():
        sub, _ = Subscription.objects.get_or_create(
            star=star, fan=fan, defaults={"max_price": star.member_price})
        assert sub.extend() is True

    sub.refresh_from_db()
    fan.refresh_from_db()
    assert fan.tuzis == Decimal("990")
    job = _pending(sub).get()
    assert job.scheduled_at == sub.expires - RENEWAL_LEAD
    assert job.queueing_lock == renewal_queueing_lock(sub.pk, sub.expires)
    assert not _renew_jobs(sub).filter(
        scheduled_at__lt=timezone.now()).exists()


@pytest.mark.django_db(transaction=True)
def test_save_hook_schedules_nothing_for_a_row_deleted_before_commit(
        creator_factory):
    """The callback runs at commit; a row that was deleted after its save but
    before the commit has no renewal moment and gets no job.

    NEGATIVE CONTROL: closing over ``instance.expires`` enqueues a job for a
    subscription that no longer exists (1).
    """
    fan, star = creator_factory(), creator_factory()
    ProcrastinateJob.objects.all().delete()

    with transaction.atomic():
        sub = _make_sub(fan, star, expires=timezone.now() + timedelta(days=30))
        sub_id = sub.pk
        sub.delete()

    assert not ProcrastinateJob.objects.filter(
        task_name="g12f.renew_subscription",
        args={"subscription_id": sub_id},
    ).exists()


@pytest.mark.django_db(transaction=True)
def test_save_hook_schedules_nothing_for_a_sub_cancelled_before_commit(
        creator_factory):
    """A create followed by a cancel (``max_price=0``) in the same transaction
    commits a cancelled row; the committed row, not the first save, decides.

    NEGATIVE CONTROL: closing over the first save's ``max_price > 0`` enqueues
    a job for the cancelled subscription (1).
    """
    fan, star = creator_factory(), creator_factory()
    ProcrastinateJob.objects.all().delete()

    with transaction.atomic():
        sub = _make_sub(fan, star, expires=timezone.now() + timedelta(days=30))
        sub.max_price = Decimal("0")
        sub.save()

    assert _renew_jobs(sub).count() == 0


@pytest.mark.django_db
def test_not_due_rearm_failure_is_logged_not_raised(
        creator_factory, monkeypatch, caplog):
    """The not-due guard charges nothing and was a bare ``return`` on main;
    its re-arm  is best effort. A transient queue/DB error there must
    not raise -- an exception here is three ``RENEWAL_RETRY_STRATEGY``
    attempts and a ``failed`` row that pages
    ``procrastinate-billing-jobs-failed`` for a job that was never going to
    charge. The daily backstop repairs the chain instead.

    NEGATIVE CONTROL: without the guard's try/except the OperationalError
    propagates out of the task.
    """
    fan, star = creator_factory(), creator_factory()
    sub = _make_sub(fan, star, expires=timezone.now() + timedelta(days=30))
    ProcrastinateJob.objects.all().delete()

    def queue_down(**kwargs):
        raise OperationalError("queue down")

    monkeypatch.setattr(renewal_tasks.renew_subscription, "configure",
                        queue_down)

    renew_subscription(subscription_id=sub.pk)  # must not raise

    fan.refresh_from_db()
    assert fan.tuzis == Decimal("1000")
    assert _renew_jobs(sub).count() == 0
    assert any(
        "re-arming the chain" in r.getMessage() and "failed" in r.getMessage()
        for r in caplog.records)


@pytest.mark.django_db
def test_backstop_sweep_carries_the_lock_and_does_not_duplicate(
        creator_factory):
    """The daily backstop is the biggest duplicate source (every sub in the
    window, every day). It enqueues a sub with no pending job and leaves one
    with a pending job alone, reporting it as ``already_pending``.

    NEGATIVE CONTROL: without the lock two sweeps make two jobs.
    """
    fan, star = creator_factory(), creator_factory()
    sub = _make_sub(fan, star, expires=timezone.now() + timedelta(hours=12))
    ProcrastinateJob.objects.all().delete()

    call_command("renew_subs")
    call_command("renew_subs")

    job = _pending(sub).get()
    assert job.queueing_lock == renewal_queueing_lock(sub.pk, sub.expires)


@pytest.mark.django_db
def test_defer_renewal_reports_whether_it_enqueued(creator_factory):
    fan, star = creator_factory(), creator_factory()
    sub = _make_sub(fan, star)
    ProcrastinateJob.objects.all().delete()

    assert defer_renewal(sub.pk, sub.expires) is True
    assert defer_renewal(sub.pk, sub.expires) is False
    assert defer_renewal(
        sub.pk, sub.expires,
        schedule_at=timezone.now() + timedelta(hours=1)) is False
    assert _pending(sub).count() == 1
    # A different cycle is not a duplicate.
    assert defer_renewal(sub.pk, sub.expires + timedelta(days=30)) is True
    assert _pending(sub).count() == 2


# ---------------------------------------------------------------------------
# A moved `expires` is a new cycle: its job is never refused
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_manual_extension_while_a_chain_job_is_pending_still_renews_on_time(
        creator_factory, monkeypatch):
    """The codex review's round-1 finding on the first cut of, whose
    lock was keyed per subscription: a fan extends an active subscription
    while its chain job is pending; the save's job at the NEW moment was
    refused by the old one; the old one later hit the not-due guard and
    left the renewal to a daily backstop whose 24h window equals the lead,
    so a CronJob starting minutes late could miss a sub expiring just after
    its tick. The lock is keyed by cycle, so the new job is enqueued
    alongside the old; the old runs at its moment, does nothing, and its
    re-arm is refused because the right job is already pending.

    NEGATIVE CONTROL: with the lock keyed per subscription alone the save
    is refused (one pending job, at the OLD moment) and this fails on the
    count.
    """
    fan, star = creator_factory(), creator_factory()
    old_expires = timezone.now() + timedelta(days=30)
    sub = _make_sub(fan, star, expires=old_expires)
    chain = _pending(sub).get()
    assert chain.scheduled_at == old_expires - RENEWAL_LEAD

    # The fan pre-pays another cycle: `expires` moves out, and the post_save
    # hook enqueues the job for the new moment next to the old one.
    new_expires = old_expires + timedelta(days=30)
    sub.expires = new_expires
    sub.save()
    assert _pending(sub).count() == 2
    fresh = _pending(sub).exclude(pk=chain.pk).get()
    assert fresh.scheduled_at == new_expires - RENEWAL_LEAD
    assert fresh.queueing_lock == renewal_queueing_lock(sub.pk, new_expires)

    # The old job runs when it comes due: nothing to charge (60d out is not
    # due), its re-arm is refused, and the chain is exactly the fresh job.
    ran = _run_pending_job_when_due(sub, monkeypatch)
    assert ran.pk == chain.pk

    fan.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("1000")
    assert sub.expires == new_expires
    assert not _sub_events(sub).exists()
    assert _pending(sub).get().pk == fresh.pk


@pytest.mark.django_db(transaction=True)
def test_expires_moved_earlier_gets_its_own_job_and_charges(
        creator_factory, monkeypatch):
    """The codex review's round-2 finding: the admin corrects an active
    subscription's expiry from 30 days away to tomorrow. Keyed per
    subscription, the pending job 29 days out held the lock, the save's
    earlier moment was refused, the daily backstop was refused by the same
    lock, and the sub lapsed unpaid with every job green. Keyed per cycle,
    the save enqueues the job for tomorrow's cycle -- due now -- and it
    charges.

    NEGATIVE CONTROL: with the lock keyed per subscription alone the only
    pending job is the one 29 days out, and the ledger never moves.
    """
    fan, star = creator_factory(), creator_factory()
    sub = _make_sub(fan, star, expires=timezone.now() + timedelta(days=30))
    stale = _pending(sub).get()

    new_expires = timezone.now() + timedelta(days=1)
    sub.expires = new_expires
    sub.save()

    assert _pending(sub).count() == 2
    fresh = _pending(sub).exclude(pk=stale.pk).get()
    assert fresh.scheduled_at == new_expires - RENEWAL_LEAD  # in the past
    assert fresh.scheduled_at < timezone.now()

    # Due now: the worker takes the earliest, and it is in the window.
    ran = _run_pending_job_when_due(sub, monkeypatch)
    assert ran.pk == fresh.pk

    fan.refresh_from_db()
    star.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("990")
    assert star.tuzis == Decimal("1010")
    assert sub.expires == new_expires + timedelta(days=30)
    # The stale job is still pending for its old moment; when it runs it
    # finds `expires` moved and does nothing. The next chain job is armed.
    assert {j.scheduled_at for j in _pending(sub)} == {
        stale.scheduled_at, sub.expires - RENEWAL_LEAD,
    }


@pytest.mark.django_db
def test_lock_key_is_stable_for_one_cycle_and_distinct_across_cycles(
        creator_factory):
    fan, star = creator_factory(), creator_factory()
    sub = _make_sub(fan, star)
    sub.refresh_from_db()
    same = Subscription.objects.get(pk=sub.pk)
    assert renewal_queueing_lock(sub.pk, sub.expires) \
        == renewal_queueing_lock(same.pk, same.expires)
    assert renewal_queueing_lock(sub.pk, sub.expires) \
        != renewal_queueing_lock(sub.pk, sub.expires + timedelta(days=30))
    assert renewal_queueing_lock(sub.pk, sub.expires) \
        != renewal_queueing_lock(sub.pk + 1, sub.expires)


# ---------------------------------------------------------------------------
# The double-charge property is untouched by the lock
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_lock_does_not_weaken_the_single_charge_guarantee(
        creator_factory, monkeypatch):
    """The lock constrains REGISTRATION only; the charge is still decided by
    the guards under ``SELECT... FOR UPDATE``. The chain job runs as the
    worker would (releasing the lock), a stale duplicate lands afterwards
    -- exactly one debit, one credit, one extension, one pending successor.
    """
    fan, star = creator_factory(), creator_factory()
    expires = timezone.now() + timedelta(hours=1)
    sub = _make_sub(fan, star, expires=expires)
    ProcrastinateJob.objects.all().delete()
    call_command("renew_subs")  # the backstop arms it

    _run_pending_job_when_due(sub, monkeypatch)
    renew_subscription(subscription_id=sub.pk)  # stale duplicate
    renew_subscription(subscription_id=sub.pk)  # and another

    fan.refresh_from_db()
    star.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("990")
    assert star.tuzis == Decimal("1010")
    assert sub.expires == expires + timedelta(days=30)
    assert _sub_events(sub).count() == 2
    assert _pending(sub).count() == 1
    assert _pending(sub).get().scheduled_at == sub.expires - RENEWAL_LEAD


@pytest.mark.django_db(transaction=True)
def test_duplicate_job_an_hour_after_a_renewal_charges_nothing(
        creator_factory, monkeypatch):
    """One cycle is charged at most once no matter how many jobs run. The
    case that matters is a duplicate landing AFTER the renewal and past
    ``extend()``'s 60s ``last_charged_at`` debounce -- a reclaimed job, a
    procrastinate exception retry, a backstop twin on a slow lane -- where
    the not-due guard (guard 5, under ``SELECT... FOR UPDATE``) is the only
    thing standing between the fan and a second charge for the same cycle.
    ``test_duplicate_jobs_charge_exactly_once`` runs its duplicate within
    seconds, inside the debounce; this one runs two an hour later.

    NEGATIVE CONTROL: with the not-due guard removed the fan is charged
    AGAIN for the same cycle (fan 980, star 1020, four events, expires 60
    days out) -- a double charge on the ledger.
    """
    fan, star = creator_factory(), creator_factory()
    expires = timezone.now() + timedelta(hours=1)
    sub = _make_sub(fan, star, expires=expires)
    ProcrastinateJob.objects.all().delete()
    call_command("renew_subs")

    _run_pending_job_when_due(sub, monkeypatch)  # the renewal: one charge
    fan.refresh_from_db()
    assert fan.tuzis == Decimal("990")

    # An hour passes (the stored charge stamp ages with it, since only the
    # task's clock is pinned) and two more copies of the job run.
    Subscription.objects.filter(pk=sub.pk).update(
        last_charged_at=timezone.now() - timedelta(hours=1))
    with monkeypatch.context() as clock:
        _pin_task_clock(clock, timezone.now() + timedelta(hours=1))
        renew_subscription(subscription_id=sub.pk)
        renew_subscription(subscription_id=sub.pk)

    fan.refresh_from_db()
    star.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("990"), "the fan was charged twice"
    assert star.tuzis == Decimal("1010"), "the creator was paid twice"
    assert sub.expires == expires + timedelta(days=30)
    assert _sub_events(sub).count() == 2
    assert _pending(sub).count() == 1
    assert _pending(sub).get().scheduled_at == sub.expires - RENEWAL_LEAD


@pytest.mark.django_db(transaction=True)
def test_overlapping_jobs_for_one_cycle_charge_once(creator_factory):
    """Two jobs for the same cycle running at the SAME moment -- an
    overlapping sweep and chain job on the two-slot billing lane, or a
    reclaimed copy started next to the original. ``SELECT... FOR UPDATE``
    on the subscription serializes them; the loser re-reads the committed
    ``expires`` and takes the not-due guard. Defence in depth behind that:
    ``extend()`` takes its own row lock and debounces on
    ``last_charged_at``. Exactly one debit, one credit, one pending
    successor, and no deadlock.
    """
    fan, star = creator_factory(), creator_factory()
    expires = timezone.now() + timedelta(hours=1)
    sub = _make_sub(fan, star, expires=expires)
    ProcrastinateJob.objects.all().delete()

    barrier = threading.Barrier(2, timeout=10)
    results = {}

    def run(name):
        try:
            barrier.wait()
            renew_subscription(subscription_id=sub.pk)
            results[name] = "done"
        except Exception as error:  # pragma: no cover - reported below
            results[name] = error
        finally:
            connection.close()

    threads = [
        threading.Thread(target=run, args=(name,)) for name in ("a", "b")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
        assert not thread.is_alive(), "overlapping renewals deadlocked"

    assert results == {"a": "done", "b": "done"}
    fan.refresh_from_db()
    star.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("990"), "the fan was charged twice"
    assert star.tuzis == Decimal("1010"), "the creator was paid twice"
    assert sub.expires == expires + timedelta(days=30)
    assert _sub_events(sub).count() == 2
    assert _pending(sub).count() == 1
    assert _pending(sub).get().scheduled_at == sub.expires - RENEWAL_LEAD


# ---------------------------------------------------------------------------
# A Subscription save is an immediate look, even while a retry is pending
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_cap_raise_while_a_retry_is_pending_is_charged_at_once(
        api_client, creator_factory, monkeypatch):
    """Review round 2 (MEDIUM). The creator raises ``member_price``; the
    fan's cap is now below it, the renewal skips, and a retry is pending an
    hour out. The fan fixes it through the real "raise your cap" endpoint,
    ``PATCH /api/tuzis/subscribe/{username}``, which only accepts a cap that
    makes the sub chargeable right now. On ``main`` that save enqueued a job
    at ``expires - RENEWAL_LEAD`` -- in the past -- and the fan was charged
    on the spot; under the per-cycle lock alone the pending retry refused it
    and the fan waited up to an hour with no signal. The hook now pulls the
    pending retry forward to that moment: still ONE pending job, the same
    row, due now. Run as the worker would, it charges. Asserted on the
    ledger.

    NEGATIVE CONTROL: without ``pull_forward`` the one pending job stays at
    its hourly moment (``scheduled_at`` an hour out) and this fails there.
    """
    fan, star = creator_factory(), creator_factory()  # cap 10 == price 10
    expires = timezone.now() + timedelta(hours=10)
    sub = _make_sub(fan, star, expires=expires)
    ProcrastinateJob.objects.all().delete()
    Creator.objects.filter(pk=star.pk).update(member_price=Decimal("20"))

    renew_subscription(subscription_id=sub.pk)  # ineligible: cap 10 < 20
    retry = _pending(sub).get()
    assert retry.scheduled_at > timezone.now() + timedelta(minutes=55)
    fan.refresh_from_db()
    assert fan.tuzis == Decimal("1000")

    api_client.force_authenticate(fan)
    resp = api_client.patch(
        f"/api/tuzis/subscribe/{star.username}",
        {"max_price": "20"}, format="json")
    assert resp.status_code == 200, resp.content

    pending = _pending(sub).get()  # one job for the cycle, the same row...
    assert pending.pk == retry.pk
    assert pending.queueing_lock == renewal_queueing_lock(sub.pk, expires)
    assert pending.scheduled_at == expires - RENEWAL_LEAD  #...due now
    assert pending.scheduled_at <= timezone.now()

    ran = _run_pending_job_when_due(sub, monkeypatch)
    assert ran.pk == retry.pk

    fan.refresh_from_db()
    star.refresh_from_db()
    sub.refresh_from_db()
    assert fan.tuzis == Decimal("980"), "the fan was not charged"
    assert star.tuzis == Decimal("1020"), "the creator was not paid"
    assert sub.expires == expires + timedelta(days=30)
    assert _sub_events(sub).count() == 2
    next_job = _pending(sub).get()
    assert next_job.scheduled_at == sub.expires - RENEWAL_LEAD
    assert next_job.queueing_lock == renewal_queueing_lock(sub.pk, sub.expires)


@pytest.mark.django_db
def test_defer_renewal_pull_forward_moves_only_a_later_pending_job(
        creator_factory):
    """``pull_forward`` is one UPDATE, filtered on ``scheduled_at > asked``:
    a pending job scheduled later is moved up; one at or before the asked
    moment, or an immediate one (``scheduled_at IS NULL``), is left alone;
    a job for another cycle is never touched. It never inserts."""
    fan, star = creator_factory(), creator_factory()
    sub = _make_sub(fan, star, expires=timezone.now() + timedelta(hours=10))
    ProcrastinateJob.objects.all().delete()
    later = timezone.now() + timedelta(hours=1)
    asked = sub.expires - RENEWAL_LEAD
    other_cycle = sub.expires + timedelta(days=30)

    assert defer_renewal(sub.pk, sub.expires, schedule_at=later) is True
    assert defer_renewal(sub.pk, other_cycle, schedule_at=later) is True
    assert defer_renewal(
        sub.pk, sub.expires, schedule_at=asked, pull_forward=True) is False
    by_lock = {j.queueing_lock: j.scheduled_at for j in _pending(sub)}
    assert by_lock == {
        renewal_queueing_lock(sub.pk, sub.expires): asked,
        renewal_queueing_lock(sub.pk, other_cycle): later,
    }
    # Asking for a LATER moment moves nothing.
    assert defer_renewal(
        sub.pk, sub.expires, schedule_at=later, pull_forward=True) is False
    assert _pending(sub).get(
        queueing_lock=renewal_queueing_lock(sub.pk, sub.expires)
    ).scheduled_at == asked
    # An immediate job (NULL scheduled_at) is due already and stays NULL.
    ProcrastinateJob.objects.all().delete()
    assert defer_renewal(sub.pk, sub.expires) is True
    assert defer_renewal(
        sub.pk, sub.expires, schedule_at=asked, pull_forward=True) is False
    assert _pending(sub).get().scheduled_at is None


@pytest.mark.django_db
def test_backstop_sweep_leaves_a_pending_retry_at_its_moment(
        creator_factory):
    """The backstop asks whether a job is pending for the cycle, not for a
    moment: a retry an hour out is reported ``already_pending`` and left
    exactly where it is, not pulled to the sweep's tick."""
    fan = creator_factory(tuzis=Decimal("5"))
    star = creator_factory()
    sub = _make_sub(fan, star, expires=timezone.now() + timedelta(hours=12))
    ProcrastinateJob.objects.all().delete()

    renew_subscription(subscription_id=sub.pk)  # short on funds: retry +1h
    retry = _pending(sub).get()
    assert retry.scheduled_at > timezone.now()

    call_command("renew_subs")

    same = _pending(sub).get()
    assert same.pk == retry.pk
    assert same.scheduled_at == retry.scheduled_at
