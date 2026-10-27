"""Re-authentication on the dj-rest-auth password-change route.

`POST /api/auth/password/change/` is the second live password-replacement
route (the SvelteKit UI uses /api/emails/change-password; this one is reached
by the classic client, ZUULI and third-party API clients, and the API is the
product). It was stock dj-rest-auth with `OLD_PASSWORD_FIELD_ENABLED` unset,
so a session alone replaced the password: no proof of the current password.

 made TOTP codes single-use, which killed the *replay* in. It did
not close the takeover chain, because these routes never asked for the current
password at all. Every test here asserts a refusal, and each one is written so
that removing the corresponding production line makes it fail.
"""

from datetime import datetime, timezone
from types import SimpleNamespace

import pyotp
import pyotp.totp
import pytest

from dj.apps.otp.models import OTPSecret

CHANGE_URL = "/api/auth/password/change/"
NEW_PASSWORD = "an-entirely-new-passphrase-9271"
OLD_PASSWORD = "the-current-passphrase-4417"

TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"


def _freeze_totp_clock(monkeypatch, frozen_now):
    """Pin PyOTP's clock and otp.utils' verification instant to one step.

    Same shape as the helper in test_creator_login_mfa.py: the
    verifier hands pyotp a single captured instant via ``for_time``, so both
    clocks must be frozen or a test can straddle a 30s boundary.
    """
    frozen_timestamp = int(frozen_now.timestamp())

    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            if tz is None:
                return cls.fromtimestamp(frozen_now.timestamp())
            return cls.fromtimestamp(frozen_now.timestamp(), tz)

    monkeypatch.setattr(
        pyotp.totp, "datetime", SimpleNamespace(datetime=FrozenDateTime)
    )

    import dj.apps.otp.utils as otp_utils

    class FrozenTimezone:
        @staticmethod
        def now():
            return FrozenDateTime.fromtimestamp(
                frozen_timestamp, tz=timezone.utc
            )

    monkeypatch.setattr(otp_utils, "timezone", FrozenTimezone)
    return pyotp.TOTP(TOTP_SECRET)


@pytest.mark.django_db
def test_production_password_hasher_persists_and_authenticates(
    client, creator_factory, monkeypatch
):
    """The effective production default must handle a real login session.

    The test suite normally selects ``pytest_settings`` and its
    one-iteration PBKDF2 fixtures. Load the actual production settings module without opening its
    database, then temporarily use that hasher list and prove the persisted
    hash and session login use PBKDF2.
    """
    import os

    from django.conf import Settings
    from django.contrib.auth.hashers import identify_hasher
    from django.test import override_settings

    # prod_settings reads DBPASS while constructing DATABASES, but this smoke
    # never opens a connection. Supply a harmless local value when a developer
    # runs the focused test outside the backend job's environment.
    monkeypatch.setenv(
        "DBPASS", os.environ.get("DBPASS", "unused-for-settings-smoke")
    )
    production_settings = Settings("dj.free2z.prod_settings")
    production_hashers = tuple(production_settings.PASSWORD_HASHERS)
    assert production_hashers[0].endswith("PBKDF2PasswordHasher")

    password = "production-hasher-smoke-9472"
    with override_settings(PASSWORD_HASHERS=production_hashers):
        user = creator_factory(
            username="production-hasher-smoke", password=password
        )
        user.refresh_from_db()

        assert identify_hasher(user.password).__class__.__name__ == (
            "PBKDF2PasswordHasher"
        )
        assert user.check_password(password)
        assert not user.check_password("wrong-production-password")
        assert client.login(username=user.username, password=password)
        assert client.session["_auth_user_id"] == str(user.pk)


@pytest.fixture
def logged_in(api_client, creator_factory):
    """A session-authenticated creator whose current password is known.

    force_authenticate models the exact starting position of the  chain:
    the attacker already holds a session (stolen cookie, borrowed device) and
    nothing more. Everything asserted below is what must still stop them.
    """
    user = creator_factory(password=OLD_PASSWORD)
    api_client.force_authenticate(user=user)
    return user


