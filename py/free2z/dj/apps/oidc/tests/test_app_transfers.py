"""App transfer contract against the real PostgreSQL schema and routes."""
from datetime import timedelta

import pytest
from django.db import connection
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.g12f.account_deletion import blockers, delete_account, schedule_deletion
from dj.apps.oidc.models import AppAuthorization, AppOwnershipTransfer

pytestmark = pytest.mark.django_db


def client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def offer(app, sender, recipient):
    return client(sender).post(f"/api/oauth/apps/{app.pk}/transfer/", {
        "recipient": recipient.username, "expected_actor_id": sender.pk,
    }, format="json")


def resolve(user, transfer_id, action="accept", actor_id=None):
    return client(user).post(f"/api/oauth/app-transfers/{transfer_id}/{action}/", {
        "expected_actor_id": actor_id or user.pk,
    }, format="json")


def test_consent_transfer_preserves_grants_and_unblocks_deletion(web_app, developer, user):
    grant = AppAuthorization.objects.create(user=user, application=web_app, scope="openid")
    assert "app_has_users" in blockers(developer)
    response = offer(web_app, developer, user)
    assert response.status_code == 201, response.content
    transfer_id = response.json()["id"]
    assert resolve(developer, transfer_id).status_code == 404
    assert resolve(user, transfer_id, actor_id=developer.pk).json()["code"] == "actor_changed"
    accepted = resolve(user, transfer_id)
    assert accepted.status_code == 200, accepted.content
    web_app.refresh_from_db()
    assert web_app.user_id == user.pk
    assert AppAuthorization.objects.get(pk=grant.pk).application_id == web_app.pk
    assert "app_has_users" not in blockers(developer)
    with connection.cursor() as cursor:
        cursor.execute("SELECT developer_creator_id FROM ledger_app WHERE id=%s", [web_app.pk])
        assert cursor.fetchone()[0] == user.pk
    assert AppOwnershipTransfer.objects.get(pk=transfer_id).state == "accepted"
    schedule_deletion(developer, confirm_username=developer.username, auth_epoch=developer.kt_account_epoch)
    developer.refresh_from_db()
    assert developer.deletion_pending()


@pytest.mark.parametrize("party", ["sender", "recipient"])
def test_recovery_epoch_invalidates_offer(web_app, developer, user, party):
    result = offer(web_app, developer, user)
    account = developer if party == "sender" else user
    type(account).objects.filter(pk=account.pk).update(kt_account_epoch=account.kt_account_epoch + 1)
    if party == "recipient":
        user.refresh_from_db()
    response = resolve(user, result.json()["id"])
    assert response.status_code == 409 and response.json()["code"] == "offer_invalid"
    web_app.refresh_from_db()
    assert web_app.user_id == developer.pk


def test_expiry_cancel_and_reoffer(web_app, developer, user):
    first = offer(web_app, developer, user).json()
    AppOwnershipTransfer.objects.filter(pk=first["id"]).update(expires_at=timezone.now() - timedelta(seconds=1))
    listed = client(user).get("/api/oauth/app-transfers/").json()["results"]
    assert listed[0]["state"] == "expired" and listed[0]["role"] == "recipient"
    assert resolve(user, first["id"]).json()["code"] == "offer_expired"
    second = offer(web_app, developer, user).json()
    assert resolve(developer, second["id"], "cancel").json()["state"] == "cancelled"
    assert resolve(user, second["id"]).status_code == 409
    assert offer(web_app, developer, user).status_code == 201


def test_open_hold_blocks_acceptance_until_release(web_app, developer, user):
    from dj.apps.ledger.api import ensure_account
    from dj.apps.oidc import ledger_projection
    account = ensure_account(user.pk)
    ledger_projection.sync_application(web_app)
    with connection.cursor() as cursor:
        cursor.execute("INSERT INTO ledger_spend_cap(app_id,account_id,period,grant_generation) VALUES(%s,%s,'total',1)", [web_app.pk, account])
        cursor.execute("SELECT * FROM ledger.hold_internal(%s,%s,1000,'one','one')", [user.public_id, web_app.pk])
        held = dict(zip([col.name for col in cursor.description], cursor.fetchone()))
    assert held["status"] == "held"
    transfer_id = offer(web_app, developer, user).json()["id"]
    assert resolve(user, transfer_id).json()["code"] == "usage_in_flight"
    with connection.cursor() as cursor:
        cursor.execute("SELECT * FROM ledger.release(%s)", [held["hold_id"]])
    assert resolve(user, transfer_id).status_code == 200


