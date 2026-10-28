"""Adding a recovery address answers the same way whatever the address is.

``POST /api/emails/add`` checks, in order: the caller's recent sign-in, then
the caller's own confirmation-attempt budget, and only then anything about the
requested address. Whether another account already holds that address, and
whether it is on the opt-out list, are facts about somebody else's mailbox; the
caller has proven control of nothing yet, so neither may change the status
code, the body, the budget consumed, or what ``recovery-status`` reports back.

An address another account added but never confirmed does not reserve it once
its confirmation window has closed: nobody proved control of the mailbox, and
the real owner must still be able to add it.
"""

from datetime import timedelta

import pytest
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.emails.confirmation_limits import (
    ALLOWED,
    USER_LIMITED,
    claim_confirmation_account_attempt,
)
from dj.apps.emails.models import Email, OptOutEmail, PasswordResetToken


ADD = "/api/emails/add"
RESEND = "/api/emails/resend"
RECOVERY = "/api/emails/recovery-status"


@pytest.fixture(autouse=True)
def _clear_cache():
    cache.clear()
    yield
    cache.clear()


def _client(user, recent_login=None):
    client = APIClient()
    client.force_authenticate(user=user)
    if recent_login is not None:
        recent_login(client, user)
    return client


def _bind(user, address, *, confirmed, expired=False):
    now = timezone.now()
    return Email.objects.create(
        user=user,
        email=address,
        token=f"token-{user.pk}",
        expires_at=now - timedelta(minutes=1) if expired else now + timedelta(hours=1),
        confirmed_at=now if confirmed else None,
    )


def _remaining_attempts(user):
    remaining = 0
    while claim_confirmation_account_attempt(user.pk) == ALLOWED:
        remaining += 1
        assert remaining <= 10
    return remaining


def _shape(response):
    """Status and body with the echoed request address factored out."""
    body = response.json() if response.content else None
    if isinstance(body, dict) and "email" in body and isinstance(body["email"], str):
        body = {**body, "email": "<requested>"}
    return response.status_code, body


@pytest.mark.django_db
@pytest.mark.parametrize("held_by_other", ["confirmed", "pending"])
def test_add_answers_identically_for_held_and_free_addresses(
    held_by_other, creator_factory, recent_login, mocker,
):
    mocker.patch("dj.apps.emails.views.send_confirmation_email", return_value=True)
    holder = creator_factory()
    _bind(holder, "held@example.com", confirmed=held_by_other == "confirmed")
    first = creator_factory()
    second = creator_factory()

    held = _client(first, recent_login).post(ADD, {"email": "held@example.com"}, format="json")
    free = _client(second, recent_login).post(ADD, {"email": "free@example.com"}, format="json")

    assert _shape(held) == _shape(free), (held.content, free.content)
    assert held.status_code == 201, held.content
    assert held.json()["email"] == "held@example.com"
    # Both requests cost exactly one attempt from the caller's own budget.
    assert _remaining_attempts(first) == _remaining_attempts(second) == 9


@pytest.mark.django_db
def test_add_requires_recent_sign_in_before_any_address_check(
    creator_factory, mocker,
):
    send = mocker.patch("dj.apps.emails.views.send_confirmation_email")
    _bind(creator_factory(), "held@example.com", confirmed=True)

    held = _client(creator_factory()).post(ADD, {"email": "held@example.com"}, format="json")
    free = _client(creator_factory()).post(ADD, {"email": "free@example.com"}, format="json")

    assert held.status_code == free.status_code == 401, (held.content, free.content)
    assert held.json() == free.json()
    send.assert_not_called()


@pytest.mark.django_db
def test_add_charges_the_account_budget_before_any_address_check(
    creator_factory, recent_login, mocker,
):
    send = mocker.patch("dj.apps.emails.views.send_confirmation_email")
    _bind(creator_factory(), "held@example.com", confirmed=True)
    first = creator_factory()
    second = creator_factory()
    for user in (first, second):
        while claim_confirmation_account_attempt(user.pk) != USER_LIMITED:
            pass

    held = _client(first, recent_login).post(ADD, {"email": "held@example.com"}, format="json")
    free = _client(second, recent_login).post(ADD, {"email": "free@example.com"}, format="json")

    assert held.status_code == free.status_code == 429, (held.content, free.content)
    assert held.json() == free.json()
    send.assert_not_called()


