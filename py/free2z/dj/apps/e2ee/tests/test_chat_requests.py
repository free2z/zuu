"""Contract A (free2z/zuu#1022): the paid encrypted chat request."""
import hashlib
import json
import threading
import uuid
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.core import mail
from django.db import connection
from django.utils import timezone
from procrastinate.contrib.django.models import ProcrastinateJob
from rest_framework.test import APIClient

from dj.apps.e2ee import handles, tasks
from dj.apps.e2ee.models import ChatRequest
from dj.apps.e2ee.views import CHAT_REQUEST_SCOPE
from dj.apps.emails.models import Email, OptOutEmail
from dj.apps.events import signals
from dj.apps.events.models import Event
from dj.apps.g12f.models import Creator
from dj.apps.tuzis import ledger
from dj.apps.tuzis.models import IdempotencyKey

LINK_PREFIX = "https://free2z.com/bridge/e2e2z/chat/#peer="


def balance(creator):
    return Creator.objects.values_list("tuzis", flat=True).get(pk=creator.pk)


def key_for(label):
    return str(uuid.UUID(bytes=hashlib.md5(label.encode()).digest(), version=4))


def chat_request(sender, username, *, key="chat", headers=None):
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=sender.pk))
    extra = {} if key is None else {"HTTP_IDEMPOTENCY_KEY": key_for(key)}
    extra.update(headers or {})
    return client.post(
        f"/api/e2ee/chat-requests/{username}/", {}, format="json", **extra,
    )


def run_email_job(chat, attempts=0):
    """Run the queued email job body the way a worker would."""
    job = ProcrastinateJob.objects.get(
        task_name=tasks.SEND_TASK_NAME, args__chat_request_id=str(chat.pk),
    )
    context = SimpleNamespace(job=SimpleNamespace(attempts=attempts))
    return tasks.send_chat_request_email(context, **job.args)


def notification_address(user, **overrides):
    fields = {
        "user": user,
        "email": f"{user.username}@example.com",
        "token": f"token-{user.username}",
        "expires_at": timezone.now() + timedelta(hours=1),
        "confirmed_at": timezone.now(),
        "get_notifications": True,
    }
    fields.update(overrides)
    return Email.objects.create(**fields)


@pytest.fixture
def pair(creator_factory):
    sender = creator_factory(username="alice_s", tuzis=Decimal("10"))
    recipient = creator_factory(username="Bob_R", tuzis=Decimal("5"))
    return sender, recipient


# ------------------------------------------------------------------- price


@pytest.mark.django_db
def test_price_is_a_server_setting(api_client, creator_factory, settings):
    api_client.force_authenticate(user=creator_factory())
    response = api_client.get("/api/e2ee/chat-requests/price/")
    assert response.status_code == 200
    assert response.json() == {"cost": 1, "enabled": True}

    settings.E2EE_CHAT_REQUEST_COST = 3
    assert api_client.get("/api/e2ee/chat-requests/price/").json() == {
        "cost": 3, "enabled": True,
    }


@pytest.mark.django_db
def test_price_and_request_require_authentication(api_client, pair):
    _, recipient = pair
    assert api_client.get(
        "/api/e2ee/chat-requests/price/").status_code in (401, 403)
    response = api_client.post(
        f"/api/e2ee/chat-requests/{recipient.username}/", {}, format="json",
        HTTP_IDEMPOTENCY_KEY=key_for("anon"),
    )
    assert response.status_code in (401, 403)


# ------------------------------------------------------------------- success


@pytest.mark.django_db
def test_success_charges_sender_and_credits_recipient(pair):
    sender, recipient = pair

    response = chat_request(sender, recipient.username)

    assert response.status_code == 200, response.data
    body = response.json()
    chat = ChatRequest.objects.get()
    assert body == {
        "balance": "9.000",
        "charged": "1.000",
        "replayed": False,
        "request_id": str(chat.pk),
        "recipient": {
            "username": "Bob_R",
            "handle": "bob_r",
            "handle_status": "bound",
        },
    }
    assert balance(sender) == Decimal("9")
    assert balance(recipient) == Decimal("6")
    assert chat.sender_id == sender.pk
    assert chat.recipient_id == recipient.pk
    assert chat.sender_handle == "alice_s"
    assert chat.charged == Decimal("1")
    assert chat.email_status == ChatRequest.EMAIL_PENDING


