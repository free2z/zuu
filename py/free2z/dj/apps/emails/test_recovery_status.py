"""``/api/emails/recovery-status`` and the flow it points at.

Two things are under test here, and the second matters more than the first.

**The endpoint** must answer, for the caller and nobody else, whether the
account has a working way back in -- where "working" means a confirmed address
that ``/api/emails/reset-password`` would really mail, which excludes one on
the opt-out list because ``send_password_reset_email`` returns early for those.

**The flow** -- ``add`` -> ``confirm`` -> ``change-password`` -- must actually
carry an account from "no password, no email, X was the only door" to
``can_recover: true`` **and an actually-delivered reset mail**. That end-to-end
proof is the point of the issue: the backend capability was believed to exist
already, and "believed to exist" is how  happened. ``test_the_whole_flow``
below is the one test that would have been red before this work if the
capability had in fact been missing, so it is what makes the claim in the PR
body checkable rather than asserted.
"""
import json
from datetime import timedelta
from io import StringIO

import pytest
from django.core import mail
from django.core.cache import cache
from django.core.management import call_command
from django.utils import timezone

from dj.apps.emails.models import Email, OptOutEmail, PasswordResetToken
from dj.apps.ktauth.epoch import EVENT_PASSWORD_CHANGE, bump_account_epoch
from dj.apps.otp.models import OTPSecret
from dj.apps.otp.utils import has_active_totp


@pytest.fixture(autouse=True)
def _clear_cache():
    cache.clear()
    yield
    cache.clear()


URL = "/api/emails/recovery-status"


def _make_email(user, address, *, confirmed, expired=False, token_epoch=None):
    return Email.objects.create(
        user=user,
        email=address,
        token="tok-" + address,
        expires_at=(
            timezone.now() - timedelta(hours=1) if expired
            else timezone.now() + timedelta(hours=1)
        ),
        confirmed_at=timezone.now() if confirmed else None,
        # None means "stamp it at the account's current epoch", which is what
        # `Email.save()` does and what a freshly issued link carries.
        token_epoch=token_epoch,
    )


def _passwordless(creator_factory):
    """An account whose only door is a linked social identity -- the 137."""
    user = creator_factory()
    user.set_unusable_password()
    user.save(update_fields=["password", "password_set", "updated_at"])
    return user


# ---------------------------------------------------------------------------
# The classification
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_no_email_no_password_is_no_credentials(api_client, creator_factory):
    user = _passwordless(creator_factory)
    api_client.force_authenticate(user=user)

    body = api_client.get(URL).json()

    assert body["can_recover"] is False
    assert body["risk"] == "no_credentials"
    assert body["next_step"] == "add_email"
    assert body["password_set"] is False
    assert body["email_on_file"] is False
    assert body["email_confirmed"] is False
    assert body["email_pending"] is False
    assert body["email_suppressed"] is False


@pytest.mark.django_db
def test_password_without_an_address_is_still_unrecoverable(
    api_client, creator_factory
):
    """A password is a door, not a recovery method.

    This is the 1,676-account majority. They can sign in today and are one
    forgotten password away from the same permanent lockout as the 137.
    """
    user = creator_factory()
    api_client.force_authenticate(user=user)

    body = api_client.get(URL).json()

    assert body["password_set"] is True
    assert body["can_recover"] is False
    assert body["risk"] == "no_recovery"
    assert body["next_step"] == "add_email"


@pytest.mark.django_db
def test_confirmed_address_alone_is_recovery_even_without_a_password(
    api_client, creator_factory
):
    """``ResetPasswordAPIView`` SETS a password, so it needs none first."""
    user = _passwordless(creator_factory)
    _make_email(user, "back@example.com", confirmed=True)
    api_client.force_authenticate(user=user)

    body = api_client.get(URL).json()

    assert body["can_recover"] is True
    assert body["risk"] == "none"
    assert body["next_step"] is None
    assert body["password_set"] is False


