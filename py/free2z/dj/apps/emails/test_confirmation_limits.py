"""Confirmation mail quotas bound accounts and recipients."""

from datetime import timedelta

import pytest
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.emails.confirmation_limits import (
    ALLOWED,
    RECIPIENT_LIMITED,
    ConfirmationMailAdmissionUnavailable,
    claim_confirmation_account_attempt,
    claim_confirmation_recipient,
)
from dj.apps.emails.models import Email, OptOutEmail, PasswordResetToken


@pytest.fixture(autouse=True)
def _clear_confirmation_limit_cache():
    cache.clear()
    yield
    cache.clear()


@pytest.mark.django_db
def test_add_email_account_limit_does_not_change_recovery_state(
    creator_factory, recent_login, mocker,
):
    user = creator_factory()
    client = APIClient()
    client.force_authenticate(user=user)
    recent_login(client, user)
    send = mocker.patch("dj.apps.emails.views.send_confirmation_email")

    for index in range(10):
        response = client.post(
            "/api/emails/add",
            {"email": f"pending-{index}@example.com"},
            format="json",
        )
        assert response.status_code == 201, response.content

    email = Email.objects.get(user=user)
    before = {
        "email": email.email,
        "token": email.token,
        "expires_at": email.expires_at,
        "confirmed_at": email.confirmed_at,
        "token_epoch": email.token_epoch,
        "epoch": user.kt_account_epoch,
    }

    refused = client.post(
        "/api/emails/add", {"email": "eleventh@example.com"}, format="json"
    )

    email.refresh_from_db()
    user.refresh_from_db()
    assert refused.status_code == 429, refused.content
    assert {
        "email": email.email,
        "token": email.token,
        "expires_at": email.expires_at,
        "confirmed_at": email.confirmed_at,
        "token_epoch": email.token_epoch,
        "epoch": user.kt_account_epoch,
    } == before
    assert send.call_count == 10


