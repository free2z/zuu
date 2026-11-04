"""Follow-up hardening of the chat-request route (free2z/zuu#1022, ws6)."""
import threading
from datetime import timedelta
from decimal import Decimal

import pytest
from django.core import mail
from django.core.checks import run_checks
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from procrastinate.contrib.django.models import ProcrastinateJob
from rest_framework.test import APIClient

from dj.apps.e2ee import tasks
from dj.apps.e2ee.checks import check_chat_request_settings
from dj.apps.e2ee.models import ChatRequest
from dj.apps.e2ee.tests.test_chat_requests import (
    balance,
    chat_request,
    key_for,
    notification_address,
    run_email_job,
)
from dj.apps.e2ee.views import CHAT_REQUEST_SCOPE
from dj.apps.events.models import Event
from dj.apps.tuzis.models import STALE_CLAIM, IdempotencyKey


@pytest.fixture
def pair(creator_factory):
    sender = creator_factory(username="hard_s", tuzis=Decimal("10"))
    recipient = creator_factory(username="hard_r", tuzis=Decimal("0"))
    return sender, recipient


# ------------------------------------------------------------ kill switch


@pytest.mark.django_db
def test_switched_off_charges_nothing_and_takes_no_key(pair, settings):
    settings.E2EE_CHAT_REQUESTS_ENABLED = False
    sender, recipient = pair

    response = chat_request(sender, recipient.username, key="off")

    assert response.status_code == 503
    assert response.json()["code"] == "chat_requests_disabled"
    assert balance(sender) == Decimal("10")
    assert balance(recipient) == Decimal("0")
    assert not IdempotencyKey.objects.filter(scope=CHAT_REQUEST_SCOPE).exists()
    assert not ChatRequest.objects.exists()
    assert not Event.objects.exists()
    assert not ProcrastinateJob.objects.filter(
        task_name=tasks.SEND_TASK_NAME).exists()

    # The same key works once the switch is back on.
    settings.E2EE_CHAT_REQUESTS_ENABLED = True
    assert chat_request(sender, recipient.username, key="off").status_code == 200


@pytest.mark.django_db
def test_switched_off_still_replays_a_completed_request(pair, settings):
    sender, recipient = pair
    first = chat_request(sender, recipient.username, key="done")
    settings.E2EE_CHAT_REQUESTS_ENABLED = False

    replay = chat_request(sender, recipient.username, key="done")

    assert replay.status_code == 200
    assert replay.json() == {**first.json(), "replayed": True}
    assert balance(sender) == Decimal("9")

    # A different recipient under that key is not a replay: just "off".
    other = chat_request(sender, sender.username, key="done")
    assert other.status_code == 503


@pytest.mark.django_db
def test_switched_off_never_denies_a_request_that_may_be_committing(
    pair, settings,
):
    sender, recipient = pair
    settings.E2EE_CHAT_REQUESTS_ENABLED = False
    record = IdempotencyKey.objects.create(
        scope=CHAT_REQUEST_SCOPE, user=sender, key=key_for("inflight"),
        request_hash="whatever",
    )

    response = chat_request(sender, recipient.username, key="inflight")
    assert response.status_code == 409
    assert response.json()["code"] == "request_in_progress"

    # A provably abandoned claim (older than STALE_CLAIM) did not charge.
    IdempotencyKey.objects.filter(pk=record.pk).update(
        created_at=timezone.now() - STALE_CLAIM - timedelta(minutes=1))
    response = chat_request(sender, recipient.username, key="inflight")
    assert response.status_code == 503
    assert IdempotencyKey.objects.filter(pk=record.pk).exists()


@pytest.mark.django_db
def test_switched_off_answers_disabled_for_unknown_and_self(pair, settings):
    settings.E2EE_CHAT_REQUESTS_ENABLED = False
    sender, _ = pair
    for username in ("nobody_at_all", sender.username):
        response = chat_request(sender, username, key=username)
        assert response.status_code == 503, username
        assert response.json()["code"] == "chat_requests_disabled"