@pytest.mark.django_db
def test_password_change_refuses_without_the_current_password(
    api_client, logged_in
):
    response = api_client.post(
        CHANGE_URL,
        {"new_password1": NEW_PASSWORD, "new_password2": NEW_PASSWORD},
        format="json",
    )

    assert response.status_code == 400, response.content
    assert "old_password" in response.json(), response.content
    logged_in.refresh_from_db()
    assert logged_in.check_password(OLD_PASSWORD)
    assert not logged_in.check_password(NEW_PASSWORD)


@pytest.mark.django_db
def test_password_change_refuses_a_wrong_current_password(
    api_client, logged_in
):
    response = api_client.post(
        CHANGE_URL,
        {
            "old_password": "not-the-current-passphrase",
            "new_password1": NEW_PASSWORD,
            "new_password2": NEW_PASSWORD,
        },
        format="json",
    )

    assert response.status_code == 400, response.content
    assert "old_password" in response.json(), response.content
    logged_in.refresh_from_db()
    assert logged_in.check_password(OLD_PASSWORD)


@pytest.mark.django_db
def test_password_change_accepts_the_correct_current_password(
    api_client, logged_in
):
    """The positive control: the fix must not brick the legitimate flow."""
    response = api_client.post(
        CHANGE_URL,
        {
            "old_password": OLD_PASSWORD,
            "new_password1": NEW_PASSWORD,
            "new_password2": NEW_PASSWORD,
        },
        format="json",
    )

    assert response.status_code == 200, response.content
    logged_in.refresh_from_db()
    assert logged_in.check_password(NEW_PASSWORD)


@pytest.mark.django_db
def test_password_change_still_works_for_an_account_with_no_password(
    api_client, creator_factory, recent_login
):
    """Zcash/social/Twitter sign-ups have set_unusable_password().

    They have no old password to present, so requiring one unconditionally --
    which is what REST_AUTH['OLD_PASSWORD_FIELD_ENABLED'] = True would do --
    would permanently lock them out of ever setting one. The requirement is
    per account, exactly as /api/emails/change-password already decides it.
    """
    user = creator_factory()
    user.set_unusable_password()
    user.save(update_fields=["password"])
    assert not user.has_usable_password()
    recent_login(api_client, user)

    response = api_client.post(
        CHANGE_URL,
        {"new_password1": NEW_PASSWORD, "new_password2": NEW_PASSWORD},
        format="json",
    )

    assert response.status_code == 200, response.content
    user.refresh_from_db()
    assert user.check_password(NEW_PASSWORD)


@pytest.mark.django_db
def test_password_change_refuses_an_mfa_account_without_an_otp_token(
    api_client, logged_in
):
    OTPSecret.objects.create(
        user=logged_in, secret=TOTP_SECRET, is_active=True
    )

    response = api_client.post(
        CHANGE_URL,
        {
            "old_password": OLD_PASSWORD,
            "new_password1": NEW_PASSWORD,
            "new_password2": NEW_PASSWORD,
        },
        format="json",
    )

    assert response.status_code == 400, response.content
    assert "otp_token" in response.json(), response.content
    logged_in.refresh_from_db()
    assert logged_in.check_password(OLD_PASSWORD)


@pytest.mark.django_db
def test_a_spent_totp_code_cannot_be_replayed_at_password_change(
    api_client, logged_in, monkeypatch
):
    """The  chain end to end, with 's single-use guarantee.

    One code is spent (here by the enrollment-verify route, the same
    consuming path), and the attacker -- who does hold the current password --
    then presents that same code at the password change. It must be refused,
    which is what proves this route goes through the CONSUMING verifier and
    not a second stateless copy of it.
    """
    totp = _freeze_totp_clock(monkeypatch, datetime(2030, 1, 1, 12, 34, 15))
    secret = OTPSecret.objects.create(
        user=logged_in, secret=TOTP_SECRET, is_active=True
    )
    code = totp.now()

    from dj.apps.otp.utils import verify_user_totp

    assert verify_user_totp(logged_in, code) is True
    secret.refresh_from_db()
    assert secret.last_used_at is not None

    response = api_client.post(
        CHANGE_URL,
        {
            "old_password": OLD_PASSWORD,
            "otp_token": code,
            "new_password1": NEW_PASSWORD,
            "new_password2": NEW_PASSWORD,
        },
        format="json",
    )

    assert response.status_code == 400, response.content
    assert "otp_token" in response.json(), response.content
    logged_in.refresh_from_db()
    assert logged_in.check_password(OLD_PASSWORD)


