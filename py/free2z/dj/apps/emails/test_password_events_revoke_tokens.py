"""A password change or reset ends every bearer token the account holds.

The gap
-------

Changing a password is what somebody does *because* they believe another party
has their credentials. Until now it ended browser sessions (Django's
session-auth-hash sees to that on next use) and left every Knox token alive —
so the one action a compromised creator takes to evict an attacker left the
attacker's long-lived API bearer working.

 raised this against the 90-day agent (MCP) tokens of. That app is
not on ``main`` —  was closed unmerged — but its tokens are ordinary
``knox.AuthToken`` rows, and so is every other bearer this platform issues, so
the family is covered by the mechanism rather than by a list that would need
extending when it lands. These tests assert the property at the level that
outlives the feature: **after a password event, a token minted before it is
refused.**

Why these tests are here and not only in ``ktauth``
--------------------------------------------------

``dj/apps/ktauth/tests/test_ownership_event_revokes_sessions.py`` drives
``bump_account_epoch`` directly and proves the primitive revokes. That is a
different claim from "the route a creator actually uses calls it". 's
table is a list of ROUTES, and a route that quietly stopped calling the
primitive — a refactor moving the bump outside the transaction, a new
password path added next year — would leave that file entirely green. So these
go through the HTTP endpoints, with a token on the wire, and assert the refusal
at a second endpoint afterwards.

Real Postgres, per the project rule; nothing here is mocked.
"""

import pytest
from knox.models import AuthToken
from rest_framework.test import APIClient

from dj.apps.emails.models import Email, PasswordResetToken

pytestmark = pytest.mark.django_db

CHANGE_PASSWORD_URL = "/api/emails/change-password"
DO_RESET_URL = "/api/emails/do-reset-password"
AUTH_PASSWORD_CHANGE_URL = "/api/auth/password/change/"
# Any IsAuthenticated endpoint would do; this one is stable, cheap, and is what
# a client hits first.
AUTHENTICATED_PROBE_URL = "/api/auth/user"

OLD_PASSWORD = "old-Password-123!"
NEW_PASSWORD = "new-Password-456!"


@pytest.fixture(autouse=True)
def _empty_throttle_bucket():
    """The recovery routes are throttled per-IP; tests must not inherit a bucket."""
    from django.core.cache import cache

    cache.clear()
    yield
    cache.clear()


def mint_bearer(user) -> str:
    """A Knox bearer token, exactly as `/api/token/login` or an agent hands one out."""
    _instance, raw = AuthToken.objects.create(user)
    return raw


def bearer_is_refused(raw_token) -> bool:
    """Does an authenticated endpoint still accept this token?

    Knox raises ``AuthenticationFailed`` with no ``WWW-Authenticate`` header, so
    DRF renders the refusal as 403 rather than 401. Both are accepted here for
    the same reason ``ktauth``'s endpoint tests accept both: what is being
    asserted is that the credential no longer authenticates, not which of the
    two status codes DRF chose.
    """
    probe = APIClient()
    probe.credentials(HTTP_AUTHORIZATION=f"Token {raw_token}")
    return probe.get(AUTHENTICATED_PROBE_URL).status_code in (401, 403)


def confirmed_email(user, address="owner@example.com") -> Email:
    from django.utils import timezone

    now = timezone.now()
    return Email.objects.create(
        user=user,
        email=address,
        token="confirm-token",
        confirmed_at=now,
        expires_at=now + timezone.timedelta(days=1),
    )


# ------------------------------------------------------------ password change


def test_changing_the_password_refuses_a_token_minted_before_it(creator_factory):
    """, end to end: the long-lived bearer does not outlive the change.

    Two tokens deliberately. One stands in for the credential the *attacker*
    holds — an agent/MCP token, a copied secret, a stale API client — and is
    never used to make the change; the other proves the account had more than
    one and that the sweep is not "delete the token that authenticated this
    request". Both must be dead afterwards.

    The change itself is made over a SESSION, not over one of the tokens, so
    the test cannot pass by accident through knox invalidating only the
    presented credential.
    """
    user = creator_factory(password=OLD_PASSWORD)
    attacker_token = mint_bearer(user)
    other_token = mint_bearer(user)
    assert not bearer_is_refused(attacker_token), (
        "precondition: the token must work BEFORE the password change"
    )

    client = APIClient()
    client.force_login(user)
    response = client.post(
        CHANGE_PASSWORD_URL,
        {"old_password": OLD_PASSWORD, "new_password": NEW_PASSWORD},
        format="json",
    )
    assert response.status_code == 200, response.data

    assert bearer_is_refused(attacker_token)
    assert bearer_is_refused(other_token)
    assert not AuthToken.objects.filter(user_id=user.pk).exists()


