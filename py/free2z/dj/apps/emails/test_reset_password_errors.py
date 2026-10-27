"""Every refusal of ``/api/emails/do-reset-password`` names its reason.

The SvelteKit reset page used to answer every failure with "the link may have
expired — request a new one". For a weak password or a mistyped authenticator
code that is false in the worst way: the link is still good, the next link
fails identically, and the reader loops on reset emails that can never work.

The page can only say the right thing if the response says which thing went
wrong, in a form it can translate. So each refusal carries a stable ``code``
next to the English ``message`` existing clients already read, and a weak
password carries each validator's own code. These tests pin the codes and —
just as important — that a refusal the reader fixes by retrying leaves the
link unconsumed, which is the fact the client's copy depends on.

The TOTP cases (``invalid_otp``, ``otp_attempts_exhausted``) are pinned next to
the rest of the MFA coverage in ``dj/apps/test_totp_credential_issuers.py``.

Real Postgres, per the project rule; nothing here is mocked.
"""

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.emails.models import Email, PasswordResetToken

pytestmark = pytest.mark.django_db

DO_RESET_URL = "/api/emails/do-reset-password"
OLD_PASSWORD = "old-Password-123!"
GOOD_PASSWORD = "new-Password-456!"


@pytest.fixture(autouse=True)
def _empty_throttle_bucket():
    """The recovery route is throttled per-IP; tests must not inherit a bucket."""
    from django.core.cache import cache

    cache.clear()
    yield
    cache.clear()


def _reset_link(user):
    now = timezone.now()
    email = Email.objects.create(
        user=user,
        email=f"{user.username}@example.com",
        token=f"confirm-{user.username}",
        confirmed_at=now,
        expires_at=now + timezone.timedelta(days=1),
    )
    return PasswordResetToken.objects.create(email=email)


def _post(body):
    return APIClient().post(DO_RESET_URL, body, format="json")


@pytest.mark.parametrize(
    ("password", "expected_code"),
    [
        # Long enough for the client's own >= 8 check, so only the server
        # can refuse these — which is exactly why the page must show why.
        ("password123", "password_too_common"),
        ("48213957", "password_entirely_numeric"),
        ("xq7", "password_too_short"),
    ],
)
def test_a_weak_password_names_each_validator_and_keeps_the_link(
    creator_factory, password, expected_code,
):
    user = creator_factory(password=OLD_PASSWORD)
    link = _reset_link(user)

    response = _post({"token": str(link.token), "password": password})

    assert response.status_code == 400, response.content
    body = response.json()
    assert body["code"] == "password_invalid"
    codes = [error["code"] for error in body["password_errors"]]
    assert expected_code in codes, body
    # The sentences themselves, not the Python list repr ``str(e)`` produced:
    # "['This password is too common.']" is what a reader used to be shown.
    assert not body["message"].startswith("["), body["message"]
    assert body["message"] == " ".join(
        error["message"] for error in body["password_errors"]
    )

    # The link is untouched: "pick another password", never "request a link".
    link.refresh_from_db()
    assert link.used is False
    user.refresh_from_db()
    assert user.check_password(OLD_PASSWORD)


def test_a_password_like_the_username_is_named_as_such(creator_factory):
    user = creator_factory(username="marigoldfarmer", password=OLD_PASSWORD)
    link = _reset_link(user)

    response = _post({"token": str(link.token), "password": "marigoldfarmer"})

    assert response.status_code == 400, response.content
    codes = [e["code"] for e in response.json()["password_errors"]]
    assert "password_too_similar" in codes


def test_an_expired_link_says_expired(creator_factory):
    user = creator_factory(password=OLD_PASSWORD)
    link = _reset_link(user)
    PasswordResetToken.objects.filter(pk=link.pk).update(
        created_at=timezone.now() - timezone.timedelta(days=2),
    )

    response = _post({"token": str(link.token), "password": GOOD_PASSWORD})

    assert response.status_code == 400, response.content
    assert response.json() == {
        "message": "Token has expired.",
        "code": "token_expired",
    }


@pytest.mark.parametrize("used", [True, False])
def test_a_spent_or_unknown_link_says_invalid(creator_factory, used):
    user = creator_factory(password=OLD_PASSWORD)
    link = _reset_link(user)
    if used:
        PasswordResetToken.objects.filter(pk=link.pk).update(used=True)
        token = str(link.token)
    else:
        token = "00000000-0000-0000-0000-000000000000"

    response = _post({"token": token, "password": GOOD_PASSWORD})

    assert response.status_code == 400, response.content
    assert response.json() == {
        "message": "Invalid token.",
        "code": "token_invalid",
    }


def test_an_oversized_otp_is_an_invalid_otp(creator_factory):
    user = creator_factory(password=OLD_PASSWORD)
    link = _reset_link(user)

    response = _post(
        {
            "token": str(link.token),
            "password": GOOD_PASSWORD,
            "otp_token": "1" * 11,
        },
    )

    assert response.status_code == 400, response.content
    assert response.json()["code"] == "invalid_otp"


def test_missing_fields_are_named():
    response = _post({"password": GOOD_PASSWORD})

    assert response.status_code == 400, response.content
    assert response.json()["code"] == "missing_fields"


def test_success_carries_no_error_code(creator_factory):
    """The positive control: a good password on a good link still works."""
    user = creator_factory(password=OLD_PASSWORD)
    link = _reset_link(user)

    response = _post({"token": str(link.token), "password": GOOD_PASSWORD})

    assert response.status_code == 200, response.content
    assert "code" not in response.json()



def test_inactive_account_reset_commits_without_signing_in(creator_factory):
    user = creator_factory(password=OLD_PASSWORD, is_active=False)
    link = _reset_link(user)
    other_link = PasswordResetToken.objects.create(email=link.email)
    client = APIClient()

    response = client.post(DO_RESET_URL, {
        "token": str(link.token), "password": GOOD_PASSWORD,
    }, format="json")

    assert response.status_code == 500
    assert response.json()["code"] == "reset_but_not_signed_in"
    user.refresh_from_db()
    link.refresh_from_db()
    other_link.refresh_from_db()
    assert user.check_password(GOOD_PASSWORD)
    assert user.is_active is False
    assert link.used is True
    assert other_link.used is True
    assert "_auth_user_id" not in client.session
    # A second request must see the committed consumption, not retry the reset.
    replay = client.post(DO_RESET_URL, {
        "token": str(link.token), "password": OLD_PASSWORD,
    }, format="json")
    assert replay.status_code == 400
    assert replay.json()["code"] == "token_invalid"
