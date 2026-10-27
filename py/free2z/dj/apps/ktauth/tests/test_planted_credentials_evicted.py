"""An ownership event evicts the attacker COMPLETELY --,,.

 made an ownership event delete the account's Knox tokens, DRF tokens,
Django sessions and outstanding password-reset links, and hang up its live
WebSockets. Three credential families survived it, and each of them hands a
attacker who had access before the event their access back after it:

* **** -- the pending ``Email.token`` confirmation link. The attacker
  POSTs their own address to ``/api/emails/add`` from a stolen session, the
  owner changes the password, every session dies -- and the emailed link still
  confirms, making the attacker's mailbox the account's recovery principal.
* **** -- a planted social / Zcash / Twitter identity. Linking is an
  ordinary authenticated action, and  deliberately excluded identities on
  the grounds that they are "the owner's own login methods". That is right for
  the identity the owner linked and wrong for one the attacker planted, and it
  signs the attacker straight back in.
* **** -- a credential ISSUED CONCURRENTLY with the event. ````'s
  revocation is a point-in-time sweep, so a login already in flight inserts its
  Knox token *after* the sweep has run and keeps it.

Every test here asserts by OUTCOME -- the planted credential no longer
authenticates through the real route -- rather than by the internal side effect
(a row count, a delete call), because an implementation-shaped assertion passes
again the day the implementation changes and the hole reopens.

The controls matter as much as the attacks and are interleaved with them
deliberately: a legitimate address change must still confirm ('s trap), and
a passwordless creator's only login method must still sign them in ('s
"whole difficulty"). A fix that closes the hole by breaking those is not a fix.

    cd py && python -m pytest dj/apps/ktauth/tests/test_planted_credentials_evicted.py
"""

import threading
from unittest import mock

import pytest
from django.conf import settings
from django.contrib.auth import login as django_login
from django.contrib.auth.base_user import AbstractBaseUser
from django.contrib.auth.hashers import make_password
from django.contrib.sessions.backends.db import SessionStore
from django.db import connection
from django.test import RequestFactory
from django.test import override_settings
from django.utils import timezone
from knox.models import AuthToken
from rest_framework.test import APIClient

from dj.apps.emails.models import Email, PasswordResetToken
from dj.apps.g12f.models import Creator, IssuedTokenEpoch
from dj.apps.ktauth import epoch
from dj.apps.ktauth.credentials import identity_can_authenticate
from dj.apps.social.models import SocialIdentity
from dj.apps.twitter.models import TwitterProfile
from dj.apps.zauth.models import ZcashIdentity


GOOGLE_UID = "google-sub-planted-1"
REDIRECT_URI = "http://localhost:3000/auth/callback"


@pytest.fixture(autouse=True)
def _clean_cache():
    from django.core.cache import cache

    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def google_configured(settings):
    settings.GOOGLE_CLIENT_ID = "test-google-id"
    settings.GOOGLE_CLIENT_SECRET = "test-google-secret"
    settings.ZUULI_SOCIAL_AUTH_ENABLED = True
    return settings


def _mock_exchange(mocker, uid=GOOGLE_UID, handle="planted@example.com"):
    return mocker.patch(
        "dj.apps.social.views.exchange_identity",
        return_value={"uid": uid, "handle": handle, "avatar_url": ""},
    )


def _social_login(client, mocker, provider="google"):
    """Drive the real two-step social login and return the response."""
    start = client.get(
        f"/api/auth/social/{provider}/start", {"redirect_uri": REDIRECT_URI},
    )
    assert start.status_code == 200, start.content
    return client.post(
        f"/api/auth/social/{provider}/",
        {
            "code": "auth-code",
            "state": start.data["state"],
            "redirect_uri": REDIRECT_URI,
        },
        format="json",
    )


def _token_client(raw_token):
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Token {raw_token}")
    return client