@pytest.mark.django_db
def test_success_creates_the_recipient_event(pair):
    sender, recipient = pair

    chat_request(sender, recipient.username)

    event = Event.objects.get(receiving_user=recipient)
    chat = ChatRequest.objects.get()
    assert event.type == "ENCRYPTED_CHAT_REQUEST"
    assert event.receiving_user_id == recipient.pk
    assert event.contributor_id == sender.pk
    assert event.payee_id == recipient.pk
    assert event.amount == Decimal("1")
    assert event.read is False
    assert event.content_object == chat
    assert event.to_dict()["content_url"] == LINK_PREFIX + "alice_s"
    assert "alice_s paid 1 tuzi" in event.message()
    assert "e2e2z" in event.message()

    # The payer's own spend record: read, linkless, names the recipient.
    spent = Event.objects.get(receiving_user=sender)
    assert spent.type == "ENCRYPTED_CHAT_REQUEST"
    assert spent.read is True
    assert spent.contributor_id == sender.pk
    assert spent.payee_id == recipient.pk
    assert spent.amount == Decimal("1")
    assert spent.content_object is None
    assert spent.to_dict()["content_url"] is None
    assert spent.message() == (
        "You paid 1 tuzi to ask Bob_R for an encrypted chat")


@pytest.mark.django_db
def test_event_reaches_the_feed_and_the_unread_badge(pair):
    sender, recipient = pair
    chat_request(sender, recipient.username)

    client = APIClient()
    client.force_authenticate(user=recipient)
    assert client.get("/api/events/unread_count/").json() == 1
    assert client.get("/api/events/unread_count/?include_recipient=1").json() == {
        "unread_count": 1, "recipient_username": recipient.username,
    }
    for path in ("/api/events/", "/api/events/?type=social"):
        results = client.get(path).json()["results"]
        assert len(results) == 1, path
        event = results[0]
        assert event["type"] == "ENCRYPTED_CHAT_REQUEST"
        assert event["content_url"] == LINK_PREFIX + "alice_s"
        assert event["contributor"]["username"] == "alice_s"
        assert event["amount"] == 1.0

    # The sender sees the spend in their feed, without a badge or a link.
    client.force_authenticate(user=sender)
    assert client.get("/api/events/unread_count/").json() == 0
    assert client.get("/api/events/unread_count/?include_recipient=1").json() == {
        "unread_count": 0, "recipient_username": sender.username,
    }
    own = client.get("/api/events/").json()["results"]
    assert [(e["type"], e["read"], e["content_url"]) for e in own] == [
        ("ENCRYPTED_CHAT_REQUEST", True, None)]


@pytest.mark.django_db(transaction=True)
def test_event_is_published_for_the_websocket_push(pair, monkeypatch):
    from dj.apps.events.management.commands import push_events

    sender, recipient = pair
    published = []

    class Recorder:
        def publish(self, topic, data, *, ensure_topic=True):
            published.append(data)

    monkeypatch.setattr(signals, "PubSubClient", Recorder)
    assert chat_request(sender, recipient.username).status_code == 200

    assert len(published) == 2
    data = next(
        d for d in published
        if d["receiving_user"]["username"] == recipient.username)
    assert data["type"] == "ENCRYPTED_CHAT_REQUEST"
    assert data["content_url"] == LINK_PREFIX + "alice_s"
    json.dumps(data)  # the Pub/Sub client is a bare json.dumps

    # The push worker routes it to the recipient's socket group.
    sent = []

    class Layer:
        async def group_send(self, group, message):
            sent.append((group, message))

    monkeypatch.setattr(push_events, "get_channel_layer", lambda: Layer())
    monkeypatch.setattr(push_events.time, "sleep", lambda _s: None)
    acked = []
    push_events.callback(SimpleNamespace(
        data=json.dumps(data).encode(), ack=lambda: acked.append(True),
    ))
    assert acked == [True]
    assert sent == [(
        f"user_{recipient.pk}",
        {"type": "events_message", "content": data},
    )]