@pytest.mark.django_db(transaction=True)
def test_gateway_admission_serializes_with_acceptance(web_app, developer, user, creator_factory):
    """A shipping hold in flight commits before acceptance checks outstanding work."""
    import threading
    from django.db import close_old_connections, transaction
    from dj.apps.ledger.api import ensure_account
    from dj.apps.oidc import ledger_projection
    from dj.apps.pricing.models import RateCard, RateCardModel

    buyer = creator_factory(username="buyer", tuzis=100)
    account = ensure_account(buyer.pk)
    ledger_projection.sync_application(web_app)
    card = RateCard.objects.create(version=19031)
    RateCardModel.objects.create(rate_card=card, model_id="test-transfer", **{
        field.name: 1 for field in RateCardModel._meta.fields if "nusd" in field.name
    })
    RateCard.objects.filter(pk=card.pk).update(active=True, published_at=timezone.now())
    with connection.cursor() as cursor:
        cursor.execute("INSERT INTO ledger_spend_cap(app_id,account_id,period,grant_generation) VALUES(%s,%s,'total',1)", [web_app.pk, account])
    transfer_id = offer(web_app, developer, user).json()["id"]
    entered, release, accepted = threading.Event(), threading.Event(), threading.Event()
    result = {}

    def admit():
        close_old_connections()
        try:
            with transaction.atomic(), connection.cursor() as cursor:
                cursor.execute("SELECT * FROM ledger.hold(%s,%s,1000,'race','race',1,300,%s,1,'test-transfer',%s)",
                               [buyer.public_id, web_app.pk, buyer.kt_account_epoch, card.version])
                result["hold"] = dict(zip([col.name for col in cursor.description], cursor.fetchone()))
                entered.set()
                assert release.wait(10)
        finally:
            close_old_connections()

    def accept():
        close_old_connections()
        try:
            result["response"] = resolve(user, transfer_id)
        finally:
            accepted.set()
            close_old_connections()

    admission = threading.Thread(target=admit)
    acceptance = threading.Thread(target=accept)
    admission.start()
    try:
        assert entered.wait(10)
        assert result["hold"]["status"] == "held"
        acceptance.start()
        assert not accepted.wait(0.25)
    finally:
        release.set()
        admission.join(10)
        if acceptance.ident:
            acceptance.join(10)
    assert not admission.is_alive() and not acceptance.is_alive()
    assert result["response"].status_code == 409
    assert result["response"].json()["code"] == "usage_in_flight"
    with connection.cursor() as cursor:
        cursor.execute("SELECT * FROM ledger.release(%s)", [result["hold"]["hold_id"]])
    assert resolve(user, transfer_id).status_code == 200