@pytest.mark.django_db
def test_password_change_accepts_current_password_plus_a_fresh_otp_token(
    api_client, logged_in, monkeypatch
):
    totp = _freeze_totp_clock(monkeypatch, datetime(2030, 1, 1, 12, 34, 15))
    OTPSecret.objects.create(
        user=logged_in, secret=TOTP_SECRET, is_active=True
    )

    response = api_client.post(
        CHANGE_URL,
        {
            "old_password": OLD_PASSWORD,
            "otp_token": totp.now(),
            "new_password1": NEW_PASSWORD,
            "new_password2": NEW_PASSWORD,
        },
        format="json",
    )

    assert response.status_code == 200, response.content
    logged_in.refresh_from_db()
    assert logged_in.check_password(NEW_PASSWORD)


@pytest.mark.django_db
def test_a_wrong_current_password_does_not_spend_a_totp_code(
    api_client, logged_in, monkeypatch
):
    """Ordering, not just presence.

    If the TOTP gate ran before the current-password check, anyone holding a
    session could burn the victim's code for the current time step by POSTing
    garbage -- turning a takeover control into a denial-of-service against the
    account owner's own password change. The cheap non-consuming proof must
    come first.
    """
    totp = _freeze_totp_clock(monkeypatch, datetime(2030, 1, 1, 12, 34, 15))
    secret = OTPSecret.objects.create(
        user=logged_in, secret=TOTP_SECRET, is_active=True
    )
    code = totp.now()

    response = api_client.post(
        CHANGE_URL,
        {
            "old_password": "not-the-current-passphrase",
            "otp_token": code,
            "new_password1": NEW_PASSWORD,
            "new_password2": NEW_PASSWORD,
        },
        format="json",
    )

    assert response.status_code == 400, response.content
    assert "old_password" in response.json(), response.content
    secret.refresh_from_db()
    assert secret.last_used_at is None, "the TOTP code was consumed anyway"


@pytest.mark.django_db
def test_a_rejected_new_password_does_not_spend_a_totp_code(
    api_client, logged_in, monkeypatch
):
    """Same property the login path holds since 's review.

    A mismatched confirmation is a typo, not an attack. Burning a single-use
    code  before noticing it locks the owner out of retrying until the
    next 30-second step for a mistake that never touched a credential.
    """
    totp = _freeze_totp_clock(monkeypatch, datetime(2030, 1, 1, 12, 34, 15))
    secret = OTPSecret.objects.create(
        user=logged_in, secret=TOTP_SECRET, is_active=True
    )

    response = api_client.post(
        CHANGE_URL,
        {
            "old_password": OLD_PASSWORD,
            "otp_token": totp.now(),
            "new_password1": NEW_PASSWORD,
            "new_password2": NEW_PASSWORD + "-typo",
        },
        format="json",
    )

    assert response.status_code == 400, response.content
    secret.refresh_from_db()
    assert secret.last_used_at is None, "the TOTP code was consumed anyway"
    logged_in.refresh_from_db()
    assert logged_in.check_password(OLD_PASSWORD)


def test_password_change_takes_no_lock_before_the_totp_gate():
    """Lock ORDER, pinned as a property of the source.

    `/api/auth/login/` consumes the TOTP under the `OTPSecret` row lock and
    then Django's login writes `Creator.last_login`, so its order is
    OTPSecret-then-Creator. An earlier draft of this fix locked `Creator`
    first and then verified TOTP, which is the opposite order and deadlocks
    against a concurrent login by the same account -- PostgreSQL aborts one
    with a 500 on an auth path. Nothing in CI interleaves the two, so the
    check that survives is that the serializer takes no account lock of its
    own: the authoritative current-password check runs inside
    `CreatorSetPasswordForm.save()`, under the lock that already guards the
    write, after the TOTP gate.
    """
    import inspect

    from dj.apps.g12f.serializers import creator as creator_serializers

    source = inspect.getsource(
        creator_serializers.CreatorPasswordChangeSerializer
    )
    assert "select_for_update" not in source, source
    assert "require_current_password" in inspect.getsource(
        creator_serializers.CreatorSetPasswordForm
    )