@pytest.mark.django_db
def test_deactivated_sender_no_longer_links_to_their_handle(pair):
    sender, recipient = pair
    chat_request(sender, recipient.username)
    Creator.objects.filter(pk=sender.pk).update(is_active=False)

    client = APIClient()
    client.force_authenticate(user=recipient)
    event = client.get("/api/events/").json()["results"][0]
    assert event["content_url"] is None
    assert event["contributor"] is None
    assert "alice_s" not in event["message"]


# ------------------------------------------------------------------- replay


@pytest.mark.django_db
def test_replay_never_charges_twice(pair):
    sender, recipient = pair

    first = chat_request(sender, recipient.username, key="same")
    second = chat_request(sender, recipient.username, key="same")

    assert first.status_code == second.status_code == 200
    assert second.json() == {**first.json(), "replayed": True}
    assert balance(sender) == Decimal("9")
    assert balance(recipient) == Decimal("6")
    assert ChatRequest.objects.count() == 1
    assert Event.objects.count() == 2
    assert ProcrastinateJob.objects.filter(
        task_name=tasks.SEND_TASK_NAME).count() == 1


@pytest.mark.django_db
def test_a_new_key_is_a_new_request(pair):
    sender, recipient = pair
    chat_request(sender, recipient.username, key="one")
    response = chat_request(sender, recipient.username, key="two")
    assert response.status_code == 200
    assert response.json()["replayed"] is False
    assert balance(sender) == Decimal("8")
    assert balance(recipient) == Decimal("7")


@pytest.mark.django_db
def test_key_reused_for_another_recipient_is_refused(pair, creator_factory):
    sender, recipient = pair
    other = creator_factory(username="carol")
    chat_request(sender, recipient.username, key="bound")

    response = chat_request(sender, other.username, key="bound")

    assert response.status_code == 409
    assert response.json()["code"] == "idempotency_mismatch"
    assert response.json()["key_resolved"] is True
    assert balance(sender) == Decimal("9")


@pytest.mark.django_db
def test_replay_survives_the_recipient_renaming(pair):
    sender, recipient = pair
    first = chat_request(sender, recipient.username, key="rename")
    Creator.objects.filter(pk=recipient.pk).update(username="bob_renamed")

    retry = chat_request(sender, "Bob_R", key="rename")

    assert retry.status_code == 200
    assert retry.json() == {**first.json(), "replayed": True}
    assert balance(sender) == Decimal("9")


@pytest.mark.django_db
def test_replay_is_not_refused_by_a_later_price_change(pair, settings):
    sender, recipient = pair
    chat_request(sender, recipient.username, key="price")
    settings.E2EE_CHAT_REQUEST_COST = 2

    retry = chat_request(sender, recipient.username, key="price")

    assert retry.status_code == 200
    assert retry.json()["charged"] == "1.000"
    assert retry.json()["replayed"] is True
    assert balance(sender) == Decimal("9")


@pytest.mark.django_db(transaction=True)
def test_concurrent_double_submit_charges_once(pair):
    sender, recipient = pair
    barrier = threading.Barrier(2)
    results = [None, None]

    def worker(index):
        try:
            barrier.wait(timeout=10)
            response = chat_request(sender, recipient.username, key="race")
            results[index] = (response.status_code, response.json())
        except Exception as error:  # pragma: no cover - surfaced below
            results[index] = error
        finally:
            connection.close()

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
        assert not thread.is_alive(), "concurrent chat request deadlocked"

    assert not [r for r in results if isinstance(r, Exception)], results
    statuses = sorted(r[0] for r in results)
    assert statuses in ([200, 200], [200, 409]), results
    for code, body in results:
        if code == 409:
            assert body["code"] == "request_in_progress"
    assert balance(sender) == Decimal("9")
    assert balance(recipient) == Decimal("6")
    assert ChatRequest.objects.count() == 1
    assert Event.objects.filter(type="ENCRYPTED_CHAT_REQUEST").count() == 2


