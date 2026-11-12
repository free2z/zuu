"""Regression tests: password-reset must not leak which emails have accounts.

``RequestResetPasswordView`` used to answer a distinguishable 404 ("Email not
confirmed") for an unknown/unconfirmed address and a 406 for a throttled send,
both of which let an attacker enumerate registered emails. The response must now
be byte-identical whether or not the address is registered and confirmed.
"""
from datetime import timedelta

import pytest
from django.core.cache import cache
from django.db import connection
from django.http import HttpResponse
from django.test import RequestFactory
from django.utils import timezone

from dj.apps.emails.models import Email, OptOutEmail
from dj.util.middleware import AtomicMiddleware


@pytest.fixture(autouse=True)
def _clear_cache():
    cache.clear()
    yield
    cache.clear()


def _make_email(user, address, *, confirmed):
    return Email.objects.create(
        user=user,
        email=address,
        token="tok-" + address,
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now() if confirmed else None,
    )


@pytest.mark.django_db
def test_unknown_and_known_emails_are_indistinguishable(api_client, creator_factory):
    confirmed_user = creator_factory()
    _make_email(confirmed_user, "confirmed@example.com", confirmed=True)

    known = api_client.post(
        "/api/emails/reset-password", {"email": "confirmed@example.com"}, format="json"
    )
    unknown = api_client.post(
        "/api/emails/reset-password", {"email": "nobody@example.com"}, format="json"
    )

    assert known.status_code == 200, known.content
    assert unknown.status_code == known.status_code
    assert unknown.json() == known.json()


@pytest.mark.django_db
def test_opted_out_reset_response_matches_known_and_unknown(api_client, creator_factory):
    _make_email(creator_factory(), "normal@example.com", confirmed=True)
    _make_email(creator_factory(), "opted-out@example.com", confirmed=True)
    OptOutEmail.objects.create(email="opted-out@example.com")
    responses = [
        api_client.post("/api/emails/reset-password", {"email": address}, format="json")
        for address in ("normal@example.com", "opted-out@example.com", "unknown@example.com")
    ]
    assert all(response.status_code == 200 for response in responses)
    assert len({response.content for response in responses}) == 1


@pytest.mark.django_db
def test_unconfirmed_email_matches_confirmed_response(api_client, creator_factory):
    confirmed_user = creator_factory()
    unconfirmed_user = creator_factory()
    _make_email(confirmed_user, "confirmed@example.com", confirmed=True)
    _make_email(unconfirmed_user, "pending@example.com", confirmed=False)

    confirmed = api_client.post(
        "/api/emails/reset-password", {"email": "confirmed@example.com"}, format="json"
    )
    unconfirmed = api_client.post(
        "/api/emails/reset-password", {"email": "pending@example.com"}, format="json"
    )

    assert unconfirmed.status_code == confirmed.status_code == 200
    assert unconfirmed.json() == confirmed.json()


@pytest.mark.django_db
def test_send_failure_does_not_leak_via_500(api_client, creator_factory, mocker):
    """If the (synchronous) send raises, a registered address must still get the
    same generic 200 — otherwise the exception 500s only for real accounts and
    re-opens the enumeration oracle (codex finding)."""
    confirmed_user = creator_factory()
    _make_email(confirmed_user, "confirmed@example.com", confirmed=True)
    mocker.patch(
        "dj.apps.emails.views.send_password_reset_email",
        side_effect=RuntimeError("SMTP down"),
    )

    known = api_client.post(
        "/api/emails/reset-password", {"email": "confirmed@example.com"}, format="json"
    )
    unknown = api_client.post(
        "/api/emails/reset-password", {"email": "nobody@example.com"}, format="json"
    )

    assert known.status_code == 200, known.content
    assert unknown.status_code == known.status_code
    assert unknown.json() == known.json()


@pytest.mark.django_db
def test_missing_email_param_still_400(api_client):
    response = api_client.post("/api/emails/reset-password", {}, format="json")
    assert response.status_code == 400, response.content


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("path", [
    "/api/emails/reset-password",
    "/api/emails/resend",
    "/api/emails/add",
])
def test_email_delivery_commits_outside_request_wide_transaction(path):
    states = []
    middleware = AtomicMiddleware(
        lambda request: states.append(connection.in_atomic_block)
        or HttpResponse(),
    )

    middleware(RequestFactory().post(path))

    assert states == [False]


@pytest.mark.django_db
def test_unknown_and_suppressed_also_run_one_worker_start(api_client, creator_factory, mocker):
    from dj.apps.emails import views

    _make_email(creator_factory(), 'blocked@example.com', confirmed=True)
    OptOutEmail.objects.create(email='blocked@example.com')
    worker = mocker.patch.object(views, '_bounded_recovery_send', return_value=1)
    for address in ('missing@example.com', 'blocked@example.com'):
        worker.reset_mock()
        response = api_client.post('/api/emails/reset-password', {'email': address}, format='json')
        assert response.status_code == 200
        worker.assert_called_once_with(None)


@pytest.mark.django_db
def test_normal_reset_runs_only_one_worker(api_client, creator_factory, mocker):
    from dj.apps.emails import views

    _make_email(creator_factory(), 'normal-worker@example.com', confirmed=True)

    def worker(message):
        if message is not None:
            views._recovery_provider_started.set(True)
        return 1

    send = mocker.patch.object(views, '_bounded_recovery_send', side_effect=worker)
    response = api_client.post(
        '/api/emails/reset-password', {'email': 'normal-worker@example.com'}, format='json',
    )
    assert response.status_code == 200
    assert send.call_count == 1
    assert send.call_args.args[0] is not None


@pytest.mark.django_db
def test_unknown_reset_does_not_skip_the_lock_wait_timing_budget(api_client, mocker):
    import time

    mocker.patch('dj.apps.emails.views._bounded_recovery_send', return_value=1)
    before = time.monotonic()
    response = api_client.post(
        '/api/emails/reset-password', {'email': 'unknown@example.com'}, format='json',
    )
    assert response.status_code == 200
    assert 1.9 <= time.monotonic() - before < 5