@pytest.mark.django_db
def test_unconfirmed_address_asks_for_a_safe_resend_not_another_address(
    api_client, creator_factory
):
    user = creator_factory()
    _make_email(user, "pending@example.com", confirmed=False)
    api_client.force_authenticate(user=user)

    body = api_client.get(URL).json()

    assert body["email_pending"] is True
    assert body["can_recover"] is False
    assert body["next_step"] == "resend_email"


@pytest.mark.django_db
def test_empty_token_does_not_disclose_delivery_state(
    api_client, creator_factory,
):
    user = creator_factory()
    email = _make_email(user, "not-sent@example.com", confirmed=False)
    api_client.force_authenticate(user=user)

    control = api_client.get(URL).json()
    control_settings = api_client.get("/api/emails/status").json()
    assert control["email_pending"] is True, "control"
    assert control["next_step"] == "resend_email"
    Email.objects.filter(pk=email.pk).update(token="")

    recovery = api_client.get(URL).json()
    settings_status = api_client.get("/api/emails/status").json()
    assert recovery["email_pending"] is True
    assert recovery["email_on_file"] is True
    assert recovery["next_step"] == "resend_email"
    assert recovery["email_pending"] == control["email_pending"]
    assert settings_status["pending"] is True
    assert settings_status["pending"] == control_settings["pending"]

    detail_output = StringIO()
    call_command(
        "recovery_census", "--json", "--username", user.username,
        stdout=detail_output,
    )
    assert json.loads(detail_output.getvalue())["email_pending"] is True
    summary_output = StringIO()
    call_command("recovery_census", "--json", stdout=summary_output)
    assert json.loads(summary_output.getvalue())["recovery"]["unconfirmed_address"] == 1


@pytest.mark.django_db
def test_an_expired_link_asks_for_a_resend_not_a_retype(
    api_client, creator_factory
):
    """We still have the address; only the link died."""
    user = creator_factory()
    _make_email(user, "stale@example.com", confirmed=False, expired=True)
    api_client.force_authenticate(user=user)

    body = api_client.get(URL).json()

    assert body["email_on_file"] is True
    assert body["email_pending"] is True
    assert body["next_step"] == "resend_email"


@pytest.mark.django_db
def test_a_revoked_link_still_needs_user_action_without_disclosing_admission(
    api_client, creator_factory
):
    """, and the dead end the codex adversarial review caught.

    ``ConfirmEmailView`` filters on ``token_epoch=F('user__kt_account_epoch')``,
    so a confirmation minted before a password change is refused even though
    its ``expires_at`` still has hours on it. Recovery status therefore points
    to a safe resend for every unconfirmed address, without exposing whether a
    link is live to another account that shares the mailbox.
    """
    user = creator_factory()
    email = _make_email(user, "revoked@example.com", confirmed=False)
    assert email.token_epoch == user.kt_account_epoch, "control: link is live"

    api_client.force_authenticate(user=user)
    assert api_client.get(URL).json()["next_step"] == "resend_email"

    # The ownership event: a password change bumps kt_account_epoch and the
    # stamp on the outstanding link goes stale.
    bump_account_epoch(user.pk, event=EVENT_PASSWORD_CHANGE)
    user.refresh_from_db()
    api_client.force_authenticate(user=user)

    body = api_client.get(URL).json()
    assert body["email_on_file"] is True
    assert body["email_pending"] is True
    assert body["next_step"] == "resend_email"

    # Negative control: the existing link really is refused.
    confirm = api_client.post(
        "/api/emails/confirm", {"token": email.token}, format="json"
    )
    assert confirm.status_code == 404
    assert Email.objects.get(pk=email.pk).confirmed_at is None


@pytest.mark.django_db
def test_an_enrolled_factor_is_reported_beside_can_recover(
    api_client, creator_factory
):
    """``can_recover`` is necessary, not sufficient, for an MFA account.

    ``ResetPasswordAPIView._verify_reset_totp`` demands a current code, so a
    user who lost their authenticator receives the reset mail and cannot
    redeem it. ``risk: none`` alone would read as "you are fine".
    """
    user = creator_factory()
    _make_email(user, "mfa@example.com", confirmed=True)
    api_client.force_authenticate(user=user)

    assert api_client.get(URL).json()["mfa_required"] is False, "control"

    OTPSecret.objects.create(user=user, secret="JBSWY3DPEHPK3PXP", is_active=True)

    body = api_client.get(URL).json()
    assert body["mfa_required"] is True
    # Still true: the link really would be delivered. The point is that the
    # client must not present that as the whole story.
    assert body["can_recover"] is True
    assert has_active_totp(user) is True, "the predicate the reset view uses"