@pytest.mark.django_db(transaction=True)
def test_concurrent_requests_cannot_overdraw(creator_factory):
    sender = creator_factory(username="poor_sender", tuzis=Decimal("1"))
    first = creator_factory(username="first_r", tuzis=Decimal("0"))
    second = creator_factory(username="second_r", tuzis=Decimal("0"))
    barrier = threading.Barrier(2)
    results = {}

    def worker(target):
        try:
            barrier.wait(timeout=10)
            response = chat_request(sender, target.username, key=target.username)
            results[target.username] = response.status_code
        finally:
            connection.close()

    threads = [
        threading.Thread(target=worker, args=(target,))
        for target in (first, second)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
        assert not thread.is_alive()

    assert sorted(results.values()) == [200, 402]
    assert balance(sender) == Decimal("0")
    assert balance(first) + balance(second) == Decimal("1")
    assert ChatRequest.objects.count() == 1


# ------------------------------------------------------------------- refusals


@pytest.mark.django_db
def test_insufficient_funds_is_the_donation_402_and_charges_nothing(
    creator_factory,
):
    sender = creator_factory(username="broke", tuzis=Decimal("0.5"))
    recipient = creator_factory(username="rich")

    response = chat_request(sender, recipient.username, key="broke")

    assert response.status_code == 402
    assert response.json() == {
        "code": "insufficient_funds",
        "cost": "1.000",
        "balance": "0.500",
        "shortfall": "0.500",
        "action": "encrypted_chat_request",
    }
    assert balance(sender) == Decimal("0.5")
    assert not ChatRequest.objects.exists()
    assert not Event.objects.exists()
    assert not ProcrastinateJob.objects.filter(
        task_name=tasks.SEND_TASK_NAME).exists()
    # The key was released: the same intent succeeds after a top-up.
    assert not IdempotencyKey.objects.filter(scope=CHAT_REQUEST_SCOPE).exists()
    Creator.objects.filter(pk=sender.pk).update(tuzis=Decimal("5"))
    assert chat_request(sender, recipient.username, key="broke").status_code == 200


@pytest.mark.django_db
def test_cannot_message_yourself(pair):
    sender, _ = pair
    response = chat_request(sender, sender.username)
    assert response.status_code == 409
    assert response.json()["code"] == "self_request"
    assert balance(sender) == Decimal("10")
    assert not ChatRequest.objects.exists()


@pytest.mark.django_db
def test_unknown_user_is_404(pair):
    sender, _ = pair
    response = chat_request(sender, "nobody_here")
    assert response.status_code == 404
    assert response.json()["code"] == "recipient_not_found"
    assert balance(sender) == Decimal("10")


@pytest.mark.django_db
def test_deactivated_recipient_is_404_and_releases_the_key(pair):
    sender, recipient = pair
    Creator.objects.filter(pk=recipient.pk).update(is_active=False)

    response = chat_request(sender, recipient.username)

    assert response.status_code == 404
    assert balance(sender) == Decimal("10")
    assert not IdempotencyKey.objects.filter(scope=CHAT_REQUEST_SCOPE).exists()


@pytest.mark.django_db
# pytest-split sorts item names: a generated UUID would change shard assignment.
@pytest.mark.parametrize(
    "raw", [None, "", "not-a-uuid", "00000000-0000-1000-8000-000000000001"]
)
def test_a_uuid4_idempotency_key_is_required(pair, raw):
    sender, recipient = pair
    headers = {} if raw is None else {"HTTP_IDEMPOTENCY_KEY": raw}
    response = chat_request(sender, recipient.username, key=None, headers=headers)
    assert response.status_code == 400
    assert response.json()["code"] == "idempotency_key_required"
    assert balance(sender) == Decimal("10")


@pytest.mark.django_db
def test_the_body_cannot_set_the_amount(pair):
    sender, recipient = pair
    client = APIClient()
    client.force_authenticate(user=sender)
    response = client.post(
        f"/api/e2ee/chat-requests/{recipient.username}/",
        {"amount": "0", "cost": 0, "charged": 0},
        format="json",
        HTTP_IDEMPOTENCY_KEY=key_for("body"),
    )
    assert response.status_code == 200
    assert response.json()["charged"] == "1.000"
    assert balance(sender) == Decimal("9")


@pytest.mark.django_db
def test_sender_without_a_handle_is_refused_before_any_charge(creator_factory):
    sender = creator_factory(username="not.eligible", tuzis=Decimal("10"))
    recipient = creator_factory(username="someone")

    response = chat_request(sender, recipient.username, key="nohandle")

    assert response.status_code == 422
    assert response.json()["code"] == "sender_handle_unavailable"
    assert balance(sender) == Decimal("10")
    assert not ChatRequest.objects.exists()
    assert not IdempotencyKey.objects.filter(scope=CHAT_REQUEST_SCOPE).exists()


@pytest.mark.django_db
@pytest.mark.parametrize("username", ["has.dot", "x" * 31, "KelvinK"])
def test_recipient_without_a_handle_is_still_delivered(
    creator_factory, username,
):
    sender = creator_factory(username="sender_ok", tuzis=Decimal("10"))
    recipient = creator_factory(username=username)

    response = chat_request(sender, recipient.username)

    assert response.status_code == 200
    assert response.json()["recipient"] == {
        "username": username,
        "handle": None,
        "handle_status": "unclaimed",
    }
    assert Event.objects.filter(receiving_user=recipient).exists()


@pytest.mark.django_db
def test_case_duplicate_accounts_only_the_earliest_owns_the_handle(
    creator_factory,
):
    """A legacy case-variant pair: the earliest account owns the handle.

    The later one predates the case-insensitive username index (hence
    ``username_ci_legacy``) and owns nothing until it claims a handle.
    """
    first = creator_factory(username="Dupe")
    later = creator_factory(username="dupe", username_ci_legacy="dupe")
    assert handles.resolve_messaging_handle(first) == ("dupe", "bound")
    assert handles.resolve_messaging_handle(later) == (None, "unclaimed")

    sender = creator_factory(username="sender_dupe", tuzis=Decimal("5"))
    response = chat_request(sender, "dupe")
    assert response.json()["recipient"]["handle_status"] == "unclaimed"

    blocked = chat_request(later, sender.username, key="dupe-sender")
    assert blocked.status_code == 422


@pytest.mark.django_db
def test_the_handle_seam(creator_factory):
    assert handles.resolve_messaging_handle(
        creator_factory(username="Mixed_Case9")) == ("mixed_case9", "bound")
    assert handles.resolve_messaging_handle(
        creator_factory(username="with-dash")) == (None, "unclaimed")


# ------------------------------------------------------------------- limits


@pytest.mark.django_db
def test_rate_limit_per_pair(pair, settings):
    settings.E2EE_CHAT_REQUEST_PAIR_DAILY_LIMIT = 2
    sender, recipient = pair
    assert chat_request(sender, recipient.username, key="p1").status_code == 200
    assert chat_request(sender, recipient.username, key="p2").status_code == 200

    response = chat_request(sender, recipient.username, key="p3")

    assert response.status_code == 429
    body = response.json()
    assert body["code"] == "rate_limited"
    assert 0 < body["retry_after"] <= 24 * 3600 + 1
    assert response["Retry-After"] == str(body["retry_after"])
    assert balance(sender) == Decimal("8")
    assert ChatRequest.objects.count() == 2
    # Refused, so the key is free, and it works once the window has passed.
    assert not IdempotencyKey.objects.filter(
        scope=CHAT_REQUEST_SCOPE, key=key_for("p3")).exists()
    ChatRequest.objects.update(created_at=timezone.now() - timedelta(days=1, seconds=1))
    assert chat_request(sender, recipient.username, key="p3").status_code == 200


@pytest.mark.django_db
def test_rate_limit_per_sender_hour_and_day(pair, creator_factory, settings):
    settings.E2EE_CHAT_REQUEST_SENDER_HOURLY_LIMIT = 2
    settings.E2EE_CHAT_REQUEST_SENDER_DAILY_LIMIT = 3
    sender, _ = pair
    targets = [creator_factory(username=f"target{i}") for i in range(4)]

    assert chat_request(sender, targets[0].username, key="h0").status_code == 200
    assert chat_request(sender, targets[1].username, key="h1").status_code == 200
    hourly = chat_request(sender, targets[2].username, key="h2")
    assert hourly.status_code == 429
    assert hourly.json()["retry_after"] <= 3601

    ChatRequest.objects.update(created_at=timezone.now() - timedelta(hours=2))
    assert chat_request(sender, targets[2].username, key="h2").status_code == 200
    ChatRequest.objects.filter(recipient=targets[2]).update(
        created_at=timezone.now() - timedelta(hours=2))
    daily = chat_request(sender, targets[3].username, key="h3")
    assert daily.status_code == 429
    assert daily.json()["retry_after"] > 3600
    assert balance(sender) == Decimal("7")


@pytest.mark.django_db
def test_rate_limit_is_per_sender_not_global(pair, creator_factory, settings):
    settings.E2EE_CHAT_REQUEST_SENDER_HOURLY_LIMIT = 1
    sender, recipient = pair
    other_sender = creator_factory(username="other_sender")
    assert chat_request(sender, recipient.username, key="a").status_code == 200
    assert chat_request(
        other_sender, recipient.username, key="b").status_code == 200


# ------------------------------------------------------------------- email


@pytest.mark.django_db
def test_email_is_queued_with_the_charge_and_sent(pair, settings):
    settings.CANONICAL_ORIGIN = "https://free2z.cash"
    sender, recipient = pair
    address = notification_address(recipient)
    chat_request(sender, recipient.username)
    chat = ChatRequest.objects.get()

    run_email_job(chat)

    assert len(mail.outbox) == 1
    message = mail.outbox[0]
    assert message.to == [address.email]
    assert message.subject == "alice_s wants to chat with you privately"
    html = message.alternatives[0][0]
    for text in (message.body, html):
        assert LINK_PREFIX + "alice_s" in text
        assert "e2e2z" in text
        assert "https://free2z.cash/api/emails/opt-out/token-Bob_R" in text
    assert "private, end-to-end encrypted chat" in message.body
    assert "install" in message.body
    assert message.extra_headers["List-Unsubscribe"] == (
        "<https://free2z.cash/api/emails/opt-out/token-Bob_R>")
    assert message.extra_headers["List-Unsubscribe-Post"] == (
        "List-Unsubscribe=One-Click")
    chat.refresh_from_db()
    assert chat.email_status == ChatRequest.EMAIL_SENT

    # At most once: running the job again sends nothing.
    run_email_job(chat)
    assert len(mail.outbox) == 1


@pytest.mark.django_db
@pytest.mark.parametrize(
    "setup, reason",
    [
        (lambda r: None, "no_address"),
        (lambda r: notification_address(r, confirmed_at=None), "unconfirmed"),
        (lambda r: notification_address(r, get_notifications=False),
         "notifications_off"),
        (lambda r: (notification_address(r), OptOutEmail.objects.create(
            email=f"{r.username}@example.com")), "opted_out"),
        (lambda r: (notification_address(r), Creator.objects.filter(
            pk=r.pk).update(is_active=False)), "recipient_inactive"),
    ],
    ids=["no-address", "unconfirmed", "notifications-off", "opted-out",
         "recipient-inactive"],
)
def test_email_preferences_are_respected(pair, setup, reason):
    sender, recipient = pair
    chat_request(sender, recipient.username)
    setup(recipient)
    chat = ChatRequest.objects.get()

    run_email_job(chat)

    assert mail.outbox == []
    chat.refresh_from_db()
    assert chat.email_status == ChatRequest.EMAIL_SKIPPED
    assert chat.email_detail == reason


@pytest.mark.django_db
def test_one_email_per_pair_per_day(pair, creator_factory):
    sender, recipient = pair
    notification_address(recipient)
    chat_request(sender, recipient.username, key="e1")
    chat_request(sender, recipient.username, key="e2")
    first, second = ChatRequest.objects.order_by("created_at")

    # Even when the later job runs first, only the earlier one mails.
    run_email_job(second)
    run_email_job(first)

    assert len(mail.outbox) == 1
    second.refresh_from_db()
    assert second.email_detail == "pair_already_mailed"

    # A different sender still gets through.
    other = creator_factory(username="other_mailer")
    chat_request(other, recipient.username, key="e3")
    run_email_job(ChatRequest.objects.get(sender=other))
    assert len(mail.outbox) == 2


@pytest.mark.django_db
def test_a_failed_send_is_retryable(pair, monkeypatch):
    sender, recipient = pair
    notification_address(recipient)
    chat_request(sender, recipient.username)
    chat = ChatRequest.objects.get()

    def boom(self, *args, **kwargs):
        raise ConnectionError("provider down")

    monkeypatch.setattr(
        "django.core.mail.EmailMultiAlternatives.send", boom)
    with pytest.raises(ConnectionError):
        run_email_job(chat)
    chat.refresh_from_db()
    assert chat.email_status == ChatRequest.EMAIL_PENDING

    monkeypatch.undo()
    run_email_job(chat)
    assert len(mail.outbox) == 1


@pytest.mark.django_db
def test_a_rolled_back_request_queues_no_email(pair, monkeypatch):
    sender, recipient = pair

    def fail_event(*args, **kwargs):
        raise RuntimeError("event write failed")

    monkeypatch.setattr(
        "dj.apps.e2ee.views.Event.objects.create", fail_event)
    client = APIClient(raise_request_exception=False)
    client.force_authenticate(user=sender)
    response = client.post(
        f"/api/e2ee/chat-requests/{recipient.username}/", {}, format="json",
        HTTP_IDEMPOTENCY_KEY=key_for("rollback"),
    )

    assert response.status_code == 500
    assert balance(sender) == Decimal("10")
    assert balance(recipient) == Decimal("5")
    assert not ChatRequest.objects.exists()
    assert not ProcrastinateJob.objects.filter(
        task_name=tasks.SEND_TASK_NAME).exists()
    assert not IdempotencyKey.objects.filter(scope=CHAT_REQUEST_SCOPE).exists()


def test_the_money_path_is_the_donation_ledger():
    """No second money path: the view moves 2Z only through ledger.transfer."""
    from dj.apps.e2ee import views

    assert views.ledger is ledger


# ------------------------------------------------------------ review fixes


@pytest.mark.django_db
def test_a_renamed_sender_keeps_its_handle_and_the_link_stays_correct(
    pair, creator_factory,
):
    """A freed username taken by someone else does not take the handle.

    Handles are permanent, so ``#peer=alice_s`` still names the sender who
    renamed, and the newcomer who took the username owns no handle.
    """
    sender, recipient = pair
    notification_address(recipient)
    chat_request(sender, recipient.username)
    Creator.objects.filter(pk=sender.pk).update(username="alice_renamed")
    newcomer = creator_factory(username="alice_s")
    assert handles.resolve_messaging_handle(newcomer) == (None, "unclaimed")

    client = APIClient()
    client.force_authenticate(user=recipient)
    event = client.get("/api/events/").json()["results"][0]
    assert event["content_url"].endswith("#peer=alice_s")

    chat = ChatRequest.objects.get()
    run_email_job(chat)
    assert len(mail.outbox) == 1


@pytest.mark.django_db
def test_a_deleted_senders_retired_handle_stops_linking(pair):
    """Defence in depth: a retired binding names nobody, so no link."""
    from dj.apps.handles.models import MessagingHandle

    sender, recipient = pair
    notification_address(recipient)
    chat_request(sender, recipient.username)
    MessagingHandle.objects.filter(user=sender).update(status="retired")

    client = APIClient()
    client.force_authenticate(user=recipient)
    event = client.get("/api/events/").json()["results"][0]
    assert event["content_url"] is None

    chat = ChatRequest.objects.get()
    run_email_job(chat)
    assert mail.outbox == []
    chat.refresh_from_db()
    assert chat.email_detail == "sender_handle_changed"


@pytest.mark.django_db
def test_a_database_error_before_sending_is_retryable(pair, monkeypatch):
    sender, recipient = pair
    notification_address(recipient)
    chat_request(sender, recipient.username)
    chat = ChatRequest.objects.get()

    def blip(_chat):
        raise RuntimeError("database went away")

    monkeypatch.setattr(tasks, "_deliverable_address", blip)
    with pytest.raises(RuntimeError):
        run_email_job(chat)
    chat.refresh_from_db()
    assert chat.email_status == ChatRequest.EMAIL_PENDING

    monkeypatch.undo()
    run_email_job(chat)
    assert len(mail.outbox) == 1


def test_the_provider_call_is_time_bounded(monkeypatch):
    fake_client = SimpleNamespace(timeout=None)
    fake_backend = SimpleNamespace(sg=SimpleNamespace(client=fake_client))
    monkeypatch.setattr(tasks, "get_connection", lambda: fake_backend)
    assert tasks.bounded_mail_connection() is fake_backend
    assert fake_client.timeout == tasks.EMAIL_SEND_TIMEOUT_SECONDS
    assert 0 < tasks.EMAIL_SEND_TIMEOUT_SECONDS <= 60


def test_the_stock_sendgrid_client_honours_the_bound():
    """The attribute we set is the one every built request reads."""
    import python_http_client

    client = python_http_client.Client(host="https://api.sendgrid.com")
    client.timeout = 7
    assert client.mail.send.timeout == 7


@pytest.mark.django_db
def test_a_handle_lookup_error_releases_the_key(pair, monkeypatch):
    sender, recipient = pair

    def broken(_user):
        raise RuntimeError("database went away")

    monkeypatch.setattr("dj.apps.e2ee.views.resolve_messaging_handle", broken)
    client = APIClient(raise_request_exception=False)
    client.force_authenticate(user=sender)
    response = client.post(
        f"/api/e2ee/chat-requests/{recipient.username}/", {}, format="json",
        HTTP_IDEMPOTENCY_KEY=key_for("lookup"),
    )
    assert response.status_code == 500
    assert not IdempotencyKey.objects.filter(scope=CHAT_REQUEST_SCOPE).exists()

    monkeypatch.undo()
    assert chat_request(sender, recipient.username, key="lookup").status_code == 200


@pytest.mark.django_db
def test_expected_cost_guards_the_first_charge(pair, settings):
    sender, recipient = pair
    client = APIClient()
    client.force_authenticate(user=sender)
    settings.E2EE_CHAT_REQUEST_COST = 3

    def post(expected, key):
        return client.post(
            f"/api/e2ee/chat-requests/{recipient.username}/",
            {"expected_cost": expected}, format="json",
            HTTP_IDEMPOTENCY_KEY=key_for(key),
        )

    stale = post(1, "quote")
    assert stale.status_code == 409
    assert stale.json()["code"] == "price_changed"
    assert stale.json()["current_price"] == "3"
    assert balance(sender) == Decimal("10")
    assert not IdempotencyKey.objects.filter(scope=CHAT_REQUEST_SCOPE).exists()

    fresh = post(3, "quote")
    assert fresh.status_code == 200
    assert fresh.json()["charged"] == "3.000"
    assert balance(sender) == Decimal("7")

    # A replay is still a replay after the price moves again.
    settings.E2EE_CHAT_REQUEST_COST = 5
    replay = post(3, "quote")
    assert replay.status_code == 200
    assert replay.json()["replayed"] is True

    assert post("x", "bad").status_code == 400