def test_settled_split_keeps_original_developer(web_app, developer, user):
    from dj.apps.ledger.api import ensure_account
    from dj.apps.oidc import ledger_projection
    from dj.apps.pricing.models import RateCard, RateCardModel

    card = RateCard.objects.create(version=19032)
    RateCardModel.objects.create(rate_card=card, model_id="settled-transfer", **{
        field.name: 1 for field in RateCardModel._meta.fields if "nusd" in field.name
    })
    RateCard.objects.filter(pk=card.pk).update(active=True, published_at=timezone.now())
    user.tuzis = 100
    user.save(update_fields=["tuzis"])
    web_app.markup_bps = 2000
    web_app.approved_markup_bps = 2000
    web_app.save()
    ledger_projection.sync_application(web_app)
    account = ensure_account(user.pk)
    with connection.cursor() as cursor:
        cursor.execute("INSERT INTO ledger_spend_cap(app_id,account_id,period,grant_generation,markup_bps) VALUES(%s,%s,'total',1,2000)", [web_app.pk, account])
        cursor.execute("SELECT * FROM ledger.hold_internal(%s,%s,10000,'before','before',0,300,NULL,NULL,'settled-transfer',%s,NULL,2000)", [user.public_id, web_app.pk, card.version])
        hold = dict(zip([col.name for col in cursor.description], cursor.fetchone()))
        assert hold["status"] == "held"
        cursor.execute("SELECT * FROM ledger.settle(%s,100000000)", [hold["hold_id"]])
        assert cursor.fetchone()[0] == "settled"
        cursor.execute("SELECT developer_creator_id, developer_m2z FROM ledger_ai_split_queue WHERE usage_id=(SELECT id FROM ledger_ai_usage WHERE hold_id=%s)", [hold["hold_id"]])
        before = cursor.fetchone()
    assert before[0] == developer.pk and before[1] > 0
    transfer_id = offer(web_app, developer, user).json()["id"]
    assert resolve(user, transfer_id).status_code == 200
    with connection.cursor() as cursor:
        cursor.execute("SELECT developer_creator_id, developer_m2z FROM ledger_ai_split_queue WHERE usage_id=(SELECT id FROM ledger_ai_usage WHERE hold_id=%s)", [hold["hold_id"]])
        assert cursor.fetchone() == before


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("kind", ["grant", "purchase"])
def test_older_pod_admission_waits_for_pending_deletion(web_app, developer, user, kind):
    """The DB fence also protects writes from a pod predating this release."""
    import threading
    from django.db import IntegrityError, close_old_connections, transaction
    from dj.apps.oidc.models import F2ZApplication
    from dj.apps.purchases.models import PurchaseIntent

    started, done = threading.Event(), threading.Event()
    result = {}

    def admit():
        close_old_connections()
        try:
            started.set()
            if kind == "grant":
                AppAuthorization.objects.create(user_id=user.pk, application_id=web_app.pk, scope="openid")
            else:
                PurchaseIntent.objects.create(
                    creator_id=user.pk, application_id=web_app.pk, rail="stripe", platform="desktop",
                    quantity_2z=100, quote={}, pricing_version="test", price_minor=100,
                    currency="USD", expires_at=timezone.now() + timedelta(hours=1),
                )
            result["created"] = True
        except IntegrityError:
            result["refused"] = True
        finally:
            done.set()
            close_old_connections()

    worker = threading.Thread(target=admit)
    with transaction.atomic():
        type(developer).objects.select_for_update().get(pk=developer.pk)
        F2ZApplication.objects.select_for_update().get(pk=web_app.pk)
        type(developer).objects.filter(pk=developer.pk).update(is_active=False)
        worker.start()
        assert started.wait(5)
        assert not done.wait(0.25)
    worker.join(10)
    assert not worker.is_alive() and result == {"refused": True}
    assert not AppAuthorization.objects.filter(application=web_app).exists()
    assert not PurchaseIntent.objects.filter(application=web_app).exists()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("kind", ["grant", "purchase"])