@pytest.mark.django_db
def test_the_runbook_3d_handover_request_is_the_one_that_works(
    api_client, creator_factory
):
    """§3b leaves a USABLE password, so §2 step 3's request no longer applies.

    Round 3 caught the runbook telling a rescued user to finish with "only
    ``new_password``" --- correct for an account whose hash is unusable, and a
    400 after a support handover. Net effect: the support-known temporary
    password stays in place, which is the one outcome §3d exists to prevent.
    Both halves are pinned here because the runbook is executable procedure.
    """
    user = creator_factory()
    # Exactly the state `manage.py changepassword` leaves behind.
    user.set_password("temporary-handover-password-1")
    user.save(update_fields=["password", "password_set", "updated_at"])
    api_client.force_authenticate(user=user)

    without_old = api_client.post(
        "/api/emails/change-password",
        {"new_password": "the-users-own-passphrase-77"},
        format="json",
    )
    assert without_old.status_code == 400, "the §2 step 3 form of the request"
    assert "old_password" in without_old.json()

    with_old = api_client.post(
        "/api/emails/change-password",
        {
            "old_password": "temporary-handover-password-1",
            "new_password": "the-users-own-passphrase-77",
        },
        format="json",
    )
    assert with_old.status_code == 200, with_old.content
    user.refresh_from_db()
    assert user.check_password("the-users-own-passphrase-77")
    assert not user.check_password("temporary-handover-password-1")


@pytest.mark.django_db
def test_an_inactive_factor_does_not_count(api_client, creator_factory):
    """Negative control: ``is_active=False`` is an abandoned enrolment."""
    user = creator_factory()
    _make_email(user, "mfa2@example.com", confirmed=True)
    OTPSecret.objects.create(
        user=user, secret="JBSWY3DPEHPK3PXP", is_active=False,
    )
    api_client.force_authenticate(user=user)

    assert api_client.get(URL).json()["mfa_required"] is False


@pytest.mark.django_db
def test_the_get_does_not_delete_an_expired_row(api_client, creator_factory):
    """Unlike ``/api/emails/status``, which DELETEs from a GET.

    Support reads this endpoint's answer while diagnosing an account; a
    diagnostic that mutates the thing it is diagnosing is how a support
    session destroys the evidence.
    """
    user = creator_factory()
    _make_email(user, "stale@example.com", confirmed=False, expired=True)
    api_client.force_authenticate(user=user)

    api_client.get(URL)

    assert Email.objects.filter(user=user).exists()


# ---------------------------------------------------------------------------
# The opt-out trap: a 201 that sends nothing, forever
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_a_suppressed_address_is_not_recovery(api_client, creator_factory):
    user = creator_factory()
    _make_email(user, "gone@example.com", confirmed=True)
    OptOutEmail.objects.create(email="gone@example.com")
    api_client.force_authenticate(user=user)

    body = api_client.get(URL).json()

    assert body["email_confirmed"] is True
    assert body["email_suppressed"] is True
    # Confirmed, and still no way back: send_password_reset_email returns
    # early for an opted-out address without sending anything.
    assert body["can_recover"] is False
    assert body["next_step"] == "replace_email"