def _change_password(user, new_password="Correct-Horse-9!"):
    """The owner's password change, through the real authenticated route."""
    client = APIClient()
    _instance, raw = AuthToken.objects.create(user)
    client.credentials(HTTP_AUTHORIZATION=f"Token {raw}")
    resp = client.post(
        "/api/emails/change-password",
        {"old_password": "password", "new_password": new_password},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    return resp


# --------------------------------------------------------------------------- #
#  -- the planted email-confirmation link
# --------------------------------------------------------------------------- #


@pytest.mark.django_db
def test_planted_confirmation_link_dies_with_the_password_change(
    creator_factory,
):
    """The  chain, end to end, asserted on the attacker's real goal.

    The attacker's goal is not "the row says confirmed"; it is to become the
    account's recovery principal so a password reset mails *them* the takeover
    link. So the assertion is exactly that: after the owner's password change,
    spending the planted confirmation link must leave the attacker unable to
    obtain a reset for their own address.
    """
    owner = creator_factory(username="victim")

    # 1. The attacker, holding a stolen credential, points the account's
    #    (OneToOne) Email row at a mailbox they control.
    stolen = APIClient()
    _instance, raw = AuthToken.objects.create(owner)
    # A recently stolen credential can still plant a method; later ownership
    # changes must evict it even after the new step-up gate.
    from dj.apps.identity.auth_context import record_login
    record_login(None, owner, methods=["pwd"], token=_instance)
    stolen.credentials(HTTP_AUTHORIZATION=f"Token {raw}")
    added = stolen.post(
        "/api/emails/add", {"email": "attacker@evil.example"}, format="json",
    )
    assert added.status_code == 201, added.content
    planted_token = Email.objects.get(user=owner).token

    # 2. The owner notices and changes their password.  kills the
    #    attacker's token, session and any reset link.
    _change_password(owner)

    # 3. The emailed confirmation link is spent.
    APIClient().post("/api/emails/confirm", {"token": planted_token})

    # 4. OUTCOME: the attacker's mailbox is not a recovery principal, so a
    #    password reset for it mints nothing they could spend.
    APIClient().post(
        "/api/emails/reset-password", {"email": "attacker@evil.example"},
    )
    assert not PasswordResetToken.objects.filter(
        email__user=owner, used=False,
    ).exists()


@pytest.mark.django_db
def test_a_legitimate_address_change_still_confirms(creator_factory, mailoutbox):
    """'s control, and the trap that makes the fix its own change.

    ``AddEmailView`` generates the confirmation token, saves the row and fires
    ``recovery_address_change`` **while still holding that token**, then mails
    it. A fix that revokes pending tokens inside the bump silently mails a dead
    link on the most-used email route on the platform. This is the test that
    catches that.
    """
    owner = creator_factory(username="owner")
    Email.objects.create(
        user=owner,
        email="old@example.com",
        token="old-token",
        expires_at=timezone.now() + timezone.timedelta(hours=1),
        confirmed_at=timezone.now(),
    )

    client = APIClient()
    _instance, raw = AuthToken.objects.create(owner)
    # A recently stolen credential can still plant a method; later ownership
    # changes must evict it even after the new step-up gate.
    from dj.apps.identity.auth_context import record_login
    record_login(None, owner, methods=["pwd"], token=_instance)
    client.credentials(HTTP_AUTHORIZATION=f"Token {raw}")
    resp = client.post(
        "/api/emails/add", {"email": "new@example.com"}, format="json",
    )
    assert resp.status_code == 201, resp.content

    # Exactly the token that was mailed, spent exactly as the recipient would.
    mailed_token = Email.objects.get(user=owner).token
    assert any(mailed_token in m.body for m in mailoutbox), (
        "the confirmation mail did not carry the token the row now holds"
    )
    confirmed = APIClient().post("/api/emails/confirm", {"token": mailed_token})
    assert confirmed.status_code == 303, confirmed.content
    assert Email.objects.get(user=owner).confirmed_at is not None


# --------------------------------------------------------------------------- #
#  -- the planted social / Zcash / Twitter identity
# --------------------------------------------------------------------------- #


@pytest.mark.django_db
def test_planted_social_identity_cannot_sign_in_after_a_password_change(
    api_client, google_configured, mocker, creator_factory,
):
    """ on the social path, driven through the real routes both ways."""
    _mock_exchange(mocker)
    owner = creator_factory(username="socialvictim")

    # 1. The attacker links their own Google account from a stolen session.
    stolen = APIClient()
    _instance, raw = AuthToken.objects.create(owner)
    # A recently stolen credential can still plant a method; later ownership
    # changes must evict it even after the new step-up gate.
    from dj.apps.identity.auth_context import record_login
    record_login(None, owner, methods=["pwd"], token=_instance)
    stolen.credentials(HTTP_AUTHORIZATION=f"Token {raw}")
    linked = _social_login(stolen, mocker)
    assert linked.status_code == 200, linked.content
    assert linked.data["linked"] is True

    # 2. The owner changes their password.
    _change_password(owner)

    # 3. OUTCOME: the planted identity no longer completes a login.
    replay = _social_login(APIClient(), mocker)
    # status-negation-ok: the security property is "no session is issued",
    # asserted directly on the next line; any refusal status satisfies it.
    assert replay.status_code != 200, replay.content
    assert not AuthToken.objects.filter(user=owner).exists()


@pytest.mark.django_db
def test_a_passwordless_creators_only_social_login_still_works(
    api_client, google_configured, mocker,
):
    """'s control -- and the reason "unlink everything" is not the fix.

    A social-only creator carries ``set_unusable_password()``. Signing them out
    of the only login method they have is not a sign-out, it is account
    destruction, so an ownership event on such an account must leave the
    identity able to sign in.
    """
    _mock_exchange(mocker)
    first = _social_login(APIClient(), mocker)
    assert first.status_code == 200, first.content
    creator = SocialIdentity.objects.get(provider_uid=GOOGLE_UID).creator
    assert not creator.has_usable_password()

    # An ownership event lands on the account (staff repair, an unlink of some
    # other credential -- the route does not matter, the event does).
    epoch.bump_account_epoch(
        creator.pk, event=epoch.EVENT_CREDENTIAL_ADMIN_EDIT,
    )

    again = _social_login(APIClient(), mocker)
    assert again.status_code == 200, again.content
    assert again.data["username"] == creator.username


@pytest.mark.django_db
def test_passwordless_social_login_keeps_oldest_and_requires_reconnect_for_newer(
    google_configured, mocker,
):
    """: a planted second social identity cannot survive an event.

    Both identities are exercised through the real OAuth start/login route. The
    first identity remains the passwordless account's last-resort login; the
    newer identity is refused until an authenticated current-epoch session
    reconnects it. Reconnecting the identity is the explicit ownership proof,
    not an anonymous stale-login side effect.
    """
    original = {
        "uid": "google-origin-1602",
        "handle": "origin@example.com",
        "avatar_url": "",
    }
    planted = {
        "uid": "google-planted-1602",
        "handle": "planted@example.com",
        "avatar_url": "",
    }
    exchange = mocker.patch(
        "dj.apps.social.views.exchange_identity",
        side_effect=[
            original,
            original,
            planted,
            original,
            planted,
            planted,
            planted,
        ],
    )

    first = _social_login(APIClient(), mocker)
    assert first.status_code == 200, first.content
    creator = SocialIdentity.objects.get(provider_uid=original["uid"]).creator
    assert not creator.has_usable_password()

    # Move the account to a new epoch before the owner signs in again. The
    # replacement below is therefore linked at a later epoch than the
    # account-origin identity, which is the case that epoch-first ranking got
    # wrong: an authenticated link is not proof that the link was owner-made.
    epoch.bump_account_epoch(
        creator.pk, event=epoch.EVENT_CREDENTIAL_ADMIN_EDIT,
    )
    owner_login = _social_login(APIClient(), mocker)
    assert owner_login.status_code == 200, owner_login.content

    # The stolen current token is enough to plant a second provider identity.
    stolen = _token_client(owner_login.data["token"])
    linked = _social_login(stolen, mocker)
    assert linked.status_code == 200, linked.content
    old_row = SocialIdentity.objects.get(provider_uid=original["uid"])
    new_row = SocialIdentity.objects.get(provider_uid=planted["uid"])
    assert old_row.creator_id == new_row.creator_id == creator.pk

    # Make the ordering explicit instead of relying on wall-clock resolution.
    SocialIdentity.objects.filter(pk=old_row.pk).update(
        verified_at=timezone.now() - timezone.timedelta(days=1),
    )

    epoch.bump_account_epoch(
        creator.pk, event=epoch.EVENT_CREDENTIAL_ADMIN_EDIT,
    )

    # This is the multi-identity, different-epoch case: the account-origin row
    # was linked at epoch 1, while the plant was linked at epoch 2. The event
    # chooses and records the older owner fallback before either row tries to
    # log in at epoch 3.
    new_row.refresh_from_db()
    creator.refresh_from_db()
    assert new_row.fallback_rejected_at_epoch == creator.kt_account_epoch

    # The account-origin identity stays usable; the newer planted identity does
    # not get to turn the passwordless exemption into a current token.
    original_login = _social_login(APIClient(), mocker)
    assert original_login.status_code == 200, original_login.content
    planted_login = _social_login(APIClient(), mocker)
    assert planted_login.status_code == 403, planted_login.content
    new_row.refresh_from_db()
    creator.refresh_from_db()
    assert new_row.fallback_rejected_at_epoch == creator.kt_account_epoch

    # The owner can use the surviving current-epoch token to reconnect the
    # stale row. The next anonymous login then succeeds because the row has a
    # fresh linked_at_epoch, not because the stale exception was widened.
    reconnect = _token_client(original_login.data["token"])
    reconnected = _social_login(reconnect, mocker)
    assert reconnected.status_code == 200, reconnected.content
    assert reconnected.data["linked"] is False
    new_row.refresh_from_db()
    creator.refresh_from_db()
    assert new_row.linked_at_epoch == creator.kt_account_epoch
    assert new_row.fallback_rejected_at_epoch is None
    assert _social_login(APIClient(), mocker).status_code == 200
    assert exchange.call_count == 7


@pytest.mark.django_db
def test_dormant_planted_identity_does_not_return_after_fallback_unlink(
    google_configured, mocker, creator_factory,
):
    """A dormant planted row is rejected before it ever attempts a login.

    The planted row and the owner's backup are deliberately linked in the same
    epoch. The ownership event decides the fallback while all three rows are
    present, so the planted row is marked even though it never attempts a
    login. The owner explicitly re-proves the backup and can then retire the
    original fallback without reviving the dormant plant.
    """
    owner = creator_factory(username="unlink-fallback-1602")
    owner.set_unusable_password()
    owner.save(update_fields=["password", "password_set", "updated_at"])
    original = SocialIdentity.objects.create(
        creator=owner, provider="google", provider_uid="unlink-original-1602",
        linked_at_epoch=1,
    )
    planted = SocialIdentity.objects.create(
        creator=owner, provider="google", provider_uid="unlink-planted-1602",
        linked_at_epoch=1,
    )
    replacement = SocialIdentity.objects.create(
        creator=owner, provider="google", provider_uid="unlink-replacement-1602",
        linked_at_epoch=1,
    )
    now = timezone.now()
    SocialIdentity.objects.filter(pk=original.pk).update(
        verified_at=now - timezone.timedelta(days=3),
    )
    SocialIdentity.objects.filter(pk=planted.pk).update(
        verified_at=now - timezone.timedelta(days=2),
    )
    SocialIdentity.objects.filter(pk=replacement.pk).update(
        verified_at=now - timezone.timedelta(days=1),
    )

    # The ownership event makes all three rows stale. The owner fallback is
    # still the oldest row, while the attacker and backup share its old epoch.
    epoch.bump_account_epoch(
        owner.pk, event=epoch.EVENT_CREDENTIAL_ADMIN_EDIT,
    )
    owner.refresh_from_db()
    planted.refresh_from_db()
    replacement.refresh_from_db()
    assert planted.fallback_rejected_at_epoch == owner.kt_account_epoch
    assert replacement.fallback_rejected_at_epoch == owner.kt_account_epoch
    exchange = mocker.patch(
        "dj.apps.social.views.exchange_identity",
        side_effect=[
            {"uid": original.provider_uid, "handle": "original", "avatar_url": ""},
            {
                "uid": replacement.provider_uid,
                "handle": "replacement",
                "avatar_url": "",
            },
            {"uid": planted.provider_uid, "handle": "planted", "avatar_url": ""},
            {
                "uid": replacement.provider_uid,
                "handle": "replacement",
                "avatar_url": "",
            },
        ],
    )

    original_login = _social_login(APIClient(), mocker)
    assert original_login.status_code == 200, original_login.content

    # The owner must explicitly reconnect the backup before removing the
    # selected fallback. That clears its durable rejection and leaves a
    # survivor for the next ownership epoch.
    replacement_reconnect = _social_login(
        _token_client(original_login.data["token"]), mocker,
    )
    assert replacement_reconnect.status_code == 200, replacement_reconnect.content

    # Exercise the real unlink route. It advances the epoch atomically and
    # makes both survivors stale. The same-epoch owner backup remains usable;
    # the previously rejected planted identity does not get promoted.
    unlink = _token_client(original_login.data["token"]).delete(
        "/api/auth/social/google/unlink-original-1602/",
    )
    assert unlink.status_code == 204, unlink.content
    planted_login = _social_login(APIClient(), mocker)
    assert planted_login.status_code == 403, planted_login.content
    replacement_login = _social_login(APIClient(), mocker)
    assert replacement_login.status_code == 200, replacement_login.content
    assert exchange.call_count == 4


@pytest.mark.django_db
def test_honest_backup_cannot_become_an_irrecoverable_lockout(
    google_configured, mocker, creator_factory,
):
    """Trying a real backup cannot make unlinking the fallback strand it."""
    owner = creator_factory(username="honest-backup-lockout-1602")
    owner.set_unusable_password()
    owner.save(update_fields=["password", "password_set", "updated_at"])
    original = SocialIdentity.objects.create(
        creator=owner,
        provider="google",
        provider_uid="honest-backup-original-1602",
        linked_at_epoch=1,
    )
    backup = SocialIdentity.objects.create(
        creator=owner,
        provider="google",
        provider_uid="honest-backup-secondary-1602",
        linked_at_epoch=1,
    )
    now = timezone.now()
    SocialIdentity.objects.filter(pk=original.pk).update(
        verified_at=now - timezone.timedelta(days=2),
    )
    SocialIdentity.objects.filter(pk=backup.pk).update(
        verified_at=now - timezone.timedelta(days=1),
    )

    epoch.bump_account_epoch(
        owner.pk, event=epoch.EVENT_CREDENTIAL_ADMIN_EDIT,
    )
    owner.refresh_from_db()
    backup.refresh_from_db()
    assert backup.fallback_rejected_at_epoch == owner.kt_account_epoch

    exchange = mocker.patch(
        "dj.apps.social.views.exchange_identity",
        side_effect=[
            {"uid": backup.provider_uid, "handle": "backup", "avatar_url": ""},
            {"uid": original.provider_uid, "handle": "original", "avatar_url": ""},
        ],
    )
    rejected = _social_login(APIClient(), mocker)
    assert rejected.status_code == 403, rejected.content

    original_login = _social_login(APIClient(), mocker)
    assert original_login.status_code == 200, original_login.content

    # The backup is the owner's real login, but it was already rejected by the
    # event-time decision. Removing the only currently usable fallback must be
    # refused until the owner re-links the backup from this session.
    unlink = _token_client(original_login.data["token"]).delete(
        f"/api/auth/social/google/{original.provider_uid}/",
    )
    assert unlink.status_code == 409, unlink.content
    assert b"Set a password or reconnect another login method" in unlink.content
    assert SocialIdentity.objects.filter(pk=original.pk).exists()
    assert SocialIdentity.objects.filter(pk=backup.pk).exists()
    assert exchange.call_count == 2


@pytest.mark.django_db
@override_settings(
    IDENTITY_PASSKEY_SIGNIN_ENABLED=True,
    WEBAUTHN_RP_ID="free2z.cash",
)
def test_passkey_can_survive_social_unlink_after_fallback_selection(
    google_configured, creator_factory,
):
    """The shared login-method registry includes stale passkeys as fallbacks."""
    from dj.apps.identity.models import WebAuthnCredential

    owner = creator_factory(username="passkey-fallback-unlink")
    owner.set_unusable_password()
    owner.save(update_fields=["password", "password_set", "updated_at"])
    social = SocialIdentity.objects.create(
        creator=owner,
        provider="google",
        provider_uid="passkey-fallback-social",
        linked_at_epoch=1,
    )
    passkey = WebAuthnCredential.objects.create(
        creator=owner,
        credential_id=b"passkey-fallback-credential",
        public_key=b"test-public-key",
        rp_id="free2z.cash",
        linked_at_epoch=1,
    )
    SocialIdentity.objects.filter(pk=social.pk).update(
        verified_at=timezone.now() + timezone.timedelta(days=1),
    )

    epoch.bump_account_epoch(
        owner.pk, event=epoch.EVENT_CREDENTIAL_ADMIN_EDIT,
    )
    owner.refresh_from_db()
    social.refresh_from_db()
    passkey.refresh_from_db()
    assert passkey.fallback_rejected_at_epoch is None
    assert social.fallback_rejected_at_epoch == owner.kt_account_epoch

    client = APIClient()
    client.force_authenticate(user=owner)
    response = client.delete(
        f"/api/auth/social/google/{social.provider_uid}/",
    )

    assert response.status_code == 204, response.content
    assert not SocialIdentity.objects.filter(pk=social.pk).exists()
    assert WebAuthnCredential.objects.filter(pk=passkey.pk).exists()
    assert Creator.objects.get(pk=owner.pk).kt_account_epoch == 3


@pytest.mark.django_db
@override_settings(
    TWITTER_CLIENT_ID="test-twitter-id",
    TWITTER_CLIENT_SECRET="test-twitter-secret",
)
def test_reenabling_twitter_login_restamps_it_as_current(
    google_configured, mocker, creator_factory,
):
    """An authenticated X re-enable clears a rejection from its disable event."""
    owner = creator_factory(username="reenable-twitter-fallback")
    owner.set_unusable_password()
    owner.save(update_fields=["password", "password_set", "updated_at"])
    social = SocialIdentity.objects.create(
        creator=owner,
        provider="google",
        provider_uid="reenable-twitter-google",
        linked_at_epoch=1,
    )
    twitter = TwitterProfile.objects.create(
        creator=owner,
        twitter_id="reenable-twitter-id",
        username="reenable-twitter",
        allow_login=True,
        linked_at_epoch=1,
    )
    exchange = _mock_exchange(
        mocker, uid=social.provider_uid, handle="owner@example.com",
    )
    owner.refresh_from_db()

    authenticated = APIClient()
    authenticated.force_authenticate(user=owner)
    disabled = authenticated.put(
        "/api/twitter/public-status/",
        {"is_public": False, "allow_login": False},
        format="json",
    )
    assert disabled.status_code == 200, disabled.content
    twitter.refresh_from_db()
    assert twitter.allow_login is False
    assert twitter.fallback_rejected_at_epoch == 2

    login = _social_login(APIClient(), mocker)
    assert login.status_code == 200, login.content
    owner.refresh_from_db()
    enabled = _token_client(login.data["token"]).put(
        "/api/twitter/public-status/",
        {"is_public": True, "allow_login": True},
        format="json",
    )
    assert enabled.status_code == 200, enabled.content

    twitter.refresh_from_db()
    owner.refresh_from_db()
    assert twitter.linked_at_epoch == owner.kt_account_epoch == 2
    assert twitter.fallback_rejected_at_epoch is None
    assert identity_can_authenticate(twitter, owner)
    assert exchange.call_count >= 1


@pytest.mark.django_db
def test_passwordless_unlink_of_only_unmarked_fallback_is_rejected(creator_factory):
    """Unlink cannot leave a passwordless owner with only rejected rows."""
    owner = creator_factory(username="unlink-lockout-1602")
    owner.set_unusable_password()
    owner.save(update_fields=["password", "password_set", "updated_at"])
    fallback = SocialIdentity.objects.create(
        creator=owner,
        provider="google",
        provider_uid="unlink-lockout-fallback-1602",
        linked_at_epoch=1,
    )
    rejected = SocialIdentity.objects.create(
        creator=owner,
        provider="github",
        provider_uid="unlink-lockout-rejected-1602",
        linked_at_epoch=1,
        fallback_rejected_at_epoch=2,
    )
    client = APIClient()
    client.force_authenticate(user=owner)

    response = client.delete(
        f"/api/auth/social/google/{fallback.provider_uid}/",
    )

    assert response.status_code == 409, response.content
    assert b"Set a password or reconnect another login method" in response.content
    assert SocialIdentity.objects.filter(pk=fallback.pk).exists()
    assert SocialIdentity.objects.filter(pk=rejected.pk).exists()


@pytest.mark.django_db
def test_disabled_oldest_twitter_leaves_social_and_zcash_logins_usable(
    google_configured, creator_factory, mocker,
):
    """A disabled Twitter row must not displace a usable identity."""
    social_owner = creator_factory(username="disabled-twitter-social-1602")
    social_owner.set_unusable_password()
    social_owner.save(update_fields=["password", "password_set", "updated_at"])
    SocialIdentity.objects.create(
        creator=social_owner,
        provider="google",
        provider_uid="disabled-twitter-social-id-1602",
    )
    TwitterProfile.objects.create(
        creator=social_owner,
        twitter_id="disabled-twitter-social-profile-1602",
        username="disabled-twitter-social-1602",
        allow_login=False,
    )
    TwitterProfile.objects.filter(
        twitter_id="disabled-twitter-social-profile-1602",
    ).update(created_at=timezone.now() - timezone.timedelta(days=2))

    zcash_owner = creator_factory(username="disabled-twitter-zcash-1602")
    zcash_owner.set_unusable_password()
    zcash_owner.save(update_fields=["password", "password_set", "updated_at"])
    zcash_address = "t1f3vC5hEbAwJdheoFbwaBYssj2Hwp3MFXX"
    ZcashIdentity.objects.create(
        creator=zcash_owner, zcash_address=zcash_address,
    )
    TwitterProfile.objects.create(
        creator=zcash_owner,
        twitter_id="disabled-twitter-zcash-profile-1602",
        username="disabled-twitter-zcash-1602",
        allow_login=False,
    )
    TwitterProfile.objects.filter(
        twitter_id="disabled-twitter-zcash-profile-1602",
    ).update(created_at=timezone.now() - timezone.timedelta(days=2))

    epoch.bump_account_epoch(
        social_owner.pk, event=epoch.EVENT_TWITTER_LOGIN_TOGGLED,
    )
    epoch.bump_account_epoch(
        zcash_owner.pk, event=epoch.EVENT_TWITTER_LOGIN_TOGGLED,
    )

    mocker.patch(
        "dj.apps.social.views.exchange_identity",
        return_value={
            "uid": "disabled-twitter-social-id-1602",
            "handle": "social-owner-1602",
            "avatar_url": "",
        },
    )
    social_login = _social_login(APIClient(), mocker)
    assert social_login.status_code == 200, social_login.content

    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    zcash_client = APIClient()
    challenge = zcash_client.post(
        "/api/auth/zcash/challenge/",
        {"address": zcash_address},
        format="json",
    )
    assert challenge.status_code == 200, challenge.content
    zcash_login = zcash_client.post(
        "/api/auth/zcash/login/",
        {
            "address": zcash_address,
            "challenge": challenge.data["challenge"],
            "signature": "c2ln",
        },
        format="json",
    )
    assert zcash_login.status_code == 200, zcash_login.content


@pytest.mark.django_db
def test_passwordless_planted_zcash_is_rejected_while_original_social_works(
    google_configured, creator_factory, mocker,
):
    """The Zcash route gets the same newer-identity protection as OAuth."""
    owner = creator_factory(username="planted-zcash-1602")
    owner.set_unusable_password()
    owner.save(update_fields=["password", "password_set", "updated_at"])
    original = SocialIdentity.objects.create(
        creator=owner,
        provider="google",
        provider_uid="original-before-zcash-1602",
    )
    SocialIdentity.objects.filter(pk=original.pk).update(
        verified_at=timezone.now() - timezone.timedelta(days=1),
    )
    address = "t1WnCauSV6fbHzWBHtSrK2qvFRyU6J121nH"
    ZcashIdentity.objects.create(creator=owner, zcash_address=address)
    epoch.bump_account_epoch(
        owner.pk, event=epoch.EVENT_CREDENTIAL_ADMIN_EDIT,
    )

    mocker.patch(
        "dj.apps.social.views.exchange_identity",
        return_value={
            "uid": original.provider_uid,
            "handle": "original-before-zcash-1602",
            "avatar_url": "",
        },
    )
    original_login = _social_login(APIClient(), mocker)
    assert original_login.status_code == 200, original_login.content

    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    client = APIClient()
    challenge = client.post(
        "/api/auth/zcash/challenge/", {"address": address}, format="json",
    )
    assert challenge.status_code == 200, challenge.content
    planted_login = client.post(
        "/api/auth/zcash/login/",
        {
            "address": address,
            "challenge": challenge.data["challenge"],
            "signature": "c2ln",
        },
        format="json",
    )
    assert planted_login.status_code == 403, planted_login.content
    owner.refresh_from_db()
    zcash = ZcashIdentity.objects.get(zcash_address=address)
    assert zcash.fallback_rejected_at_epoch == owner.kt_account_epoch


@pytest.mark.django_db
def test_orphan_twitter_adoption_starts_a_new_identity_age(
    google_configured, creator_factory, mocker,
):
    """A preexisting orphan cannot outrank the identity that adopted it."""
    owner = creator_factory(username="orphan-adoption-1602")
    owner.set_unusable_password()
    owner.save(update_fields=["password", "password_set", "updated_at"])
    original = SocialIdentity.objects.create(
        creator=owner,
        provider="google",
        provider_uid="original-before-orphan-1602",
    )
    SocialIdentity.objects.filter(pk=original.pk).update(
        verified_at=timezone.now() - timezone.timedelta(days=1),
    )
    orphan_created_at = timezone.now() - timezone.timedelta(days=30)
    orphan = TwitterProfile.objects.create(
        creator=None,
        twitter_id="orphan-adoption-1602",
        username="orphan-adoption-1602",
    )
    TwitterProfile.objects.filter(pk=orphan.pk).update(
        created_at=orphan_created_at,
    )
    adopter = APIClient()
    adopter.force_login(owner)
    # This case exercises identity age after successful authenticated
    # adoption; the reauthentication policy has separate coverage.
    mocker.patch("dj.apps.twitter.views.require_recent_auth", return_value=None)
    mocker.patch(
        "dj.apps.twitter.views.is_valid_twitter_request", return_value=True,
    )
    mocker.patch(
        "dj.apps.twitter.views.get_twitter_user",
        return_value={
            "id": orphan.twitter_id,
            "username": orphan.username,
            "name": "Adopted",
            "description": "",
            "profile_image_url": "",
        },
    )
    adopted = adopter.get("/api/twitter/callback")
    assert adopted.status_code == 302, adopted.content
    orphan.refresh_from_db()
    assert orphan.creator_id == owner.pk
    assert orphan.created_at > orphan_created_at

    epoch.bump_account_epoch(
        owner.pk, event=epoch.EVENT_CREDENTIAL_ADMIN_EDIT,
    )
    attacker_login = APIClient().get("/api/twitter/callback")
    assert attacker_login.status_code == 403, attacker_login.content

    mocker.patch(
        "dj.apps.social.views.exchange_identity",
        return_value={
            "uid": original.provider_uid,
            "handle": "original-before-orphan-1602",
            "avatar_url": "",
        },
    )
    original_login = _social_login(APIClient(), mocker)
    assert original_login.status_code == 200, original_login.content


@pytest.mark.django_db
def test_passwordless_oldest_identity_order_is_deterministic_across_providers(
    creator_factory, google_configured, settings,
):
    """Timestamp order wins across the legacy and newer identity models.

    Rows from before the epoch migrations all carry the initial epoch, so the
    provider-specific creation timestamps are the only available age signal.
    Equal timestamps use the explicit provider order in ``ktauth.credentials``.
    """
    settings.TWITTER_CLIENT_ID = "test-twitter-id"
    settings.TWITTER_CLIENT_SECRET = "test-twitter-secret"
    owner = creator_factory(username="cross-provider-1602")
    owner.set_unusable_password()
    owner.save(update_fields=["password", "password_set", "updated_at"])
    social = SocialIdentity.objects.create(
        creator=owner, provider="google", provider_uid="cross-social-1602",
    )
    twitter = TwitterProfile.objects.create(
        creator=owner,
        twitter_id="cross-twitter-1602",
        username="cross-twitter-1602",
    )
    zcash = ZcashIdentity.objects.create(
        creator=owner,
        zcash_address="t1WnCauSV6fbHzWBHtSrK2qvFRyU6J121nH",
    )
    same_timestamp = timezone.now() - timezone.timedelta(days=2)
    SocialIdentity.objects.filter(pk=social.pk).update(
        verified_at=same_timestamp,
        linked_at_epoch=1,
    )
    TwitterProfile.objects.filter(pk=twitter.pk).update(
        created_at=same_timestamp,
        linked_at_epoch=1,
    )
    ZcashIdentity.objects.filter(pk=zcash.pk).update(
        created_at=same_timestamp,
        linked_at_epoch=1,
    )
    epoch.bump_account_epoch(
        owner.pk, event=epoch.EVENT_CREDENTIAL_ADMIN_EDIT,
    )
    owner.refresh_from_db()
    social.refresh_from_db()
    twitter.refresh_from_db()
    zcash.refresh_from_db()

    # ``social`` is first only because the timestamp tie-break is explicit;
    # this is deterministic, not a claim that Google is intrinsically trusted.
    assert identity_can_authenticate(social, owner)
    assert not identity_can_authenticate(twitter, owner)
    assert not identity_can_authenticate(zcash, owner)


@pytest.mark.django_db
def test_same_provider_timestamp_tie_uses_stable_provider_identifier(
    creator_factory, google_configured,
):
    """Same-provider legacy rows are ordered without query-result luck."""
    owner = creator_factory(username="same-provider-tie-1602")
    owner.set_unusable_password()
    owner.save(update_fields=["password", "password_set", "updated_at"])
    first = SocialIdentity.objects.create(
        creator=owner, provider="google", provider_uid="a-tie-1602",
    )
    second = SocialIdentity.objects.create(
        creator=owner, provider="google", provider_uid="b-tie-1602",
    )
    same_timestamp = timezone.now() - timezone.timedelta(days=2)
    SocialIdentity.objects.filter(pk__in=[first.pk, second.pk]).update(
        verified_at=same_timestamp, linked_at_epoch=1,
    )
    epoch.bump_account_epoch(
        owner.pk, event=epoch.EVENT_CREDENTIAL_ADMIN_EDIT,
    )
    owner.refresh_from_db()
    first.refresh_from_db()
    second.refresh_from_db()
    assert identity_can_authenticate(first, owner)
    assert not identity_can_authenticate(second, owner)


@pytest.mark.django_db
@pytest.mark.parametrize("bad_epoch", [None, 3])
def test_passwordless_identity_refuses_missing_or_future_epoch(
    creator_factory, bad_epoch,
):
    """Anomalous epoch data never becomes a passwordless bypass."""
    owner = creator_factory(username=f"bad-epoch-{bad_epoch}-1602")
    owner.set_unusable_password()
    owner.save(update_fields=["password", "password_set", "updated_at"])
    identity = SocialIdentity.objects.create(
        creator=owner, provider="google", provider_uid=f"bad-{bad_epoch}-1602",
    )
    epoch.bump_account_epoch(
        owner.pk, event=epoch.EVENT_CREDENTIAL_ADMIN_EDIT,
    )
    owner.refresh_from_db()
    identity.linked_at_epoch = bad_epoch
    assert not identity_can_authenticate(identity, owner)


@pytest.mark.django_db
def test_future_epoch_row_cannot_displace_valid_stale_fallback(
    creator_factory, google_configured,
):
    """Corrupt future data must not hide an otherwise usable fallback."""
    owner = creator_factory(username="future-fallback-1602")
    owner.set_unusable_password()
    owner.save(update_fields=["password", "password_set", "updated_at"])
    valid = SocialIdentity.objects.create(
        creator=owner, provider="google", provider_uid="valid-fallback-1602",
        linked_at_epoch=1,
    )
    SocialIdentity.objects.create(
        creator=owner, provider="github", provider_uid="future-row-1602",
        linked_at_epoch=3,
    )
    epoch.bump_account_epoch(
        owner.pk, event=epoch.EVENT_CREDENTIAL_ADMIN_EDIT,
    )
    owner.refresh_from_db()
    valid.refresh_from_db()
    assert identity_can_authenticate(valid, owner)


@pytest.mark.django_db
def test_current_epoch_and_usable_password_paths_are_unchanged(creator_factory):
    """Current identities still work; password-backed stale identities do not."""
    owner = creator_factory(username="bypass-controls-1602")
    identity = SocialIdentity.objects.create(
        creator=owner, provider="google", provider_uid="bypass-1602",
    )
    Creator.objects.filter(pk=owner.pk).update(kt_account_epoch=2)
    owner.refresh_from_db()
    identity.linked_at_epoch = owner.kt_account_epoch
    assert identity_can_authenticate(identity, owner)

    identity.linked_at_epoch = 1
    assert owner.has_usable_password()
    assert not identity_can_authenticate(identity, owner)


@pytest.mark.django_db
def test_durable_fallback_rejection_beats_current_epoch_fast_path(
    creator_factory,
):
    """A rejected row cannot bypass its marker by looking current."""
    owner = creator_factory(username="durably-rejected-current-1602")
    owner.set_unusable_password()
    owner.save(update_fields=["password", "password_set", "updated_at"])
    rejected = SocialIdentity.objects.create(
        creator=owner,
        provider="google",
        provider_uid="durably-rejected-current-1602",
    )
    backup = SocialIdentity.objects.create(
        creator=owner,
        provider="github",
        provider_uid="durably-rejected-backup-1602",
    )
    rejected.fallback_rejected_at_epoch = owner.kt_account_epoch
    assert not identity_can_authenticate(rejected, owner)
    assert identity_can_authenticate(backup, owner)


@pytest.mark.django_db
def test_passwordless_single_zcash_identity_survives_an_epoch_transition(
    creator_factory, mocker,
):
    """The one-identity control is driven through the real Zcash login route."""
    owner = creator_factory(username="single-zcash-1602")
    owner.set_unusable_password()
    owner.save(update_fields=["password", "password_set", "updated_at"])
    address = "t1WnCauSV6fbHzWBHtSrK2qvFRyU6J121nH"
    ZcashIdentity.objects.create(creator=owner, zcash_address=address)
    epoch.bump_account_epoch(
        owner.pk, event=epoch.EVENT_CREDENTIAL_ADMIN_EDIT,
    )
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    client = APIClient()
    challenge = client.post(
        "/api/auth/zcash/challenge/", {"address": address}, format="json",
    )
    assert challenge.status_code == 200, challenge.content
    response = client.post(
        "/api/auth/zcash/login/",
        {
            "address": address,
            "challenge": challenge.data["challenge"],
            "signature": "c2ln",
        },
        format="json",
    )
    assert response.status_code == 200, response.content
    assert response.data["username"] == owner.username


@pytest.mark.django_db
def test_passwordless_single_twitter_identity_survives_an_epoch_transition(
    creator_factory, mocker, settings,
):
    """The legacy Twitter session route keeps its sole identity usable."""
    settings.TWITTER_CLIENT_ID = "test-twitter-id"
    settings.TWITTER_CLIENT_SECRET = "test-twitter-secret"
    owner = creator_factory(username="single-twitter-1602")
    owner.set_unusable_password()
    owner.save(update_fields=["password", "password_set", "updated_at"])
    TwitterProfile.objects.create(
        creator=owner,
        twitter_id="single-twitter-id-1602",
        username="single-twitter-1602",
        allow_login=True,
    )
    epoch.bump_account_epoch(
        owner.pk, event=epoch.EVENT_CREDENTIAL_ADMIN_EDIT,
    )
    mocker.patch(
        "dj.apps.twitter.views.is_valid_twitter_request", return_value=True,
    )
    mocker.patch(
        "dj.apps.twitter.views.get_twitter_user",
        return_value={
            "id": "single-twitter-id-1602",
            "username": "single-twitter-1602",
            "name": "Owner",
            "description": "",
            "profile_image_url": "",
        },
    )
    client = APIClient()
    response = client.get("/api/twitter/callback")
    assert response.status_code == 302, response.content
    assert client.session["_auth_user_id"] == str(owner.pk)


@pytest.mark.django_db
def test_event_does_not_reject_rows_when_no_fallback_is_eligible(creator_factory):
    """An empty eligible set is not evidence to permanently reject a method."""
    owner = creator_factory(username="no-eligible-fallback-1602")
    owner.set_unusable_password()
    owner.save(update_fields=["password", "password_set", "updated_at"])
    disabled = TwitterProfile.objects.create(
        creator=owner,
        twitter_id="disabled-only-fallback-1602",
        username="disabled_only_fallback_1602",
        allow_login=False,
    )

    epoch.bump_account_epoch(
        owner.pk, event=epoch.EVENT_PASSWORD_CHANGE,
    )

    disabled.refresh_from_db()
    assert disabled.fallback_rejected_at_epoch is None


@pytest.mark.django_db
def test_planted_zcash_identity_cannot_sign_in_after_a_password_change(
    creator_factory, mocker,
):
    """ on the Zcash path. Same shape, separate model, separate app."""
    owner = creator_factory(username="zcashvictim")
    address = "t1WnCauSV6fbHzWBHtSrK2qvFRyU6J121nH"
    ZcashIdentity.objects.create(creator=owner, zcash_address=address)

    _change_password(owner)

    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    challenge = APIClient().post(
        "/api/auth/zcash/challenge/", {"address": address}, format="json",
    )
    assert challenge.status_code == 200, challenge.content
    login = APIClient().post(
        "/api/auth/zcash/login/",
        {
            "address": address,
            "challenge": challenge.data["challenge"],
            "signature": "c2ln",
        },
        format="json",
    )
    # status-negation-ok: the security property is "no session is issued",
    # asserted directly on the next line; any refusal status satisfies it.
    assert login.status_code != 200, login.content
    assert not AuthToken.objects.filter(user=owner).exists()


@pytest.mark.django_db
def test_planted_twitter_identity_cannot_sign_in_after_a_password_change(
    creator_factory, mocker,
):
    """ on the legacy Twitter path -- the family that predates ``social``.

    It is easy to miss precisely because the newer app looks like it superseded
    it, and it is a *session* login rather than a Knox one, so the eviction has
    to hold on both credential shapes.
    """
    owner = creator_factory(username="twittervictim")
    TwitterProfile.objects.create(
        creator=owner,
        twitter_id="planted-twitter-id",
        username="attackerhandle",
        allow_login=True,
    )

    _change_password(owner)

    mocker.patch(
        "dj.apps.twitter.views.is_valid_twitter_request", return_value=True,
    )
    mocker.patch(
        "dj.apps.twitter.views.get_twitter_user",
        return_value={
            "id": "planted-twitter-id",
            "username": "attackerhandle",
            "name": "A",
            "description": "",
            "profile_image_url": "",
        },
    )
    client = APIClient()
    client.get("/api/twitter/callback")
    # OUTCOME: no session was established for the victim.
    assert "_auth_user_id" not in client.session


@pytest.mark.django_db
def test_anonymous_twitter_callback_reloads_event_marker_before_authentication(
    google_configured, settings, creator_factory, mocker,
):
    """An event landing after the callback read cannot be erased by metadata."""
    settings.TWITTER_CLIENT_ID = "test-twitter-id"
    settings.TWITTER_CLIENT_SECRET = "test-twitter-secret"
    owner = creator_factory(username="twitter-event-interleave-1602")
    owner.set_unusable_password()
    owner.save(update_fields=["password", "password_set", "updated_at"])
    SocialIdentity.objects.create(
        creator=owner,
        provider="google",
        provider_uid="twitter-event-interleave-google",
        linked_at_epoch=1,
    )
    profile = TwitterProfile.objects.create(
        creator=owner,
        twitter_id="twitter-event-interleave-x",
        username="twitter_event_interleave_x",
        allow_login=True,
        linked_at_epoch=1,
    )
    mocker.patch(
        "dj.apps.twitter.views.is_valid_twitter_request", return_value=True,
    )
    mocker.patch(
        "dj.apps.twitter.views.get_twitter_user",
        return_value={
            "id": profile.twitter_id,
            "username": profile.username,
            "name": "Updated name",
            "description": "updated description",
            "profile_image_url": "",
        },
    )

    get_or_create = TwitterProfile.objects.get_or_create

    def read_then_commit_event(*args, **kwargs):
        # Return the callback's pre-event instance, then land the owner's
        # event before callback code enters its account-lock/auth phase.
        row, created = get_or_create(*args, **kwargs)
        assert not created
        epoch.bump_account_epoch(
            owner.pk, event=epoch.EVENT_PASSWORD_CHANGE,
        )
        return row, created

    mocker.patch.object(
        TwitterProfile.objects,
        "get_or_create",
        side_effect=read_then_commit_event,
    )
    client = APIClient()
    response = client.get("/api/twitter/callback")

    assert response.status_code == 403, response.content
    assert "_auth_user_id" not in client.session
    owner.refresh_from_db()
    profile.refresh_from_db()
    assert profile.fallback_rejected_at_epoch == owner.kt_account_epoch


@pytest.mark.django_db
def test_foreign_x_identity_never_refreshes_the_signed_in_victims_auth(
    settings, creator_factory, mocker,
):
    """A stale stolen session + the attacker's OWN X login is not re-auth.

    The callback must never authenticate ``request.user`` with an X identity
    linked to a different Creator. If it does, the attacker's own OAuth proof
    records fresh authentication on the victim's session, which satisfies
    the recent-auth gate on a passwordless victim's first-password set: a
    persistent takeover. The session must instead switch to the profile's
    owner (the behaviour on ``main``), leaving the victim untouched.
    """
    from django.contrib.auth import SESSION_KEY

    settings.TWITTER_CLIENT_ID = "test-twitter-id"
    settings.TWITTER_CLIENT_SECRET = "test-twitter-secret"
    victim = creator_factory(username="foreign-x-victim-1860")
    victim.set_unusable_password()
    victim.save(update_fields=["password", "password_set", "updated_at"])
    SocialIdentity.objects.create(
        creator=victim,
        provider="google",
        provider_uid="foreign-x-victim-google",
        linked_at_epoch=victim.kt_account_epoch,
    )
    attacker = creator_factory(username="foreign-x-attacker-1860")
    profile = TwitterProfile.objects.create(
        creator=attacker,
        twitter_id="foreign-x-attacker-x",
        username="foreign_x_attacker_x",
        allow_login=True,
        linked_at_epoch=attacker.kt_account_epoch,
    )
    assert profile.linked_at_epoch == victim.kt_account_epoch
    mocker.patch(
        "dj.apps.twitter.views.is_valid_twitter_request", return_value=True,
    )
    mocker.patch(
        "dj.apps.twitter.views.get_twitter_user",
        return_value={
            "id": profile.twitter_id,
            "username": profile.username,
            "name": "n",
            "description": "",
            "profile_image_url": "",
        },
    )

    client = APIClient()
    client.force_login(victim)  # a stolen session with no recent auth
    refused = client.post(
        "/api/emails/change-password",
        {"new_password": "Attacker-Owned-9!"},
        format="json",
    )
    assert refused.status_code == 401, refused.content

    response = client.get("/api/twitter/callback")
    assert response.status_code == 302, response.content
    assert client.session.get(SESSION_KEY) == str(attacker.pk)

    client.post(
        "/api/emails/change-password",
        {"new_password": "Attacker-Owned-9!"},
        format="json",
    )
    victim.refresh_from_db()
    assert not victim.has_usable_password()


# --------------------------------------------------------------------------- #
#  -- a credential issued CONCURRENTLY with the revocation
# --------------------------------------------------------------------------- #


@pytest.mark.django_db(transaction=True)
def test_a_token_minted_during_the_revocation_window_cannot_authenticate(
    google_configured, mocker,
):
    """The interleaving itself, on two real connections. Not an approximation.

    A sequential "issue then revoke" proves nothing about this race: 's
    revocation is an enumerate-then-delete, and what defeats it is a row
    committed *after* the enumeration. So the login is paused between its
    identity read and ``AuthToken.objects.create()`` -- exactly where
    ``py/dj/apps/social/views.py`` sits when the sweep runs -- the ownership
    event is committed on the main connection, and only then is the login let
    go. The token it returns is a row the sweep could not have seen.
    """
    _mock_exchange(mocker)
    first = _social_login(APIClient(), mocker)
    assert first.status_code == 200, first.content
    creator = SocialIdentity.objects.get(provider_uid=GOOGLE_UID).creator
    # Give the account a usable password: a passwordless account is exempt
    # from the identity check (see the control above), and this test is about
    # the token race, not the identity.
    Creator.objects.filter(pk=creator.pk).update(
        password=make_password("password"), password_set=True,
    )
    AuthToken.objects.filter(user=creator).delete()

    at_the_insert = threading.Event()
    let_it_commit = threading.Event()
    real_create = AuthToken.objects.create

    def paused_create(user, *args, **kwargs):
        at_the_insert.set()
        assert let_it_commit.wait(30), "the ownership event never committed"
        return real_create(user, *args, **kwargs)

    mocker.patch.object(AuthToken.objects, "create", paused_create)

    result = {}

    def racing_login():
        try:
            result["response"] = _social_login(APIClient(), mocker)
        finally:
            connection.close()

    login_thread = threading.Thread(target=racing_login)
    login_thread.start()
    try:
        assert at_the_insert.wait(30), "the login never reached token issuance"
        # The sweep runs and COMMITS while the login is parked one statement
        # short of its INSERT.
        epoch.bump_account_epoch(
            creator.pk, event=epoch.EVENT_SOCIAL_IDENTITY_UNLINKED,
        )
    finally:
        let_it_commit.set()
        login_thread.join(timeout=60)
    assert not login_thread.is_alive()

    response = result["response"]
    # status-negation-ok: a fix that refuses to issue at all is also a pass --
    # nothing was handed out, so nothing survived the event.
    if response.status_code != 200:
        return
    raced_token = response.data["token"]

    # OUTCOME: the token the evicted principal walked away with authenticates
    # nothing. Any authenticated route will do; this one is the cheapest.
    probe = _token_client(raced_token).get("/api/auth/user/")
    assert probe.status_code in (401, 403), probe.content


# --------------------------------------------------------------------------- #
#, the session half -- no stamp table, and no test would have noticed
# --------------------------------------------------------------------------- #


@pytest.mark.django_db
def test_a_session_created_during_the_revocation_window_cannot_authenticate(
    creator_factory,
):
    """The same race as the Knox one, on the credential the SPA actually uses.

    ``bump_account_epoch`` deletes session rows, and a login already past its
    credential check inserts its row afterwards. ``django.contrib.auth.login``
    computes the session's auth hash from the user instance the login is
    holding -- loaded before the event -- so mixing the counter into
    ``get_session_auth_hash`` makes that cookie disagree with the row the next
    time it is presented. Driven exactly that way here: a stale instance, a
    committed event, then a session created from the stale instance.
    """
    owner = creator_factory(username="racedsession")
    stale = Creator.objects.get(pk=owner.pk)

    epoch.bump_account_epoch(owner.pk, event=epoch.EVENT_PASSWORD_CHANGE)

    request = RequestFactory().get("/")
    request.session = SessionStore()
    django_login(
        request, stale, backend="django.contrib.auth.backends.ModelBackend",
    )
    request.session.save()

    client = APIClient()
    client.cookies[settings.SESSION_COOKIE_NAME] = request.session.session_key
    probe = client.get("/api/auth/user/")
    assert probe.status_code in (401, 403), probe.content


@pytest.mark.django_db
def test_an_ordinary_session_still_authenticates(creator_factory):
    """The control for the above. Signing everybody out is not a fix."""
    owner = creator_factory(username="ordinarysession")

    request = RequestFactory().get("/")
    request.session = SessionStore()
    django_login(
        request,
        Creator.objects.get(pk=owner.pk),
        backend="django.contrib.auth.backends.ModelBackend",
    )
    request.session.save()

    client = APIClient()
    client.cookies[settings.SESSION_COOKIE_NAME] = request.session.session_key
    probe = client.get("/api/auth/user/")
    assert probe.status_code == 200, probe.content


@pytest.mark.django_db
def test_the_session_hash_is_unchanged_for_an_account_with_no_event_yet(
    creator_factory,
):
    """Every live session on the platform must survive the deploy.

    The counter is mixed in only once an account has actually had an ownership
    event; at ``INITIAL_ACCOUNT_EPOCH`` the value is Django's own, byte for
    byte. Without that, shipping this change would recompute every session's
    auth hash at once and sign the entire platform out -- and the property is
    invisible in any behavioural test, because a fresh test session is written
    with whatever hash the code computes.

    Asserted against Django's implementation rather than a hard-coded digest,
    so a Django upgrade that changes the base computation is a failure here
    rather than a mass logout in production.
    """
    owner = creator_factory(username="untouched")
    assert owner.kt_account_epoch == epoch.INITIAL_ACCOUNT_EPOCH

    stock = AbstractBaseUser._get_session_auth_hash(owner)
    assert owner.get_session_auth_hash() == stock

    Creator.objects.filter(pk=owner.pk).update(kt_account_epoch=2)
    moved = Creator.objects.get(pk=owner.pk)
    assert moved.get_session_auth_hash() != stock


@pytest.mark.django_db
def test_every_knox_token_is_stamped_including_the_ones_knox_mints_itself(
    creator_factory,
):
    """A token with no stamp is refused, so "no stamp" must be unreachable.

    ``/api/token/login/`` is ``knox.views.LoginView`` -- third-party code this
    repo never calls -- so the stamp cannot be an argument to a helper the
    login views agree to use. It is written by a ``post_save`` receiver on the
    model instead, and this is the test that the receiver actually covers the
    issuer nobody here wrote.
    """
    owner = creator_factory(username="knoxlogin")
    client = APIClient()
    _instance, raw = AuthToken.objects.create(owner)
    client.credentials(HTTP_AUTHORIZATION=f"Token {raw}")

    minted = client.post("/api/token/login/")
    assert minted.status_code == 200, minted.content

    stamps = IssuedTokenEpoch.objects.filter(token__user=owner)
    assert stamps.count() == AuthToken.objects.filter(user=owner).count()
    assert set(stamps.values_list("account_epoch", flat=True)) == {
        owner.kt_account_epoch,
    }


@pytest.mark.django_db(transaction=True)
def test_the_knox_login_view_race_also_yields_a_dead_token(creator_factory):
    """The same interleaving on ``/api/token/login/`` -- knox's own issuer.

    Raised by the codex adversarial review of this change, and it is a
    different code path with a different failure: the two login views in this
    repo stamp from their own validating snapshot, but knox's view is
    third-party and gets its stamp from the ``post_save`` receiver, which
    necessarily reads the counter AFTER the insert. One statement too late --
    the attacker starts the POST at epoch N, the event commits to N+1, and the
    receiver would stamp the brand-new token N+1.

    Two real connections, as above; the issuer is parked between authenticating
    the caller and inserting the token.
    """
    owner = creator_factory(username="knoxrace")
    _instance, caller_token = AuthToken.objects.create(owner)

    at_the_insert = threading.Event()
    let_it_commit = threading.Event()
    real_create = AuthToken.objects.create

    def paused_create(user, *args, **kwargs):
        at_the_insert.set()
        assert let_it_commit.wait(30), "the ownership event never committed"
        return real_create(user, *args, **kwargs)

    result = {}

    def racing_login():
        try:
            client = APIClient()
            client.credentials(HTTP_AUTHORIZATION=f"Token {caller_token}")
            result["response"] = client.post("/api/token/login/")
        finally:
            connection.close()

    with mock.patch.object(AuthToken.objects, "create", paused_create):
        login_thread = threading.Thread(target=racing_login)
        login_thread.start()
        try:
            assert at_the_insert.wait(30), "never reached token issuance"
            epoch.bump_account_epoch(
                owner.pk, event=epoch.EVENT_PASSWORD_CHANGE,
            )
        finally:
            let_it_commit.set()
            login_thread.join(timeout=60)
    assert not login_thread.is_alive()

    response = result["response"]
    # status-negation-ok: a refusal to issue is a pass; only an issued token
    # has to be probed below.
    if response.status_code != 200:
        return
    probe = _token_client(response.data["token"]).get("/api/auth/user/")
    assert probe.status_code in (401, 403), probe.content