def test_transfer_waits_for_grant_or_purchase_admission(web_app, developer, user, creator_factory, kind):
    import threading
    from django.db import close_old_connections, transaction
    from dj.apps.purchases.models import PurchaseIntent

    buyer = creator_factory(username="admission_buyer")
    transfer_id = offer(web_app, developer, user).json()["id"]
    admitted, release, finished = threading.Event(), threading.Event(), threading.Event()
    result = {}

    def admit():
        close_old_connections()
        try:
            with transaction.atomic():
                if kind == "grant":
                    grant = AppAuthorization.objects.create(user_id=buyer.pk, application_id=web_app.pk, scope="openid")
                else:
                    PurchaseIntent.objects.create(
                        creator_id=buyer.pk, application_id=web_app.pk, rail="stripe", platform="desktop",
                        quantity_2z=100, quote={}, pricing_version="test", price_minor=100,
                        currency="USD", expires_at=timezone.now() + timedelta(hours=1),
                    )
                admitted.set()
                assert release.wait(10)
                if kind == "grant":
                    from dj.apps.oidc import ledger_projection
                    ledger_projection.sync_grant(grant)
        finally:
            close_old_connections()

    def accept():
        close_old_connections()
        try:
            result["response"] = resolve(user, transfer_id)
        finally:
            finished.set()
            close_old_connections()

    worker = threading.Thread(target=admit)
    accepter = threading.Thread(target=accept)
    worker.start()
    try:
        assert admitted.wait(10)
        accepter.start()
        assert finished.wait(5)
    finally:
        release.set()
        worker.join(10)
        if accepter.ident:
            accepter.join(10)
    assert not worker.is_alive() and not accepter.is_alive()
    assert result["response"].json()["code"] == "app_busy"
    assert resolve(user, transfer_id).status_code == 200
    web_app.refresh_from_db()
    assert web_app.user_id == user.pk
    if kind == "grant":
        assert AppAuthorization.objects.filter(application=web_app, user=buyer).exists()
    else:
        assert PurchaseIntent.objects.filter(application=web_app, creator=buyer).exists()


def test_transferred_owner_can_complete_deletion(web_app, developer, user):
    AppAuthorization.objects.create(user=user, application=web_app, scope="openid")
    transfer_id = offer(web_app, developer, user).json()["id"]
    assert resolve(user, transfer_id).status_code == 200
    delete_account(developer, confirm_username=developer.username, auth_epoch=developer.kt_account_epoch)
    developer.refresh_from_db()
    assert not developer.is_active and developer.deleted_at is not None
    web_app.refresh_from_db()
    assert web_app.user_id == user.pk


@pytest.mark.parametrize("party", ["sender", "recipient"])
def test_inactive_or_pending_account_cannot_complete_offer(web_app, developer, user, party):
    transfer_id = offer(web_app, developer, user).json()["id"]
    account = developer if party == "sender" else user
    type(account).objects.filter(pk=account.pk).update(
        is_active=False, deletion_requested_at=timezone.now(), purge_after=timezone.now() + timedelta(days=1),
    )
    response = resolve(user, transfer_id)
    assert response.status_code == 409
    web_app.refresh_from_db()
    assert web_app.user_id == developer.pk