@pytest.mark.django_db
def test_a_suppressed_unconfirmed_address_is_not_pending_anywhere(
    api_client, creator_factory
):
    """All THREE views of the same account must say the same thing.

    Round 5: the endpoint's ``email_pending`` did not exclude suppression
    while ``recovery_census``'s summary bucket and its ``--username`` detail
    both did, so support and the account holder got different diagnoses for
    one account -- exactly what the runbook promises cannot happen.
    """
    user = creator_factory()
    _make_email(user, "sup@example.com", confirmed=False)
    api_client.force_authenticate(user=user)

    assert api_client.get(URL).json()["email_pending"] is True, "control"

    OptOutEmail.objects.create(email="sup@example.com")

    body = api_client.get(URL).json()
    assert body["email_pending"] is False
    assert body["email_suppressed"] is True
    assert body["next_step"] == "replace_email"

    out = StringIO()
    call_command(
        "recovery_census", "--json", "--username", user.username, stdout=out
    )
    detail = json.loads(out.getvalue())
    summary = StringIO()
    call_command("recovery_census", "--json", stdout=summary)
    counts = json.loads(summary.getvalue())["recovery"]

    assert detail["email_pending"] == body["email_pending"]
    assert counts["unconfirmed_address"] == 0
    assert counts["suppressed_address"] == 1


@pytest.mark.django_db
def test_the_suppression_the_endpoint_reports_is_real(
    api_client, creator_factory, settings
):
    """Negative control for the flag above: prove the mail really is dropped.

    Without this the ``email_suppressed`` assertions would be a test of a
    boolean we set ourselves. Here the reset is requested for real and the
    outbox is what answers.
    """
    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    user = creator_factory()
    _make_email(user, "gone@example.com", confirmed=True)

    mail.outbox.clear()
    api_client.post(
        "/api/emails/reset-password", {"email": "gone@example.com"},
        format="json",
    )
    assert len(mail.outbox) == 1, "control: a confirmed address gets mail"

    OptOutEmail.objects.create(email="gone@example.com")
    mail.outbox.clear()
    response = api_client.post(
        "/api/emails/reset-password", {"email": "gone@example.com"},
        format="json",
    )

    # The generic 200 is unchanged -- that is the anti-enumeration contract --
    # and nothing was sent. Exactly the silence  is about.
    assert response.status_code == 200
    assert mail.outbox == []


# ---------------------------------------------------------------------------
# The password flag is a cache, and it lies
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_the_stored_hash_wins_over_the_password_set_flag(
    api_client, creator_factory, recent_login):
    """g12f migration 0081 backfilled ``password_set`` only for ``password=''``.

    An account made unusable before that column existed still reads
    ``password_set=True`` over a ``!`` hash. ``/api/emails/password-is-set``
    reports the flag and therefore tells such a user they have a password,
    while ``ChangePasswordSerializer`` branches on the hash and waives
    ``old_password``. This endpoint must agree with the serializer, because it
    is the serializer that decides whether the recovery flow can proceed.
    """
    user = creator_factory()
    user.set_unusable_password()
    # The exact legacy shape: hash unusable, flag never updated.
    user.password_set = True
    user.save(update_fields=["password", "password_set", "updated_at"])
    api_client.force_authenticate(user=user)
    recent_login(api_client, user)

    assert api_client.get("/api/emails/password-is-set").json() == {
        "password_set": True
    }, "control: the old endpoint still reports the stale flag"

    assert api_client.get(URL).json()["password_set"] is False
    # And the serializer agrees with us, not with the flag: no old_password.
    assert api_client.post(
        "/api/emails/change-password",
        {"new_password": "a-perfectly-fine-passphrase-42"},
        format="json",
    ).status_code == 200


# ---------------------------------------------------------------------------
# Anti-enumeration
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_anonymous_callers_are_refused(api_client):
    assert api_client.get(URL).status_code in (401, 403)


@pytest.mark.django_db
def test_request_input_cannot_redirect_it_at_another_account(
    api_client, creator_factory
):
    """The endpoint reads no request input, so it cannot be pointed anywhere.

    An attacker's account and a victim's account differ in every field this
    endpoint reports; if any query parameter were honoured, the two responses
    below would differ.
    """
    victim = creator_factory()
    _make_email(victim, "victim@example.com", confirmed=True)
    attacker = _passwordless(creator_factory)
    api_client.force_authenticate(user=attacker)

    baseline = api_client.get(URL).json()
    for probe in (
        f"?username={victim.username}",
        "?email=victim@example.com",
        f"?user_id={victim.pk}",
        f"?user={victim.pk}",
        f"?id={victim.pk}",
    ):
        assert api_client.get(URL + probe).json() == baseline, probe

    assert baseline["can_recover"] is False