@pytest.mark.django_db
def test_add_email_account_limit_cannot_preserve_a_confirmed_recovery_principal(
    creator_factory, recent_login, mocker,
):
    user = creator_factory()
    user.refresh_from_db()
    email = Email.objects.create(
        user=user,
        email="confirmed@example.com",
        token="confirmed-link-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )
    reset_token = PasswordResetToken.objects.create(email=email)
    for _ in range(10):
        assert claim_confirmation_account_attempt(user.pk) == ALLOWED

    client = APIClient()
    client.force_authenticate(user=user)
    recent_login(client, user)
    send = mocker.patch("dj.apps.emails.views.send_confirmation_email")
    before_epoch = user.kt_account_epoch

    response = client.post(
        "/api/emails/add", {"email": "replacement@example.com"}, format="json"
    )

    email.refresh_from_db()
    user.refresh_from_db()
    reset_token.refresh_from_db()
    assert response.status_code == 201, response.content
    assert email.email == "replacement@example.com"
    assert email.token == ""
    assert email.confirmed_at is None
    assert email.expires_at > timezone.now()
    assert user.kt_account_epoch == before_epoch + 1
    assert reset_token.used is True
    send.assert_not_called()


@pytest.mark.parametrize("failed_admission", ["account", "recipient"])
@pytest.mark.django_db
def test_admission_store_failure_cannot_preserve_confirmed_recovery(
    failed_admission, creator_factory, recent_login, mocker,
):
    user = creator_factory()
    email = Email.objects.create(
        user=user,
        email="attacker@example.com",
        token="attacker-link",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )
    reset_token = PasswordResetToken.objects.create(email=email)
    epoch = user.kt_account_epoch
    client = APIClient()
    client.force_authenticate(user=user)
    recent_login(client, user)
    send = mocker.patch("dj.apps.emails.views.send_confirmation_email")
    claim = (
        "claim_confirmation_account_attempt"
        if failed_admission == "account"
        else "claim_confirmation_recipient"
    )
    mocker.patch(
        f"dj.apps.emails.views.{claim}",
        side_effect=ConfirmationMailAdmissionUnavailable(),
    )

    response = client.post(
        "/api/emails/add", {"email": "owner@example.com"}, format="json",
    )

    email.refresh_from_db()
    user.refresh_from_db()
    reset_token.refresh_from_db()
    assert response.status_code == 201, response.content
    assert email.email == "owner@example.com"
    assert email.token == ""
    assert email.confirmed_at is None
    assert reset_token.used is True
    assert user.kt_account_epoch == epoch + 1
    send.assert_not_called()


@pytest.mark.parametrize("target_outcome", ["allowed", "recipient_capped", "opted_out"])
@pytest.mark.django_db
def test_account_attempt_boundary_is_independent_of_target_outcome(
    target_outcome, creator_factory, recent_login, mocker,
):
    user = creator_factory()
    client = APIClient()
    client.force_authenticate(user=user)
    recent_login(client, user)
    send = mocker.patch("dj.apps.emails.views.send_confirmation_email")
    for _ in range(9):
        assert claim_confirmation_account_attempt(user.pk) == ALLOWED

    target = f"{target_outcome}@example.com"
    if target_outcome == "recipient_capped":
        for _ in range(3):
            assert claim_confirmation_recipient(target) == ALLOWED
        assert claim_confirmation_recipient(target) == RECIPIENT_LIMITED
    elif target_outcome == "opted_out":
        OptOutEmail.objects.create(email=target)

    tenth = client.post("/api/emails/add", {"email": target}, format="json")
    assert tenth.status_code == 201, tenth.content
    assert set(tenth.json()) == {"email", "confirmed_at"}
    assert tenth.json()["email"] == target
    assert send.call_count == (1 if target_outcome == "allowed" else 0)

    before_email = Email.objects.filter(user=user).values(
        "email", "token", "expires_at", "confirmed_at", "token_epoch"
    ).first()
    user.refresh_from_db()
    before_epoch = user.kt_account_epoch
    eleventh = client.post(
        "/api/emails/add",
        {"email": f"after-{target_outcome}@example.com"},
        format="json",
    )
    after_email = Email.objects.filter(user=user).values(
        "email", "token", "expires_at", "confirmed_at", "token_epoch"
    ).first()
    user.refresh_from_db()
    after_epoch = user.kt_account_epoch

    assert eleventh.status_code == 429, eleventh.content
    assert after_email == before_email
    assert after_epoch == before_epoch
    assert send.call_count == (1 if target_outcome == "allowed" else 0)


@pytest.mark.django_db
def test_add_opted_out_recipient_revokes_existing_recovery(
    creator_factory, recent_login, mocker,
):
    user = creator_factory()
    email = Email.objects.create(
        user=user,
        email="live@example.com",
        token="still-live-confirmation",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )
    OptOutEmail.objects.create(email="suppressed@example.com")
    reset_token = PasswordResetToken.objects.create(email=email)
    original_account_epoch = user.kt_account_epoch
    client = APIClient()
    client.force_authenticate(user=user)
    recent_login(client, user)
    send = mocker.patch("dj.apps.emails.views.send_confirmation_email")

    response = client.post(
        "/api/emails/add", {"email": "suppressed@example.com"}, format="json"
    )

    email.refresh_from_db()
    user.refresh_from_db()
    assert response.status_code == 201, response.content
    reset_token.refresh_from_db()
    assert email.email == "suppressed@example.com"
    assert email.token == ""
    assert email.expires_at > timezone.now()
    assert email.confirmed_at is None
    assert email.token_epoch == user.kt_account_epoch
    assert user.kt_account_epoch == original_account_epoch + 1
    assert reset_token.used is True
    send.assert_not_called()


@pytest.mark.django_db
def test_resend_suppression_does_not_rotate_a_live_token(creator_factory, mocker):
    user = creator_factory()
    email = Email.objects.create(
        user=user,
        email="suppressed@example.com",
        token="still-live-confirmation",
        expires_at=timezone.now() + timedelta(hours=1),
    )
    Email.objects.filter(pk=email.pk).update(
        updated_at=timezone.now() - timedelta(hours=1)
    )
    email.refresh_from_db()
    original_updated_at = email.updated_at
    OptOutEmail.objects.create(email=email.email)
    client = APIClient()
    client.force_authenticate(user=user)
    send = mocker.patch("dj.apps.emails.views.send_confirmation_email")

    response = client.post("/api/emails/resend", {}, format="json")

    email.refresh_from_db()
    assert response.status_code == 204
    assert email.token == "still-live-confirmation"
    assert email.updated_at > original_updated_at
    send.assert_not_called()

    retry = client.post("/api/emails/resend", {}, format="json")
    assert retry.status_code == 429, retry.content


@pytest.mark.django_db
def test_resend_account_limit_does_not_rotate_confirmation(
    creator_factory, mocker,
):
    user = creator_factory()
    email = Email.objects.create(
        user=user,
        email="resend@example.com",
        token="still-live-confirmation",
        expires_at=timezone.now() + timedelta(hours=1),
    )
    Email.objects.filter(pk=email.pk).update(
        updated_at=timezone.now() - timedelta(hours=1)
    )
    email.refresh_from_db()
    original_updated_at = email.updated_at
    for _ in range(10):
        assert claim_confirmation_account_attempt(user.pk) == ALLOWED

    client = APIClient()
    client.force_authenticate(user=user)
    send = mocker.patch("dj.apps.emails.views.send_confirmation_email")
    response = client.post("/api/emails/resend", {}, format="json")

    email.refresh_from_db()
    assert response.status_code == 429
    assert email.token == "still-live-confirmation"
    assert email.updated_at == original_updated_at
    send.assert_not_called()


@pytest.mark.django_db
def test_resend_recipient_limit_is_silent_and_does_not_rotate(
    creator_factory, mocker,
):
    user = creator_factory()
    email = Email.objects.create(
        user=user,
        email="resend-capped@example.com",
        token="still-live-confirmation",
        expires_at=timezone.now() + timedelta(hours=1),
    )
    Email.objects.filter(pk=email.pk).update(
        updated_at=timezone.now() - timedelta(hours=1)
    )
    email.refresh_from_db()
    original_updated_at = email.updated_at
    for _ in range(3):
        assert claim_confirmation_recipient(email.email) == ALLOWED

    client = APIClient()
    client.force_authenticate(user=user)
    send = mocker.patch("dj.apps.emails.views.send_confirmation_email")
    response = client.post("/api/emails/resend", {}, format="json")

    email.refresh_from_db()
    assert response.status_code == 204
    assert email.token == "still-live-confirmation"
    assert email.updated_at > original_updated_at
    send.assert_not_called()

    retry = client.post("/api/emails/resend", {}, format="json")
    assert retry.status_code == 429, retry.content


@pytest.mark.django_db
@pytest.mark.parametrize("outcome", ["allowed", "opted_out", "recipient_capped"])
def test_resend_cooldown_does_not_disclose_recipient_suppression(
    outcome, creator_factory, mocker,
):
    user = creator_factory()
    email = Email.objects.create(
        user=user, email="cooldown@example.com", token="existing-link",
        expires_at=timezone.now() + timedelta(hours=1),
    )
    Email.objects.filter(pk=email.pk).update(
        updated_at=timezone.now() - timedelta(hours=1))
    if outcome == "opted_out":
        OptOutEmail.objects.create(email=email.email)
    elif outcome == "recipient_capped":
        for _ in range(3):
            assert claim_confirmation_recipient(email.email) == ALLOWED
    send = mocker.patch("dj.apps.emails.views.send_confirmation_email")
    client = APIClient()
    client.force_authenticate(user=user)

    assert client.post("/api/emails/resend", {}, format="json").status_code == 204
    second = client.post("/api/emails/resend", {}, format="json")
    assert second.status_code == 429
    assert second.json() == {
        "detail": "Confirmation email recently sent. Please try again in a few minutes."
    }
    email.refresh_from_db()
    if outcome != "allowed":
        assert email.token == "existing-link"
        send.assert_not_called()
    else:
        send.assert_called_once()


@pytest.mark.django_db
def test_recipient_limit_is_silent_but_replaces_unconfirmed_email(
    creator_factory, recent_login, mocker,
):
    user = creator_factory()
    client = APIClient()
    client.force_authenticate(user=user)
    recent_login(client, user)
    send = mocker.patch("dj.apps.emails.views.send_confirmation_email")

    # Fill a recipient's shared budget as three independent account ids. The
    # current schema still enforces global uniqueness; the helper test above
    # directly verifies its cross-account behavior until that separate schema
    # change lands.
    for _ in range(3):
        assert claim_confirmation_recipient("target@example.com") == ALLOWED

    email = Email.objects.create(
        user=user,
        email="current@example.com",
        token="existing-token",
        expires_at=timezone.now() + timedelta(hours=1),
    )
    before_epoch = user.kt_account_epoch

    response = client.post(
        "/api/emails/add", {"email": "target@example.com"}, format="json"
    )

    email.refresh_from_db()
    user.refresh_from_db()
    assert response.status_code == 201, response.content
    assert response.json() == {
        "email": "target@example.com",
        "confirmed_at": None,
    }
    assert email.email == "target@example.com"
    assert email.token == ""
    assert email.expires_at > timezone.now()
    assert email.confirmed_at is None
    assert user.kt_account_epoch == before_epoch
    send.assert_not_called()


@pytest.mark.parametrize(
    "failure,expected",
    [
        (RuntimeError("provider rejected request"), ALLOWED),
        (TimeoutError("provider response was lost"), RECIPIENT_LIMITED),
    ],
)
@pytest.mark.parametrize("endpoint", ["add", "resend"])
@pytest.mark.django_db
def test_mail_endpoints_refund_only_definitively_failed_delivery_claims(
    failure, expected, endpoint, creator_factory, recent_login, mocker,
):
    user = creator_factory()
    if endpoint == "resend":
        email = Email.objects.create(
            user=user,
            email="mail-failure@example.com",
            token="existing-token",
            expires_at=timezone.now() + timedelta(hours=1),
        )
        Email.objects.filter(pk=email.pk).update(
            updated_at=timezone.now() - timedelta(hours=1),
        )
    client = APIClient()
    client.force_authenticate(user=user)
    if endpoint == "add":
        recent_login(client, user)
    for _ in range(2):
        assert claim_confirmation_recipient("mail-failure@example.com") == ALLOWED
    mocker.patch(
        "dj.apps.emails.views.send_confirmation_email", side_effect=failure,
    )

    with pytest.raises(type(failure)):
        if endpoint == "add":
            client.post(
                "/api/emails/add",
                {"email": "mail-failure@example.com"},
                format="json",
            )
        else:
            client.post("/api/emails/resend", {}, format="json")

    # The first result after the request distinguishes a refunded definite
    # refusal from an ambiguous timeout that may already have reached SendGrid.
    assert claim_confirmation_recipient("mail-failure@example.com") == expected


@pytest.mark.parametrize("endpoint", ["add", "resend"])
@pytest.mark.django_db
def test_database_rollback_releases_recipient_reservation(
    endpoint, creator_factory, recent_login, mocker,
):
    user = creator_factory()
    for _ in range(2):
        assert claim_confirmation_recipient("rollback@example.com") == ALLOWED
    if endpoint == "resend":
        email = Email.objects.create(
            user=user,
            email="rollback@example.com",
            token="existing-token",
            expires_at=timezone.now() + timedelta(hours=1),
        )
        Email.objects.filter(pk=email.pk).update(
            updated_at=timezone.now() - timedelta(hours=1),
        )
    client = APIClient()
    client.force_authenticate(user=user)
    if endpoint == "add":
        recent_login(client, user)
    mocker.patch.object(Email, "save", side_effect=RuntimeError("db write failed"))

    with pytest.raises(RuntimeError, match="db write failed"):
        if endpoint == "add":
            client.post(
                "/api/emails/add",
                {"email": "rollback@example.com"},
                format="json",
            )
        else:
            client.post("/api/emails/resend", {}, format="json")

    assert claim_confirmation_recipient("rollback@example.com") == ALLOWED


@pytest.mark.django_db
def test_an_address_held_elsewhere_is_charged_like_any_other(
    creator_factory, recent_login, mocker,
):
    """The caller's budget is spent before the address is looked at.

    An address another account holds costs the caller one attempt, exactly
    like a free one, and is neither mailed nor charged to the recipient's
    shared allowance -- nothing is sent to it.
    """
    owner = creator_factory()
    Email.objects.create(
        user=owner,
        email="already-owned@example.com",
        token="owner-confirmation-token",
        expires_at=timezone.now() + timedelta(hours=1),
    )
    submitter = creator_factory()
    client = APIClient()
    client.force_authenticate(user=submitter)
    recent_login(client, submitter)
    send = mocker.patch("dj.apps.emails.views.send_confirmation_email")

    response = client.post(
        "/api/emails/add",
        {"email": "already-owned@example.com"},
        format="json",
    )

    assert response.status_code == 201, response.content
    for _ in range(9):
        assert claim_confirmation_account_attempt(submitter.pk) == ALLOWED
    assert claim_confirmation_account_attempt(submitter.pk) != ALLOWED
    for _ in range(3):
        assert claim_confirmation_recipient("already-owned@example.com") == ALLOWED
    send.assert_not_called()


@pytest.mark.parametrize("suppression", ["recipient_capped", "opted_out"])
@pytest.mark.django_db
def test_unchanged_suppressed_add_preserves_confirmation(
    suppression, creator_factory, recent_login, mocker,
):
    user = creator_factory()
    email = Email.objects.create(
        user=user, email="same@example.com", token="current-link",
        expires_at=timezone.now() + timedelta(hours=1),
    )
    if suppression == "opted_out":
        OptOutEmail.objects.create(email=email.email)
    else:
        for _ in range(3):
            assert claim_confirmation_recipient(email.email) == ALLOWED
    before = (email.token, email.expires_at, email.updated_at, email.token_epoch)
    client = APIClient()
    client.force_authenticate(user=user)
    recent_login(client, user)
    send = mocker.patch("dj.apps.emails.views.send_confirmation_email")
    response = client.post("/api/emails/add", {"email": email.email}, format="json")
    email.refresh_from_db()
    # Re-adding the address already on file binds nothing new and sends
    # nothing; a fresh link is ResendEmailView's job.
    assert response.status_code == 201, response.content
    assert (email.token, email.expires_at, email.updated_at, email.token_epoch) == before
    send.assert_not_called()


@pytest.mark.django_db
def test_other_account_cannot_block_recovery_hijack_removal(
    creator_factory, recent_login, mocker,
):
    attacker = creator_factory()
    victim = creator_factory()
    old = Email.objects.create(
        user=victim, email="attacker@evil.example", token="attacker-old-link",
        expires_at=timezone.now() + timedelta(hours=1), confirmed_at=timezone.now(),
    )
    reset = PasswordResetToken.objects.create(email=old)
    before_epoch = victim.kt_account_epoch
    send = mocker.patch("dj.apps.emails.views.send_confirmation_email")
    hostile = APIClient()
    hostile.force_authenticate(user=attacker)
    recent_login(hostile, attacker)
    # Use the real Add endpoint and recipient limiter. Toggling frees the
    # globally unique email row while preserving the mailbox's shared quota.
    for _ in range(3):
        for address in ("owner@example.com", "junk@example.com"):
            response = hostile.post("/api/emails/add", {"email": address}, format="json")
            assert response.status_code == 201, response.content
    sent_before = send.call_count
    owner = APIClient()
    owner.force_authenticate(user=victim)
    recent_login(owner, victim)
    response = owner.post("/api/emails/add", {"email": "owner@example.com"}, format="json")
    assert response.status_code == 201, response.content
    old.refresh_from_db()
    reset.refresh_from_db()
    victim.refresh_from_db()
    assert old.email == "owner@example.com"
    assert old.confirmed_at is None
    assert old.token == ""
    assert old.expires_at > timezone.now()
    assert reset.used is True
    assert victim.kt_account_epoch == before_epoch + 1
    assert send.call_count == sent_before
    # Settings status must retain the unconfirmed replacement for later resend.
    status_response = owner.get("/api/emails/status")
    assert status_response.status_code == 200, status_response.content
    assert status_response.json()["pending"] is True
    recovery = owner.get("/api/emails/recovery-status").json()
    assert recovery["email_pending"] is True
    assert recovery["next_step"] == "resend_email"
    assert Email.objects.filter(pk=old.pk, email="owner@example.com").exists()
    anonymous = APIClient()
    for token in ("", "attacker-old-link"):
        confirm = anonymous.post("/api/emails/confirm", {"token": token})
        assert confirm.status_code in (400, 404), confirm.content
        opt_out = anonymous.post(
            "/api/emails/opt-out/owner@example.com", {"token": token},
        )
        assert opt_out.status_code == 404, opt_out.content
    old.refresh_from_db()
    assert old.confirmed_at is None
    assert not OptOutEmail.objects.filter(email="owner@example.com").exists()
