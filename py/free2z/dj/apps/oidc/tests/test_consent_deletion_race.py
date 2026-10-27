"""The consent grant and app deletion must serialize on the app row."""
from __future__ import annotations

import threading
import time
from types import SimpleNamespace

import pytest
from django.db import connection, transaction
from rest_framework.test import APIClient

from dj.apps.oidc import consent
from dj.apps.oidc.models import AppAuthorization, F2ZApplication
from dj.apps.g12f import account_deletion

from .conftest import WEB_REDIRECT, Flow


pytestmark = pytest.mark.django_db(transaction=True)


def _decision(flow, evaluated):
    return {
        "request_id": evaluated["request_id"],
        "authorization_request": evaluated["authorization_request"],
        "allow": True,
    }


def _client(user):
    client = APIClient()
    client.force_authenticate(user)
    return client


def _backend_pid():
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_backend_pid()")
        return cursor.fetchone()[0]


def _wait_until_blocked(blocked_pid, blocker_pid, *, timeout=10):
    """Wait until Postgres confirms this backend is blocked by the other."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT wait_event_type = 'Lock' "
                "AND %s = ANY(pg_blocking_pids(pid)) "
                "FROM pg_stat_activity WHERE pid = %s",
                [blocker_pid, blocked_pid],
            )
            row = cursor.fetchone()
        if row is not None and row[0]:
            return True
        time.sleep(0.02)
    return False


def test_delete_wins_first_consent_returns_conflict_instead_of_commit_error(
    user, web_app, monkeypatch,
):
    flow = Flow(_client(user), user, web_app, redirect_uri=WEB_REDIRECT, scope="openid profile")
    evaluated = flow.evaluate().json()
    lock_attempted = threading.Event()
    result = {}
    original_lock = consent._lock_application_for_consent

    def observe_lock(application):
        lock_attempted.set()
        return original_lock(application)

    monkeypatch.setattr(consent, "_lock_application_for_consent", observe_lock)

    def consent_request():
        try:
            result["response"] = _client(user).post(
                "/api/oauth/authorize", _decision(flow, evaluated), format="json",
            )
        except BaseException as exc:  # surfaced in the main test thread below
            result["exception"] = exc
        finally:
            connection.close()

    worker = threading.Thread(target=consent_request, name="delete-first-consent")
    with transaction.atomic():
        deleting_app = F2ZApplication.objects.select_for_update().get(pk=web_app.pk)
        deleting_app.delete()
        worker.start()
        reached_lock = lock_attempted.wait(timeout=10)

    # Exiting the transaction releases the deleted row; the waiting consent
    # then observes that it no longer exists.
    worker.join(timeout=20)
    assert not worker.is_alive(), "consent request did not finish after deletion committed"
    assert reached_lock, "consent did not reach its app-row lock"
    assert "exception" not in result, result.get("exception")
    response = result["response"]
    assert response.status_code == 409, response.content
    assert response.json()["code"] == "application_unavailable"
    assert not AppAuthorization.objects.filter(user=user, application_id=web_app.pk).exists()


def test_first_consent_lock_makes_developer_delete_see_the_committed_grant(
    user, developer, web_app, monkeypatch,
):
    flow = Flow(_client(user), user, web_app, redirect_uri=WEB_REDIRECT, scope="openid profile")
    evaluated = flow.evaluate().json()
    consent_lock_acquired = threading.Event()
    delete_started = threading.Event()
    allow_consent_to_finish = threading.Event()
    results = {}
    original_lock = consent._lock_application_for_consent

    def hold_consent_lock(application):
        found = original_lock(application)
        results["consent_pid"] = _backend_pid()
        consent_lock_acquired.set()
        assert allow_consent_to_finish.wait(timeout=10), "test did not release the consent transaction"
        return found

    monkeypatch.setattr(consent, "_lock_application_for_consent", hold_consent_lock)

    def consent_request():
        try:
            results["consent"] = _client(user).post(
                "/api/oauth/authorize", _decision(flow, evaluated), format="json",
            )
        except BaseException as exc:
            results["consent_exception"] = exc
        finally:
            connection.close()

    def delete_request():
        try:
            results["delete_pid"] = _backend_pid()
            delete_started.set()
            results["delete"] = _client(developer).delete(
                f"/api/oauth/apps/{web_app.pk}/",
            )
        except BaseException as exc:
            results["delete_exception"] = exc
        finally:
            connection.close()

    consenting = threading.Thread(target=consent_request, name="grant-first-consent")
    deleting = threading.Thread(target=delete_request, name="grant-first-delete")
    consenting.start()
    overlap_proven = False
    consent_lock_ready = False
    delete_started_ok = False
    try:
        consent_lock_ready = consent_lock_acquired.wait(timeout=10)
        if consent_lock_ready:
            deleting.start()
            delete_started_ok = delete_started.wait(timeout=10)
            if delete_started_ok:
                overlap_proven = _wait_until_blocked(
                    results["delete_pid"], results["consent_pid"], timeout=10,
                )
    finally:
        # Release only after Postgres confirms the delete is waiting on the
        # consent transaction's conflicting app-row lock.
        allow_consent_to_finish.set()

    consenting.join(timeout=20)
    if deleting.ident is not None:
        deleting.join(timeout=20)
    assert not consenting.is_alive() and not deleting.is_alive(), "race workers did not finish"
    assert consent_lock_ready, "consent did not acquire the app-row lock"
    assert delete_started_ok, "delete request did not start"
    assert overlap_proven, "delete never waited on the consent-held app lock"
    assert "consent_exception" not in results, results.get("consent_exception")
    assert "delete_exception" not in results, results.get("delete_exception")
    assert results["consent"].status_code == 200, results["consent"].content
    assert results["delete"].status_code == 409, results["delete"].content
    assert results["delete"].json()["code"] == "app_has_authorizations"
    assert AppAuthorization.objects.filter(user=user, application=web_app).exists()
    assert F2ZApplication.objects.filter(pk=web_app.pk).exists()


def test_account_deletion_serializes_before_consent_for_a_self_owned_app(
    user, monkeypatch,
):
    app = F2ZApplication.objects.create(
        name="Self-owned app", user=user, client_type=F2ZApplication.CLIENT_PUBLIC,
        redirect_uris=WEB_REDIRECT, allowed_scopes="openid profile",
    )
    flow = Flow(_client(user), user, app, redirect_uri=WEB_REDIRECT, scope="openid profile")
    evaluated = flow.evaluate().json()

    creator_locked = threading.Event()
    allow_account_deletion = threading.Event()
    consent_user_lock_attempted = threading.Event()
    results = {}
    original_delete_apps = account_deletion._delete_unused_apps
    original_user_lock = consent._lock_user_for_consent

    def pause_after_creator_lock(creator, report):
        # delete_account has already taken Creator FOR UPDATE before entering
        # _purge_locked; pause before it takes the self-owned app's row lock.
        creator_locked.set()
        assert allow_account_deletion.wait(timeout=15), "test did not release account deletion"
        return original_delete_apps(creator, report)

    def observe_consent_user_lock(consenting_user):
        results["consent_pid"] = _backend_pid()
        consent_user_lock_attempted.set()
        return original_user_lock(consenting_user)

    monkeypatch.setattr(account_deletion, "_delete_unused_apps", pause_after_creator_lock)
    monkeypatch.setattr(consent, "_lock_user_for_consent", observe_consent_user_lock)

    user_pk, username, auth_epoch = user.pk, user.username, user.kt_account_epoch

    def delete_account():
        try:
            results["delete_pid"] = _backend_pid()
            results["deletion"] = account_deletion.delete_account(
                SimpleNamespace(pk=user_pk), confirm_username=username, auth_epoch=auth_epoch,
            )
        except BaseException as exc:
            results["deletion_exception"] = exc
        finally:
            connection.close()

    def grant_consent():
        try:
            results["consent"] = _client(user).post(
                "/api/oauth/authorize", _decision(flow, evaluated), format="json",
            )
        except BaseException as exc:
            results["consent_exception"] = exc
        finally:
            connection.close()

    deleting = threading.Thread(target=delete_account, name="account-delete-self-owned-app")
    consenting = threading.Thread(target=grant_consent, name="consent-self-owned-app")
    deleting.start()
    deletion_paused = False
    consent_lock_attempted = False
    overlap_proven = False
    try:
        deletion_paused = creator_locked.wait(timeout=10)
        if deletion_paused:
            consenting.start()
            consent_lock_attempted = consent_user_lock_attempted.wait(timeout=10)
            if consent_lock_attempted:
                overlap_proven = _wait_until_blocked(
                    results["consent_pid"], results["delete_pid"], timeout=10,
                )
    finally:
        # The deleter owns Creator FOR UPDATE. Consent must wait there before
        # it can lock the self-owned application, avoiding an app -> Creator
        # cycle at its deferred FK check.
        allow_account_deletion.set()

    deleting.join(timeout=30)
    if consenting.ident is not None:
        consenting.join(timeout=30)
    assert not deleting.is_alive() and not consenting.is_alive(), "account deletion race did not finish"
    assert deletion_paused, "account deletion did not lock the Creator row"
    assert consent_lock_attempted, "consent did not reach its Creator lock"
    assert overlap_proven, "consent never waited on account deletion's Creator lock"
    assert "deletion_exception" not in results, results.get("deletion_exception")
    assert "consent_exception" not in results, results.get("consent_exception")
    assert results["consent"].status_code == 409, results["consent"].content
    assert results["consent"].json()["code"] == "account_unavailable"
    assert not AppAuthorization.objects.filter(user_id=user.pk, application_id=app.pk).exists()
    assert not F2ZApplication.objects.filter(pk=app.pk).exists()
    user.refresh_from_db()
    assert not user.is_active