@pytest.mark.django_db
def test_it_never_returns_the_address_itself(api_client, creator_factory):
    """Booleans only.

    ``/api/emails/status`` returns the address for the settings screen and
    that is fine; keeping this payload address-free means the recovery prompt
    can be rendered in contexts that should not see it, and means a future
    loosening of who may call it leaks nothing new.
    """
    user = creator_factory()
    _make_email(user, "private@example.com", confirmed=True)
    api_client.force_authenticate(user=user)

    body = api_client.get(URL).json()

    assert "private@example.com" not in str(body)
    assert set(body) == {
        "can_recover", "mfa_required", "email_on_file", "email_confirmed",
        "email_pending", "email_suppressed", "password_set", "risk",
        "next_step",
    }


@pytest.mark.django_db
def test_the_generic_reset_200_is_untouched(api_client, creator_factory, caplog):
    """ must not become the PR that weakened the thing it complained about."""
    user = creator_factory()
    _make_email(user, "known@example.com", confirmed=True)

    known = api_client.post(
        "/api/emails/reset-password", {"email": "known@example.com"},
        format="json",
    )
    unknown = api_client.post(
        "/api/emails/reset-password", {"email": "nobody@example.com"},
        format="json",
    )

    assert known.status_code == unknown.status_code == 200
    assert known.json() == unknown.json()
    # The conversion signal counts only real, quota-approved send attempts;
    # unknown addresses remain indistinguishable and add no telemetry.
    assert caplog.text.count("password_reset_delivery_attempt") == 1
    assert caplog.text.count("password_reset_delivery_sent") == 1
    assert "known@example.com" not in caplog.text


@pytest.mark.django_db
def test_reset_attempt_metric_excludes_unconfirmed_and_opted_out_addresses(
    api_client, creator_factory, caplog,
):
    unconfirmed_user = creator_factory()
    _make_email(unconfirmed_user, "pending@example.com", confirmed=False)
    opted_out_user = creator_factory()
    _make_email(opted_out_user, "suppressed@example.com", confirmed=True)
    OptOutEmail.objects.create(email="suppressed@example.com")

    pending = api_client.post(
        "/api/emails/reset-password", {"email": "pending@example.com"},
        format="json",
    )
    suppressed = api_client.post(
        "/api/emails/reset-password", {"email": "suppressed@example.com"},
        format="json",
    )

    assert pending.status_code == suppressed.status_code == 200
    assert pending.json() == suppressed.json()
    assert "password_reset_delivery_attempt" not in caplog.text
    assert "password_reset_delivery_sent" not in caplog.text
    assert "pending@example.com" not in caplog.text
    assert "suppressed@example.com" not in caplog.text


@pytest.mark.django_db
def test_a_mail_backend_returning_zero_is_not_counted_as_sent(
    api_client, creator_factory, mocker, caplog,
):
    user = creator_factory()
    _make_email(user, "known@example.com", confirmed=True)
    message = mocker.Mock()
    message.send.return_value = 0
    mocker.patch("dj.apps.emails.views.EmailMultiAlternatives", return_value=message)

    response = api_client.post(
        "/api/emails/reset-password", {"email": "known@example.com"},
        format="json",
    )

    assert response.status_code == 200  # enumeration-safe response stays generic
    assert "password_reset_delivery_attempt" in caplog.text
    assert "password_reset_delivery_sent" not in caplog.text
    assert not PasswordResetToken.objects.filter(
        email__email="known@example.com", used=False,
    ).exists()