@pytest.mark.django_db
def test_an_address_another_account_confirmed_is_never_moved_or_mailed(
    creator_factory, recent_login, mocker,
):
    send = mocker.patch("dj.apps.emails.views.send_confirmation_email")
    holder = creator_factory()
    held = _bind(holder, "held@example.com", confirmed=True)
    held_before = Email.objects.filter(pk=held.pk).values().get()
    requester = creator_factory()
    previous = _bind(requester, "previous@example.com", confirmed=True)
    reset = PasswordResetToken.objects.create(email=previous)
    epoch_before = requester.kt_account_epoch

    response = _client(requester, recent_login).post(
        ADD, {"email": "held@example.com"}, format="json",
    )

    assert response.status_code == 201, response.content
    assert Email.objects.filter(pk=held.pk).values().get() == held_before
    send.assert_not_called()
    # The request still replaces the caller's previous recovery address, as a
    # change always does: the old principal must not survive a change request
    # because of who holds the new address.
    requester.refresh_from_db()
    assert not Email.objects.filter(pk=previous.pk).exists()
    assert not PasswordResetToken.objects.filter(pk=reset.pk).exists()
    assert requester.kt_account_epoch == epoch_before + 1


@pytest.mark.django_db
def test_an_expired_unconfirmed_binding_does_not_reserve_the_address(
    creator_factory, recent_login, mocker,
):
    send = mocker.patch("dj.apps.emails.views.send_confirmation_email", return_value=True)
    stale = _bind(creator_factory(), "mine@example.com", confirmed=False, expired=True)
    owner = creator_factory()

    response = _client(owner, recent_login).post(ADD, {"email": "mine@example.com"}, format="json")

    assert response.status_code == 201, response.content
    assert not Email.objects.filter(pk=stale.pk).exists()
    bound = Email.objects.get(user=owner)
    assert bound.email == "mine@example.com"
    assert bound.confirmed_at is None
    assert bound.token
    send.assert_called_once()


@pytest.mark.django_db
def test_a_live_unconfirmed_binding_elsewhere_is_left_alone(
    creator_factory, recent_login, mocker,
):
    send = mocker.patch("dj.apps.emails.views.send_confirmation_email")
    live = _bind(creator_factory(), "mine@example.com", confirmed=False)
    before = Email.objects.filter(pk=live.pk).values().get()
    requester = creator_factory()

    response = _client(requester, recent_login).post(
        ADD, {"email": "mine@example.com"}, format="json",
    )

    assert response.status_code == 201, response.content
    assert Email.objects.filter(pk=live.pk).values().get() == before
    assert not Email.objects.filter(user=requester).exists()
    send.assert_not_called()


@pytest.mark.django_db
def test_re_adding_the_callers_own_confirmed_address_changes_nothing(
    creator_factory, recent_login, mocker,
):
    send = mocker.patch("dj.apps.emails.views.send_confirmation_email")
    user = creator_factory()
    own = _bind(user, "own@example.com", confirmed=True)
    before = Email.objects.filter(pk=own.pk).values().get()
    epoch_before = user.kt_account_epoch

    response = _client(user, recent_login).post(ADD, {"email": "own@example.com"}, format="json")

    user.refresh_from_db()
    assert response.status_code == 201, response.content
    assert Email.objects.filter(pk=own.pk).values().get() == before
    assert user.kt_account_epoch == epoch_before
    send.assert_not_called()


@pytest.mark.django_db
def test_recovery_status_is_identical_for_suppressed_and_clean_unconfirmed_addresses(
    creator_factory, recent_login, mocker,
):
    mocker.patch("dj.apps.emails.views.send_confirmation_email", return_value=True)
    OptOutEmail.objects.create(email="suppressed@example.com")
    first = creator_factory()
    second = creator_factory()
    first_client = _client(first, recent_login)
    second_client = _client(second, recent_login)

    assert first_client.post(ADD, {"email": "suppressed@example.com"}, format="json").status_code == 201
    assert second_client.post(ADD, {"email": "clean@example.com"}, format="json").status_code == 201

    suppressed = first_client.get(RECOVERY)
    clean = second_client.get(RECOVERY)
    assert suppressed.status_code == clean.status_code == 200
    assert suppressed.json() == clean.json()
    assert clean.json()["email_suppressed"] is False
    assert clean.json()["next_step"] == "resend_email"

    # And the follow-up the status recommends answers the same way too.
    Email.objects.filter(user__in=[first, second]).update(
        updated_at=timezone.now() - timedelta(minutes=10),
    )
    assert _shape(first_client.post(RESEND, {}, format="json")) == _shape(
        second_client.post(RESEND, {}, format="json")
    )


@pytest.mark.django_db
def test_recovery_status_still_reports_suppression_of_a_confirmed_address(
    api_client, creator_factory,
):
    user = creator_factory()
    _bind(user, "gone@example.com", confirmed=True)
    OptOutEmail.objects.create(email="gone@example.com")
    api_client.force_authenticate(user=user)

    body = api_client.get(RECOVERY).json()

    assert body["email_suppressed"] is True
    assert body["can_recover"] is False
    assert body["next_step"] == "replace_email"