@pytest.mark.django_db
def test_price_reports_the_switch(api_client, creator_factory, settings):
    api_client.force_authenticate(user=creator_factory())
    assert api_client.get("/api/e2ee/chat-requests/price/").json() == {
        "cost": 1, "enabled": True,
    }
    settings.E2EE_CHAT_REQUESTS_ENABLED = False
    assert api_client.get("/api/e2ee/chat-requests/price/").json() == {
        "cost": 1, "enabled": False,
    }


def test_the_switch_defaults_on_and_parses_strictly(monkeypatch):
    from django.core.exceptions import ImproperlyConfigured

    from dj.free2z.settings import _strict_boolean_env

    monkeypatch.delenv("E2EE_CHAT_REQUESTS_ENABLED", raising=False)
    assert _strict_boolean_env("E2EE_CHAT_REQUESTS_ENABLED", default=True)
    monkeypatch.setenv("E2EE_CHAT_REQUESTS_ENABLED", "false")
    assert not _strict_boolean_env("E2EE_CHAT_REQUESTS_ENABLED", default=True)
    monkeypatch.setenv("E2EE_CHAT_REQUESTS_ENABLED", "nope")
    with pytest.raises(ImproperlyConfigured):
        _strict_boolean_env("E2EE_CHAT_REQUESTS_ENABLED", default=True)


# ------------------------------------------------------------ system check


def test_the_shipped_settings_pass_the_check():
    assert check_chat_request_settings(None) == []
    assert not [
        e for e in run_checks() if e.id and e.id.startswith("e2ee.")
    ]


@pytest.mark.parametrize(
    "cost", [0, -1, 1.5, "1", None, True, Decimal("1"), 2_147_483_648],
)
def test_a_bad_price_fails_the_check(settings, cost):
    settings.E2EE_CHAT_REQUEST_COST = cost
    assert [e.id for e in check_chat_request_settings(None)] == ["e2ee.E001"]


@pytest.mark.parametrize("cost", [1, 3, 2_147_483_647])
def test_a_good_price_passes_the_check(settings, cost):
    settings.E2EE_CHAT_REQUEST_COST = cost
    assert check_chat_request_settings(None) == []


def test_bad_limits_and_switch_fail_the_check(settings):
    settings.E2EE_CHAT_REQUEST_PAIR_DAILY_LIMIT = 0
    settings.E2EE_CHAT_REQUESTS_ENABLED = "yes"
    assert sorted(e.id for e in check_chat_request_settings(None)) == [
        "e2ee.E002", "e2ee.E003",
    ]


def test_the_check_is_registered():
    from django.core.checks.registry import registry

    assert check_chat_request_settings in registry.get_checks()


# ------------------------------------------------------------ stuck emails


def test_the_retry_ladder_is_minutes_not_years():
    strategy = tasks.EMAIL_RETRY
    waits = [
        strategy.wait + strategy.exponential_wait ** (attempt + 1)
        for attempt in range(strategy.max_attempts)
    ]
    assert sum(waits) < tasks.EMAIL_IN_FLIGHT_WINDOW.total_seconds() / 2
    assert max(waits) < 30 * 60


@pytest.mark.django_db
def test_the_last_failed_attempt_marks_the_email_failed(pair, monkeypatch):
    sender, recipient = pair
    notification_address(recipient)
    chat_request(sender, recipient.username)
    chat = ChatRequest.objects.get()

    def boom(self, *args, **kwargs):
        raise ConnectionError("provider down")

    monkeypatch.setattr("django.core.mail.EmailMultiAlternatives.send", boom)
    with pytest.raises(ConnectionError):
        run_email_job(chat, attempts=tasks.EMAIL_RETRY.max_attempts - 1)
    chat.refresh_from_db()
    assert chat.email_status == ChatRequest.EMAIL_PENDING

    with pytest.raises(ConnectionError):
        run_email_job(chat, attempts=tasks.EMAIL_RETRY.max_attempts)
    chat.refresh_from_db()
    assert chat.email_status == ChatRequest.EMAIL_FAILED
    assert chat.email_detail == "retries_exhausted"