def test_offer_pagination_reaches_all_pending_beyond_history(user, developer):
    import uuid

    now = timezone.now()
    records = []
    for index in range(270):
        records.append(AppOwnershipTransfer(
            application_id=uuid.uuid4(), application_name=f"App {index}", sender_id=developer.pk,
            recipient_id=user.pk, sender_epoch=developer.kt_account_epoch, recipient_epoch=user.kt_account_epoch,
            created_at=now + timedelta(seconds=index), expires_at=now + timedelta(days=7),
            state="pending" if index < 130 else "cancelled",
        ))
    AppOwnershipTransfer.objects.bulk_create(records)
    route = "/api/oauth/app-transfers/"
    found, pages, cursor = [], 0, None
    while True:
        response = client(user).get(route, {"cursor": cursor} if cursor else {})
        assert response.status_code == 200
        body = response.json()
        assert len(body["results"]) <= 50
        found.extend(body["results"])
        pages += 1
        cursor = body["next_cursor"]
        if cursor is None:
            break
        assert pages < 10
    assert pages == 6 and len(found) == 270
    assert len({offer["id"] for offer in found}) == 270
    assert sum(offer["state"] == "pending" for offer in found) == 130
    stolen_cursor = client(user).get(route).json()["next_cursor"]
    assert client(developer).get(route, {"cursor": stolen_cursor}).status_code == 400


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("winner", ["accept", "cancel"])
def test_accept_cancel_race_has_one_terminal_winner(web_app, developer, user, monkeypatch, winner):
    import threading
    from django.db import close_old_connections
    from dj.apps.oidc import ledger_projection

    ledger_projection.sync_application(web_app)
    transfer_id = offer(web_app, developer, user).json()["id"]
    entered, release, loser_done = threading.Event(), threading.Event(), threading.Event()
    results = {}
    original = AppOwnershipTransfer.save

    def pause_save(row, *args, **kwargs):
        if row.state == ("accepted" if winner == "accept" else "cancelled"):
            entered.set()
            assert release.wait(10)
        return original(row, *args, **kwargs)

    monkeypatch.setattr(AppOwnershipTransfer, "save", pause_save)
    def invoke(action):
        close_old_connections()
        try:
            results[action] = resolve(user if action == "accept" else developer, transfer_id, action)
        finally:
            if action != winner:
                loser_done.set()
            close_old_connections()

    first = threading.Thread(target=invoke, args=(winner,))
    loser = "cancel" if winner == "accept" else "accept"
    second = threading.Thread(target=invoke, args=(loser,))
    first.start()
    try:
        assert entered.wait(10)
        second.start()
        assert not loser_done.wait(0.25)
    finally:
        release.set()
        first.join(10)
        if second.ident:
            second.join(10)
    assert not first.is_alive() and not second.is_alive()
    assert results[winner].status_code == 200
    assert results[loser].status_code == 409
    row = AppOwnershipTransfer.objects.get(pk=transfer_id)
    assert row.state == ("accepted" if winner == "accept" else "cancelled")
    web_app.refresh_from_db()
    expected = user.pk if winner == "accept" else developer.pk
    assert web_app.user_id == expected
    with connection.cursor() as cursor:
        cursor.execute("SELECT developer_creator_id FROM ledger_app WHERE id=%s", [web_app.pk])
        assert cursor.fetchone()[0] == expected


@pytest.mark.django_db(transaction=True)
def test_accept_waiting_on_account_lock_expires_without_transfer(web_app, developer, user):
    import threading
    from django.db import close_old_connections, transaction
    from dj.apps.oidc import ledger_projection

    ledger_projection.sync_application(web_app)
    transfer_id = offer(web_app, developer, user).json()["id"]
    AppOwnershipTransfer.objects.filter(pk=transfer_id).update(expires_at=timezone.now() + timedelta(seconds=1))
    started, finished = threading.Event(), threading.Event()
    result = {}
    def accept():
        close_old_connections()
        try:
            started.set()
            result["response"] = resolve(user, transfer_id)
        finally:
            finished.set()
            close_old_connections()
    worker = threading.Thread(target=accept)
    with transaction.atomic():
        type(developer).objects.select_for_update().get(pk=developer.pk)
        worker.start()
        assert started.wait(5)
        assert not finished.wait(1.5)
    worker.join(10)
    assert not worker.is_alive()
    assert result["response"].json()["code"] == "offer_expired"
    assert AppOwnershipTransfer.objects.get(pk=transfer_id).state == "expired"
    web_app.refresh_from_db()
    assert web_app.user_id == developer.pk
    with connection.cursor() as cursor:
        cursor.execute("SELECT developer_creator_id FROM ledger_app WHERE id=%s", [web_app.pk])
        assert cursor.fetchone()[0] == developer.pk


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("kind", ["grant", "purchase"])
def test_same_account_admission_does_not_deadlock_deletion_schedule(web_app, developer, kind, recent_login):
    import threading
    from django.db import close_old_connections, transaction
    from dj.apps.purchases.models import PurchaseIntent

    session = APIClient()
    recent_login(session, developer)
    schedule_url = "/api/auth/account-deletion/schedule/"
    held, release, done = threading.Event(), threading.Event(), threading.Event()
    result = {}
    def admission():
        close_old_connections()
        try:
            with transaction.atomic():
                if kind == "grant":
                    AppAuthorization.objects.create(user_id=developer.pk, application_id=web_app.pk, scope="openid")
                else:
                    PurchaseIntent.objects.create(
                        creator_id=developer.pk, application_id=web_app.pk, rail="stripe", platform="desktop",
                        quantity_2z=100, quote={}, pricing_version="test", price_minor=100,
                        currency="USD", expires_at=timezone.now() + timedelta(hours=1),
                    )
                held.set()
                assert release.wait(10)
        except Exception as exc:
            result["error"] = exc
        finally:
            done.set()
            close_old_connections()
    worker = threading.Thread(target=admission)
    worker.start()
    try:
        assert held.wait(10)
        refused = session.post(schedule_url, {"confirm_username": developer.username}, format="json")
        assert refused.status_code == 409 and refused.json()["code"] == "app_busy"
    finally:
        release.set()
        worker.join(10)
    assert done.is_set() and not worker.is_alive() and "error" not in result
    refused = session.post(schedule_url, {"confirm_username": developer.username}, format="json")
    assert refused.status_code == 409 and refused.json()["code"] == "app_has_users"
    developer.refresh_from_db()
    assert developer.is_active