def test_the_dj_rest_auth_password_change_route_revokes_too(creator_factory):
    """The sibling route, because 's table lists routes, not functions.

    ``/api/auth/password/change/`` is a different view, a different serializer
    and a different transaction from ``/api/emails/change-password``. Testing
    one and assuming the other is how a two-route surface ends up half fixed.
    """
    user = creator_factory(password=OLD_PASSWORD)
    token = mint_bearer(user)

    client = APIClient()
    client.force_login(user)
    response = client.post(
        AUTH_PASSWORD_CHANGE_URL,
        {
            "old_password": OLD_PASSWORD,
            "new_password1": NEW_PASSWORD,
            "new_password2": NEW_PASSWORD,
        },
        format="json",
    )
    assert response.status_code == 200, response.data

    assert bearer_is_refused(token)


def test_a_failed_password_change_revokes_nothing(creator_factory):
    """The control that makes the two above mean something.

    A wrong current password must leave the account exactly as it was. Without
    this, "revoke on every request to this route" would pass every positive
    test here while handing anyone with a session a free sign-out-everywhere
    button — and, on the reset path, a way to keep an owner logged out.
    """
    user = creator_factory(password=OLD_PASSWORD)
    token = mint_bearer(user)

    client = APIClient()
    client.force_login(user)
    response = client.post(
        CHANGE_PASSWORD_URL,
        {"old_password": "not-the-password", "new_password": NEW_PASSWORD},
        format="json",
    )
    assert response.status_code == 400, response.data

    assert not bearer_is_refused(token)
    assert AuthToken.objects.filter(user_id=user.pk).count() == 1


def test_one_accounts_password_change_leaves_another_accounts_token_alive(
    creator_factory,
):
    """The over-broad control, at the route level.

    Every assertion above is satisfied by a sweep that deletes every token on
    the platform. This is the one that isn't.
    """
    alice = creator_factory(username="pw-alice", password=OLD_PASSWORD)
    bob = creator_factory(username="pw-bob", password=OLD_PASSWORD)
    bob_token = mint_bearer(bob)

    client = APIClient()
    client.force_login(alice)
    response = client.post(
        CHANGE_PASSWORD_URL,
        {"old_password": OLD_PASSWORD, "new_password": NEW_PASSWORD},
        format="json",
    )
    assert response.status_code == 200, response.data

    assert not bearer_is_refused(bob_token)


# ------------------------------- password login issues no bearer token


LOGIN_URL = "/api/auth/login/"
CAPTCHA = "ci-valid-captcha"


@pytest.fixture
def passing_captcha(monkeypatch):
    """Make reCAPTCHA say yes without touching the network.

    Same shape as `dj/apps/g12f/test_creator_login_mfa.py`: the serializer POSTs
    to Google's siteverify, and a test that reached the real endpoint would be
    slow, flaky and dependent on a secret CI does not have.
    """
    from types import SimpleNamespace

    monkeypatch.setattr(
        "dj.apps.g12f.captcha.requests.post",
        lambda _url, **_kwargs: SimpleNamespace(json=lambda: {"success": True}),
    )


def test_logging_in_establishes_a_session_and_mints_no_bearer_token(
    creator_factory, passing_captcha,
):
    """: ``/api/auth/login/`` is session-only; the inert key is gone.

    ``dj.apps.ktauth.epoch`` records that dj-rest-auth's default
    ``TOKEN_MODEL`` made ``LoginView.login()`` call
    ``Token.objects.get_or_create(user=user)`` on every sign-in -- a permanent
    per-account key that authenticated nothing. ``REST_AUTH['TOKEN_MODEL']``
    is now None, and ``rest_framework.authtoken`` is not even
    installed, so there is no model to mint into: a regression would be a
    200 with a ``key`` body (or an ImproperlyConfigured at import).

    Both halves are asserted, because the obvious regression of "no token"
    is "no login": the session this route exists to create must still
    authenticate a follow-up request, which is the SPA's whole sign-in flow.

    Negative control: delete ``'TOKEN_MODEL': None`` from ``REST_AUTH`` and
    the whole app fails to import (dj_rest_auth refuses a default Token model
    whose app is not installed).
    """
    user = creator_factory(password=OLD_PASSWORD)
    client = APIClient()

    login = client.post(
        LOGIN_URL,
        {
            "username": user.username,
            "password": OLD_PASSWORD,
            "captcha_result": CAPTCHA,
        },
        format="json",
    )

    assert login.status_code == 204, (login.status_code, login.content)
    assert login.content == b""
    assert not AuthToken.objects.filter(user_id=user.pk).exists(), (
        "password login is not a Knox issuer either"
    )
    me = client.get(AUTHENTICATED_PROBE_URL)
    assert me.status_code == 200, me.content
    assert me.json()["username"] == user.username