@pytest.mark.django_db
@pytest.mark.parametrize(
    "status, created_age, updated_age, suppresses",
    [
        (ChatRequest.EMAIL_SENT, timedelta(hours=3), timedelta(hours=3), True),
        # Still queued (never claimed), recent: its email is on its way.
        (ChatRequest.EMAIL_PENDING, timedelta(minutes=5), None, True),
        # Still queued but ancient: the queue is not delivering it.
        (ChatRequest.EMAIL_PENDING, timedelta(hours=2), None, False),
        # Between retries, recently handed back.
        (ChatRequest.EMAIL_PENDING, timedelta(hours=3), timedelta(minutes=5), True),
        # An old request that a worker is sending RIGHT NOW (backlog).
        (ChatRequest.EMAIL_SENDING, timedelta(hours=3), timedelta(seconds=5), True),
        # Stuck in `sending` by a killed worker.
        (ChatRequest.EMAIL_SENDING, timedelta(hours=3), timedelta(hours=2), False),
        (ChatRequest.EMAIL_PENDING, timedelta(hours=3), timedelta(hours=2), False),
        (ChatRequest.EMAIL_FAILED, timedelta(minutes=5), timedelta(minutes=1), False),
        (ChatRequest.EMAIL_SKIPPED, timedelta(minutes=5), timedelta(minutes=1), False),
    ],
)
def test_which_earlier_emails_suppress_a_later_one(
    pair, status, created_age, updated_age, suppresses,
):
    sender, recipient = pair
    notification_address(recipient)
    chat_request(sender, recipient.username, key="earlier")
    chat_request(sender, recipient.username, key="later")
    earlier, later = ChatRequest.objects.order_by("created_at")
    now = timezone.now()
    ChatRequest.objects.filter(pk=earlier.pk).update(
        email_status=status,
        created_at=now - created_age,
        email_updated_at=None if updated_age is None else now - updated_age,
    )

    run_email_job(later)

    later.refresh_from_db()
    if suppresses:
        assert mail.outbox == []
        assert later.email_detail == "pair_already_mailed"
    else:
        assert len(mail.outbox) == 1
        assert later.email_status == ChatRequest.EMAIL_SENT
        assert later.email_updated_at is not None


@pytest.mark.django_db
def test_stranded_jobs_from_the_old_retry_ladder_are_rescheduled(pair):
    from io import StringIO

    from django.core.management import call_command
    from django.db import connection as conn

    sender, recipient = pair
    chat_request(sender, recipient.username, key="parked")
    chat_request(sender, recipient.username, key="normal")
    parked, normal = [
        ProcrastinateJob.objects.get(
            task_name=tasks.SEND_TASK_NAME,
            args__chat_request_id=str(chat.pk),
        )
        for chat in ChatRequest.objects.order_by("created_at")
    ]
    with conn.cursor() as cursor:
        cursor.execute(
            "UPDATE procrastinate_jobs SET scheduled_at = now() + "
            "interval '2 days' WHERE id = %s", [parked.pk],
        )

    out = StringIO()
    call_command("e2ee_reschedule_email_jobs", "--dry-run", stdout=out)
    assert out.getvalue().strip() == "1 parked chat-request email job(s)"

    out = StringIO()
    call_command("e2ee_reschedule_email_jobs", stdout=out)
    assert out.getvalue().strip() == "rescheduled 1 chat-request email job(s)"
    with conn.cursor() as cursor:
        cursor.execute(
            "SELECT id, scheduled_at <= now() FROM procrastinate_jobs "
            "WHERE id IN (%s, %s)", [parked.pk, normal.pk],
        )
        rows = dict(cursor.fetchall())
    assert rows[parked.pk] is True

    out = StringIO()
    call_command("e2ee_reschedule_email_jobs", stdout=out)
    assert out.getvalue().strip() == "rescheduled 0 chat-request email job(s)"


