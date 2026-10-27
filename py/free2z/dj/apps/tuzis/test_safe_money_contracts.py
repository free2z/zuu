"""Contract and race tests for explicit retry-safe money endpoints."""
from datetime import timedelta
from decimal import Decimal
import hashlib
import importlib
from pathlib import Path
import threading
import uuid

import pytest
from django.conf import settings
from django.core.management import call_command
from django.db import connection
from django.utils import timezone
from rest_framework.test import APIClient
from procrastinate.contrib.django.models import ProcrastinateJob

from dj.apps.events.models import Event
from dj.apps.g12f.models import Creator, Subscription
from dj.apps.g12f.tasks import renew_subscription
from dj.apps.tuzis import ledger
from dj.apps.tuzis import models as idempotency
from dj.apps.tuzis.models import IdempotencyKey
from dj.apps.tuzis.views import ConfirmedSubscribeView, IdempotentDonate2Z


def balance(creator):
    return Creator.objects.values_list("tuzis", flat=True).get(pk=creator.pk)


def contract_key(label):
    """Encode readable test labels as deterministic, valid UUIDv4 keys."""
    return str(uuid.UUID(bytes=hashlib.md5(label.encode()).digest(), version=4))


def donation(
    fan, star, *, key="donation-key", amount="10", anon=False,
    intent="donation",
):
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=fan.pk))
    headers = (
        {"HTTP_IDEMPOTENCY_KEY": contract_key(key)} if key is not None else {}
    )
    return client.post(
        f"/api/tuzis/donate-idempotent/{star.username}",
        {"amount": amount, "anon": anon, "intent": intent},
        format="json",
        **headers,
    )


def confirmed_subscribe(
    fan, star, *, key="subscription-key", price="10", superseded=None,
    creator_id=None,
):
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=fan.pk))
    headers = (
        {"HTTP_IDEMPOTENCY_KEY": contract_key(key)} if key is not None else {}
    )
    if superseded is not None:
        headers["HTTP_X_SUPERSEDED_IDEMPOTENCY_KEY"] = superseded
    payload = {"expected_price": price}
    if creator_id is not None:
        payload["creator_id"] = creator_id
    return client.post(
        f"/api/tuzis/subscribe-confirmed/{star.username}",
        payload,
        format="json",
        **headers,
    )


def cancel_subscription(fan, star):
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=fan.pk))
    return client.delete(f"/api/tuzis/subscribe/{star.username}")


def test_idempotency_header_is_allowed_for_browser_cors_preflight():
    assert "idempotency-key" in settings.CORS_ALLOW_HEADERS


def test_legacy_subscribe_only_post_escapes_request_atomicity():
    from django.test import RequestFactory

    from dj.util.middleware import wants_atomic_request

    factory = RequestFactory()
    path = "/api/tuzis/subscribe/astar"
    assert wants_atomic_request(factory.post(path)) is False
    assert wants_atomic_request(factory.patch(path)) is True




def test_request_hash_migration_keeps_sqlite_bootstrap_supported():
    migration = importlib.import_module(
        "dj.apps.tuzis.migrations.0002_idempotencykey_request_hash"
    )

    class Connection:
        def __init__(self, vendor):
            self.vendor = vendor

    class SchemaEditor:
        def __init__(self, vendor):
            self.connection = Connection(vendor)
            self.statements = []

        def execute(self, statement):
            self.statements.append(statement)

    sqlite = SchemaEditor("sqlite")
    postgres = SchemaEditor("postgresql")
    migration.set_postgres_lock_timeout(None, sqlite)
    migration.set_postgres_lock_timeout(None, postgres)

    assert sqlite.statements == []
    assert postgres.statements == ["SET LOCAL lock_timeout = '3s';"]


@pytest.mark.django_db
def test_idempotent_donation_requires_explicit_route_key(creator_factory):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"))

    response = donation(fan, star, key=None)

    assert response.status_code == 400
    assert response.data["code"] == "idempotency_key_required"
    assert balance(fan) == Decimal("100")
    assert balance(star) == Decimal("0")


@pytest.mark.django_db
def test_idempotent_donation_machine_errors_are_stable(creator_factory):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"))
    client = APIClient()
    client.force_authenticate(user=fan)

    bad_key = client.post(
        f"/api/tuzis/donate-idempotent/{star.username}",
        {"amount": "10", "anon": False},
        format="json",
        HTTP_IDEMPOTENCY_KEY="not-a-uuid",
    )
    assert bad_key.status_code == 400
    assert bad_key.data["code"] == "idempotency_key_required"

    self_send = client.post(
        f"/api/tuzis/donate-idempotent/{fan.username}",
        {"amount": "10", "anon": False},
        format="json",
        HTTP_IDEMPOTENCY_KEY=contract_key("self"),
    )
    assert self_send.status_code == 400
    assert self_send.data["code"] == "self_send"

    missing = client.post(
        "/api/tuzis/donate-idempotent/no-such-recipient",
        {"amount": "10", "anon": False},
        format="json",
        HTTP_IDEMPOTENCY_KEY=contract_key("missing"),
    )
    assert missing.status_code == 404
    assert missing.data["code"] == "recipient_not_found"


@pytest.mark.django_db
@pytest.mark.parametrize("intent", ["page_fund", "page_comment", "buy_2z"])
def test_idempotent_donation_refuses_legacy_zec_intents(
    creator_factory, intent,
):
    """The retired ZEC memo protocols are not 2Z transfer intents.

    `page_fund` / `page_comment` were instructions to a Free2Z-controlled
    wallet and `buy_2z` is the one memo Free2Z still processes -- on chain,
    via `credit_creators`, never over HTTP. None of them may be smuggled in as
    a peer-to-peer 2Z intent: the ledger action is what the audit trail and
    the replay identity key on, so accepting one here would mint history that
    reads as an on-chain event. Pins the ChoiceField so a future "convenient"
    widening of the intent set is a deliberate, reviewed change.
    """
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"))

    response = donation(fan, star, key=f"legacy-{intent}", intent=intent)

    assert response.status_code == 400
    assert response.data["code"] == "invalid_request"
    assert balance(fan) == Decimal("100")
    assert balance(star) == Decimal("0")
    assert not IdempotencyKey.objects.filter(
        key=contract_key(f"legacy-{intent}"),
    ).exists()


@pytest.mark.django_db
@pytest.mark.parametrize("amount", ["1.001", "2147483648"])
def test_idempotent_donation_rejects_amounts_audit_events_cannot_represent(
    creator_factory, amount,
):
    fan = creator_factory(tuzis=Decimal("3000000000"))
    star = creator_factory(tuzis=Decimal("0"))

    response = donation(fan, star, key=f"invalid-{amount}", amount=amount)

    assert response.status_code == 400
    assert response.data["code"] == "invalid_request"
    assert balance(fan) == Decimal("3000000000")
    assert balance(star) == Decimal("0")
    assert not Event.objects.filter(
        type__in=["DONATION_SENT", "DONATION_RECEIVED"],
        contributor=fan,
    ).exists()
    assert not IdempotencyKey.objects.filter(
        key=contract_key(f"invalid-{amount}"),
    ).exists()


@pytest.mark.django_db
def test_idempotent_donation_accepts_exact_audit_integer_maximum(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("2147483648"))
    star = creator_factory(tuzis=Decimal("0"))

    response = donation(
        fan,
        star,
        key="maximum-audit-amount",
        amount="2147483647",
    )

    assert response.status_code == 200
    assert response.data == {
        "balance": "1.000",
        "charged": "2147483647.000",
        "replayed": False,
    }
    assert balance(fan) == Decimal("1")
    assert balance(star) == Decimal("2147483647")
    assert set(
        Event.objects.filter(
            type__in=["DONATION_SENT", "DONATION_RECEIVED"],
            amount=2147483647,
        ).values_list("type", flat=True)
    ) == {"DONATION_SENT", "DONATION_RECEIVED"}


@pytest.mark.django_db
def test_idempotent_donation_returns_and_replays_authoritative_balance(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"))

    first = donation(fan, star, key="stable", amount="10")
    replay = donation(fan, star, key="stable", amount="10")

    assert first.status_code == replay.status_code == 200
    assert first.data == {
        "balance": "90.000",
        "charged": "10.000",
        "replayed": False,
    }
    assert replay.data == {**first.data, "replayed": True}
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db
def test_donation_key_rejects_changed_amount_and_privacy(creator_factory):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"))
    assert donation(fan, star, key="stable", amount="10").status_code == 200

    changed_amount = donation(fan, star, key="stable", amount="11")
    changed_privacy = donation(
        fan, star, key="stable", amount="10", anon=True)

    assert changed_amount.status_code == 409
    assert changed_amount.data["code"] == "idempotency_mismatch"
    assert changed_privacy.status_code == 409
    assert changed_privacy.data["code"] == "idempotency_mismatch"
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db
def test_donation_and_ppv_cannot_cross_replay_same_key(creator_factory):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"))

    donation_response = donation(
        fan, star, key="shared-action", amount="10", intent="donation"
    )
    ppv_response = donation(
        fan, star, key="shared-action", amount="10", intent="ppv"
    )

    assert donation_response.status_code == 200
    assert ppv_response.status_code == 409
    assert ppv_response.data["code"] == "idempotency_mismatch"
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db
def test_donation_key_rejects_changed_recipient(creator_factory):
    fan = creator_factory(tuzis=Decimal("100"))
    first_star = creator_factory(tuzis=Decimal("0"))
    second_star = creator_factory(tuzis=Decimal("0"))

    assert donation(fan, first_star, key="stable", amount="10").status_code == 200
    mismatch = donation(fan, second_star, key="stable", amount="10")

    assert mismatch.status_code == 409
    assert mismatch.data["code"] == "idempotency_mismatch"
    assert balance(fan) == Decimal("90")
    assert balance(first_star) == Decimal("10")
    assert balance(second_star) == Decimal("0")


@pytest.mark.django_db
def test_donation_replays_after_recipient_username_changes(creator_factory):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"))
    old_username = star.username
    first = donation(fan, star, key="renamed-recipient", amount="10")
    Creator.objects.filter(pk=star.pk).update(username=f"renamed-{star.pk}")

    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=fan.pk))
    replay = client.post(
        f"/api/tuzis/donate-idempotent/{old_username}",
        {"amount": "10", "anon": False},
        format="json",
        HTTP_IDEMPOTENCY_KEY=contract_key("renamed-recipient"),
    )

    assert first.status_code == replay.status_code == 200
    assert replay.data == {**first.data, "replayed": True}
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db
def test_idempotent_donation_replays_after_recipient_deactivation(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"))
    first = donation(fan, star, key="deactivated-recipient", amount="10")
    star.is_active = False
    star.save(update_fields=["is_active"])

    replay = donation(fan, star, key="deactivated-recipient", amount="10")

    assert first.status_code == replay.status_code == 200
    assert replay.data == {**first.data, "replayed": True}
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db
def test_abandoned_donation_claim_recovers_after_recipient_rename(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"))
    old_username = star.username
    new_username = f"renamed-{star.pk}"
    key = contract_key("abandoned-renamed-recipient")
    claim = idempotency.claim(
        "donate-idempotent",
        fan,
        key,
        request_hash=idempotency.fingerprint({
            "recipient": star.pk,
            "recipient_username": old_username,
            "amount": "10.000",
            "anonymous": False,
        }),
    )
    IdempotencyKey.objects.filter(pk=claim.pk).update(
        created_at=timezone.now() - idempotency.STALE_CLAIM - timedelta(seconds=1)
    )
    Creator.objects.filter(pk=star.pk).update(username=new_username)

    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=fan.pk))
    missing = client.post(
        f"/api/tuzis/donate-idempotent/{old_username}",
        {"amount": "10", "anon": False},
        format="json",
        HTTP_IDEMPOTENCY_KEY=key,
    )
    recovered = client.post(
        f"/api/tuzis/donate-idempotent/{new_username}",
        {"amount": "10", "anon": False},
        format="json",
        HTTP_IDEMPOTENCY_KEY=key,
    )

    assert missing.status_code == 404
    assert missing.data["code"] == "recipient_not_found"
    assert recovered.status_code == 200
    assert recovered.data["charged"] == "10.000"
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("path_suffix", "amount", "anon"),
    [
        (None, "11", False),
        (None, "10", True),
        ("different-missing-recipient", "10", False),
    ],
)
def test_donation_replay_after_rename_still_binds_entire_request(
    creator_factory, path_suffix, amount, anon,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"))
    old_username = star.username
    assert donation(
        fan, star, key="renamed-mismatch", amount="10",
    ).status_code == 200
    Creator.objects.filter(pk=star.pk).update(username=f"renamed-{star.pk}")

    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=fan.pk))
    response = client.post(
        "/api/tuzis/donate-idempotent/"
        f"{path_suffix or old_username}",
        {"amount": amount, "anon": anon},
        format="json",
        HTTP_IDEMPOTENCY_KEY=contract_key("renamed-mismatch"),
    )

    assert response.status_code == 409
    assert response.data["code"] == "idempotency_mismatch"
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db
def test_donation_insufficient_funds_reports_authoritative_balance_and_releases_key(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("5"))
    star = creator_factory(tuzis=Decimal("0"))

    failed = donation(fan, star, key="retry", amount="10")

    assert failed.status_code == 402
    assert failed.data["code"] == "insufficient_funds"
    assert Decimal(failed.data["cost"]) == Decimal("10")
    assert Decimal(failed.data["balance"]) == Decimal("5")
    assert Decimal(failed.data["shortfall"]) == Decimal("5")
    assert failed.data["action"] == "donation"
    assert not IdempotencyKey.objects.filter(key=contract_key("retry")).exists()

    Creator.objects.filter(pk=fan.pk).update(tuzis=Decimal("20"))
    retried = donation(fan, star, key="retry", amount="10")
    assert retried.status_code == 200
    assert retried.data["balance"] == "10.000"