def test_a_drf_token_key_does_not_authenticate(creator_factory):
    """A DRF-shaped ``Authorization: Token <40 hex>`` header is refused.

    Every legacy ``rest_framework.authtoken`` key was purged in  (g12f
    migration 0113), but a client that saved one before then will still
    present it. Knox is the only token authenticator configured and resolves
    the presented prefix against ``knox.AuthToken``, so the old key is simply
    an unknown token. If someone wires DRF's ``TokenAuthentication`` in
    per-view, ``test_authentication_inventory.py`` goes red before this can.
    """
    import secrets

    creator_factory(password=OLD_PASSWORD)
    probe = APIClient()
    probe.credentials(HTTP_AUTHORIZATION=f"Token {secrets.token_hex(20)}")
    assert probe.get(AUTHENTICATED_PROBE_URL).status_code in (401, 403)


# ------------------------------------------------------------- password reset


def test_resetting_the_password_refuses_a_token_minted_before_it(creator_factory):
    """The recovery path, which is the one that runs while an attacker is inside.

    A reset is spent by whoever controls the recovery mailbox, and the whole
    point of the flow is that the person driving it may not be the person
    holding the account's live credentials. Leaving those credentials alive
    through it means the owner recovers their password and the attacker keeps
    their token.
    """
    user = creator_factory(password=OLD_PASSWORD)
    email = confirmed_email(user)
    reset = PasswordResetToken.objects.create(email=email)
    attacker_token = mint_bearer(user)
    assert not bearer_is_refused(attacker_token)

    response = APIClient().post(
        DO_RESET_URL,
        {"token": str(reset.token), "password": NEW_PASSWORD},
        format="json",
    )
    assert response.status_code == 200, response.data

    assert bearer_is_refused(attacker_token)
    assert not AuthToken.objects.filter(user_id=user.pk).exists()


def test_an_admin_credential_edit_burns_an_outstanding_reset_link(
    creator_factory,
):
    """The fourth credential family, and the gap the per-route sweeps left.

    Both password routes and ``/api/emails/add`` already burned outstanding
    ``PasswordResetToken`` rows for themselves. The events that reach none of
    those routes — staff editing a credential in the admin, ``manage.py
    changepassword``, a social/twitter unlink — did not, so an operator
    repairing a compromised account replaced the password on top of a live
    reset link pointing at whatever mailbox the attacker still controlled.

    Driven through ``bump_account_epoch`` rather than through the admin, for
    the same reason the parametrized ``ktauth`` test is: the sweep belongs to
    the primitive, so every event inherits it, and this asserts the property at
    the level that inheritance happens.
    """
    from dj.apps.ktauth import epoch

    user = creator_factory()
    email = confirmed_email(user)
    outstanding = PasswordResetToken.objects.create(email=email)

    epoch.bump_account_epoch(user.pk, event=epoch.EVENT_ADMIN_CREDENTIAL_EDIT)

    outstanding.refresh_from_db()
    assert outstanding.used is True

    #...and it is genuinely unusable, not merely flagged.
    response = APIClient().post(
        DO_RESET_URL,
        {"token": str(outstanding.token), "password": NEW_PASSWORD},
        format="json",
    )
    assert response.status_code == 400, response.data


def test_burning_reset_links_is_scoped_to_the_account(creator_factory):
    """The over-broad control for the reset-token sweep.

    ``PasswordResetToken`` reaches its owner through ``email__user_id``; a
    filter dropped there would invalidate every outstanding recovery link on
    the platform on every password change, locking out exactly the people in
    the middle of recovering an account.
    """
    from dj.apps.ktauth import epoch

    alice = creator_factory(username="reset-alice")
    bob = creator_factory(username="reset-bob")
    bob_reset = PasswordResetToken.objects.create(
        email=confirmed_email(bob, "bob@example.com"),
    )
    confirmed_email(alice, "alice@example.com")

    epoch.bump_account_epoch(alice.pk, event=epoch.EVENT_PASSWORD_CHANGE)

    bob_reset.refresh_from_db()
    assert bob_reset.used is False


def test_a_rejected_reset_token_revokes_nothing(creator_factory):
    """An invalid reset token must not be an unauthenticated sign-out button.

    ``/api/emails/do-reset-password`` is ``AllowAny``. If revocation happened
    anywhere but inside the committed reset, anyone on the internet could keep
    an account signed out by POSTing garbage at it.
    """
    user = creator_factory(password=OLD_PASSWORD)
    email = confirmed_email(user)
    spent = PasswordResetToken.objects.create(email=email, used=True)
    token = mint_bearer(user)

    response = APIClient().post(
        DO_RESET_URL,
        {"token": str(spent.token), "password": NEW_PASSWORD},
        format="json",
    )
    assert response.status_code == 400, response.data

    assert not bearer_is_refused(token)