@pytest.mark.django_db
def test_a_resumed_earlier_email_sees_a_later_one_already_sent(pair):
    sender, recipient = pair
    notification_address(recipient)
    chat_request(sender, recipient.username, key="stalled")
    chat_request(sender, recipient.username, key="fresh")
    earlier, later = ChatRequest.objects.order_by("created_at")
    # The earlier job stalled past the in-flight window, so the later one
    # mailed first.
    ChatRequest.objects.filter(pk=earlier.pk).update(
        created_at=timezone.now() - timedelta(hours=2))
    run_email_job(later)
    assert len(mail.outbox) == 1

    run_email_job(earlier)

    assert len(mail.outbox) == 1
    earlier.refresh_from_db()
    assert earlier.email_detail == "pair_already_mailed"


@pytest.mark.django_db
def test_disabled_copy_never_promises_an_earlier_attempt_did_not_charge(
    pair, settings,
):
    settings.E2EE_CHAT_REQUESTS_ENABLED = False
    sender, recipient = pair
    body = chat_request(sender, recipient.username, key="copy").json()
    assert "This attempt charged nothing" in body["error"]
    assert "same Idempotency-Key" in body["error"]


@pytest.mark.django_db
def test_an_earlier_email_resumed_mid_delivery_of_a_later_one_stays_silent(
    pair,
):
    """Codex round 3: B is DELIVERING (not yet sent) when stale A resumes."""
    sender, recipient = pair
    notification_address(recipient)
    chat_request(sender, recipient.username, key="stale-a")
    chat_request(sender, recipient.username, key="live-b")
    earlier, later = ChatRequest.objects.order_by("created_at")
    ChatRequest.objects.filter(pk=earlier.pk).update(
        created_at=timezone.now() - timedelta(hours=2))
    ChatRequest.objects.filter(pk=later.pk).update(
        email_status=ChatRequest.EMAIL_SENDING,
        email_detail=tasks.DELIVERING,
        email_updated_at=timezone.now(),
    )

    run_email_job(earlier)

    assert mail.outbox == []
    earlier.refresh_from_db()
    assert earlier.email_detail == "pair_already_mailed"


@pytest.mark.django_db(transaction=True)
def test_two_workers_deciding_for_one_pair_send_one_email(pair, monkeypatch):
    """Both rows are claimed before either decides; the pair lock picks one."""
    sender, recipient = pair
    notification_address(recipient)
    chat_request(sender, recipient.username, key="w1")
    chat_request(sender, recipient.username, key="w2")
    rows = list(ChatRequest.objects.order_by("created_at"))
    # Make both look stale so neither is suppressed as "earlier, on its way".
    ChatRequest.objects.update(
        created_at=timezone.now() - timedelta(hours=2),
        email_status=ChatRequest.EMAIL_SENDING,
        email_updated_at=timezone.now(),
    )
    for row in rows:
        row.refresh_from_db()
    barrier = threading.Barrier(2)
    decisions = []

    def decide(row):
        try:
            barrier.wait(timeout=10)
            decisions.append(tasks._claim_pair_delivery(row))
        finally:
            connection.close()

    threads = [threading.Thread(target=decide, args=(r,)) for r in rows]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
        assert not thread.is_alive()
    assert sorted(decisions) == [False, True]


@pytest.mark.django_db
@pytest.mark.parametrize(
    "status, old_is_earlier, age, suppresses",
    [
        # A decision the old release already made counts in either order.
        (ChatRequest.EMAIL_SENT, True, timedelta(minutes=5), True),
        (ChatRequest.EMAIL_SENT, False, timedelta(minutes=5), True),
        (ChatRequest.EMAIL_SENT, True, timedelta(hours=23), True),
        (ChatRequest.EMAIL_SENT, True, timedelta(hours=25), False),
        # An old worker mid-claim follows the old rule: only earlier rows
        # suppress. So it suppresses a LATER new row, never an earlier one --
        # otherwise both versions could skip (codex round 5).
        (ChatRequest.EMAIL_SENDING, True, timedelta(minutes=5), True),
        (ChatRequest.EMAIL_SENDING, False, timedelta(minutes=5), False),
        # ...within the old release's 24h window (it may have been claimed
        # just now after a backlog; there is no timestamp to tell).
        (ChatRequest.EMAIL_SENDING, True, timedelta(hours=2), True),
    ],
)
def test_rows_from_the_previous_release_without_a_timestamp(
    pair, status, old_is_earlier, age, suppresses,
):
    """Old workers never set email_updated_at; their rows must still count."""
    sender, recipient = pair
    notification_address(recipient)
    chat_request(sender, recipient.username, key="new-row")
    new = ChatRequest.objects.get()
    old = ChatRequest.objects.create(
        sender=sender, recipient=recipient, sender_handle="hard_s",
        charged=Decimal("1"), email_status=status,
    )
    now = timezone.now()
    offset = timedelta(minutes=1)
    ChatRequest.objects.filter(pk=old.pk).update(
        created_at=now - age, email_updated_at=None)
    ChatRequest.objects.filter(pk=new.pk).update(
        created_at=now - age + (offset if old_is_earlier else -offset))

    run_email_job(new)

    assert (mail.outbox == []) is suppresses