@pytest.mark.django_db
def test_a_failed_otp_does_not_rehash_the_password_and_log_the_user_out(
    api_client, logged_in, settings
):
    """Raised by the codex adversarial review of this change.

    `AbstractBaseUser.check_password()` hands the hasher a setter that
    silently re-hashes AND SAVES whenever the stored encoding is outdated.
    On this route that write lands before the TOTP gate runs, and it
    committed even when the gate then answered 400 -- AtomicMiddleware's
    transaction saw a handled response, not an exception ( now rolls a
    RAISED error back; the helper stays write-free regardless). Since the session auth hash is
    an HMAC over `user.password`, the user who merely mistyped their
    authenticator code is logged out of every session with no explanation.
    """
    from dj.apps.g12f.models import Creator
    from django.contrib.auth.hashers import make_password

    settings.PASSWORD_HASHERS = [
        "django.contrib.auth.hashers.PBKDF2PasswordHasher",
        "django.contrib.auth.hashers.MD5PasswordHasher",
    ]
    outdated_encoding = make_password(OLD_PASSWORD, hasher="md5")
    Creator.objects.filter(pk=logged_in.pk).update(password=outdated_encoding)
    # `force_authenticate` hands the view THIS instance, so it must carry the
    # outdated encoding too. Without the refresh the request's user still
    # holds the freshly-made PBKDF2 hash, nothing needs upgrading, and the
    # test passes while testing nothing -- which is exactly how the first
    # draft of it stayed green with the defect present (codex review).
    logged_in.refresh_from_db()
    assert logged_in.password == outdated_encoding
    OTPSecret.objects.create(
        user=logged_in, secret=TOTP_SECRET, is_active=True
    )

    response = api_client.post(
        CHANGE_URL,
        {
            "old_password": OLD_PASSWORD,
            "otp_token": "000000",
            "new_password1": NEW_PASSWORD,
            "new_password2": NEW_PASSWORD,
        },
        format="json",
    )

    assert response.status_code == 400, response.content
    assert "otp_token" in response.json(), response.content
    stored = Creator.objects.get(pk=logged_in.pk)
    assert stored.password == outdated_encoding, (
        "the rejected request rewrote the password hash, which rotates "
        "get_session_auth_hash() and logs the account out"
    )


@pytest.mark.django_db
@pytest.mark.parametrize(
    "payload, expected",
    [
        ({"new_password": NEW_PASSWORD}, "missing"),
        (
            {"old_password": "not-the-current-passphrase",
             "new_password": NEW_PASSWORD},
            "wrong",
        ),
    ],
    ids=["missing", "wrong"],
)
def test_sibling_emails_route_also_demands_the_current_password(
    api_client, logged_in, payload, expected
):
    """ names two routes with the same shape; pin both.

    /api/emails/change-password already enforces this. Nothing asserted it,
    so a future refactor of ChangePasswordSerializer could quietly drop the
    requirement and every existing test would stay green.
    """
    response = api_client.post(
        "/api/emails/change-password", payload, format="json"
    )

    assert response.status_code == 400, (expected, response.content)
    assert "old_password" in response.json(), response.content
    logged_in.refresh_from_db()
    assert logged_in.check_password(OLD_PASSWORD)


@pytest.mark.django_db
def test_old_password_is_verified_against_the_committed_row(
    api_client, logged_in
):
    """A stale authenticated instance must not authorize the change.

    Authentication loads request.user before the view runs. If a concurrent
    change committed in between, checking the old password against that
    in-memory copy accepts a password the account no longer has. The check
    runs against the row read under the account lock instead.
    """
    from dj.apps.g12f.models import Creator

    # Commit a different password directly, leaving the request's
    # already-authenticated instance holding the superseded hash.
    concurrent = Creator.objects.get(pk=logged_in.pk)
    concurrent.set_password("changed-by-someone-else-8823")
    concurrent.save(update_fields=["password"])
    assert logged_in.check_password(OLD_PASSWORD), "test setup is not stale"

    response = api_client.post(
        CHANGE_URL,
        {
            "old_password": OLD_PASSWORD,
            "new_password1": NEW_PASSWORD,
            "new_password2": NEW_PASSWORD,
        },
        format="json",
    )

    assert response.status_code == 400, response.content
    assert "old_password" in response.json(), response.content
    logged_in.refresh_from_db()
    assert logged_in.check_password("changed-by-someone-else-8823")