@pytest.mark.django_db
def test_donation_rollback_releases_key_and_preserves_value(
    creator_factory, monkeypatch,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"))
    with monkeypatch.context() as patch:
        patch.setattr(
            Event.objects,
            "create",
            lambda *args, **kwargs: (_ for _ in ()).throw(
                RuntimeError("event failed")),
        )
        with pytest.raises(RuntimeError):
            donation(fan, star, key="rollback", amount="10")

    assert balance(fan) == Decimal("100")
    assert balance(star) == Decimal("0")
    assert not IdempotencyKey.objects.filter(key=contract_key("rollback")).exists()
    # Prove the released key is usable after the failing transaction is gone.
    assert donation(fan, star, key="rollback", amount="10").status_code == 200


@pytest.mark.django_db(transaction=True)
def test_concurrent_donation_duplicates_debit_once(creator_factory):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"))
    barrier = threading.Barrier(2)
    results = [None, None]

    def worker(index):
        try:
            barrier.wait(timeout=10)
            response = donation(fan, star, key="concurrent", amount="10")
            results[index] = (response.status_code, response.data)
        except Exception as error:
            results[index] = error
        finally:
            connection.close()

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
        assert not thread.is_alive(), "concurrent donation deadlocked"

    assert not [result for result in results if isinstance(result, Exception)]
    assert all(result[0] in (200, 409) for result in results)
    assert any(result[0] == 200 for result in results)
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db(transaction=True)
def test_in_flight_donation_retry_returns_without_waiting_for_money(
    creator_factory, monkeypatch,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"))
    original_entered_money = threading.Event()
    release_original = threading.Event()
    results = {}
    original_transfer = ledger.transfer

    assert IdempotentDonate2Z.atomic_request is False
    assert ConfirmedSubscribeView.atomic_request is False

    def paused_transfer(sender, recipient, amount, **kwargs):
        if threading.current_thread().name == "original-donation":
            original_entered_money.set()
            assert release_original.wait(timeout=10)
        return original_transfer(sender, recipient, amount, **kwargs)

    monkeypatch.setattr(ledger, "transfer", paused_transfer)

    def send(label):
        try:
            response = donation(fan, star, key="paused-original", amount="10")
            results[label] = (response.status_code, response.data)
        except Exception as error:
            results[label] = error
        finally:
            connection.close()

    original = threading.Thread(
        target=send, args=("original",), name="original-donation")
    duplicate = threading.Thread(
        target=send, args=("duplicate",), name="duplicate-donation")
    original.start()
    assert original_entered_money.wait(timeout=10)
    duplicate.start()
    duplicate.join(timeout=5)
    assert not duplicate.is_alive(), "duplicate blocked behind original request"
    assert results["duplicate"][0] == 409
    assert results["duplicate"][1]["code"] == "request_in_progress"

    release_original.set()
    original.join(timeout=30)
    assert not original.is_alive()
    assert results["original"][0] == 200
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db
def test_subscription_status_is_target_specific_and_server_timed(
    creator_factory, api_client,
):
    fan = creator_factory()
    star = creator_factory(member_price=Decimal("10"))
    other_fan = creator_factory()
    Subscription.objects.create(
        fan=other_fan,
        star=star,
        expires=timezone.now() + timedelta(days=30),
        max_price=Decimal("10"),
    )
    api_client.force_authenticate(user=fan)

    missing = api_client.get(
        f"/api/tuzis/subscription-status/{star.username}")
    assert missing.status_code == 200
    assert missing.data == {
        "username": star.username,
        "active": False,
        "expires": None,
        "max_price": None,
        "current_price": "10",
    }

    sub = Subscription.objects.create(
        fan=fan,
        star=star,
        expires=timezone.now() - timedelta(seconds=1),
        max_price=Decimal("0"),
    )
    expired = api_client.get(
        f"/api/tuzis/subscription-status/{star.username}")
    assert expired.data["active"] is False
    assert expired.data["max_price"] == "0"

    sub.expires = timezone.now() + timedelta(days=30)
    sub.save(update_fields=["expires"])
    active = api_client.get(
        f"/api/tuzis/subscription-status/{star.username}")
    assert active.data["active"] is True
    assert active.data["max_price"] == "0"


@pytest.mark.django_db
def test_deactivated_creator_cannot_receive_donations_or_subscriptions(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    star.is_active = False
    star.save(update_fields=["is_active"])

    legacy = APIClient()
    legacy.force_authenticate(user=fan)
    legacy_donation = legacy.post(
        f"/api/tuzis/donate/{star.username}",
        {"amount": "10"},
        format="json",
        HTTP_IDEMPOTENCY_KEY=contract_key("legacy-inactive-donation"),
    )
    idempotent_donation = donation(
        fan, star, key="inactive-donation", amount="10",
    )
    confirmed = confirmed_subscribe(
        fan, star, key="inactive-subscription", price="10",
    )
    legacy_subscribe = legacy.post(
        f"/api/tuzis/subscribe/{star.username}", {}, format="json",
    )
    status_response = legacy.get(
        f"/api/tuzis/subscription-status/{star.username}"
    )
    get_subscription = legacy.get(f"/api/tuzis/subscribe/{star.username}")
    delete_subscription = legacy.delete(
        f"/api/tuzis/subscribe/{star.username}"
    )
    patch_subscription = legacy.patch(
        f"/api/tuzis/subscribe/{star.username}",
        {"max_price": "10"},
        format="json",
    )

    assert legacy_donation.status_code == 404
    assert idempotent_donation.status_code == 404
    assert confirmed.status_code == 404
    assert legacy_subscribe.status_code == 404
    assert status_response.status_code == 404
    assert get_subscription.status_code == 404
    assert delete_subscription.status_code == 404
    assert patch_subscription.status_code == 404
    assert balance(fan) == Decimal("100")
    assert balance(star) == Decimal("0")
    assert not Subscription.objects.filter(fan=fan, star=star).exists()


@pytest.mark.django_db
def test_deactivated_creator_subscription_remains_cancellable(
    api_client, creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    sub = Subscription.objects.create(
        fan=fan,
        star=star,
        expires=timezone.now() + timedelta(hours=1),
        max_price=Decimal("10"),
    )
    star.is_active = False
    star.save(update_fields=["is_active"])

    api_client.force_authenticate(user=fan)
    listed = api_client.get("/api/tuzis/my-subscriptions")
    cancelled = api_client.delete(f"/api/tuzis/subscribe/{star.username}")

    assert listed.status_code == 200
    assert listed.data["count"] == 1
    assert cancelled.status_code == 200

    sub.refresh_from_db()
    assert sub.max_price == 0

    # Re-enabling the creator later must not turn a fan's cancellation into a
    # surprise charge.
    star.is_active = True
    star.save(update_fields=["is_active"])
    renew_subscription(subscription_id=sub.pk)

    fan.refresh_from_db()
    star.refresh_from_db()
    assert fan.tuzis == Decimal("100")
    assert star.tuzis == Decimal("0")


@pytest.mark.django_db
def test_confirmed_subscription_requires_exact_locked_price(creator_factory):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("11"))

    response = confirmed_subscribe(fan, star, key="price", price="10")

    assert response.status_code == 409
    assert response.data["code"] == "price_changed"
    assert response.data["current_price"] == "11"
    assert balance(fan) == Decimal("100")
    assert balance(star) == Decimal("0")
    assert not Subscription.objects.filter(fan=fan, star=star).exists()
    assert not IdempotencyKey.objects.filter(key=contract_key("price")).exists()


@pytest.mark.django_db
def test_confirmed_subscription_rejects_price_above_creator_field_maximum(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("2000000"))
    star = creator_factory(
        tuzis=Decimal("0"), member_price=Decimal("999999"))

    response = confirmed_subscribe(
        fan, star, key="impossible-price", price="1000000")

    assert response.status_code == 400
    assert response.data["code"] == "invalid_request"
    assert balance(fan) == Decimal("2000000")
    assert balance(star) == Decimal("0")
    assert not Subscription.objects.filter(fan=fan, star=star).exists()
    assert not IdempotencyKey.objects.filter(
        key=contract_key("impossible-price")
    ).exists()


@pytest.mark.django_db
def test_legacy_extend_uses_locked_current_price_after_price_edit(creator_factory):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    sub = Subscription.objects.create(fan=fan, star=star, max_price=Decimal("10"))

    Creator.objects.filter(pk=star.pk).update(member_price=Decimal("20"))
    assert sub.extend() is True

    assert balance(fan) == Decimal("80")
    assert balance(star) == Decimal("20")


@pytest.mark.django_db
def test_renewal_extend_enforces_existing_price_cap(creator_factory):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    sub = Subscription.objects.create(fan=fan, star=star, max_price=Decimal("10"))

    Creator.objects.filter(pk=star.pk).update(member_price=Decimal("20"))
    with pytest.raises(ledger.ExpectedPriceMismatch):
        sub.extend(enforce_max_price=True)

    assert balance(fan) == Decimal("100")
    assert balance(star) == Decimal("0")


@pytest.mark.django_db
def test_confirmed_subscription_replays_and_binds_price_fingerprint(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    first = confirmed_subscribe(fan, star, key="stable", price="10")
    replay = confirmed_subscribe(fan, star, key="stable", price="10")
    conflict = confirmed_subscribe(fan, star, key="stable", price="11")

    assert first.status_code == replay.status_code == 200
    assert set(first.data) == {
        "balance", "charged", "replayed", "expires", "subscription",
    }
    assert first.data["balance"] == "90.000"
    assert first.data["charged"] is True
    assert first.data["replayed"] is False
    assert first.data["subscription"]["fan"]["username"] == fan.username
    assert first.data["subscription"]["star"]["username"] == star.username
    assert first.data["subscription"]["max_price"] == "10"
    assert replay.data == {**first.data, "replayed": True}
    # The price is still bound: the claim is NOT taken over and nothing is
    # charged at 11. What it answers changed in one case -- while the
    # membership this key bought is still running, the receipt is the honest
    # answer, because a 409 that invites a fresh key buys a second month
    # (codex adversarial review, round 3). Lapse it and the refusal is back.
    assert conflict.status_code == 200
    assert conflict.data == {**first.data, "replayed": True}
    Subscription.objects.filter(fan=fan, star=star).update(
        expires=timezone.now() - timedelta(days=1),
        last_charged_at=timezone.now() - timedelta(days=40),
    )
    lapsed = confirmed_subscribe(fan, star, key="stable", price="11")
    assert lapsed.status_code == 409
    assert lapsed.data["code"] == "idempotency_mismatch"
    assert lapsed.data["key_resolved"] is True
    assert Subscription.objects.get(fan=fan, star=star).max_price == Decimal("10")
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db(transaction=True)
def test_committed_subscription_stays_successful_when_renewal_enqueue_fails(
    creator_factory, monkeypatch,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    def queue_unavailable(**kwargs):
        raise RuntimeError("renewal queue unavailable")

    # The hook enqueues through `tasks.defer_renewal`, which calls
    # `renew_subscription.configure(**kwargs)`; patching the task object's
    # `configure` is the same seam it always was, reached one module over.
    monkeypatch.setattr(
        "dj.apps.g12f.tasks.renew_subscription.configure",
        queue_unavailable,
    )

    response = confirmed_subscribe(
        fan, star, key="queue-failure", price="10")
    replay = confirmed_subscribe(
        fan, star, key="queue-failure", price="10")

    assert response.status_code == replay.status_code == 200
    assert response.data["charged"] is True
    assert replay.data == {**response.data, "replayed": True}
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")
    assert Subscription.objects.filter(fan=fan, star=star).exists()


@pytest.mark.django_db
def test_confirmed_subscription_replays_after_creator_username_changes(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    old_username = star.username
    first = confirmed_subscribe(
        fan, star, key="renamed-creator", price="10")
    Creator.objects.filter(pk=star.pk).update(username=f"renamed-{star.pk}")

    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=fan.pk))
    replay = client.post(
        f"/api/tuzis/subscribe-confirmed/{old_username}",
        {"expected_price": "10"},
        format="json",
        HTTP_IDEMPOTENCY_KEY=contract_key("renamed-creator"),
    )

    assert first.status_code == replay.status_code == 200
    assert replay.data == {**first.data, "replayed": True}
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db
def test_confirmed_subscription_replays_after_creator_deactivation(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    first = confirmed_subscribe(
        fan, star, key="deactivated-creator", price="10")
    star.is_active = False
    star.save(update_fields=["is_active"])

    replay = confirmed_subscribe(
        fan, star, key="deactivated-creator", price="10")

    assert first.status_code == replay.status_code == 200
    assert replay.data == {**first.data, "replayed": True}
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db
def test_legacy_subscription_replays_after_creator_deactivation(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    client = APIClient()
    client.force_authenticate(user=fan)
    key = contract_key("deactivated-legacy-creator")

    first = client.post(
        f"/api/tuzis/subscribe/{star.username}",
        HTTP_IDEMPOTENCY_KEY=key,
    )
    star.is_active = False
    star.save(update_fields=["is_active"])
    replay = client.post(
        f"/api/tuzis/subscribe/{star.username}",
        HTTP_IDEMPOTENCY_KEY=key,
    )

    assert first.status_code == replay.status_code == 200
    assert first.data["replayed"] is False
    assert replay.data["replayed"] is True
    assert {**replay.data, "replayed": False} == first.data
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db
def test_abandoned_subscription_claim_recovers_after_creator_rename(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    old_username = star.username
    new_username = f"renamed-{star.pk}"
    key = contract_key("abandoned-renamed-creator")
    claim = idempotency.claim(
        "subscribe-confirmed",
        fan,
        key,
        request_hash=idempotency.fingerprint({
            "creator": star.pk,
            "creator_username": old_username,
            "expected_price": "10",
        }),
    )
    IdempotencyKey.objects.filter(pk=claim.pk).update(
        created_at=timezone.now() - idempotency.STALE_CLAIM - timedelta(seconds=1)
    )
    Creator.objects.filter(pk=star.pk).update(username=new_username)

    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=fan.pk))
    missing = client.post(
        f"/api/tuzis/subscribe-confirmed/{old_username}",
        {"expected_price": "10"},
        format="json",
        HTTP_IDEMPOTENCY_KEY=key,
    )
    recovered = client.post(
        f"/api/tuzis/subscribe-confirmed/{new_username}",
        {"expected_price": "10"},
        format="json",
        HTTP_IDEMPOTENCY_KEY=key,
    )

    assert missing.status_code == 404
    assert missing.data["code"] == "creator_not_found"
    assert recovered.status_code == 200
    assert recovered.data["charged"] is True
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("path_suffix", "expected_price"),
    [(None, "11"), ("different-missing-creator", "10")],
)
def test_subscription_replay_after_rename_still_binds_entire_request(
    creator_factory, path_suffix, expected_price,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    old_username = star.username
    assert confirmed_subscribe(
        fan, star, key="renamed-mismatch", price="10",
    ).status_code == 200
    Creator.objects.filter(pk=star.pk).update(username=f"renamed-{star.pk}")

    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=fan.pk))
    response = client.post(
        "/api/tuzis/subscribe-confirmed/"
        f"{path_suffix or old_username}",
        {"expected_price": expected_price},
        format="json",
        HTTP_IDEMPOTENCY_KEY=contract_key("renamed-mismatch"),
    )

    assert response.status_code == 409
    assert response.data["code"] == "idempotency_mismatch"
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db(transaction=True)
def test_confirmed_resubscription_preserves_cancelled_renewal_choice(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    sub = Subscription.objects.create(
        fan=fan,
        star=star,
        expires=timezone.now() - timedelta(days=1),
        max_price=Decimal("0"),
        last_charged_at=timezone.now() - timedelta(days=31),
    )
    ProcrastinateJob.objects.filter(
        task_name="g12f.renew_subscription",
        args={"subscription_id": sub.pk},
    ).delete()

    response = confirmed_subscribe(
        fan, star, key="resubscribe-cancelled", price="10")

    assert response.status_code == 200, response.content
    assert response.data["charged"] is True
    sub.refresh_from_db()
    assert sub.max_price == Decimal("0")
    jobs = ProcrastinateJob.objects.filter(
        task_name="g12f.renew_subscription",
        args={"subscription_id": sub.pk},
    )
    assert not jobs.exists()


@pytest.mark.django_db(transaction=True)
def test_confirmed_recent_purchase_preserves_cancelled_renewal_choice(
    creator_factory, monkeypatch,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    first = confirmed_subscribe(
        fan, star, key="recent-cancel-first", price="10")
    assert first.status_code == 200
    assert first.data["charged"] is True
    sub = Subscription.objects.get(fan=fan, star=star)
    sub.max_price = Decimal("0")
    sub.save(update_fields=["max_price"])
    ProcrastinateJob.objects.filter(
        task_name="g12f.renew_subscription",
        args={"subscription_id": sub.pk},
    ).delete()

    def creator_lock_would_amplify_free_retry(*creators):
        raise AssertionError(
            "a debounced no-charge retry must not lock shared creator rows"
        )

    monkeypatch.setattr(
        ledger, "lock_in_order", creator_lock_would_amplify_free_retry
    )

    response = confirmed_subscribe(
        fan, star, key="recent-cancel-resubscribe", price="10")

    assert response.status_code == 200, response.content
    assert response.data["charged"] is False
    sub.refresh_from_db()
    assert sub.max_price == Decimal("0")
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")
    jobs = ProcrastinateJob.objects.filter(
        task_name="g12f.renew_subscription",
        args={"subscription_id": sub.pk},
    )
    assert not jobs.exists()


@pytest.mark.django_db(transaction=True)
def test_debounced_confirmed_purchase_validates_price_without_creator_lock(
    creator_factory, monkeypatch,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    first = confirmed_subscribe(
        fan, star, key="debounced-price-first", price="10"
    )
    assert first.status_code == 200
    assert first.data["charged"] is True
    Creator.objects.filter(pk=star.pk).update(member_price=Decimal("11"))

    def creator_lock_would_amplify_free_retry(*creators):
        raise AssertionError(
            "a debounced no-charge retry must not lock shared creator rows"
        )

    monkeypatch.setattr(
        ledger, "lock_in_order", creator_lock_would_amplify_free_retry
    )

    response = confirmed_subscribe(
        fan, star, key="debounced-price-second", price="10"
    )

    assert response.status_code == 409
    assert response.data["code"] == "price_changed"
    assert response.data["current_price"] == "11"
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")
    assert not IdempotencyKey.objects.filter(
        key=contract_key("debounced-price-second")
    ).exists()


@pytest.mark.django_db
@pytest.mark.parametrize("recent", [False, True])
def test_confirmed_purchase_preserves_higher_existing_renewal_cap(
    creator_factory, recent,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    sub = Subscription.objects.create(
        fan=fan,
        star=star,
        expires=timezone.now() + timedelta(days=15),
        max_price=Decimal("100"),
        last_charged_at=(
            timezone.now() if recent
            else timezone.now() - timedelta(days=31)
        ),
    )

    response = confirmed_subscribe(
        fan, star, key=f"higher-cap-{recent}", price="10")

    assert response.status_code == 200, response.content
    assert response.data["charged"] is (not recent)
    sub.refresh_from_db()
    assert sub.max_price == Decimal("100")
    assert balance(fan) == (Decimal("100") if recent else Decimal("90"))


@pytest.mark.django_db(transaction=True)
def test_confirmed_purchase_wins_cancellation_before_subscription_lock(
    creator_factory, monkeypatch,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    sub = Subscription.objects.create(
        fan=fan,
        star=star,
        expires=timezone.now() - timedelta(days=1),
        max_price=Decimal("10"),
        last_charged_at=timezone.now() - timedelta(days=31),
    )
    purchase_loaded = threading.Event()
    cancellation_committed = threading.Event()
    original_extend = Subscription.extend
    results = {}

    def paused_extend(instance, *args, **kwargs):
        purchase_loaded.set()
        assert cancellation_committed.wait(timeout=10)
        return original_extend(instance, *args, **kwargs)

    monkeypatch.setattr(Subscription, "extend", paused_extend)

    def purchase():
        try:
            results["response"] = confirmed_subscribe(
                fan, star, key="cancel-race", price="10")
        finally:
            connection.close()

    thread = threading.Thread(target=purchase)
    thread.start()
    assert purchase_loaded.wait(timeout=10)
    Subscription.objects.filter(pk=sub.pk).update(max_price=Decimal("0"))
    cancellation_committed.set()
    thread.join(timeout=30)
    assert not thread.is_alive(), "confirmed purchase deadlocked"

    response = results["response"]
    assert response.status_code == 200, response.content
    assert response.data["charged"] is True
    sub.refresh_from_db()
    assert sub.max_price == Decimal("0")
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db(transaction=True)
def test_serialized_cancellation_cannot_erase_just_paid_entitlement(
    creator_factory, monkeypatch,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    sub = Subscription.objects.create(
        fan=fan,
        star=star,
        expires=timezone.now() - timedelta(days=1),
        max_price=Decimal("100"),
        last_charged_at=timezone.now() - timedelta(days=31),
    )
    old_expiry = sub.expires
    old_charge = sub.last_charged_at
    purchase_holds_subscription = threading.Event()
    release_purchase = threading.Event()
    cancel_started = threading.Event()
    original_transfer = ledger.transfer
    results = {}

    def paused_transfer(sender, recipient, amount, **kwargs):
        purchase_holds_subscription.set()
        assert release_purchase.wait(timeout=10)
        return original_transfer(sender, recipient, amount, **kwargs)

    monkeypatch.setattr(ledger, "transfer", paused_transfer)

    def purchase():
        try:
            results["purchase"] = confirmed_subscribe(
                fan, star, key="cancel-after-purchase", price="10")
        finally:
            connection.close()

    def cancel():
        try:
            cancel_started.set()
            results["cancel"] = cancel_subscription(fan, star)
        finally:
            connection.close()

    purchase_thread = threading.Thread(target=purchase)
    cancel_thread = threading.Thread(target=cancel)
    purchase_thread.start()
    assert purchase_holds_subscription.wait(timeout=10)
    cancel_thread.start()
    assert cancel_started.wait(timeout=10)
    cancel_thread.join(timeout=1)
    assert cancel_thread.is_alive(), "cancellation bypassed the purchase lock"

    release_purchase.set()
    purchase_thread.join(timeout=30)
    cancel_thread.join(timeout=30)
    assert not purchase_thread.is_alive()
    assert not cancel_thread.is_alive()
    assert results["purchase"].status_code == 200
    assert results["cancel"].status_code == 200

    sub.refresh_from_db()
    assert sub.expires > old_expiry
    assert sub.last_charged_at > old_charge
    assert sub.max_price == Decimal("0")
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db
def test_confirmed_subscription_insufficient_funds_reconciles_and_retries(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("5"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    failed = confirmed_subscribe(fan, star, key="retry", price="10")
    assert failed.status_code == 402
    assert failed.data["code"] == "insufficient_funds"
    assert failed.data["cost"] == "10.000"
    assert failed.data["balance"] == "5.000"
    assert failed.data["shortfall"] == "5.000"
    assert failed.data["action"] == "subscription"
    assert not IdempotencyKey.objects.filter(key=contract_key("retry")).exists()

    Creator.objects.filter(pk=fan.pk).update(tuzis=Decimal("20"))
    retried = confirmed_subscribe(fan, star, key="retry", price="10")
    assert retried.status_code == 200
    assert retried.data["balance"] == "10.000"


@pytest.mark.django_db(transaction=True)
def test_price_update_cannot_interleave_between_compare_and_debit(
    creator_factory, monkeypatch,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    reached_transfer = threading.Event()
    updater_started = threading.Event()
    release_transfer = threading.Event()
    original_transfer = ledger.transfer
    results = {}

    def paused_transfer(sender, recipient, amount, **kwargs):
        reached_transfer.set()
        assert release_transfer.wait(timeout=10)
        return original_transfer(sender, recipient, amount, **kwargs)

    monkeypatch.setattr(ledger, "transfer", paused_transfer)

    def purchase():
        try:
            results["purchase"] = confirmed_subscribe(
                fan, star, key="atomic-price", price="10")
        finally:
            connection.close()

    def update_price():
        try:
            assert reached_transfer.wait(timeout=10)
            updater_started.set()
            Creator.objects.filter(pk=star.pk).update(
                member_price=Decimal("20"))
            results["updated"] = True
        finally:
            connection.close()

    purchase_thread = threading.Thread(target=purchase)
    update_thread = threading.Thread(target=update_price)
    purchase_thread.start()
    update_thread.start()
    assert reached_transfer.wait(timeout=10)
    assert updater_started.wait(timeout=10)
    # The updater is now waiting on the creator row lock held by the purchase.
    release_transfer.set()
    purchase_thread.join(timeout=30)
    update_thread.join(timeout=30)
    assert not purchase_thread.is_alive()
    assert not update_thread.is_alive()

    response = results["purchase"]
    assert response.status_code == 200, response.content
    assert response.data["balance"] == "90.000"
    assert results["updated"] is True
    assert Creator.objects.get(pk=star.pk).member_price == Decimal("20")
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db
def test_confirmed_subscription_rollback_releases_key(
    creator_factory, monkeypatch,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    with monkeypatch.context() as patch:
        patch.setattr(
            Event.objects,
            "create",
            lambda *args, **kwargs: (_ for _ in ()).throw(
                RuntimeError("event failed")),
        )
        with pytest.raises(RuntimeError):
            confirmed_subscribe(fan, star, key="rollback", price="10")

    assert balance(fan) == Decimal("100")
    assert balance(star) == Decimal("0")
    assert not Subscription.objects.filter(fan=fan, star=star).exists()
    assert not IdempotencyKey.objects.filter(key=contract_key("rollback")).exists()
    retry = confirmed_subscribe(fan, star, key="rollback", price="10")
    assert retry.status_code == 200


@pytest.mark.django_db
@pytest.mark.parametrize("route", ["confirmed", "legacy"])
def test_subscription_rolled_back_finish_releases_both_claims(
    creator_factory, monkeypatch, route,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    compatibility_scope = (
        "subscribe-confirmed" if route == "confirmed" else f"subscribe:{star.pk}"
    )

    def purchase():
        if route == "confirmed":
            return confirmed_subscribe(fan, star, key="dual-claim-rollback")
        return legacy_subscribe(
            fan, star, raw_key=contract_key("dual-claim-rollback"),
        )

    finish = IdempotencyKey.finish
    finished_scopes = []

    def finish_then_fail(record, *args, **kwargs):
        finish(record, *args, **kwargs)
        finished_scopes.append(record.scope)
        if record.scope == compatibility_scope:
            # Both in-memory objects now look finished, but the debit and
            # receipt writes still belong to an uncommitted transaction.
            raise RuntimeError("receipt transaction interrupted")

    with monkeypatch.context() as patch:
        patch.setattr(IdempotencyKey, "finish", finish_then_fail)
        with pytest.raises(RuntimeError, match="receipt transaction interrupted"):
            purchase()

    assert finished_scopes == [f"subscribe-intent:{star.pk}", compatibility_scope]
    assert balance(fan) == Decimal("100")
    assert balance(star) == Decimal("0")
    assert not Subscription.objects.filter(fan=fan, star=star).exists()
    assert not IdempotencyKey.objects.filter(
        user=fan, key=contract_key("dual-claim-rollback"),
    ).exists()
    retry = purchase()
    assert retry.status_code == 200
    receipts = IdempotencyKey.objects.filter(
        user=fan, key=contract_key("dual-claim-rollback"),
    )
    assert set(receipts.values_list("scope", "response_status")) == {
        (f"subscribe-intent:{star.pk}", 200), (compatibility_scope, 200),
    }
    assert balance(fan) == Decimal("90")


@pytest.mark.django_db
def test_cleanup_prunes_only_old_completed_retry_receipts(creator_factory):
    fan = creator_factory()
    old_completed = IdempotencyKey.objects.create(
        scope="donate-idempotent",
        user=fan,
        key=contract_key("old-completed"),
        response_status=200,
        response_body={"balance": "1.000"},
    )
    old_in_flight = IdempotencyKey.objects.create(
        scope="subscribe-confirmed",
        user=fan,
        key=contract_key("old-in-flight"),
    )
    fresh_completed = IdempotencyKey.objects.create(
        scope="donate-idempotent",
        user=fan,
        key=contract_key("fresh-completed"),
        response_status=200,
        response_body={"balance": "1.000"},
    )
    old_legacy_subscription = IdempotencyKey.objects.create(
        scope="subscribe:123",
        user=fan,
        key=contract_key("old-legacy-subscription"),
        response_status=200,
        response_body={"charged": True},
    )
    permanent_non_http_marker = IdempotencyKey.objects.create(
        scope="aiscore_comment",
        user=fan,
        key=contract_key("old-ai-score"),
        response_status=200,
        response_body={"score": -1},
    )
    similarly_named_permanent_marker = IdempotencyKey.objects.create(
        scope="subscriber:123",
        user=fan,
        key=contract_key("old-similarly-named-marker"),
        response_status=200,
        response_body={"permanent": True},
    )
    old_internal_image_receipt = IdempotencyKey.objects.create(
        scope="ai_image",
        user=fan,
        key=contract_key("old-server-generated-image-key"),
        response_status=200,
        response_body={"_image_operation": {
            "provider": "openai", "key_source": "server_generated",
        }},
    )
    old_scrubbed_internal_image_receipt = IdempotencyKey.objects.create(
        scope="ai_image",
        user=fan,
        key=contract_key("old-scrubbed-server-generated-image-key"),
        response_status=503,
        response_body={
            "_account_deletion_scrubbed": True,
            "_server_generated_ai_image_key": True,
        },
    )
    old_client_image_receipt = IdempotencyKey.objects.create(
        scope="ai_image",
        user=fan,
        key=contract_key("old-client-image-key"),
        response_status=200,
        response_body={"_image_operation": {
            "provider": "openai", "key_source": "client",
        }},
    )
    old = timezone.now() - timedelta(days=366)
    IdempotencyKey.objects.filter(
        pk__in=[
            old_completed.pk,
            old_in_flight.pk,
            old_legacy_subscription.pk,
            permanent_non_http_marker.pk,
            similarly_named_permanent_marker.pk,
            old_internal_image_receipt.pk,
            old_scrubbed_internal_image_receipt.pk,
            old_client_image_receipt.pk,
        ],
    ).update(created_at=old)

    call_command("cleanup_idempotency", retention_days=365, batch_size=1)

    assert not IdempotencyKey.objects.filter(pk=old_completed.pk).exists()
    assert not IdempotencyKey.objects.filter(
        pk=old_legacy_subscription.pk
    ).exists()
    assert IdempotencyKey.objects.filter(pk=old_in_flight.pk).exists()
    assert IdempotencyKey.objects.filter(pk=fresh_completed.pk).exists()
    assert IdempotencyKey.objects.filter(
        pk=permanent_non_http_marker.pk
    ).exists()
    assert IdempotencyKey.objects.filter(
        pk=similarly_named_permanent_marker.pk
    ).exists()
    assert not IdempotencyKey.objects.filter(
        pk=old_internal_image_receipt.pk
    ).exists()
    assert not IdempotencyKey.objects.filter(
        pk=old_scrubbed_internal_image_receipt.pk
    ).exists()
    assert IdempotencyKey.objects.filter(pk=old_client_image_receipt.pk).exists()


@pytest.mark.django_db
def test_cleanup_retention_horizon_starts_when_claim_finishes(creator_factory):
    fan = creator_factory()
    claim = IdempotencyKey.objects.create(
        scope="donate-idempotent",
        user=fan,
        key=contract_key("slow-completion"),
    )
    IdempotencyKey.objects.filter(pk=claim.pk).update(
        created_at=timezone.now() - timedelta(days=366)
    )
    claim.refresh_from_db()

    claim.finish(200, {"balance": "1.000"})
    completed_at = claim.created_at
    call_command("cleanup_idempotency", retention_days=365, batch_size=1)

    assert completed_at > timezone.now() - timedelta(minutes=1)
    assert IdempotencyKey.objects.filter(pk=claim.pk).exists()


# --------------------------------------------------------------------------
#the legacy subscribe route's published Idempotency-Key rule must be
# the rule the view enforces.  tightened enforcement to UUIDv4 and left
# the OpenApiParameter advertising "any 1..200 chars, truncated, blank ok";
# regenerating f2z.yaml reproduces a stale decorator faithfully, so only an
# assertion against the generated schema can notice the two drifting apart.
# --------------------------------------------------------------------------


def legacy_subscribe(fan, star, *, raw_key):
    """POST the legacy route with the header EXACTLY as given (no encoding)."""
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=fan.pk))
    headers = {} if raw_key is None else {"HTTP_IDEMPOTENCY_KEY": raw_key}
    return client.post(f"/api/tuzis/subscribe/{star.username}", **headers)


@pytest.mark.django_db(transaction=True)
def test_confirmed_subscribe_keeps_one_key_bound_across_concurrent_creators(
    creator_factory, monkeypatch,
):
    from dj.apps.tuzis import views as money_views

    fan = creator_factory(tuzis=Decimal("100"))
    first = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    second = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    claimed_first = threading.Event()
    release_first = threading.Event()
    results = {}
    original_claim = money_views._claim

    def paused_claim(*args, **kwargs):
        result = original_claim(*args, **kwargs)
        if threading.current_thread().name == "first-confirmed-subscribe":
            claimed_first.set()
            assert release_first.wait(timeout=10)
        return result

    monkeypatch.setattr(money_views, "_claim", paused_claim)

    def purchase_first():
        try:
            results["first"] = confirmed_subscribe(
                fan, first, key="concurrent-creator-key", creator_id=first.pk,
            )
        except Exception as error:
            results["first"] = error
        finally:
            connection.close()

    thread = threading.Thread(
        target=purchase_first, name="first-confirmed-subscribe",
    )
    thread.start()
    try:
        assert claimed_first.wait(timeout=10)
        conflicting = confirmed_subscribe(
            fan, second, key="concurrent-creator-key", creator_id=second.pk,
        )
    finally:
        release_first.set()
        thread.join(timeout=30)
    assert not thread.is_alive(), "confirmed cross-creator request deadlocked"
    assert not isinstance(results["first"], Exception), results["first"]
    assert results["first"].status_code == 200
    assert conflicting.status_code == 409
    assert conflicting.data["code"] == "idempotency_mismatch"
    assert balance(fan) == Decimal("90")
    assert balance(first) == Decimal("10")
    assert balance(second) == Decimal("0")
    assert not Subscription.objects.filter(fan=fan, star=second).exists()


@pytest.mark.django_db(transaction=True)
def test_legacy_and_confirmed_subscribe_share_one_claim_before_charge(
    creator_factory, monkeypatch,
):
    """A route switch cannot turn one in-flight intent into two debits."""
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    entered_transfer = threading.Event()
    release_transfer = threading.Event()
    results = {}
    original_transfer = ledger.transfer
    raw_key = contract_key("cross-route-in-flight")

    def paused_transfer(sender, recipient, amount, **kwargs):
        if threading.current_thread().name == "legacy-subscribe":
            entered_transfer.set()
            assert release_transfer.wait(timeout=10)
        return original_transfer(sender, recipient, amount, **kwargs)

    monkeypatch.setattr(ledger, "transfer", paused_transfer)

    def purchase():
        try:
            results["legacy"] = legacy_subscribe(
                fan, star, raw_key=raw_key,
            )
        except Exception as error:
            results["legacy"] = error
        finally:
            connection.close()

    thread = threading.Thread(target=purchase, name="legacy-subscribe")
    thread.start()
    assert entered_transfer.wait(timeout=10)

    in_flight = confirmed_subscribe(
        fan, star, key="cross-route-in-flight", price="10",
    )
    assert in_flight.status_code == 409
    assert in_flight.data["code"] == "request_in_progress"
    # The losing confirmed route must release its temporary fan-wide claim;
    # the legacy request still owns its historical and shared claims.
    assert set(IdempotencyKey.objects.filter(
        user=fan, key=raw_key,
    ).values_list("scope", flat=True)) == {
        f"subscribe-intent:{star.pk}", f"subscribe:{star.pk}",
    }

    release_transfer.set()
    thread.join(timeout=30)
    assert not thread.is_alive(), "cross-route subscribe deadlocked"
    assert not isinstance(results["legacy"], Exception)
    assert results["legacy"].status_code == 200

    # Move the subscription beyond the 60-second debounce. The completed
    # shared claim, not the subscription lock's recent-charge shortcut, must
    # answer the route switch now.
    Subscription.objects.filter(fan=fan, star=star).update(
        last_charged_at=timezone.now() - timedelta(minutes=2),
    )
    replay = confirmed_subscribe(
        fan, star, key="cross-route-in-flight", price="10",
    )

    assert replay.status_code == 200
    assert replay.data["replayed"] is True
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")
    assert Subscription.objects.filter(fan=fan, star=star).count() == 1


def _header_parameter(operation, name):
    return next(
        parameter
        for parameter in operation.get("parameters", [])
        if parameter.get("in") == "header" and parameter.get("name") == name
    )


@pytest.mark.django_db
def test_legacy_subscribe_idempotency_key_contract_is_the_enforced_rule(
    creator_factory,
):
    from drf_spectacular.generators import SchemaGenerator

    schema = SchemaGenerator().get_schema(request=None, public=True)
    legacy = schema["paths"]["/api/tuzis/subscribe/{username}"]["post"]
    confirmed = schema["paths"][
        "/api/tuzis/subscribe-confirmed/{username}"
    ]["post"]

    declared = _header_parameter(legacy, "Idempotency-Key")["schema"]
    # One shape on both subscribe routes: a client that mints for one can
    # reuse the minting code for the other.
    assert declared == _header_parameter(confirmed, "Idempotency-Key")["schema"]
    assert declared["format"] == "uuid"
    assert declared["minLength"] == declared["maxLength"] == 36
    description = _header_parameter(legacy, "Idempotency-Key")["description"]
    assert "invalid_idempotency_key" in description
    # The pre- wording, verbatim: it must not come back.
    assert "truncated to" not in description
    assert "whitespace-only value is NOT an error" not in description
    # The refusal has a machine-readable code, and the contract says so.
    refusal = legacy["responses"]["400"]["content"]["application/json"]
    assert "code" in refusal["schema"]["properties"]

    # And the view really does what the contract now says, for the exact
    # values the old contract used to bless: a 200-character non-UUID key
    # and a blank one. Nothing is charged, the key is never truncated into a
    # claim.
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    legacy_shaped = "f2z-" + "k" * 196
    assert len(legacy_shaped) == 200

    for raw in (legacy_shaped, legacy_shaped + "-tail", "", "   "):
        response = legacy_subscribe(fan, star, raw_key=raw)
        assert response.status_code == 400, (raw, response.content)
        assert response.data["code"] == "invalid_idempotency_key", raw
    assert balance(fan) == Decimal("100")
    assert not IdempotencyKey.objects.filter(user=fan).exists()
    assert not Subscription.objects.filter(fan=fan, star=star).exists()

    # The blessed shape still works, so the tightened contract is a
    # narrowing, not an outage.
    accepted = legacy_subscribe(fan, star, raw_key=contract_key("legacy-ok"))
    assert accepted.status_code == 200, accepted.content
    assert accepted.data["charged"] is True
    assert balance(fan) == Decimal("90")


# --------------------------------------------------------------------------
#the reproduction from the issue, pinned against the route the new-ui
# now uses. The server half of this already landed in  (this test passes
# on main); the client half is that ProfileSubscribe / SubscribeToCreator send
# the price they RENDERED as expected_price, which the frontend tests pin.
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_confirmed_subscribe_refuses_the_price_the_fan_never_saw(
    creator_factory,
):
    from drf_spectacular.generators import SchemaGenerator

    fan = creator_factory(tuzis=Decimal("1000000"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    # 1-2. The profile renders "10 2Z per month".
    rendered_price = str(star.member_price)
    assert rendered_price == "10"

    # 3. The creator raises the price before the fan clicks.
    Creator.objects.filter(pk=star.pk).update(member_price=Decimal("999999"))

    # 4. The fan confirms the dialog they already had open.
    response = confirmed_subscribe(
        fan, star, key="never-saw", price=rendered_price
    )

    # 5. Refused, with the price that WOULD have been charged, and no 2Z moved.
    assert response.status_code == 409, response.content
    assert response.data["code"] == "price_changed"
    assert response.data["current_price"] == "999999"
    assert balance(fan) == Decimal("1000000")
    assert balance(star) == Decimal("0")
    assert not Subscription.objects.filter(fan=fan, star=star).exists()
    # The refusal releases the key so the fan's fresh confirmation may reuse
    # it -- the client keeps one key per purchase intent.
    assert not IdempotencyKey.objects.filter(
        key=contract_key("never-saw")
    ).exists()

    # Only a confirmation of the NEW price charges, and it charges that price.
    fresh = confirmed_subscribe(
        fan, star, key="never-saw", price=response.data["current_price"]
    )
    assert fresh.status_code == 200, fresh.content
    assert fresh.data["charged"] is True
    assert balance(fan) == Decimal("1")
    assert balance(star) == Decimal("999999")

    # The shape the client branches on is in the contract: a 409 whose body
    # carries `code` and `current_price`.
    schema = SchemaGenerator().get_schema(request=None, public=True)
    operation = schema["paths"][
        "/api/tuzis/subscribe-confirmed/{username}"
    ]["post"]
    conflict = operation["responses"]["409"]["content"]["application/json"]
    assert conflict["schema"] == {"$ref": "#/components/schemas/CreditError"}
    credit_error = schema["components"]["schemas"]["CreditError"]
    assert {"code", "current_price"} <= set(credit_error["properties"])
    body = operation["requestBody"]["content"]["application/json"]["schema"]
    assert body == {
        "$ref": "#/components/schemas/ConfirmedSubscriptionRequest"
    }
    assert "expected_price" in schema["components"]["schemas"][
        "ConfirmedSubscriptionRequest"
    ]["required"]
    assert schema["components"]["schemas"]["ConfirmedSubscriptionRequest"][
        "properties"
    ]["creator_id"]["type"] == "integer"


# --------------------------------------------------------------------------
# Cross-route continuity. The client keeps
# one key per purchase intent and reuses it on the retry the abort copy asks
# for; the legacy route records that key under `subscribe:<pk>`, this route
# claims under `subscribe-confirmed`. Without the lookup below, a bundle that
# switched routes mid-purchase would pay a second month for a membership the
# legacy request already committed.
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_confirmed_subscribe_replays_a_committed_legacy_receipt_under_the_same_key(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    # The old bundle's request committed; its response was lost.
    first = legacy_subscribe(fan, star, raw_key=contract_key("migrated"))
    assert first.status_code == 200, first.content
    assert first.data["charged"] is True
    assert balance(fan) == Decimal("90")
    # Past the 60-second debounce, so only the receipt can stop a re-charge.
    Subscription.objects.filter(fan=fan, star=star).update(
        last_charged_at=timezone.now() - timedelta(minutes=5)
    )

    # The new bundle retries the same intent, same key, on the new route.
    retry = confirmed_subscribe(fan, star, key="migrated", price="10")

    assert retry.status_code == 200, retry.content
    assert retry.data["replayed"] is True
    assert retry.data["charged"] is True
    assert retry.data["balance"] == "90.000"
    assert retry.data["expires"] == first.data["expires"]
    assert retry.data["subscription"]["star"]["username"] == star.username
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")
    assert not IdempotencyKey.objects.filter(
        scope="subscribe-confirmed", key=contract_key("migrated")
    ).exists()


@pytest.mark.django_db
def test_confirmed_subscribe_treats_an_in_flight_legacy_key_as_undecided(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    IdempotencyKey.objects.create(
        scope=f"subscribe:{star.pk}", user=fan, key=contract_key("in-flight"),
    )

    response = confirmed_subscribe(fan, star, key="in-flight", price="10")

    assert response.status_code == 409, response.content
    assert response.data["code"] == "request_in_progress"
    assert balance(fan) == Decimal("100")
    assert not Subscription.objects.filter(fan=fan, star=star).exists()


# --------------------------------------------------------------------------
#...and the same continuity in the OTHER direction (codex adversarial review
# of ). Bridging one way is not a bridge: the new-ui buys on the
# confirmed route now, but an older bundle in a tab left open across the
# deploy -- or a rollback -- still posts to the legacy route with the SAME
# key out of localStorage.
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_legacy_subscribe_replays_historical_receipt_after_debounce(
    creator_factory,
):
    """A pre-shared-claim legacy receipt remains replay-only after a minute."""
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    sub = Subscription.objects.create(
        fan=fan, star=star, expires=timezone.now() + timedelta(days=29),
        max_price=Decimal("10"),
        last_charged_at=timezone.now() - timedelta(minutes=2),
    )
    IdempotencyKey.objects.create(
        scope=f"subscribe:{star.pk}", user=fan,
        key=contract_key("historical-legacy"), request_hash="old-hash",
        response_status=200,
        response_body={"charged": True, "expires": sub.expires.isoformat()},
    )

    response = legacy_subscribe(
        fan, star, raw_key=contract_key("historical-legacy"),
    )

    assert response.status_code == 200, response.content
    assert response.data == {
        "charged": True, "expires": sub.expires.isoformat(), "replayed": True,
    }
    assert balance(fan) == Decimal("100")
    assert balance(star) == Decimal("0")


@pytest.mark.django_db
def test_legacy_subscribe_does_not_take_over_historical_pending_receipt(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    IdempotencyKey.objects.create(
        scope=f"subscribe:{star.pk}", user=fan,
        key=contract_key("historical-pending"), request_hash="old-hash",
    )

    response = legacy_subscribe(
        fan, star, raw_key=contract_key("historical-pending"),
    )

    assert response.status_code == 409, response.content
    assert response.data == {"error": "Request already in progress"}
    assert balance(fan) == Decimal("100")
    assert not Subscription.objects.filter(fan=fan, star=star).exists()


@pytest.mark.django_db
@pytest.mark.parametrize("active", [True, False])
def test_historical_confirmed_exact_fingerprint_without_creator_metadata(
    creator_factory, active,
):
    fan = creator_factory(tuzis=Decimal("90"))
    star = creator_factory(tuzis=Decimal("10"), member_price=Decimal("10"))
    sub = Subscription.objects.create(
        fan=fan, star=star, max_price=Decimal("10"),
        expires=timezone.now() + timedelta(days=1 if active else -1),
    )
    IdempotencyKey.objects.create(
        scope="subscribe-confirmed", user=fan,
        key=contract_key("historical-exact-no-metadata"),
        request_hash=idempotency.fingerprint({
            "creator": star.pk, "creator_username": star.username,
            "expected_price": "10",
        }),
        response_status=200,
        response_body={"charged": True, "expires": sub.expires.isoformat()},
    )
    response = confirmed_subscribe(
        fan, star, key="historical-exact-no-metadata",
    )
    if active:
        assert response.status_code == 200, response.content
        assert response.data["replayed"] is True
    else:
        assert response.status_code == 409
        assert response.data["code"] == "idempotency_mismatch"
        assert response.data["key_resolved"] is True
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db
def test_confirmed_subscribe_rejects_reused_username_before_claim(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    first = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    second = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    response = confirmed_subscribe(
        fan, second, key="creator-id-reused", price="10", creator_id=first.pk,
    )

    assert response.status_code == 409, response.content
    assert response.data["code"] == "creator_changed"
    assert balance(fan) == Decimal("100")
    assert balance(first) == Decimal("0")
    assert balance(second) == Decimal("0")
    assert not IdempotencyKey.objects.filter(user=fan).exists()


@pytest.mark.django_db
def test_confirmed_subscribe_replays_by_creator_id_after_rename(creator_factory):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    first = confirmed_subscribe(
        fan, star, key="creator-id-rename", price="10", creator_id=star.pk,
    )
    assert first.status_code == 200, first.content
    Creator.objects.filter(pk=star.pk).update(username=f"{star.username}-new")
    star.refresh_from_db()
    Subscription.objects.filter(fan=fan, star=star).update(
        last_charged_at=timezone.now() - timedelta(minutes=2),
    )

    replay = confirmed_subscribe(
        fan, star, key="creator-id-rename", price="10", creator_id=star.pk,
    )

    assert replay.status_code == 200, replay.content
    assert replay.data["replayed"] is True
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db
def test_legacy_subscribe_replays_a_committed_confirmed_receipt_under_the_same_key(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    # The new bundle's confirmed request committed; its response was lost.
    first = confirmed_subscribe(fan, star, key="rollback", price="10")
    assert first.status_code == 200, first.content
    assert first.data["charged"] is True
    assert balance(fan) == Decimal("90")
    # Past the 60-second debounce, so only the receipt can stop a re-charge.
    Subscription.objects.filter(fan=fan, star=star).update(
        last_charged_at=timezone.now() - timedelta(minutes=5)
    )

    # The old bundle retries the same intent, same key, on the old route.
    retry = legacy_subscribe(fan, star, raw_key=contract_key("rollback"))

    assert retry.status_code == 200, retry.content
    assert retry.data["replayed"] is True
    assert retry.data["charged"] is True
    assert retry.data["expires"] == first.data["expires"]
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")
    # No claim was minted under the legacy scope: the key stayed one key.
    assert not IdempotencyKey.objects.filter(
        scope=f"subscribe:{star.pk}", key=contract_key("rollback")
    ).exists()


@pytest.mark.django_db
def test_legacy_subscribe_charges_a_confirmed_key_spent_on_another_creator(
    creator_factory,
):
    """A receipt we can PROVE is another creator's is not this request.

    An earlier revision answered 409 here on the theory that "the key is
    spent". It is spent on the confirmed route's fan-wide scope -- but this
    route's scope is `subscribe:<star.pk>`, where the key is untouched, so a
    claim here cannot replay or double-charge the other creator's purchase.
    Refusing turned a legitimate purchase into a permanent dead end (the
    client keeps one key per creator, so the same key comes back every time)
    and silently narrowed the per-creator scoping this route publishes for
    third-party clients (codex adversarial review).
    """
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    other = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    spent = confirmed_subscribe(fan, other, key="cross-creator", price="10")
    assert spent.status_code == 200, spent.content
    assert balance(fan) == Decimal("90")

    response = legacy_subscribe(fan, star, raw_key=contract_key("cross-creator"))

    assert response.status_code == 200, response.content
    assert response.data["charged"] is True
    assert response.data["replayed"] is False
    # The OTHER creator's receipt was not replayed -- this is a real, new
    # purchase, charged to its own creator.
    assert balance(fan) == Decimal("80")
    assert balance(star) == Decimal("10")
    assert balance(other) == Decimal("10")
    assert Subscription.objects.filter(fan=fan, star=star).exists()


@pytest.mark.django_db
def test_legacy_subscribe_refuses_an_unattributable_confirmed_receipt(
    creator_factory,
):
    """The 409 survives exactly where identification is impossible.

    A confirmed receipt recorded before  carries no `_creator_pk`. It may
    be THIS creator's committed purchase, and claiming under it here would be
    the second month the cross-route lookup exists to stop. Nothing moves.
    """
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    IdempotencyKey.objects.create(
        scope="subscribe-confirmed",
        user=Creator.objects.get(pk=fan.pk),
        key=contract_key("pre-1585"),
        response_status=200,
        response_body={
            "balance": "90.000",
            "charged": True,
            "replayed": False,
            "expires": timezone.now().isoformat(),
        },
    )

    response = legacy_subscribe(fan, star, raw_key=contract_key("pre-1585"))

    assert response.status_code == 409, response.content
    assert response.data["code"] == "idempotency_mismatch"
    assert balance(fan) == Decimal("100")
    assert not Subscription.objects.filter(fan=fan, star=star).exists()


@pytest.mark.django_db
def test_legacy_subscribe_treats_an_in_flight_confirmed_key_as_undecided(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    IdempotencyKey.objects.create(
        scope="subscribe-confirmed", user=fan, key=contract_key("mid-flight"),
    )

    response = legacy_subscribe(fan, star, raw_key=contract_key("mid-flight"))

    assert response.status_code == 409, response.content
    assert balance(fan) == Decimal("100")
    assert not Subscription.objects.filter(fan=fan, star=star).exists()


@pytest.mark.django_db
def test_idempotency_key_spellings_of_one_uuid_are_one_key(creator_factory):
    """The published rule has to match `uuid4_key`'s ACTUAL leniency.

     replaced a description that was too loose with one that was, for a
    moment, too strict: it promised every non-36-character value a 400, while
    `uuid.UUID()` happily parses the braced, `urn:uuid:` and unhyphenated
    spellings and normalizes them to the same canonical key. A client reading
    that guarantee would treat those as three independent keys and expect
    three charges. They are one key, and one charge.
    """
    from drf_spectacular.generators import SchemaGenerator

    canonical = contract_key("spellings")
    bare = canonical.replace("-", "")
    spellings = [canonical, "{%s}" % canonical, f"urn:uuid:{bare}", bare]

    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    first = legacy_subscribe(fan, star, raw_key=spellings[0])
    assert first.status_code == 200, first.content
    assert first.data["charged"] is True
    assert balance(fan) == Decimal("90")

    for raw in spellings[1:]:
        # Past the debounce every time, so the receipt is the only thing that
        # can stop a second charge.
        Subscription.objects.filter(fan=fan, star=star).update(
            last_charged_at=timezone.now() - timedelta(minutes=5)
        )
        replay = legacy_subscribe(fan, star, raw_key=raw)
        assert replay.status_code == 200, (raw, replay.content)
        assert replay.data["replayed"] is True, raw
        assert balance(fan) == Decimal("90"), raw

    # One claim row for four spellings.
    assert IdempotencyKey.objects.filter(
        scope=f"subscribe:{star.pk}", user=fan
    ).count() == 1

    # A non-v4 UUID is still refused: leniency about SPELLING is not leniency
    # about version.
    v1 = str(uuid.UUID(bytes=b"\x00" * 16, version=1))
    refused = legacy_subscribe(fan, star, raw_key=v1)
    assert refused.status_code == 400, refused.content
    assert refused.data["code"] == "invalid_idempotency_key"

    # And the contract says all of this, so a client does not have to guess.
    schema = SchemaGenerator().get_schema(request=None, public=True)
    legacy = schema["paths"]["/api/tuzis/subscribe/{username}"]["post"]
    description = _header_parameter(legacy, "Idempotency-Key")["description"]
    assert "urn:uuid:" in description
    assert "unhyphenated" in description
    # The over-strict wording  briefly shipped must not come back.
    assert "any other value" not in description


@pytest.mark.django_db
def test_a_confirmed_receipt_is_matched_by_creator_id_not_username(
    creator_factory,
):
    """A username is not an identity: creators rename and names get reused.

    Creator A is paid as `alice` on the confirmed route, renames, and creator
    B takes `alice`. A legacy retry under the same key aimed at B must NOT be
    handed A's receipt -- that reports a purchase B's subscription never
    received.

    It must not be REFUSED either. B is a different creator, the legacy scope
    is `subscribe:<B.pk>`, and the key is unspent there: the fan is buying B's
    membership and gets it, charged to B. Answering 409 was the same permanent
    dead end as the cross-creator case above -- the client reuses one key per
    creator, so it would never resolve.
    """
    fan = creator_factory(tuzis=Decimal("100"))
    first = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    second = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    paid = confirmed_subscribe(fan, first, key="renamed", price="10")
    assert paid.status_code == 200, paid.content
    original_name = first.username
    # The fan already holds an expired row with the SECOND creator, so the
    # "is there a subscription" check alone cannot tell the two apart.
    Subscription.objects.create(
        star=Creator.objects.get(pk=second.pk),
        fan=Creator.objects.get(pk=fan.pk),
        max_price=Decimal("10"),
        expires=timezone.now() - timedelta(days=1),
    )
    Creator.objects.filter(pk=first.pk).update(username=f"{original_name}-x")
    Creator.objects.filter(pk=second.pk).update(username=original_name)
    second.refresh_from_db()
    assert second.username == original_name

    response = legacy_subscribe(fan, second, raw_key=contract_key("renamed"))

    assert response.status_code == 200, response.content
    # NOT a replay: the first creator's receipt did not leak into this answer.
    assert response.data["replayed"] is False
    assert response.data["charged"] is True
    # And the 2Z went to the creator who holds the name NOW, not to the one
    # whose receipt shares the key.
    assert balance(fan) == Decimal("80")
    assert balance(second) == Decimal("10")
    assert balance(first) == Decimal("10")
    assert Subscription.objects.get(
        star=second, fan=fan
    ).expires > timezone.now()


@pytest.mark.django_db
def test_server_only_receipt_fields_never_reach_a_replayed_response(
    creator_factory,
):
    """`_creator_pk` is request identity, not API surface.

    The replay builders strip a fixed set; a new server-only field added to a
    stored receipt without being added to that set would silently widen every
    replayed body, and no schema check would notice.
    """
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    first = confirmed_subscribe(fan, star, key="no-leak", price="10")
    assert first.status_code == 200, first.content
    replay = confirmed_subscribe(fan, star, key="no-leak", price="10")
    assert replay.status_code == 200, replay.content
    assert replay.data["replayed"] is True

    stored = IdempotencyKey.objects.get(
        scope="subscribe-confirmed", user=fan, key=contract_key("no-leak")
    )
    assert stored.response_body["_creator_pk"] == star.pk
    for field in ("_creator_pk", "_unresolved_fingerprint"):
        assert field in stored.response_body, field
        assert field not in replay.data, field
    assert balance(fan) == Decimal("90")


# --------------------------------------------------------------------------
# A retry must never become permanently unbuyable (codex adversarial review of
# this PR). `expected_price` is part of the confirmed route's claim
# fingerprint, and `ConfirmedSubscribeView` sets `atomic_request = False` so
# the claim row commits BEFORE the money transaction. A worker killed in that
# window leaves an unfinished row bound to the old price -- and
# `cleanup_idempotency` only deletes rows that FINISHED, so it never goes
# away. Comparing the fingerprint before the stale-claim takeover turned every
# later retry at a changed price into 409 `idempotency_mismatch`, forever, for
# a fan whose client reuses one key per creator.
# --------------------------------------------------------------------------


def _wedge_unfinished_claim(fan, star, *, key, price):
    """The row a worker killed between claim() and the money transaction."""
    row = IdempotencyKey.objects.create(
        scope="subscribe-confirmed",
        user=Creator.objects.get(pk=fan.pk),
        key=contract_key(key),
        request_hash=idempotency.fingerprint({
            "creator": star.pk,
            "creator_username": star.username,
            "expected_price": price,
        }),
    )
    IdempotencyKey.objects.filter(pk=row.pk).update(
        created_at=timezone.now() - idempotency.STALE_CLAIM - timedelta(
            minutes=1),
    )
    return row


@pytest.mark.django_db
def test_a_stale_unfinished_claim_does_not_wedge_a_retry_at_a_new_price(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("12"))
    _wedge_unfinished_claim(fan, star, key="wedged", price="10")

    # The creator moved 10 -> 12 while the request was dying, so the client
    # re-confirms the NEW price under the same per-creator key.
    response = confirmed_subscribe(fan, star, key="wedged", price="12")

    assert response.status_code == 200, response.content
    assert response.data["charged"] is True
    assert balance(fan) == Decimal("88")
    assert balance(star) == Decimal("12")


@pytest.mark.django_db
def test_a_stale_unfinished_claim_still_replays_at_the_same_price(
    creator_factory,
):
    """The takeover must not have quietly become "always take over"."""
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    _wedge_unfinished_claim(fan, star, key="same-price", price="10")

    response = confirmed_subscribe(fan, star, key="same-price", price="10")

    assert response.status_code == 200, response.content
    assert balance(fan) == Decimal("90")


@pytest.mark.django_db
def test_a_fresh_in_flight_claim_at_a_different_price_is_still_a_conflict(
    creator_factory,
):
    """Only STALENESS licenses the takeover, never a changed fingerprint.

    A claim younger than STALE_CLAIM may be a request that is genuinely still
    running and about to commit a charge. Taking it over would be the double
    charge the whole module exists to prevent.
    """
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("12"))
    IdempotencyKey.objects.create(
        scope="subscribe-confirmed",
        user=Creator.objects.get(pk=fan.pk),
        key=contract_key("still-running"),
        request_hash=idempotency.fingerprint({
            "creator": star.pk,
            "creator_username": star.username,
            "expected_price": "10",
        }),
    )

    response = confirmed_subscribe(fan, star, key="still-running", price="12")

    assert response.status_code == 409, response.content
    assert response.data["code"] == "idempotency_mismatch"
    assert balance(fan) == Decimal("100")


@pytest.mark.django_db
def test_a_finished_receipt_at_a_different_price_is_never_taken_over(
    creator_factory,
):
    """A COMPLETED key is spent; only unfinished stale rows are takeable.

    THE PRICE MOVED ACROSS A LOST RESPONSE, and the membership it bought is
    still running. `key_resolved: true` would be a lie by omission here: the
    receipt IS this purchase intent, both bundles retire the key on that
    signal, and the next click buys a second month past the debounce (codex
    adversarial review, round 3 of the round-2 fixes). The receipt itself is
    the honest answer.
    """
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    paid = confirmed_subscribe(fan, star, key="spent", price="10")
    assert paid.status_code == 200, paid.content
    Creator.objects.filter(pk=star.pk).update(member_price=Decimal("12"))
    # Past the debounce: nothing but the receipt can stop a second charge.
    Subscription.objects.filter(fan=fan, star=star).update(
        last_charged_at=timezone.now() - timedelta(minutes=5)
    )

    response = confirmed_subscribe(fan, star, key="spent", price="12")

    assert response.status_code == 200, response.content
    assert response.data["replayed"] is True
    assert response.data["expires"] == paid.data["expires"]
    # Nothing charged, and the claim was NOT taken over: it still describes
    # the request that made it.
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")
    record = IdempotencyKey.objects.get(
        scope="subscribe-confirmed", user=fan, key=contract_key("spent"))
    assert record.request_hash == idempotency.fingerprint({
        "creator": star.pk,
        "creator_username": star.username,
        "expected_price": "10",
    })

    # And the fan who really does want another month gets one on the next
    # click: the clients retire a key on a 200, so this is what they send.
    extra = confirmed_subscribe(fan, star, key="spent-2", price="12")
    assert extra.status_code == 200, extra.content
    assert extra.data["charged"] is True
    assert balance(fan) == Decimal("78")


@pytest.mark.django_db
def test_the_recovery_signal_is_never_sent_for_the_membership_in_hand(
    creator_factory,
):
    """`key_resolved: true` is permission to buy again -- prove the boundary.

    Three receipts, one difference each. Only the two that provably are NOT
    this purchase may bless a fresh key.
    """
    fan = creator_factory(tuzis=Decimal("1000"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    other = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    # 1. Another creator's receipt: it holds no evidence about this one.
    assert confirmed_subscribe(
        fan, other, key="shared", price="10").status_code == 200
    cross = confirmed_subscribe(fan, star, key="shared", price="10")
    assert cross.status_code == 409, cross.content
    assert cross.data["key_resolved"] is True

    # 2. This creator's receipt, membership LAPSED: that month is over.
    assert confirmed_subscribe(
        fan, star, key="lapsing", price="10").status_code == 200
    _lapse(fan, star)
    Creator.objects.filter(pk=star.pk).update(member_price=Decimal("12"))
    lapsed = confirmed_subscribe(fan, star, key="lapsing", price="12")
    assert lapsed.status_code == 409, lapsed.content
    assert lapsed.data["key_resolved"] is True

    # 3. A receipt this route cannot attribute at all, while a membership is
    # live: it MIGHT be this one, so it must not bless a new key.
    assert confirmed_subscribe(
        fan, star, key="live-again", price="12").status_code == 200
    IdempotencyKey.objects.create(
        scope="subscribe-confirmed",
        user=Creator.objects.get(pk=fan.pk),
        key=contract_key("pre-1585-live"),
        response_status=200,
        request_hash="a-different-request",
        response_body={"charged": True, "replayed": False},
    )
    unattributable = confirmed_subscribe(
        fan, star, key="pre-1585-live", price="12")
    assert unattributable.status_code == 409, unattributable.content
    assert unattributable.data["code"] == "idempotency_mismatch"
    assert "key_resolved" not in unattributable.data


# --------------------------------------------------------------------------
# The key a client can no longer SEND (bullets 2 and 3).
# --------------------------------------------------------------------------


LEGACY_SHAPED_KEY = "f2z-lz4k9x-0.8213746519"


def _pre_1542_legacy_receipt(fan, star, *, raw_key=LEGACY_SHAPED_KEY):
    """A committed legacy receipt recorded under a pre-UUID key.

    Made by charging for real through the legacy route and then rewriting the
    stored key to the shape 's client minted in browsers without
    `crypto.randomUUID` -- the route refuses to accept that shape now, which
    is precisely why the receipt is unreachable without the retirement header.
    """
    first = legacy_subscribe(fan, star, raw_key=contract_key("pre-uuid"))
    assert first.status_code == 200, first.content
    IdempotencyKey.objects.filter(
        scope=f"subscribe:{star.pk}",
        user=fan,
        key=contract_key("pre-uuid"),
    ).update(key=raw_key)
    # Past the 60-second debounce, so only the receipt can stop a re-charge.
    Subscription.objects.filter(fan=fan, star=star).update(
        last_charged_at=timezone.now() - timedelta(minutes=5)
    )
    return first


@pytest.mark.django_db
def test_a_superseded_legacy_key_replays_instead_of_charging_again(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    first = _pre_1542_legacy_receipt(fan, star)
    assert balance(fan) == Decimal("90")

    response = confirmed_subscribe(
        fan, star, key="replacement", price="10",
        superseded=LEGACY_SHAPED_KEY,
    )

    assert response.status_code == 200, response.content
    assert response.data["replayed"] is True
    assert response.data["charged"] is True
    assert response.data["expires"] == first.data["expires"]
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")
    # The REPLACEMENT key is now a receipt for the same purchase. Leaving it
    # unclaimed would leave it chargeable -- see the mixed-bundle test below.
    alias = IdempotencyKey.objects.get(
        scope="subscribe-confirmed", user=fan, key=contract_key("replacement")
    )
    assert alias.response_status == 200
    assert alias.response_body["_creator_pk"] == star.pk


@pytest.mark.django_db
def test_the_replacement_key_is_not_left_chargeable_after_a_bridged_replay(
    creator_factory,
):
    """The retry after a bridged replay comes from the same browser.

    The new bundle stores replacement K, sends both headers and is answered
    with the old purchase; that response is lost. The fan retries from a tab
    still running the pre- bundle, which reads K out of the SAME
    localStorage and sends no superseded header at all. If K were unclaimed
    that retry is a second month, well past the 60-second debounce. (Codex
    adversarial review, round 2 -- RISKIEST LINE.)
    """
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    _pre_1542_legacy_receipt(fan, star)

    bridged = confirmed_subscribe(
        fan, star, key="replacement", price="10",
        superseded=LEGACY_SHAPED_KEY,
    )
    assert bridged.status_code == 200, bridged.content
    assert balance(fan) == Decimal("90")

    # The old bundle: legacy route, replacement key, no superseded header.
    on_legacy = legacy_subscribe(
        fan, star, raw_key=contract_key("replacement"))
    assert on_legacy.status_code == 200, on_legacy.content
    assert on_legacy.data["replayed"] is True
    assert balance(fan) == Decimal("90")

    # And a confirmed retry of the replacement key alone replays too.
    again = confirmed_subscribe(fan, star, key="replacement", price="10")
    assert again.status_code == 200, again.content
    assert again.data["replayed"] is True
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db
def test_without_the_superseded_key_the_same_client_pays_twice(
    creator_factory,
):
    """The negative control, in-repo: this IS the  double charge."""
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    _pre_1542_legacy_receipt(fan, star)
    assert balance(fan) == Decimal("90")

    response = confirmed_subscribe(fan, star, key="replacement", price="10")

    assert response.status_code == 200, response.content
    assert response.data["charged"] is True
    assert balance(fan) == Decimal("80")


@pytest.mark.django_db
def test_a_superseded_key_never_claims_charges_or_fails_the_write(
    creator_factory,
):
    """An unusable hint degrades to a normal purchase; it never 4xxs it."""
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    for offered in ("f2z-never-seen-before", "   ", "x" * 400):
        Subscription.objects.filter(fan=fan, star=star).delete()
        IdempotencyKey.objects.all().delete()
        Creator.objects.filter(pk=fan.pk).update(tuzis=Decimal("100"))
        response = confirmed_subscribe(
            fan, star, key="ignored", price="10", superseded=offered,
        )
        assert response.status_code == 200, (offered, response.content)
        assert response.data["charged"] is True, offered
        assert balance(fan) == Decimal("90"), offered
        # Nothing was ever recorded under the offered value.
        assert not IdempotencyKey.objects.filter(key=offered.strip()).exists()


@pytest.mark.django_db
def test_a_uuid_in_the_superseded_header_is_ignored(creator_factory):
    """A usable key belongs in Idempotency-Key, where it claims as well.

    Honouring it here would be a second, weaker way to spend a key: a client
    could read one key's receipt while claiming under another.
    """
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    first = legacy_subscribe(fan, star, raw_key=contract_key("real-uuid"))
    assert first.status_code == 200, first.content
    Subscription.objects.filter(fan=fan, star=star).update(
        last_charged_at=timezone.now() - timedelta(minutes=5)
    )

    response = confirmed_subscribe(
        fan, star, key="other", price="10",
        superseded=contract_key("real-uuid"),
    )

    assert response.status_code == 200, response.content
    assert response.data["replayed"] is False
    assert balance(fan) == Decimal("80")


@pytest.mark.django_db
def test_the_superseded_key_header_is_in_the_published_contract():
    """A header a generated client cannot see does not ship."""
    from drf_spectacular.generators import SchemaGenerator

    schema = SchemaGenerator().get_schema(request=None, public=True)
    operation = schema["paths"][
        "/api/tuzis/subscribe-confirmed/{username}"
    ]["post"]
    parameter = _header_parameter(operation, "X-Superseded-Idempotency-Key")
    # OpenAPI's default; drf-spectacular omits the key rather than writing it.
    assert parameter.get("required", False) is False
    assert parameter["schema"]["maxLength"] == 200
    description = parameter["description"]
    assert "never charges" in description
    assert "ignored" in description
    # And the browser can actually send it.
    assert "x-superseded-idempotency-key" in [
        header.lower() for header in settings.CORS_ALLOW_HEADERS
    ]


def test_the_cross_route_key_guarantee_is_published_only_where_it_holds():
    """A guarantee is worth what the narrowest operation carrying it honours.

    The subscribe bridge -- "a key spent here is also spent on the other
    subscribe route" -- was written into the Idempotency-Key parameter shared
    with POST /api/tuzis/donate-idempotent/{username}, which claims under its
    own `donate-idempotent` scope and reads neither subscribe receipt. A
    third-party client reading that operation would be told a key spent on a
    donation replays on a subscribe. It does not, and acting on it is a
    second debit -- the same published-rule-the-server-does-not-enforce drift
     exists to close.
    """
    from drf_spectacular.generators import SchemaGenerator

    schema = SchemaGenerator().get_schema(request=None, public=True)
    paths = schema["paths"]
    confirmed = _header_parameter(
        paths["/api/tuzis/subscribe-confirmed/{username}"]["post"],
        "Idempotency-Key",
    )
    donate = _header_parameter(
        paths["/api/tuzis/donate-idempotent/{username}"]["post"],
        "Idempotency-Key",
    )

    # Same minting rule -- one UUIDv4 shape for every confirmed 2Z route.
    assert donate["schema"] == confirmed["schema"]
    assert "canonical lowercase" in donate["description"]

    # But the bridge belongs to the two subscribe routes and nowhere else.
    bridge = "/api/tuzis/subscribe/{username}/ and vice versa"
    assert bridge in confirmed["description"]
    assert bridge not in donate["description"]
    assert "no other endpoint replays it" in donate["description"]


def test_the_lapsed_month_rule_is_published_on_both_subscribe_routes():
    """The rule the server now enforces on every subscribe replay.

    A receipt lives 365 days and a membership 30, so a retry after the month
    ended is neither replayed nor charged under that key. Both routes do it;
    a client that cannot read it in the contract has no way to know its
    completed key stops replaying (adversarial review, rounds 2-4).
    """
    from drf_spectacular.generators import SchemaGenerator

    schema = SchemaGenerator().get_schema(request=None, public=True)
    paths = schema["paths"]
    for path in (
        "/api/tuzis/subscribe/{username}",
        "/api/tuzis/subscribe-confirmed/{username}",
    ):
        description = _header_parameter(
            paths[path]["post"], "Idempotency-Key",
        )["description"]
        assert "ENDED" in description, path
        assert "key_resolved" in description, path
        # And the 409 that carries it is declared on the operation.
        conflict = paths[path]["post"]["responses"]["409"]
        properties = (
            conflict["content"]["application/json"]["schema"].get(
                "properties",
            )
        )
        if properties is None:
            # A $ref to CreditError, whose own schema declares the field.
            ref = conflict["content"]["application/json"]["schema"]["$ref"]
            name = ref.rsplit("/", 1)[-1]
            properties = schema["components"]["schemas"][name]["properties"]
        assert "key_resolved" in properties, path

        # And the flag's own help text stops promising what round 3 proved
        # false. "The other request finished, so this key holds no evidence
        # about yours" is exactly the sentence that had both bundles retire a
        # key bound to the membership the fan is still holding and buy a
        # second month. A published guarantee outliving the code that honours
        # it is  itself.
        flag = properties["key_resolved"]["description"]
        assert "holds no evidence" not in flag, path
        assert "STILL holding" in flag or "still holding" in flag, path


@pytest.mark.django_db
def test_balance_means_one_thing_on_every_confirmed_200(creator_factory):
    """Same route, same `replayed: true` -- one meaning for `balance`.

    `_claim` replayed the balance frozen in the stored receipt while the
    legacy-receipt bridge read the fan's current one, so a client could not
    tell which number it held. Live is the only meaning every path can
    produce: the legacy route records no balance at all.
    """
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    other = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    own = confirmed_subscribe(fan, star, key="own-receipt", price="10")
    assert own.status_code == 200, own.content
    assert own.data["balance"] == "90.000"
    legacy = _pre_1542_legacy_receipt(fan, other)
    assert legacy.status_code == 200, legacy.content
    assert balance(fan) == Decimal("80")

    # Something else moves the balance between the original and the retry --
    # a renewal, a donation, a purchase in another tab.
    Creator.objects.filter(pk=fan.pk).update(tuzis=Decimal("55"))

    own_replay = confirmed_subscribe(fan, star, key="own-receipt", price="10")
    assert own_replay.status_code == 200, own_replay.content
    assert own_replay.data["replayed"] is True
    assert own_replay.data["balance"] == "55.000"

    bridged = confirmed_subscribe(
        fan, other, key="bridge", price="10",
        superseded=LEGACY_SHAPED_KEY,
    )
    assert bridged.status_code == 200, bridged.content
    assert bridged.data["replayed"] is True
    assert bridged.data["balance"] == "55.000"
    assert balance(fan) == Decimal("55")


# --------------------------------------------------------------------------
# A key spent on a DIFFERENT, finished request must not strand every later
# purchase for the receipt's 365-day horizon (codex adversarial review, round
# 3). The client keeps one key per purchase intent, so it sends the same key
# every time; without a signal it cannot tell "still committing, reuse this
# key" from "spent on something else, mint a new one", and the safe reading of
# the ambiguity is the one that never recovers.
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_a_mismatch_says_whether_the_other_request_finished(creator_factory):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    paid = confirmed_subscribe(fan, star, key="stranded", price="10")
    assert paid.status_code == 200, paid.content
    # The membership lapses and the creator moves their price. The client's
    # per-creator key is still the one bound to the old purchase.
    Subscription.objects.filter(fan=fan, star=star).update(
        expires=timezone.now() - timedelta(days=1),
        last_charged_at=timezone.now() - timedelta(days=40),
    )
    Creator.objects.filter(pk=star.pk).update(member_price=Decimal("12"))

    refused = confirmed_subscribe(fan, star, key="stranded", price="12")
    assert refused.status_code == 409, refused.content
    assert refused.data["code"] == "idempotency_mismatch"
    assert refused.data["key_resolved"] is True
    assert balance(fan) == Decimal("90")

    # Acting on it -- a genuinely new key -- buys the new month.
    fresh = confirmed_subscribe(fan, star, key="stranded-2", price="12")
    assert fresh.status_code == 200, fresh.content
    assert fresh.data["charged"] is True
    assert balance(fan) == Decimal("78")


@pytest.mark.django_db
def test_an_unfinished_claim_is_reported_as_unresolved(creator_factory):
    """False is the answer that MUST NOT be wrong: it may still be charging."""
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("12"))
    IdempotencyKey.objects.create(
        scope="subscribe-confirmed",
        user=Creator.objects.get(pk=fan.pk),
        key=contract_key("running"),
        request_hash=idempotency.fingerprint({
            "creator": star.pk,
            "creator_username": star.username,
            "expected_price": "10",
        }),
    )

    response = confirmed_subscribe(fan, star, key="running", price="12")

    assert response.status_code == 409, response.content
    assert response.data["code"] == "idempotency_mismatch"
    assert response.data["key_resolved"] is False
    assert balance(fan) == Decimal("100")


@pytest.mark.django_db
def test_a_cross_route_refusal_never_claims_the_key_is_resolved(
    creator_factory,
):
    """The one 409 where the receipt might BE this purchase stays silent.

    `_confirmed_subscribe_receipt` refuses a receipt it cannot attribute to a
    creator. Saying `key_resolved: true` there would invite the client to mint
    a new key and buy a second month of the very membership that receipt may
    record.
    """
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    IdempotencyKey.objects.create(
        scope="subscribe-confirmed",
        user=Creator.objects.get(pk=fan.pk),
        key=contract_key("unattributable"),
        response_status=200,
        response_body={"charged": True, "replayed": False},
    )

    response = legacy_subscribe(
        fan, star, raw_key=contract_key("unattributable"))

    assert response.status_code == 409, response.content
    assert response.data["code"] == "idempotency_mismatch"
    assert "key_resolved" not in response.data
    assert balance(fan) == Decimal("100")


@pytest.mark.django_db
def test_the_legacy_409_publishes_the_signal_it_actually_sends():
    """A recovery signal a generated client cannot see does not exist.

    `key_resolved` is the ONLY escape from a 409 that would otherwise stand
    for the receipt's whole 365-day retention horizon, and the legacy route
    sends it. It was on the wire and absent from the published 409, so a
    client generated from `f2z.yaml` -- ZUULI, any third party -- had to cast
    past its own types to read a field the contract said did not exist. That
    is the exact drift this PR exists to remove, one route over. (Adversarial
    review, round 2.)
    """
    from drf_spectacular.generators import SchemaGenerator

    schema = SchemaGenerator().get_schema(request=None, public=True)
    legacy = schema["paths"]["/api/tuzis/subscribe/{username}"]["post"]
    confirmed = schema["paths"][
        "/api/tuzis/subscribe-confirmed/{username}"
    ]["post"]

    conflict = legacy["responses"]["409"]["content"]["application/json"]
    properties = conflict["schema"]["properties"]
    assert "key_resolved" in properties, (
        "the legacy 409 sends key_resolved; the spec must declare it"
    )
    assert properties["key_resolved"]["type"] == "boolean"
    # Not required: it is deliberately absent where the endpoint cannot tell.
    assert "key_resolved" not in conflict["schema"].get("required", [])

    # Same field, same meaning as the confirmed route's CreditError, so one
    # client-side handler works on both.
    confirmed_ref = confirmed["responses"]["409"]["content"][
        "application/json"]["schema"]["$ref"].rsplit("/", 1)[-1]
    confirmed_properties = schema["components"]["schemas"][
        confirmed_ref]["properties"]
    assert "key_resolved" in confirmed_properties
    for phrase in ("mint a new", "reuse the SAME key"):
        assert phrase in properties["key_resolved"]["description"], phrase
        assert phrase in confirmed_properties["key_resolved"]["description"]

    # And the third code the route can answer with is named too.
    code_description = properties["code"]["description"]
    for code in (
        "idempotency_mismatch",
        "invalid_idempotency_record",
    ):
        assert code in code_description, code


@pytest.mark.django_db
def test_the_legacy_409_signal_on_the_wire_matches_the_published_shape(
    creator_factory,
):
    """The spec assertion above is only worth as much as this pairing."""
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    paid = legacy_subscribe(fan, star, raw_key=contract_key("legacy-spent"))
    assert paid.status_code == 200, paid.content
    # A different request under the same key: another creator, same scope key.
    other = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    IdempotencyKey.objects.filter(
        scope=f"subscribe:{star.pk}", user=fan,
    ).update(scope=f"subscribe:{other.pk}", request_hash="mismatched")

    refused = legacy_subscribe(
        fan, other, raw_key=contract_key("legacy-spent"))

    assert refused.status_code == 409, refused.content
    assert refused.data["code"] == "idempotency_mismatch"
    assert refused.data["key_resolved"] is True
    assert balance(fan) == Decimal("90")


# --------------------------------------------------------------------------
# A receipt outlives the membership it certifies by up to eleven months
# (COMPLETED_CLAIM_RETENTION 365d vs SUBSCRIPTION_PERIOD 30d). Replaying one
# then tells a fan who is not subscribed, and has bought nothing, that their
# purchase landed. (Adversarial review, round 2.)
# --------------------------------------------------------------------------


def _lapse(fan, star):
    """Age the membership past its expiry, and past the charge debounce."""
    Subscription.objects.filter(fan=fan, star=star).update(
        expires=timezone.now() - timedelta(days=170),
        last_charged_at=timezone.now() - timedelta(days=200),
    )


@pytest.mark.django_db
def test_a_superseded_key_whose_month_ran_out_retires_instead_of_charging(
    creator_factory,
):
    """Neither of the two wrong answers: no false success, no silent debit.

    Replaying tells a fan who is not subscribed that their purchase landed.
    Charging debits under a key the CLIENT still considers unresolved, and on
    the legacy route that debit is not even price-bound (codex adversarial
    review, round 4). The key is retired instead, and the fan's next click
    buys the month under one minted after they were told.
    """
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    _pre_1542_legacy_receipt(fan, star)
    assert balance(fan) == Decimal("90")
    _lapse(fan, star)

    response = confirmed_subscribe(
        fan, star, key="replacement", price="10",
        superseded=LEGACY_SHAPED_KEY,
    )

    assert response.status_code == 409, response.content
    assert response.data["code"] == "idempotency_mismatch"
    assert response.data["key_resolved"] is True
    assert balance(fan) == Decimal("90")
    assert Subscription.objects.get(
        fan=fan, star=star).expires < timezone.now()

    # What the clients do with that answer, and it must actually work.
    bought = confirmed_subscribe(fan, star, key="replacement-2", price="10")
    assert bought.status_code == 200, bought.content
    assert bought.data["charged"] is True
    assert balance(fan) == Decimal("80")
    assert Subscription.objects.get(
        fan=fan, star=star).expires > timezone.now()


@pytest.mark.django_db
def test_a_lapsed_legacy_receipt_does_not_replay_on_the_confirmed_route(
    creator_factory,
):
    """The same rule for the key the client CAN still send."""
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    first = legacy_subscribe(fan, star, raw_key=contract_key("carried-over"))
    assert first.status_code == 200, first.content
    _lapse(fan, star)

    response = confirmed_subscribe(
        fan, star, key="carried-over", price="10")

    assert response.status_code == 409, response.content
    assert response.data["code"] == "idempotency_mismatch"
    assert response.data["key_resolved"] is True
    assert balance(fan) == Decimal("90")


@pytest.mark.django_db
def test_a_lapsed_confirmed_receipt_does_not_replay_on_the_legacy_route(
    creator_factory,
):
    """And in the other direction, where an old bundle asks."""
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    first = confirmed_subscribe(fan, star, key="old-bundle", price="10")
    assert first.status_code == 200, first.content
    _lapse(fan, star)

    response = legacy_subscribe(fan, star, raw_key=contract_key("old-bundle"))

    assert response.status_code == 409, response.content
    assert response.data["code"] == "idempotency_mismatch"
    assert response.data["key_resolved"] is True
    # This route binds NO price, so a debit here on the strength of an
    # expired receipt would be at whatever the creator charges today.
    assert balance(fan) == Decimal("90")


@pytest.mark.django_db
def test_a_running_membership_still_replays_rather_than_charging_twice(
    creator_factory,
):
    """The guard the lapse rule must not weaken: this IS the double charge.

    Same setup as the lapse tests, one field different -- the membership is
    still running -- and the answer must flip back to a replay.
    """
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    _pre_1542_legacy_receipt(fan, star)
    Subscription.objects.filter(fan=fan, star=star).update(
        expires=timezone.now() + timedelta(days=1),
        last_charged_at=timezone.now() - timedelta(days=29),
    )

    response = confirmed_subscribe(
        fan, star, key="replacement", price="10",
        superseded=LEGACY_SHAPED_KEY,
    )

    assert response.status_code == 200, response.content
    assert response.data["replayed"] is True
    assert balance(fan) == Decimal("90")


@pytest.mark.django_db
def test_a_matching_retry_after_the_month_ended_never_reports_success(
    creator_factory,
):
    """The replay path the mismatch guard cannot see (codex round 4).

    A bridged replay records the REPLACEMENT key with this request's
    fingerprint. A later retry of that key sends the SAME fingerprint, so it
    is a DuplicateRequest, not a conflict -- it never reaches the
    mismatch path, and it replayed a receipt for a membership that ended
    months ago: `charged: true`, `expires` in the past, and both bundles
    marking the fan subscribed off the 200.
    """
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    _pre_1542_legacy_receipt(fan, star)
    bridged = confirmed_subscribe(
        fan, star, key="replacement", price="10",
        superseded=LEGACY_SHAPED_KEY,
    )
    assert bridged.status_code == 200, bridged.content
    assert balance(fan) == Decimal("90")
    _lapse(fan, star)

    # Same key, same price: a matching fingerprint, so this is the duplicate
    # path, not the mismatch path.
    retry = confirmed_subscribe(fan, star, key="replacement", price="10")

    assert retry.status_code == 409, retry.content
    assert retry.data["code"] == "idempotency_mismatch"
    assert retry.data["key_resolved"] is True
    assert balance(fan) == Decimal("90")

    # And the plain (unbridged) version of the same shape, on both routes.
    other = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    assert confirmed_subscribe(
        fan, other, key="plain", price="10").status_code == 200
    _lapse(fan, other)
    same = confirmed_subscribe(fan, other, key="plain", price="10")
    assert same.status_code == 409, same.content
    assert same.data["key_resolved"] is True

    third = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    assert legacy_subscribe(
        fan, third, raw_key=contract_key("legacy-plain")).status_code == 200
    _lapse(fan, third)
    legacy_again = legacy_subscribe(
        fan, third, raw_key=contract_key("legacy-plain"))
    assert legacy_again.status_code == 409, legacy_again.content
    assert legacy_again.data["key_resolved"] is True
    assert balance(fan) == Decimal("70")


@pytest.mark.django_db
def test_a_replay_inside_the_month_is_untouched_by_the_expiry_guard(
    creator_factory,
):
    """The guard must not break the thing it sits in front of.

    Same key, same price, membership still running, on both routes: the
    replay is the whole double-charge protection and it has to still be a
    200 that charges nothing.
    """
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    first = confirmed_subscribe(fan, star, key="inside", price="10")
    assert first.status_code == 200, first.content
    Subscription.objects.filter(fan=fan, star=star).update(
        last_charged_at=timezone.now() - timedelta(minutes=5)
    )

    again = confirmed_subscribe(fan, star, key="inside", price="10")
    assert again.status_code == 200, again.content
    assert again.data["replayed"] is True

    on_legacy = legacy_subscribe(fan, star, raw_key=contract_key("inside"))
    assert on_legacy.status_code == 200, on_legacy.content
    assert on_legacy.data["replayed"] is True
    assert balance(fan) == Decimal("90")


# --------------------------------------------------------------------------
# Adversarial review of, round 3: the legacy route's own 409 contract,
# the ordering of a replay against the creator gates, and a direct unit test
# on the SHARED `idempotency.claim()` primitive this branch reordered.
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_the_legacy_recovery_signal_is_never_sent_for_the_membership_in_hand(
    creator_factory,
):
    """The legacy 409 promised this in its schema and did the opposite.

    `CreatorSubscribeView` fingerprints `creator_username`, so a creator
    RENAME between a committed purchase and the retry of the same key is a
    mismatch. It answered `key_resolved: true` -- and all three bundles read
    that as "retire the key and buy again", which is a second month for a fan
    holding the membership they just paid for. The published 409 already said
    a finished receipt for a membership still in hand replays as a 200.
    """
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    key = contract_key("legacy-rename")

    first = legacy_subscribe(fan, star, raw_key=key)
    assert first.status_code == 200, first.content
    assert balance(fan) == Decimal("90")

    # The creator renames, so the retry fingerprints differently. Past the
    # debounce, so only the receipt can stop a second debit.
    Creator.objects.filter(pk=star.pk).update(username="renamed-star")
    star.refresh_from_db(fields=["username"])
    Subscription.objects.filter(fan=fan, star=star).update(
        last_charged_at=timezone.now() - timedelta(minutes=5)
    )

    retry = legacy_subscribe(fan, star, raw_key=key)

    assert retry.status_code == 200, retry.content
    assert retry.data["replayed"] is True
    assert retry.data["charged"] == first.data["charged"]
    assert "key_resolved" not in retry.data
    # The whole point: no second month.
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db
def test_the_legacy_signal_still_fires_for_a_receipt_that_is_not_this_month(
    creator_factory,
):
    """The guard above must not have become "never resolve a legacy key".

    A fan with NO membership from this creator cannot be holding the purchase
    the receipt describes, so the key really is spent on something else and
    `key_resolved: true` is the signal that lets them recover.
    """
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    key = contract_key("legacy-no-membership")

    IdempotencyKey.objects.create(
        scope=f"subscribe:{star.pk}",
        user=Creator.objects.get(pk=fan.pk),
        key=key,
        response_status=200,
        request_hash="some-other-request",
        response_body={
            "charged": True,
            "expires": "2020-01-01T00:00:00Z",
            "replayed": False,
        },
    )

    retry = legacy_subscribe(fan, star, raw_key=key)

    assert retry.status_code == 409, retry.content
    assert retry.data["code"] == "idempotency_mismatch"
    assert retry.data["key_resolved"] is True
    assert balance(fan) == Decimal("100")


@pytest.mark.django_db
def test_a_committed_purchase_replays_even_when_the_creator_gates_would_refuse(
    creator_factory,
):
    """The CROSS-route lookups run before `is_active` / `member_price`.

    Deliberate, and the same ordering `_claim`'s own replay has always had
    (`test_confirmed_subscription_replays_after_creator_deactivation`): the
    receipt reports money that already moved, and what the creator changed
    afterwards cannot alter that. A 404/400 here would be a false failure on
    the retry of a committed purchase, and neither answer carries
    `key_resolved`, so the client would keep and re-send the key forever.
    """
    fan = creator_factory(tuzis=Decimal("1000"))
    gone = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    priceless = creator_factory(
        tuzis=Decimal("0"), member_price=Decimal("10"))

    # Legacy receipt -> replayed on the CONFIRMED route after deactivation.
    legacy_key = contract_key("gates-legacy")
    assert legacy_subscribe(fan, gone, raw_key=legacy_key).status_code == 200
    Creator.objects.filter(pk=gone.pk).update(is_active=False)
    gone.refresh_from_db(fields=["is_active"])
    Subscription.objects.filter(fan=fan, star=gone).update(
        last_charged_at=timezone.now() - timedelta(minutes=5)
    )
    on_confirmed = confirmed_subscribe(
        fan, gone, key="gates-legacy", price="10")
    assert on_confirmed.status_code == 200, on_confirmed.content
    assert on_confirmed.data["replayed"] is True

    # Confirmed receipt -> replayed on the LEGACY route after the creator's
    # price became one that route answers 400 for. the column is
    # NOT NULL and 0 is a free membership, so the only refused price left is
    # a negative one written past the validators.
    assert confirmed_subscribe(
        fan, priceless, key="gates-confirmed", price="10").status_code == 200
    Creator.objects.filter(pk=priceless.pk).update(member_price=-1)
    priceless.refresh_from_db(fields=["member_price"])
    Subscription.objects.filter(fan=fan, star=priceless).update(
        last_charged_at=timezone.now() - timedelta(minutes=5)
    )
    on_legacy = legacy_subscribe(
        fan, priceless, raw_key=contract_key("gates-confirmed"))
    assert on_legacy.status_code == 200, on_legacy.content
    assert on_legacy.data["replayed"] is True

    # Two memberships bought, two debits, and nothing extra on the retries.
    assert balance(fan) == Decimal("980")


# --------------------------------------------------------------------------
# `idempotency.claim()` is SHARED. The stale-takeover reorder in
# `dj.apps.tuzis.models` changes it for donate, PPV, zpage translate, zpage
# fund, storytime and the `aiscore_comments` management command -- not just
# subscribe. These test the primitive directly, under a neutral scope, so the
# contract is pinned where it actually lives rather than through one route's
# happy path.
# --------------------------------------------------------------------------


def _unfinished_claim_row(fan, *, scope, key, request_hash, age=None):
    row = IdempotencyKey.objects.create(
        scope=scope,
        user=Creator.objects.get(pk=fan.pk),
        key=key,
        request_hash=request_hash,
    )
    if age is not None:
        IdempotencyKey.objects.filter(pk=row.pk).update(
            created_at=timezone.now() - age)
    row.refresh_from_db()
    return row


@pytest.mark.django_db
def test_claim_takes_over_a_stale_unfinished_row_whatever_it_was_reserved_for(
    creator_factory,
):
    """The reorder, stated as the primitive's own contract.

    An unfinished row older than STALE_CLAIM belongs to a dead process and no
    money committed under it -- every caller finishes the claim inside the
    same transaction that moves the 2Z. Comparing the fingerprint FIRST made
    such a row a permanent 409 for any retry whose request changed at all
    (`cleanup_idempotency` only deletes rows that FINISHED), so the caller
    could never complete that purchase from that browser again.
    """
    fan = creator_factory(tuzis=Decimal("100"))
    stale = _unfinished_claim_row(
        fan,
        scope="donate-idempotent",
        key=contract_key("primitive-stale"),
        request_hash=idempotency.fingerprint({"amount": "10"}),
        age=idempotency.STALE_CLAIM + timedelta(minutes=1),
    )

    claimed = idempotency.claim(
        "donate-idempotent",
        Creator.objects.get(pk=fan.pk),
        contract_key("primitive-stale"),
        request_hash=idempotency.fingerprint({"amount": "12"}),
    )

    assert claimed.pk == stale.pk
    # Rebound to THIS request, and re-owned so the dead holder cannot release
    # a claim it no longer has.
    assert claimed.request_hash == idempotency.fingerprint({"amount": "12"})
    assert claimed.owner != stale.owner
    assert claimed.response_status is None


@pytest.mark.django_db
def test_claim_still_refuses_a_fresh_row_reserved_for_another_request(
    creator_factory,
):
    """Only STALENESS licenses the takeover. A young row may be committing."""
    fan = creator_factory(tuzis=Decimal("100"))
    _unfinished_claim_row(
        fan,
        scope="donate-idempotent",
        key=contract_key("primitive-young"),
        request_hash=idempotency.fingerprint({"amount": "10"}),
    )

    with pytest.raises(idempotency.IdempotencyConflict):
        idempotency.claim(
            "donate-idempotent",
            Creator.objects.get(pk=fan.pk),
            contract_key("primitive-young"),
            request_hash=idempotency.fingerprint({"amount": "12"}),
        )


@pytest.mark.django_db
def test_claim_never_takes_over_a_finished_row_however_old(creator_factory):
    """A FINISHED row is a receipt: money moved. Age does not spend it again.

    This is the invariant the takeover rests on -- `finish()` commits in the
    same transaction as the debit -- read in the other direction.
    """
    fan = creator_factory(tuzis=Decimal("100"))
    row = _unfinished_claim_row(
        fan,
        scope="donate-idempotent",
        key=contract_key("primitive-finished"),
        request_hash=idempotency.fingerprint({"amount": "10"}),
        age=idempotency.STALE_CLAIM + timedelta(days=30),
    )
    IdempotencyKey.objects.filter(pk=row.pk).update(
        response_status=200, response_body={"charged": True})

    with pytest.raises(idempotency.IdempotencyConflict):
        idempotency.claim(
            "donate-idempotent",
            Creator.objects.get(pk=fan.pk),
            contract_key("primitive-finished"),
            request_hash=idempotency.fingerprint({"amount": "12"}),
        )


@pytest.mark.django_db
def test_claim_honours_allow_stale_takeover_false_on_a_changed_request(
    creator_factory,
):
    """A caller that opts out of the takeover keeps the strict answer.

    `allow_stale_takeover=False` is how a caller says "an unfinished row here
    may still be running", and the reorder must not have made staleness win
    over that flag.
    """
    fan = creator_factory(tuzis=Decimal("100"))
    _unfinished_claim_row(
        fan,
        scope="donate-idempotent",
        key=contract_key("primitive-opt-out"),
        request_hash=idempotency.fingerprint({"amount": "10"}),
        age=idempotency.STALE_CLAIM + timedelta(minutes=1),
    )

    with pytest.raises(idempotency.IdempotencyConflict):
        idempotency.claim(
            "donate-idempotent",
            Creator.objects.get(pk=fan.pk),
            contract_key("primitive-opt-out"),
            request_hash=idempotency.fingerprint({"amount": "12"}),
            allow_stale_takeover=False,
        )


@pytest.mark.django_db
def test_a_moved_username_replay_obeys_the_lapsed_month_rule_too(
    creator_factory,
):
    """The rename replay was the one path that skipped the rule.

    `_replay_when_target_moved` answers a retry whose username no longer
    resolves -- so there is no `star` to ask about the membership, and the
    lapsed-month guard the rest of this branch applies to every replay was
    simply not reached. The receipt names the creator by immutable id, which
    is what closes it. A `200 {charged: true, expires: <past>}` here makes
    both bundles run their success path and mark a fan subscribed who is not
    and who bought nothing. (Codex adversarial review, round 5.)
    """
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    old_username = star.username

    first = confirmed_subscribe(fan, star, key="moved-lapsed", price="10")
    assert first.status_code == 200, first.content
    assert balance(fan) == Decimal("90")

    # The creator renames, so the old URL resolves to nobody -- and the
    # month the receipt bought has since run out.
    Creator.objects.filter(pk=star.pk).update(username="moved-away")
    Subscription.objects.filter(fan=fan, star=star).update(
        expires=timezone.now() - timedelta(days=1),
        last_charged_at=timezone.now() - timedelta(days=31),
    )

    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=fan.pk))
    retry = client.post(
        f"/api/tuzis/subscribe-confirmed/{old_username}",
        {"expected_price": "10"},
        format="json",
        HTTP_IDEMPOTENCY_KEY=contract_key("moved-lapsed"),
    )

    assert retry.status_code == 409, retry.content
    assert retry.data["code"] == "idempotency_mismatch"
    # The recovery signal: retire the key, buy the month under a fresh one.
    assert retry.data["key_resolved"] is True
    # Nothing moved on the ambiguous request.
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db
def test_a_moved_username_still_replays_a_membership_that_is_running(
    creator_factory,
):
    """The guard above must not have broken the rename replay it guards.

    A retry of a committed purchase whose creator has since renamed still
    gets its receipt back, because the month it bought is still running.
    """
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    old_username = star.username

    first = confirmed_subscribe(fan, star, key="moved-live", price="10")
    assert first.status_code == 200, first.content

    Creator.objects.filter(pk=star.pk).update(username="moved-away-too")
    Subscription.objects.filter(fan=fan, star=star).update(
        last_charged_at=timezone.now() - timedelta(minutes=5)
    )

    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=fan.pk))
    retry = client.post(
        f"/api/tuzis/subscribe-confirmed/{old_username}",
        {"expected_price": "10"},
        format="json",
        HTTP_IDEMPOTENCY_KEY=contract_key("moved-live"),
    )

    assert retry.status_code == 200, retry.content
    assert retry.data["replayed"] is True
    assert balance(fan) == Decimal("90")


@pytest.mark.django_db(transaction=True)
def test_legacy_rollout_claim_order_with_actual_previous_handler(
    creator_factory, monkeypatch,
):
    """An old pod cannot insert its receipt behind the new pod's money locks."""
    from django.db import transaction
    from rest_framework.test import APIRequestFactory, force_authenticate

    from dj.apps.tuzis import views as money_views

    fixture = Path(__file__).with_name("fixtures") / "legacy_subscribe_post_3b7db874e.txt"
    namespace = dict(vars(money_views))
    exec(compile(fixture.read_text(), str(fixture), "exec"), namespace)
    old_post = namespace["post"]
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    Subscription.objects.create(
        fan=fan, star=star, max_price=Decimal("10"),
        expires=timezone.now() - timedelta(days=1),
    )
    key = contract_key("mixed-version-legacy")
    new_holds_money = threading.Event()
    release_new = threading.Event()
    old_claimed_or_finished = threading.Event()
    results = {}
    original_extend = Subscription.extend
    original_claim = idempotency.claim

    def pause_new_after_money(sub, *args, **kwargs):
        result = original_extend(sub, *args, **kwargs)
        if threading.current_thread().name == "new-legacy-pod":
            new_holds_money.set()
            assert release_new.wait(timeout=10)
        return result

    def observe_old_claim(*args, **kwargs):
        result = original_claim(*args, **kwargs)
        if threading.current_thread().name == "old-legacy-pod":
            old_claimed_or_finished.set()
        return result

    monkeypatch.setattr(Subscription, "extend", pause_new_after_money)
    monkeypatch.setattr(idempotency, "claim", observe_old_claim)

    def old_request():
        view = money_views.CreatorSubscribeView()
        raw = APIRequestFactory().post(
            f"/api/tuzis/subscribe/{star.username}", HTTP_IDEMPOTENCY_KEY=key,
        )
        force_authenticate(raw, user=Creator.objects.get(pk=fan.pk))
        request = view.initialize_request(raw)
        # Previous AtomicMiddleware wrapped the entire legacy POST. Calling
        # the frozen handler directly preserves that old transaction boundary.
        with transaction.atomic():
            return old_post(view, request, username=star.username)

    def run(which, action):
        try:
            results[which] = action()
        except Exception as error:
            results[which] = error
        finally:
            if which == "old":
                old_claimed_or_finished.set()
            connection.close()

    new = threading.Thread(
        name="new-legacy-pod", target=run,
        args=("new", lambda: legacy_subscribe(fan, star, raw_key=key)),
    )
    old = threading.Thread(name="old-legacy-pod", target=run, args=("old", old_request))
    new.start()
    try:
        assert new_holds_money.wait(timeout=10)
        old.start()
        assert old_claimed_or_finished.wait(timeout=10)
    finally:
        release_new.set()
        new.join(timeout=30)
        if old.ident is not None:
            old.join(timeout=30)
    assert not new.is_alive() and not old.is_alive(), "mixed-version deadlock"
    assert not isinstance(results["new"], Exception), results["new"]
    assert not isinstance(results["old"], Exception), results["old"]
    assert results["new"].status_code == 200
    assert results["old"].status_code == 409
    Subscription.objects.filter(fan=fan, star=star).update(
        last_charged_at=timezone.now() - timedelta(minutes=2),
    )
    replay = old_request()
    assert replay.status_code == 200
    assert replay.data["replayed"] is True
    assert balance(fan) == Decimal("90")
    assert balance(star) == Decimal("10")


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("retry_route", ["legacy", "confirmed"])
def test_previous_pod_other_payer_same_legacy_key_replays_without_second_debit(
    creator_factory, retry_route,
):
    from django.db import transaction
    from rest_framework.test import APIRequestFactory, force_authenticate

    from dj.apps.tuzis import views as money_views

    alice = creator_factory(tuzis=Decimal("100"))
    bob = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    label = "other-payer-old-tab-key"
    key = contract_key(label)
    assert legacy_subscribe(alice, star, raw_key=key).status_code == 200

    # Old browser reused Alice's still-visible key. An actual previous pod
    # legitimately charges Bob once: receipts include the authenticated payer.
    fixture = Path(__file__).with_name("fixtures") / "legacy_subscribe_post_3b7db874e.txt"
    namespace = dict(vars(money_views))
    exec(compile(fixture.read_text(), str(fixture), "exec"), namespace)
    view = money_views.CreatorSubscribeView()
    raw = APIRequestFactory().post(
        f"/api/tuzis/subscribe/{star.username}", HTTP_IDEMPOTENCY_KEY=key,
    )
    force_authenticate(raw, user=bob)
    with transaction.atomic():
        paid = namespace["post"](
            view, view.initialize_request(raw), username=star.username,
        )
    assert paid.status_code == 200
    assert paid.data["charged"] is True
    Subscription.objects.filter(fan=bob, star=star).update(
        last_charged_at=timezone.now() - timedelta(minutes=2),
    )
    # The response was lost, and the new bundle must retain that same UUID.
    if retry_route == "legacy":
        replay = legacy_subscribe(bob, star, raw_key=key)
    else:
        replay = confirmed_subscribe(bob, star, key=label, creator_id=star.pk)
    assert replay.status_code == 200
    assert replay.data["replayed"] is True
    assert balance(alice) == Decimal("90")
    assert balance(bob) == Decimal("90")
    assert balance(star) == Decimal("20")


def _previous_pod_subscription(fan, star, key):
    from django.db import transaction
    from rest_framework.test import APIRequestFactory, force_authenticate
    from dj.apps.tuzis import views

    fixture = (
        Path(__file__).with_name("fixtures") / "legacy_subscribe_post_3b7db874e.txt"
    )
    namespace = dict(vars(views))
    exec(compile(fixture.read_text(), str(fixture), "exec"), namespace)
    view = views.CreatorSubscribeView()
    raw = APIRequestFactory().post(
        f"/api/tuzis/subscribe/{star.username}", HTTP_IDEMPOTENCY_KEY=key
    )
    force_authenticate(raw, user=Creator.objects.get(pk=fan.pk))
    with transaction.atomic():
        return namespace["post"](
            view, view.initialize_request(raw), username=star.username
        )


def _creator_switch_setup(creator_factory):
    fan = creator_factory(tuzis=Decimal("100"))
    a = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    label = "creator-switch"
    key = contract_key(label)
    assert confirmed_subscribe(fan, a, key=label).status_code == 200
    old_name = a.username
    a.username += "renamed"
    a.save(update_fields=["username"])
    b = creator_factory(
        username=old_name, tuzis=Decimal("0"), member_price=Decimal("10")
    )
    return fan, a, b, key, label


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("route", ["legacy", "confirmed"])
def test_previous_pod_completed_creator_switch_replays(creator_factory, route):
    fan, a, b, key, label = _creator_switch_setup(creator_factory)
    assert _previous_pod_subscription(fan, b, key).status_code == 200
    Subscription.objects.filter(fan=fan, star=b).update(
        last_charged_at=timezone.now() - timedelta(minutes=2)
    )
    replay = (
        legacy_subscribe(fan, b, raw_key=key)
        if route == "legacy"
        else confirmed_subscribe(fan, b, key=label, creator_id=b.pk)
    )
    assert replay.status_code == 200
    assert replay.data["replayed"] is True
    assert balance(fan) == Decimal("80")
    assert balance(a) == Decimal("10")
    assert balance(b) == Decimal("10")


@pytest.mark.django_db(transaction=True)
def test_previous_pod_inflight_creator_switch_rechecks_committed_receipt(
    creator_factory, monkeypatch
):
    from dj.apps.tuzis import views

    fan, a, b, key, label = _creator_switch_setup(creator_factory)
    old_claimed = threading.Event()
    release_old = threading.Event()
    new_missed = threading.Event()
    results = {}
    original_claim = idempotency.claim
    original_lookup = views._legacy_subscribe_receipt

    def claim(*args, **kwargs):
        result = original_claim(*args, **kwargs)
        if threading.current_thread().name == "old":
            old_claimed.set()
            assert release_old.wait(10)
        return result

    def lookup(*args, **kwargs):
        result = original_lookup(*args, **kwargs)
        if threading.current_thread().name == "new" and not new_missed.is_set():
            assert result is None
            new_missed.set()
        return result

    monkeypatch.setattr(idempotency, "claim", claim)
    monkeypatch.setattr(views, "_legacy_subscribe_receipt", lookup)

    def worker(name, action):
        try:
            results[name] = action()
        except Exception as exc:
            results[name] = exc
        finally:
            connection.close()

    old = threading.Thread(
        name="old",
        target=worker,
        args=("old", lambda: _previous_pod_subscription(fan, b, key)),
    )
    new = threading.Thread(
        name="new",
        target=worker,
        args=("new", lambda: confirmed_subscribe(fan, b, key=label, creator_id=b.pk)),
    )
    old.start()
    try:
        assert old_claimed.wait(10)
        new.start()
        assert new_missed.wait(10)
    finally:
        release_old.set()
        old.join(30)
        if new.ident:
            new.join(30)
    assert not old.is_alive() and not new.is_alive()
    assert not isinstance(results["old"], Exception), results["old"]
    assert not isinstance(results["new"], Exception), results["new"]
    assert results["old"].status_code == 200
    assert results["new"].status_code == 200, results["new"].data
    assert results["new"].data["replayed"] is True
    assert balance(fan) == Decimal("80")
    assert balance(a) == Decimal("10")
    assert balance(b) == Decimal("10")