@pytest.mark.django_db
def test_a_legacy_in_flight_row_stops_counting_a_day_before_the_request(pair):
    sender, recipient = pair
    notification_address(recipient)
    chat_request(sender, recipient.username, key="fresh-new")
    new = ChatRequest.objects.get()
    old = ChatRequest.objects.create(
        sender=sender, recipient=recipient, sender_handle="hard_s",
        charged=Decimal("1"), email_status=ChatRequest.EMAIL_SENDING,
    )
    ChatRequest.objects.filter(pk=old.pk).update(
        created_at=timezone.now() - timedelta(hours=25), email_updated_at=None)

    run_email_job(new)

    assert len(mail.outbox) == 1


# ------------------------------------------------------------ rate limit race


@pytest.mark.django_db(transaction=True)
def test_the_rate_limit_holds_under_concurrency(creator_factory, settings):
    settings.E2EE_CHAT_REQUEST_SENDER_HOURLY_LIMIT = 1
    sender = creator_factory(username="racer", tuzis=Decimal("10"))
    targets = [
        creator_factory(username=f"race_t{i}", tuzis=Decimal("0"))
        for i in range(2)
    ]
    barrier = threading.Barrier(2)
    results = {}

    def worker(target):
        try:
            barrier.wait(timeout=10)
            response = chat_request(sender, target.username, key=target.username)
            results[target.username] = (response.status_code, response.json())
        except Exception as error:  # pragma: no cover - surfaced below
            results[target.username] = error
        finally:
            connection.close()

    threads = [threading.Thread(target=worker, args=(t,)) for t in targets]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
        assert not thread.is_alive(), "rate-limited requests deadlocked"

    assert not [r for r in results.values() if isinstance(r, Exception)], results
    assert sorted(code for code, _ in results.values()) == [200, 429], results
    assert balance(sender) == Decimal("9")
    assert sum(balance(t) for t in targets) == Decimal("1")
    assert ChatRequest.objects.count() == 1
    assert IdempotencyKey.objects.filter(
        scope=CHAT_REQUEST_SCOPE, response_status__isnull=False).count() == 1


# ------------------------------------------------------------ feed queries


@pytest.mark.django_db
def test_feed_queries_grow_by_one_per_chat_request(creator_factory):
    recipient = creator_factory(username="feed_r")

    def feed_queries(count):
        for i in range(count):
            sender = creator_factory(tuzis=Decimal("5"))
            assert chat_request(
                sender, recipient.username, key=f"feed-{count}-{i}",
            ).status_code == 200
        client = APIClient()
        client.force_authenticate(user=recipient)
        with CaptureQueriesContext(connection) as ctx:
            response = client.get("/api/events/")
        assert response.status_code == 200
        return len(ctx.captured_queries), response.json()["results"]

    one, _ = feed_queries(1)
    six, results = feed_queries(5)
    assert len(results) == 6
    # The page's chat requests (and their senders) are fetched in one query;
    # what is left per row is the handle seam's own ambiguity check.
    assert six - one == 5, (one, six)
    assert all(r["content_url"].endswith(r["contributor"]["username"])
               for r in results)