@pytest.mark.django_db(transaction=True)
def test_transfer_migration_is_bounded_and_atomic_under_table_contention():
    import threading
    import time
    from django.db import close_old_connections, transaction
    from django.db.migrations.executor import MigrationExecutor
    from django.db.migrations.recorder import MigrationRecorder

    target = ("oidc", "0007_app_ownership_transfer")
    executor = MigrationExecutor(connection)
    executor.migrate([("oidc", "0006_mcpairequest")])
    result = {}
    done = threading.Event()
    def install():
        close_old_connections()
        try:
            start = time.monotonic()
            MigrationExecutor(connection).migrate([target])
            result["unexpected_success"] = True
        except Exception as exc:
            result["error"] = exc
            result["elapsed"] = time.monotonic() - start
        finally:
            done.set()
            connection.close()
    worker = threading.Thread(target=install)
    try:
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute("LOCK TABLE purchases_purchaseintent IN ACCESS EXCLUSIVE MODE")
            worker.start()
            assert done.wait(12), "migration exceeded its lock bound"
            assert "error" in result and 3 < result["elapsed"] < 10
            assert getattr(result["error"].__cause__, "sqlstate", None) == "55P03"
            cursor.execute("SELECT to_regclass('public.oidc_appownershiptransfer')")
            assert cursor.fetchone()[0] is None
            cursor.execute("SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'oidc_active_%' OR tgname='oidc_transfer_hold_admission'")
            assert cursor.fetchone()[0] == 0
            assert not MigrationRecorder(connection).migration_qs.filter(app="oidc", name=target[1]).exists()
        worker.join(10)
        assert not worker.is_alive()
    finally:
        worker.join(12)
        MigrationExecutor(connection).migrate([target])


@pytest.mark.django_db(transaction=True)
def test_accept_waiting_for_hold_admission_rechecks_expiry(web_app, developer, user):
    import threading
    from django.db import close_old_connections, transaction
    from dj.apps.oidc import ledger_projection

    ledger_projection.sync_application(web_app)
    transfer_id = offer(web_app, developer, user).json()["id"]
    AppOwnershipTransfer.objects.filter(pk=transfer_id).update(expires_at=timezone.now() + timedelta(seconds=1))
    started, finished = threading.Event(), threading.Event()
    result = {}
    def accept():
        close_old_connections()
        try:
            started.set()
            result["response"] = resolve(user, transfer_id)
        finally:
            finished.set()
            connection.close()
    worker = threading.Thread(target=accept)
    with transaction.atomic(), connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock_shared(hashtextextended(%s, 1303))", [str(web_app.pk)])
        worker.start()
        assert started.wait(5)
        assert not finished.wait(1.5)
    worker.join(10)
    assert not worker.is_alive()
    assert result["response"].json()["code"] == "offer_expired"
    assert AppOwnershipTransfer.objects.get(pk=transfer_id).state == "expired"
    web_app.refresh_from_db()
    assert web_app.user_id == developer.pk
    with connection.cursor() as cursor:
        cursor.execute("SELECT developer_creator_id FROM ledger_app WHERE id=%s", [web_app.pk])
        assert cursor.fetchone()[0] == developer.pk