# ---------------------------------------------------------------------------
# The whole point: an X-only account establishing recovery, end to end
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_the_whole_flow(api_client, creator_factory, settings, recent_login):
    """No password, no email -> can_recover, with a real reset mail at the end.

    Every step uses an endpoint that already existed before. That is the
    finding: the capability was there and nothing ever pointed a user at it.
    """
    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    user = _passwordless(creator_factory)
    api_client.force_authenticate(user=user)
    recent_login(api_client, user)

    assert api_client.get(URL).json() == {
        "can_recover": False,
        "mfa_required": False,
        "email_on_file": False,
        "email_confirmed": False,
        "email_pending": False,
        "email_suppressed": False,
        "password_set": False,
        "risk": "no_credentials",
        "next_step": "add_email",
    }

    # 1. add_email -- and a confirmation link really goes out.
    mail.outbox.clear()
    added = api_client.post(
        "/api/emails/add", {"email": "rescue@example.com"}, format="json"
    )
    assert added.status_code == 201, added.content
    assert len(mail.outbox) == 1

    assert api_client.get(URL).json()["next_step"] == "resend_email"

    # 2. confirm_email, with the token from the row the link carries. This is
    #    a link landing, not a JSON route: it answers 303 to the profile page.
    token = Email.objects.get(user=user).token
    confirmed = api_client.post(
        "/api/emails/confirm", {"token": token}, format="json"
    )
    assert confirmed.status_code == 303, confirmed.content
    assert Email.objects.get(user=user).confirmed_at is not None

    body = api_client.get(URL).json()
    assert body["can_recover"] is True
    assert body["risk"] == "none"
    assert body["next_step"] is None

    # 3. set a password with no old one -- the account never had one.
    changed = api_client.post(
        "/api/emails/change-password",
        {"new_password": "a-perfectly-fine-passphrase-42"},
        format="json",
    )
    assert changed.status_code == 200, changed.content
    user.refresh_from_db()
    assert user.has_usable_password()

    # 4. and the door it all exists for now opens: an unauthenticated reset
    #    request really mails this account a link.
    api_client.force_authenticate(user=None)
    mail.outbox.clear()
    reset = api_client.post(
        "/api/emails/reset-password", {"email": "rescue@example.com"},
        format="json",
    )
    assert reset.status_code == 200
    assert len(mail.outbox) == 1
    assert mail.outbox[0].to == ["rescue@example.com"]

@pytest.mark.django_db
@pytest.mark.parametrize("invalidation", ["epoch", "expiry"])
@pytest.mark.parametrize("quota_full", [False, True])
def test_resend_status_does_not_reveal_shared_mailbox_admission(
    api_client, creator_factory, mocker, invalidation, quota_full,
):
    from dj.apps.emails.confirmation_limits import (
        ALLOWED, claim_confirmation_recipient,
    )

    user = creator_factory()
    email = _make_email(user, "mail.box+probe@gmail.com", confirmed=False)
    if invalidation == "epoch":
        bump_account_epoch(user.pk, event=EVENT_PASSWORD_CHANGE)
        user.refresh_from_db()
    else:
        Email.objects.filter(pk=email.pk).update(
            expires_at=timezone.now() - timedelta(minutes=1),
        )
    Email.objects.filter(pk=email.pk).update(
        updated_at=timezone.now() - timedelta(minutes=6),
    )
    email.refresh_from_db()
    old_credentials = (email.token, email.token_epoch, email.expires_at)
    if quota_full:
        for index in range(3):
            assert claim_confirmation_recipient(
                f"mailbox+victim{index}@googlemail.com", claim_id=f"victim-{index}",
            ) == ALLOWED
    send = mocker.patch("dj.apps.emails.views.send_confirmation_email", return_value=True)
    api_client.force_authenticate(user=user)

    response = api_client.post("/api/emails/resend")
    assert response.status_code == 204
    email.refresh_from_db()
    assert send.call_count == (0 if quota_full else 1)
    if quota_full:
        assert (email.token, email.token_epoch, email.expires_at) == old_credentials
    else:
        assert email.token != old_credentials[0]
    assert api_client.post(
        "/api/emails/confirm", {"token": old_credentials[0]}, format="json",
    ).status_code == 404

    recovery = api_client.get(URL).json()
    assert recovery["email_on_file"] is True
    assert recovery["email_pending"] is True
    assert recovery["email_confirmed"] is False
    assert recovery["can_recover"] is False
    assert recovery["next_step"] == "resend_email"
    status_response = api_client.get("/api/emails/status").json()
    assert status_response["email"] == email.email
    assert status_response["pending"] is True
    assert status_response["confirmed"] is False
    assert Email.objects.filter(pk=email.pk).exists()
    assert api_client.post("/api/emails/resend").status_code == 429
