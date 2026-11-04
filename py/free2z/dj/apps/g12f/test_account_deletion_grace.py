"""Account deletion's 30-day grace period: request -> sign in to keep -> purge.

Real Postgres, real endpoints, one test per sign-in backend. What each
protects:

* a request deactivates at once and kills every credential, but deletes
  nothing and keeps the sign-in methods;
* during the grace period EVERY sign-in path (password, password+TOTP, the
  OTP login, X, Zcash wallet, social) answers "keep?" with a keep token and
  creates no session, no Knox token and no AuthContext;
* only an account in its grace period gets that answer -- a banned or
  otherwise deactivated account, or one past its purge date, never does;
* "Keep my account" reactivates, records and notifies, and signs in; app
  grants stay revoked; the keep token is single-use and short-lived;
* the purge re-checks under the row lock (cancel and purge race), and a
  blocker pauses it loudly, at a bounded rate;
* money during the grace period behaves as documented.
"""
from __future__ import annotations

import json
import logging
import uuid
from decimal import Decimal

import pytest
from django.core import mail
from django.test import Client
from django.utils import timezone
from knox.models import AuthToken
from rest_framework.test import APIClient

from dj.apps.g12f import account_deletion
from dj.apps.g12f.models import AccountDeletionEvent, Creator, zPage
from dj.apps.identity.models import AuthContext
# The login-auth-context suite's helpers and autouse fixtures (frozen TOTP
# clock, captcha stub, clean caches).
from dj.apps.identity.tests import test_login_auth_context as _login_suite
from dj.apps.identity.tests.test_login_auth_context import (  # noqa: F401 -- fixtures
    PASSWORD, ZCASH_ADDRESS, _captcha_passes, _clean_caches, _enable_totp,
    _frozen_totp_clock, _social_login, _totp, _twitter_callback,
)
from dj.apps.oidc.models import AppAuthorization, F2ZApplication
from dj.apps.social.models import SocialIdentity
from dj.apps.twitter.models import TwitterProfile
from dj.apps.zauth.models import ZcashIdentity

pytestmark = pytest.mark.django_db


@pytest.fixture
def google(settings):
    return _login_suite.google.__wrapped__(settings)


@pytest.fixture
def isolated_zcash_admission(settings, request):
    return _login_suite.isolated_zcash_admission.__wrapped__(settings, request)

URL = "/api/auth/account-deletion/"
SCHEDULE_URL = "/api/auth/account-deletion/schedule/"
KEEP_URL = "/api/auth/account-deletion/keep/"


def _fresh(user):
    return Creator.objects.get(pk=user.pk)


@pytest.fixture
def holder(creator_factory, recent_login):
    """An account whose holder has just requested deletion, with an app
    grant and a page."""
    user = creator_factory(username="leaving_soon", password=PASSWORD)
    app = F2ZApplication.objects.create(
        name="Some app", user=creator_factory(username="dev_a"),
        client_type=F2ZApplication.CLIENT_PUBLIC,
        redirect_uris="https://app.example.com/cb", allowed_scopes="openid")
    AppAuthorization.objects.create(user=user, application=app, scope="openid")
    zPage.objects.create(creator=user, free2zaddr=str(uuid.uuid4()), title="t",
                         description="d", content="c", is_published=True)
    client = APIClient()
    recent_login(client, user)
    response = client.post(SCHEDULE_URL, {"confirm_username": "leaving_soon"}, format="json")
    assert response.status_code == 202, response.content
    user.request_client = client
    return user


def _no_credentials_created(user):
    assert not AuthToken.objects.filter(user_id=user.pk).exists()
    assert not AuthContext.objects.filter(creator_id=user.pk).exists()


def _password_login(client, username, password=PASSWORD, **extra):
    return client.post("/api/auth/login/", {
        "username": username, "password": password,
        "captcha_result": "ci-valid-captcha", **extra,
    }, format="json")


def _pending_login(username="leaving_soon"):
    """A password sign-in to a pending account: ``(browser, keep_token)``.
    The token is bound to that browser (its keep cookie)."""
    browser = APIClient()
    response = _password_login(browser, username)
    assert response.status_code == 409, response.content
    return browser, response.json()["keep_token"]


def _keep(token, browser=None):
    return (browser or APIClient()).post(KEEP_URL, {"keep_token": token}, format="json")


# --- the request ------------------------------------------------------------


def test_a_request_deactivates_now_and_deletes_nothing(holder):
    row = _fresh(holder)
    assert not row.is_active and row.deletion_pending()
    assert row.purge_after - row.deletion_requested_at == account_deletion.GRACE_PERIOD
    assert row.has_usable_password()                     # can come back
    assert zPage.objects.filter(creator_id=holder.pk).exists()   # nothing deleted
    assert not AppAuthorization.objects.live().filter(user_id=holder.pk).exists()
    # The requesting browser is signed out, and nothing else survives either.
    assert holder.request_client.get("/api/auth/user/").status_code in (401, 403)
    assert not AuthToken.objects.filter(user_id=holder.pk).exists()
    assert AccountDeletionEvent.objects.filter(creator_id=holder.pk, kind="scheduled").exists()


# --- every sign-in path answers "keep?" -------------------------------------


def test_password_sign_in_answers_keep_and_signs_nobody_in(holder):
    AuthContext.objects.filter(creator_id=holder.pk).delete()
    client = APIClient()
    response = _password_login(client, "leaving_soon")
    assert response.status_code == 409, response.content
    body = response.json()
    assert body["code"] == "deletion_pending" and body["keep_token"]
    assert body["purge_after"].startswith(_fresh(holder).purge_after.date().isoformat())
    assert client.get("/api/auth/user/").status_code in (401, 403)
    _no_credentials_created(holder)


def test_a_wrong_password_learns_nothing_about_a_pending_account(holder):
    response = _password_login(APIClient(), "leaving_soon", password="wrong")
    assert response.status_code == 400
    assert "keep_token" not in response.content.decode()


def test_password_and_totp_needs_the_code_before_keep(holder):
    _enable_totp(holder)
    AuthContext.objects.filter(creator_id=holder.pk).delete()
    refused = _password_login(APIClient(), "leaving_soon")
    assert refused.status_code == 400 and "keep_token" not in refused.content.decode()
    response = _password_login(APIClient(), "leaving_soon", otp_token=_totp())
    assert response.status_code == 409
    _no_credentials_created(holder)


def test_the_otp_login_view_answers_keep(holder):
    _enable_totp(holder)
    AuthContext.objects.filter(creator_id=holder.pk).delete()
    response = APIClient().post("/api/otp/login/", {
        "username": "leaving_soon", "password": PASSWORD, "token": _totp(),
    }, format="json")
    assert response.status_code == 409, response.content
    assert response.json()["keep_token"]
    _no_credentials_created(holder)


def test_social_sign_in_answers_keep_with_no_token(holder, google, mocker):
    SocialIdentity.objects.create(
        creator=holder, provider="google", provider_uid="g-leaving",
        handle="g@example.com", linked_at_epoch=_fresh(holder).kt_account_epoch)
    AuthContext.objects.filter(creator_id=holder.pk).delete()
    response = _social_login(APIClient(), mocker, uid="g-leaving")
    assert response.status_code == 409, response.content
    assert response.json()["keep_token"] and "token" not in response.json()
    _no_credentials_created(holder)


def test_zcash_sign_in_answers_keep_with_no_token(holder, mocker, isolated_zcash_admission):
    ZcashIdentity.objects.create(creator=holder, zcash_address=ZCASH_ADDRESS,
                                 linked_at_epoch=_fresh(holder).kt_account_epoch)
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    AuthContext.objects.filter(creator_id=holder.pk).delete()
    client = APIClient()
    challenge = client.post("/api/auth/zcash/challenge/", {"address": ZCASH_ADDRESS},
                            format="json")
    response = client.post("/api/auth/zcash/login/", {
        "address": ZCASH_ADDRESS, "challenge": challenge.data["challenge"],
        "signature": "valid-signature"}, format="json")
    assert response.status_code == 409, response.content
    assert response.json()["keep_token"]
    _no_credentials_created(holder)


def test_x_sign_in_lands_on_the_keep_page_with_no_session(holder, mocker):
    TwitterProfile.objects.create(
        creator=holder, twitter_id="tw-leaving", username="tw-leaving",
        allow_login=True, linked_at_epoch=_fresh(holder).kt_account_epoch)
    AuthContext.objects.filter(creator_id=holder.pk).delete()
    client = Client()
    response = _twitter_callback(client, mocker, "tw-leaving")
    assert response.status_code == 302
    location = response["Location"]
    assert location.startswith("/account/keep#t=")
    assert "?" not in location.split("#")[0]           # never in the query string
    assert client.session.get("_auth_user_id") is None
    _no_credentials_created(holder)

    #... and that keep token keeps the account and signs the X holder in.
    token = location.split("#t=")[1].split("&")[0]
    from urllib.parse import unquote

    # Not from another browser: the token is bound to this one (login CSRF).
    elsewhere = Client().post(KEEP_URL, {"keep_token": unquote(token)},
                              content_type="application/json")
    assert elsewhere.status_code == 400, elsewhere.content
    assert not _fresh(holder).is_active
    kept = client.post(KEEP_URL, {"keep_token": unquote(token)},
                       content_type="application/json")
    assert kept.status_code == 200, kept.content
    assert _fresh(holder).is_active


# --- only a pending account ever gets that answer ---------------------------


def test_a_banned_or_deactivated_account_never_gets_a_keep_token(creator_factory):
    banned = creator_factory(username="banned_one", password=PASSWORD)
    Creator.objects.filter(pk=banned.pk).update(is_active=False)
    response = _password_login(APIClient(), "banned_one")
    assert response.status_code == 400
    assert "keep_token" not in response.content.decode()
    assert not _fresh(banned).deletion_pending()


def test_an_account_past_its_purge_date_can_be_kept_until_it_is_purged(holder):
    """A purge that has not run yet -- or is blocked by earnings owed --
    must not lock the holder out of the account they need to settle."""
    Creator.objects.filter(pk=holder.pk).update(
        purge_after=timezone.now() - timezone.timedelta(minutes=1))
    browser, token = _pending_login("leaving_soon")
    assert _keep(token, browser).status_code == 200
    assert _fresh(holder).is_active


def test_a_purged_account_gets_no_keep_token(holder):
    account_deletion.purge_due_deletions(
        now=timezone.now() + account_deletion.GRACE_PERIOD + timezone.timedelta(seconds=1))
    assert not _fresh(holder).deletion_pending()
    assert _password_login(APIClient(), "leaving_soon").status_code == 400


# --- keep -------------------------------------------------------------------


def test_keep_reactivates_records_and_signs_in_but_grants_stay_revoked(holder):
    epoch_before = _fresh(holder).kt_account_epoch
    client, token = _pending_login("leaving_soon")
    kept = client.post(KEEP_URL, {"keep_token": token}, format="json")
    assert kept.status_code == 200, kept.content
    row = _fresh(holder)
    assert row.is_active and not row.deletion_pending()
    assert row.deletion_requested_at is None and row.purge_after is None
    assert row.deletion_cancelled_at is not None
    assert row.kt_account_epoch == epoch_before + 1                # ownership event
    assert AccountDeletionEvent.objects.filter(creator_id=holder.pk, kind="cancelled").exists()
    assert client.get("/api/auth/user/").status_code == 200        # signed in now
    assert not AppAuthorization.objects.live().filter(user_id=holder.pk).exists()
    preview = client.get(URL).json()
    assert preview["deletion_cancelled_at"] is not None


def test_a_keep_token_is_single_use_and_expires(holder):
    token_browser, token = _pending_login("leaving_soon")
    nonce = token_browser.cookies[account_deletion.KEEP_COOKIE].value
    assert _keep(token, token_browser).status_code == 200
    # Replayed from the same browser, binding cookie and all: still spent.
    token_browser.cookies[account_deletion.KEEP_COOKIE] = nonce
    again = _keep(token, token_browser)
    assert again.status_code == 400 and again.json()["code"] == "keep_token_invalid"

    # A second request, then a token older than its ten minutes.
    client = APIClient()
    client.force_login(_fresh(holder))
    from types import SimpleNamespace

    from dj.apps.identity.auth_context import record_login
    session = client.session
    record_login(SimpleNamespace(session=session), _fresh(holder), methods=["pwd"])
    from django.conf import settings
    client.cookies[settings.SESSION_COOKIE_NAME] = session.session_key
    assert client.post(SCHEDULE_URL, {"confirm_username": "leaving_soon"},
                       format="json").status_code == 202
    stale_browser, stale = _pending_login("leaving_soon")
    import time
    from unittest import mock
    with mock.patch("django.core.signing.time.time",
                    return_value=time.time() + account_deletion.KEEP_TOKEN_MAX_AGE + 5):
        assert _keep(stale, stale_browser).status_code == 400
    assert not _fresh(holder).is_active


def test_keep_token_is_refused_after_an_ownership_epoch_change(holder):
    from dj.apps.ktauth.epoch import EVENT_PASSWORD_RESET, bump_account_epoch

    browser, token = _pending_login("leaving_soon")
    nonce = browser.cookies[account_deletion.KEEP_COOKIE].value
    claims = account_deletion.read_keep_token(token, browser_nonce=nonce)
    bump_account_epoch(holder.pk, event=EVENT_PASSWORD_RESET)
    pending = _fresh(holder)
    assert pending.kt_account_epoch == claims["e"] + 1
    assert account_deletion.keep_allowed(pending)
    # Signature, expiry and browser binding still pass. Only the row-locked
    # ownership-epoch comparison may reject this otherwise usable token.
    assert account_deletion.read_keep_token(token, browser_nonce=nonce) == claims
    with pytest.raises(account_deletion.KeepTokenInvalid):
        account_deletion.keep_account(token, browser_nonce=nonce)
    response = _keep(token, browser)
    assert response.status_code == 400
    assert response.json()["code"] == "keep_token_invalid"
    row = _fresh(holder)
    assert not row.is_active and row.deletion_pending()
    assert row.kt_account_epoch == pending.kt_account_epoch
    assert row.deletion_cancelled_at is None
    assert not AccountDeletionEvent.objects.filter(
        creator_id=holder.pk, kind="cancelled").exists()
    _no_credentials_created(holder)


def test_keep_token_refuses_a_present_but_different_browser_nonce(holder):
    browser, token = _pending_login("leaving_soon")
    nonce = browser.cookies[account_deletion.KEEP_COOKIE].value
    assert account_deletion.read_keep_token(token, browser_nonce=nonce)["u"] == holder.pk
    different_nonce = nonce + "-different-browser"
    browser.cookies[account_deletion.KEEP_COOKIE] = different_nonce
    with pytest.raises(account_deletion.KeepTokenInvalid, match="another browser"):
        account_deletion.read_keep_token(token, browser_nonce=different_nonce)
    response = _keep(token, browser)
    assert response.status_code == 400
    assert response.json()["code"] == "keep_token_invalid"
    assert _fresh(holder).deletion_pending()
    _no_credentials_created(holder)
    # The bad binding neither spends nor corrupts the legitimate token.
    browser.cookies[account_deletion.KEEP_COOKIE] = nonce
    assert _keep(token, browser).status_code == 200


def test_a_social_keep_returns_a_knox_token(holder, google, mocker):
    SocialIdentity.objects.create(
        creator=holder, provider="google", provider_uid="g-keep",
        handle="g@example.com", linked_at_epoch=_fresh(holder).kt_account_epoch)
    token = _social_login(APIClient(), mocker, uid="g-keep").json()["keep_token"]
    kept = _keep(token)                  # a native caller: no browser binding
    assert kept.status_code == 200 and kept.json()["token"]
    bearer = APIClient()
    bearer.credentials(HTTP_AUTHORIZATION=f"Token {kept.json()['token']}")
    assert bearer.get("/api/auth/user/").status_code == 200


def test_keep_mails_a_confirmed_address_and_never_needs_one(
    holder, creator_factory, django_capture_on_commit_callbacks,
):
    from dj.apps.emails.models import Email

    token_browser, token = _pending_login("leaving_soon")
    with django_capture_on_commit_callbacks(execute=True):
        assert _keep(token, token_browser).status_code == 200
    assert mail.outbox == []                                       # no email, no mail

    other = creator_factory(username="with_email", password=PASSWORD)
    Email.objects.create(user=other, email="w@example.com", token="t" * 32,
                         expires_at=timezone.now(), confirmed_at=timezone.now())
    Creator.objects.filter(pk=other.pk).update(
        is_active=False, deletion_requested_at=timezone.now(),
        purge_after=timezone.now() + account_deletion.GRACE_PERIOD)
    token_browser, token = _pending_login("with_email")
    with django_capture_on_commit_callbacks(execute=True):
        assert _keep(token, token_browser).status_code == 200
    assert [m.to for m in mail.outbox] == [["w@example.com"]]


# --- the purge --------------------------------------------------------------


def _after_grace():
    return timezone.now() + account_deletion.GRACE_PERIOD + timezone.timedelta(seconds=1)


def test_nothing_is_purged_before_the_grace_period_ends(holder):
    assert account_deletion.purge_due_deletions()["purged"] == 0
    assert _fresh(holder).deleted_at is None


def test_the_purge_runs_after_the_grace_period(holder):
    assert account_deletion.purge_due_deletions(now=_after_grace())["purged"] == 1
    row = _fresh(holder)
    assert row.deleted_at is not None and not row.has_usable_password()
    assert not zPage.objects.filter(creator_id=holder.pk).exists()
    assert AccountDeletionEvent.objects.filter(creator_id=holder.pk, kind="purged").exists()


def test_keep_then_purge_the_purge_skips(holder):
    token_browser, token = _pending_login("leaving_soon")
    assert _keep(token, token_browser).status_code == 200
    assert account_deletion.purge_due_deletions(now=_after_grace())["purged"] == 0
    assert _fresh(holder).is_active and _fresh(holder).deleted_at is None


def test_purge_then_keep_the_keep_fails(holder):
    token_browser, token = _pending_login("leaving_soon")
    assert account_deletion.purge_due_deletions(now=_after_grace())["purged"] == 1
    assert _keep(token, token_browser).status_code == 400
    assert not _fresh(holder).is_active


def test_a_purge_racing_a_keep_rechecks_under_the_lock(holder, monkeypatch):
    """The purge selected the account as due; a keep committed before the
    purge took the row lock. The locked re-check must see it."""
    token_browser, token = _pending_login("leaving_soon")
    real_filter = Creator.objects.filter

    def keep_after_selection(*args, **kwargs):
        qs = real_filter(*args, **kwargs)
        if kwargs.get("purge_after__lte") is not None:
            pks = list(qs.values_list("pk", flat=True))
            assert _keep(token, token_browser).status_code == 200       # the racing keep
            return real_filter(pk__in=pks)
        return qs

    monkeypatch.setattr(Creator.objects, "filter", keep_after_selection)
    result = account_deletion.purge_due_deletions(now=_after_grace())
    monkeypatch.undo()
    assert result == {"purged": 0, "blocked": 0, "skipped": 1, "failed": 0}
    assert _fresh(holder).is_active and _fresh(holder).deleted_at is None


def test_a_blocked_purge_stays_pending_and_alerts_at_a_bounded_rate(
    holder, monkeypatch, caplog,
):
    monkeypatch.setattr(account_deletion, "blockers",
                        lambda creator, **kw: [account_deletion.BLOCKER_EARNINGS_OWED])
    with caplog.at_level(logging.ERROR, logger="dj.apps.g12f.account_deletion"):
        for _ in range(3):
            assert account_deletion.purge_due_deletions(now=_after_grace())["blocked"] == 1
    lines = [json.loads(r.getMessage()) for r in caplog.records
             if account_deletion.PURGE_BLOCKED_EVENT in r.getMessage()]
    assert len(lines) == 1
    expected = account_deletion.purge_blocked_payload(holder.pk, ["earnings_owed"])
    assert {k: lines[0][k] for k in expected} == expected
    assert AccountDeletionEvent.objects.filter(creator_id=holder.pk,
                                               kind="purge_blocked").count() == 1
    row = _fresh(holder)
    assert row.deleted_at is None and not row.is_active
    # A day later it alerts again: it repeats, but never silently stops.
    with caplog.at_level(logging.ERROR, logger="dj.apps.g12f.account_deletion"):
        account_deletion.purge_due_deletions(
            now=_after_grace() + account_deletion.BLOCKED_PURGE_ALERT_INTERVAL
            + timezone.timedelta(minutes=1))
    assert AccountDeletionEvent.objects.filter(creator_id=holder.pk,
                                               kind="purge_blocked").count() == 2


# --- money during the grace period -------------------------------------------


def test_a_zcash_credit_to_a_pending_account_lands_and_survives_keep(holder):
    from dj.apps.ledger import api as ledger_api
    from dj.apps.tuzis import ledger

    ledger.credit(_fresh(holder), Decimal("7"), source="sys:promo", ref_kind="tuzi_grant",
                  ref_id="late-1", idem=f"late-{uuid.uuid4()}")
    token_browser, token = _pending_login("leaving_soon")
    assert _keep(token, token_browser).status_code == 200
    assert ledger_api.read_balance(holder.pk).balance >= ledger_api.to_m2z(Decimal("7"))


def test_a_pending_account_cannot_spend_or_be_paid(holder, creator_factory):
    """Inactive is inactive: the money paths that refuse a deactivated
    account refuse a pending one too."""
    from dj.apps.tuzis import ledger

    fan = creator_factory(username="fan_pay", tuzis=Decimal("50"))
    with pytest.raises(ledger.InactiveCreator):
        ledger.transfer(fan, _fresh(holder), Decimal("1"), action="test")


def test_x_with_totp_answers_keep_only_after_the_code(holder, mocker):
    _enable_totp(holder)
    TwitterProfile.objects.create(
        creator=holder, twitter_id="tw-mfa-leaving", username="tw-mfa-leaving",
        allow_login=True, linked_at_epoch=_fresh(holder).kt_account_epoch)
    AuthContext.objects.filter(creator_id=holder.pk).delete()
    client = Client()
    assert _twitter_callback(client, mocker, "tw-mfa-leaving").status_code == 200
    wrong = client.post("/api/twitter/callback", {"otp_token": "000000"}, secure=True)
    assert wrong.status_code == 400
    accepted = client.post("/api/twitter/callback", {"otp_token": _totp()}, secure=True)
    assert accepted.status_code == 302
    assert accepted["Location"].startswith("/account/keep#t=")
    assert client.session.get("_auth_user_id") is None
    _no_credentials_created(holder)


def test_a_password_reset_of_a_pending_account_answers_keep(holder, api_client):
    from dj.apps.emails.models import Email, PasswordResetToken

    email = Email.objects.create(user=holder, email="leaving@example.com",
                                 token="r" * 32,
                                 expires_at=timezone.now() + timezone.timedelta(days=1),
                                 confirmed_at=timezone.now())
    reset = PasswordResetToken.objects.create(email=email)
    AuthContext.objects.filter(creator_id=holder.pk).delete()
    response = api_client.post("/api/emails/do-reset-password", {
        "token": str(reset.token), "password": "a-new-Passw0rd!"}, format="json")
    assert response.status_code == 409, response.content
    assert response.json()["keep_token"]
    assert api_client.get("/api/auth/user/").status_code in (401, 403)
    _no_credentials_created(holder)


def test_a_pending_fans_membership_is_not_renewed(holder, creator_factory):
    """The fan side: a renewal never charges an account in its grace period
    (the  freeze applies to any inactive fan); keeping the account
    resumes normal renewals from there."""
    from dj.apps.g12f.tasks import renew_subscription
    from dj.apps.g12f.test_renew_subscription import _make_sub

    star = creator_factory(username="star_x")
    Creator.objects.filter(pk=holder.pk).update(tuzis=Decimal("100"))
    sub = _make_sub(_fresh(holder), star,
                    expires=timezone.now() + timezone.timedelta(hours=1))
    renew_subscription(subscription_id=sub.pk)
    assert _fresh(holder).tuzis == Decimal("100")       # nothing charged


# --- review fixes: identities, bans, browser binding, TOTP burn, batching ----


def _schedule(user):
    """Request deletion for ``user`` from a recently-authenticated browser."""
    from types import SimpleNamespace

    from django.conf import settings

    from dj.apps.identity.auth_context import record_login

    client = APIClient()
    client.force_login(_fresh(user))
    session = client.session
    record_login(SimpleNamespace(session=session), _fresh(user), methods=["pwd"])
    client.cookies[settings.SESSION_COOKIE_NAME] = session.session_key
    response = client.post(SCHEDULE_URL, {"confirm_username": user.username}, format="json")
    assert response.status_code == 202, response.content


def test_identities_linked_before_the_request_still_sign_in_to_keep(
    creator_factory, google, mocker,
):
    """The request's epoch bump ends credentials, not sign-in methods: an
    identity linked BEFORE the request must still reach "keep?", and still
    sign in after the keep's own bump."""
    user = creator_factory(username="linked_first", password=PASSWORD)
    epoch = _fresh(user).kt_account_epoch
    SocialIdentity.objects.create(
        creator=user, provider="google", provider_uid="g-first",
        handle="g@example.com", linked_at_epoch=epoch)
    TwitterProfile.objects.create(
        creator=user, twitter_id="tw-first", username="tw-first",
        allow_login=True, linked_at_epoch=epoch)
    _schedule(user)

    pending = _social_login(APIClient(), mocker, uid="g-first")
    assert pending.status_code == 409, pending.content
    kept = _keep(pending.json()["keep_token"])
    assert kept.status_code == 200, kept.content
    after = _social_login(APIClient(), mocker, uid="g-first")
    assert after.status_code == 200 and after.json()["token"], after.content
    current = _fresh(user).kt_account_epoch
    assert TwitterProfile.objects.get(twitter_id="tw-first").linked_at_epoch == current


def test_a_passwordless_account_keeps_every_sign_in_method(
    creator_factory, google, mocker, isolated_zcash_admission,
):
    """Without a password the bump would also reject all but the oldest
    identity as a fallback; the request must not cost the holder any."""
    user = creator_factory(username="no_password")
    user.set_unusable_password()
    user.save()
    epoch = _fresh(user).kt_account_epoch
    ZcashIdentity.objects.create(creator=user, zcash_address=ZCASH_ADDRESS,
                                 linked_at_epoch=epoch)
    SocialIdentity.objects.create(
        creator=user, provider="google", provider_uid="g-nopw",
        handle="n@example.com", linked_at_epoch=epoch)
    _schedule(user)
    new_epoch = _fresh(user).kt_account_epoch
    for model in (ZcashIdentity, SocialIdentity):
        row = model.objects.get(creator_id=user.pk)
        assert (row.linked_at_epoch, row.fallback_rejected_at_epoch) == (new_epoch, None)
    assert _social_login(APIClient(), mocker, uid="g-nopw").status_code == 409


def test_an_identity_rejected_before_the_request_stays_rejected(creator_factory):
    """Carrying identities across restores exactly what could sign in
    before; it never rehabilitates one an earlier event rejected."""
    user = creator_factory(username="had_stale", password=PASSWORD)
    Creator.objects.filter(pk=user.pk).update(kt_account_epoch=5)
    stale = SocialIdentity.objects.create(
        creator=user, provider="google", provider_uid="g-stale",
        handle="s@example.com", linked_at_epoch=4, fallback_rejected_at_epoch=5)
    epoch = 5
    _schedule(user)
    stale.refresh_from_db()
    assert stale.fallback_rejected_at_epoch == epoch


def test_a_ban_while_pending_cannot_be_undone_by_keeping(holder):
    browser, token = _pending_login("leaving_soon")
    _fresh(holder).ban_and_soft_delete()
    assert AccountDeletionEvent.objects.filter(creator_id=holder.pk, kind="banned").exists()
    refused = _keep(token, browser)
    assert refused.status_code == 400
    assert not _fresh(holder).is_active
    again = _password_login(APIClient(), "leaving_soon")
    assert again.status_code == 400 and "keep_token" not in again.content.decode()
    #... and the deletion still runs on schedule.
    assert account_deletion.purge_due_deletions(now=_after_grace())["purged"] == 1


def test_a_cross_site_keep_is_refused_without_csrf(holder):
    from django.middleware.csrf import _get_new_csrf_string

    browser = APIClient(enforce_csrf_checks=True)
    response = _password_login(browser, "leaving_soon")
    assert response.status_code == 409, response.content
    token = response.json()["keep_token"]
    forged = browser.post(KEEP_URL, {"keep_token": token}, format="json")
    assert forged.status_code == 403
    assert not _fresh(holder).is_active
    secret = _get_new_csrf_string()
    browser.cookies["csrftoken"] = secret
    kept = browser.post(KEEP_URL, {"keep_token": token}, format="json",
                        HTTP_X_CSRFTOKEN=secret)
    assert kept.status_code == 200, kept.content


def test_the_keep_answer_burns_the_password_logins_totp_code(holder):
    _enable_totp(holder)
    code = _totp()
    first = _password_login(APIClient(), "leaving_soon", otp_token=code)
    assert first.status_code == 409, first.content
    replay = _password_login(APIClient(), "leaving_soon", otp_token=code)
    assert replay.status_code == 400 and "keep_token" not in replay.content.decode()


def test_the_keep_answer_burns_the_wallet_logins_totp_code(
    creator_factory, mocker, isolated_zcash_admission,
):
    user = creator_factory(username="wallet_mfa", password=PASSWORD)
    ZcashIdentity.objects.create(creator=user, zcash_address=ZCASH_ADDRESS,
                                 linked_at_epoch=_fresh(user).kt_account_epoch)
    _enable_totp(user)
    _schedule(user)
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    code = _totp()

    def wallet_login():
        client = APIClient()
        challenge = client.post("/api/auth/zcash/challenge/",
                                {"address": ZCASH_ADDRESS}, format="json")
        return client.post("/api/auth/zcash/login/", {
            "address": ZCASH_ADDRESS, "challenge": challenge.data["challenge"],
            "signature": "valid-signature", "otp_token": code}, format="json")

    first = wallet_login()
    assert first.status_code == 409, first.content
    replay = wallet_login()
    assert replay.status_code == 400, replay.content
    assert replay.json() == {"detail": "Invalid OTP token."}         # the code is spent


def test_a_pending_username_costs_one_password_hash_like_any_other(holder, mocker):
    """A wrong password for a pending account must not take measurably
    longer than for any other account (a second hash would)."""
    import django.contrib.auth.base_user as base_user

    spy = mocker.spy(base_user, "check_password")
    response = _password_login(APIClient(), "leaving_soon", password="wrong")
    assert response.status_code == 400
    assert spy.call_count == 1


def test_long_blocked_purges_do_not_starve_the_rest(holder, creator_factory, monkeypatch):
    other = creator_factory(username="also_leaving", password=PASSWORD)
    _schedule(other)
    Creator.objects.filter(pk=holder.pk).update(
        purge_after=timezone.now() - timezone.timedelta(days=2))   # oldest, blocked
    real_blockers = account_deletion.blockers
    monkeypatch.setattr(
        account_deletion, "blockers",
        lambda creator, **kw: ([account_deletion.BLOCKER_EARNINGS_OWED]
                               if creator.pk == holder.pk else real_blockers(creator, **kw)))
    now = _after_grace()
    assert account_deletion.purge_due_deletions(now=now, limit=1)["blocked"] == 1
    assert account_deletion.purge_due_deletions(now=now, limit=1)["purged"] == 1
    assert _fresh(other).deleted_at is not None
    assert _fresh(holder).deleted_at is None


def test_a_ban_from_an_instance_loaded_before_the_request_still_blocks_keep(holder):
    """The scorer loads the Creator, the holder requests deletion, THEN the
    ban lands from the stale instance: the ban must still be recorded."""
    stale = _fresh(holder)
    stale.deletion_requested_at = None          # as loaded before the request
    stale.purge_after = None
    stale.ban_and_soft_delete()
    assert AccountDeletionEvent.objects.filter(creator_id=holder.pk, kind="banned").exists()


def test_a_pending_authors_comments_on_other_pages_hide_and_come_back(creator_factory):
    """'Your account is hidden right away' covers comments on OTHER people's
    pages too (which otherwise inherit the page's visibility); keeping the
    account shows them again."""
    from dj.apps.comments.models import Comment
    from dj.apps.comments.visibility import comment_visible

    owner = creator_factory(username="page_owner")
    page = zPage.objects.create(creator=owner, free2zaddr=str(uuid.uuid4()), title="t",
                                description="d", content="c", is_published=True,
                                vanity="owners-page")
    author = creator_factory(username="commenter", password=PASSWORD)
    comment = Comment.objects.create(author=author, content="hello there", tuzis=1,
                                     content_object=page)
    list_url = f"/api/comments/zpage/{page.free2zaddr}/"

    def listed():
        body = APIClient().get(list_url).json()
        rows = body["results"] if isinstance(body, dict) else body
        return [r["uuid"] for r in rows]

    assert str(comment.uuid) in listed()                 # the page is live
    _schedule(author)
    comment.refresh_from_db()
    assert str(comment.uuid) not in listed()
    assert not comment_visible(Comment.objects.get(pk=comment.pk), None)
    assert str(comment.uuid) not in str(APIClient().get("/api/comments/").content)

    browser, token = _pending_login("commenter")
    assert _keep(token, browser).status_code == 200
    assert str(comment.uuid) in listed()


def test_keeping_a_creator_re_arms_their_members_renewals(
    holder, creator_factory, django_capture_on_commit_callbacks,
):
    """A renewal job that ran while the creator was pending dropped its
    chain (inactive creator); keeping the account must re-arm it, or the
    membership lapses at expiry."""
    from procrastinate.contrib.django.models import ProcrastinateJob

    from dj.apps.g12f.tasks import renew_subscription
    from dj.apps.g12f.test_renew_subscription import _make_sub, _renew_jobs

    Creator.objects.filter(pk=holder.pk).update(member_price=Decimal("5"))
    fan = creator_factory(username="member_fan", tuzis=Decimal("50"))
    sub = _make_sub(fan, _fresh(holder), max_price=Decimal("5"),
                    expires=timezone.now() + timezone.timedelta(hours=1))
    ProcrastinateJob.objects.all().delete()
    renew_subscription(subscription_id=sub.pk)          # creator inactive: no-op
    assert not _renew_jobs(sub).exists()

    browser, token = _pending_login("leaving_soon")
    with django_capture_on_commit_callbacks(execute=True):
        assert _keep(token, browser).status_code == 200
    assert _renew_jobs(sub).filter(status="todo").exists()


def test_a_blocked_purge_alert_survives_the_worker_json_formatter(holder, monkeypatch, caplog):
    """The alert filters on top-level `jsonPayload.event`; in a worker that
    is only true if WorkerRootJSONFormatter passes the line through."""
    from dj.free2z.log_json import WorkerRootJSONFormatter

    monkeypatch.setattr(account_deletion, "blockers",
                        lambda creator, **kw: [account_deletion.BLOCKER_EARNINGS_OWED])
    with caplog.at_level(logging.ERROR, logger="dj.apps.g12f.account_deletion"):
        account_deletion.purge_due_deletions(now=_after_grace())
    record = next(r for r in caplog.records
                  if account_deletion.PURGE_BLOCKED_EVENT in r.getMessage())
    line = json.loads(WorkerRootJSONFormatter().format(record))
    assert line["event"] == account_deletion.PURGE_BLOCKED_EVENT
    assert line["severity"] == "ERROR" and line["user_id"] == holder.pk


def test_a_late_keep_signs_in_with_the_original_sign_in_time(holder, mocker):
    """A keep token spent nine minutes after the sign-in must not look like a
    fresh sign-in to the recent-authentication checks."""
    proved_at = timezone.now() - timezone.timedelta(minutes=9)
    mocker.patch.object(account_deletion.timezone, "now", return_value=proved_at)
    browser, token = _pending_login("leaving_soon")
    mocker.stopall()
    assert _keep(token, browser).status_code == 200
    context = AuthContext.objects.filter(creator_id=holder.pk).latest("created_at")
    assert abs((context.auth_time - proved_at).total_seconds()) < 1


def test_a_purged_authors_kept_thread_placeholder_stays_reachable(creator_factory):
    """The purge keeps an emptied comment that others replied to; only a
    PENDING author's comments are hidden, never that placeholder."""
    from dj.apps.comments.models import Comment
    from dj.apps.comments.visibility import comment_visible

    owner = creator_factory(username="thread_owner")
    page = zPage.objects.create(creator=owner, free2zaddr=str(uuid.uuid4()), title="t",
                                description="d", content="c", is_published=True,
                                vanity="thread-page")
    author = creator_factory(username="thread_author", password=PASSWORD)
    parent = Comment.objects.create(author=author, content="parent", tuzis=1,
                                    content_object=page)
    parent.tags.add("my-private-topic")
    Comment.objects.create(author=owner, content="a reply", tuzis=1,
                           content_object=page, parent=parent)
    _schedule(author)
    assert not comment_visible(Comment.objects.get(pk=parent.pk), None)
    assert account_deletion.purge_due_deletions(now=_after_grace())["purged"] == 1
    kept = Comment._base_manager.get(pk=parent.pk)
    assert kept.content == "" and comment_visible(kept, None, placeholder_ok=True)
    assert not comment_visible(kept, None)              # strict paths: no card, no vote
    assert not kept.tags.exists()
    assert APIClient().get(f"/api/comments/{parent.uuid}/replies/").status_code == 200
    # Served as the same placeholder as during the grace period: the
    # username (still reserved on the row) and the tags never come back.
    body = APIClient().get(f"/api/comments/zpage/{page.free2zaddr}/").content.decode()
    assert "thread_author" not in body and "my-private-topic" not in body
    assert '"username":"[deleted]"' in body
    # The bulk list finds it by none of what it hides (the username stays
    # reserved on the row for 30 days).
    for params in ({"author": "thread_author"}, {"search": "thread_author"}):
        found = APIClient().get("/api/comments/", params).json()
        found = found["results"] if isinstance(found, dict) else found
        assert str(parent.uuid) not in {r["uuid"] for r in found}, params


def test_an_x_keep_resumes_the_sdk_authorize_step(holder, mocker):
    """An SDK app's X sign-in carries `next` (/oauth/authorize?...) in its
    handshake; the keep page must get it, or the app never hears back."""
    from urllib.parse import parse_qs

    from dj.apps.twitter.views import (
        TWITTER_OAUTH2_HANDSHAKE_COOKIE, sign_oauth2_handshake,
    )

    TwitterProfile.objects.create(
        creator=holder, twitter_id="tw-sdk", username="tw-sdk",
        allow_login=True, linked_at_epoch=_fresh(holder).kt_account_epoch)
    authorize = "/oauth/authorize?client_id=aha&state=s1"
    client = Client()
    client.cookies[TWITTER_OAUTH2_HANDSHAKE_COOKIE] = sign_oauth2_handshake(
        "twitter-state", "verifier", authorize)
    mocker.patch("dj.apps.twitter.views.get_twitter_user", return_value={
        "id": "tw-sdk", "username": "tw-sdk", "name": "X user",
        "description": "", "profile_image_url": ""})
    response = client.get("/api/twitter/callback",
                          {"state": "twitter-state", "code": "provider-code"},
                          secure=True)
    assert response.status_code == 302
    fragment = parse_qs(response["Location"].split("#", 1)[1])
    assert fragment["n"] == [authorize]


def test_keeping_a_fan_re_arms_their_own_renewals(
    holder, creator_factory, django_capture_on_commit_callbacks,
):
    """The fan side: a pending fan's retries stop at the last look before
    expiry, so keeping must re-arm the fan's own memberships too."""
    from procrastinate.contrib.django.models import ProcrastinateJob

    from dj.apps.g12f.test_renew_subscription import _make_sub, _renew_jobs

    star = creator_factory(username="their_star", member_price=Decimal("5"))
    Creator.objects.filter(pk=holder.pk).update(tuzis=Decimal("50"))
    sub = _make_sub(_fresh(holder), star, max_price=Decimal("5"),
                    expires=timezone.now() + timezone.timedelta(minutes=2))
    ProcrastinateJob.objects.all().delete()
    browser, token = _pending_login("leaving_soon")
    with django_capture_on_commit_callbacks(execute=True):
        assert _keep(token, browser).status_code == 200
    assert _renew_jobs(sub).filter(status="todo").exists()


def test_renewal_re_arming_commits_with_the_keep_or_not_at_all(holder, creator_factory, mocker):
    """No post-commit window: if re-arming fails, the keep rolls back with
    it and the token is still good."""
    from dj.apps.g12f import tasks as g12f_tasks
    from dj.apps.g12f.test_renew_subscription import _make_sub

    Creator.objects.filter(pk=holder.pk).update(member_price=Decimal("5"))
    fan = creator_factory(username="member_fan_2", tuzis=Decimal("50"))
    _make_sub(fan, _fresh(holder), max_price=Decimal("5"),
              expires=timezone.now() + timezone.timedelta(hours=1))
    browser, token = _pending_login("leaving_soon")
    nonce = browser.cookies[account_deletion.KEEP_COOKIE].value
    mocker.patch.object(g12f_tasks, "defer_renewal", side_effect=RuntimeError("queue down"))
    with pytest.raises(RuntimeError):
        account_deletion.keep_account(token, browser_nonce=nonce)
    assert not _fresh(holder).is_active
    mocker.stopall()
    creator, _ = account_deletion.keep_account(token, browser_nonce=nonce)
    assert creator.is_active


def test_the_hourly_cron_command_purges_what_is_due(holder):
    """The operator path until the periodic ships."""
    from io import StringIO

    from django.core.management import call_command

    Creator.objects.filter(pk=holder.pk).update(
        purge_after=timezone.now() - timezone.timedelta(minutes=1))
    dry = StringIO()
    call_command("purge_scheduled_deletions", "--dry-run", stdout=dry)
    assert f"user={holder.pk}" in dry.getvalue()
    assert _fresh(holder).deleted_at is None
    out = StringIO()
    call_command("purge_scheduled_deletions", stdout=out)
    assert "purged=1" in out.getvalue()
    assert _fresh(holder).deleted_at is not None


def test_one_failing_purge_does_not_stall_the_rest(holder, creator_factory, monkeypatch, caplog):
    other = creator_factory(username="purges_fine", password=PASSWORD)
    _schedule(other)
    Creator.objects.filter(pk=holder.pk).update(
        purge_after=timezone.now() - timezone.timedelta(days=2))   # first in line
    real = account_deletion._purge_locked

    def broken_for_holder(creator):
        if creator.pk == holder.pk:
            raise RuntimeError("policy gap")
        return real(creator)

    monkeypatch.setattr(account_deletion, "_purge_locked", broken_for_holder)
    with caplog.at_level(logging.ERROR, logger="dj.apps.g12f.account_deletion"):
        result = account_deletion.purge_due_deletions(now=_after_grace(), limit=1)
    assert result["failed"] == 1
    lines = [json.loads(r.getMessage()) for r in caplog.records
             if account_deletion.PURGE_BLOCKED_EVENT in r.getMessage()]
    assert lines and lines[0]["blockers"] == account_deletion.PURGE_FAILED
    assert _fresh(holder).deleted_at is None and not _fresh(holder).is_active
    # The failed account goes to the back; the next run purges the other.
    assert account_deletion.purge_due_deletions(now=_after_grace(), limit=1)["purged"] == 1
    assert _fresh(other).deleted_at is not None


def test_a_replied_to_comment_stays_as_a_placeholder_while_pending(creator_factory):
    """Other people's replies stay reachable during the grace period: the
    pending author's comment they hang under shows with no text and a
    pseudonym, as the purge will leave it; a comment nobody replied to is
    simply hidden."""
    from dj.apps.comments.models import Comment

    owner = creator_factory(username="replier")
    page = zPage.objects.create(creator=owner, free2zaddr=str(uuid.uuid4()), title="t",
                                description="d", content="c", is_published=True,
                                vanity="replied-page")
    author = creator_factory(username="root_author", password=PASSWORD)
    root = Comment.objects.create(author=author, content="my words", headline="h",
                                  tuzis=1, content_object=page)
    reply = Comment.objects.create(author=owner, content="a reply", tuzis=1,
                                   content_object=page, parent=root)
    leaf = Comment.objects.create(author=author, content="lonely", tuzis=1,
                                  content_object=page)
    _schedule(author)

    body = APIClient().get(f"/api/comments/zpage/{page.free2zaddr}/").json()
    rows = {r["uuid"]: r for r in (body["results"] if isinstance(body, dict) else body)}
    assert str(leaf.uuid) not in rows
    placeholder = rows[str(root.uuid)]
    assert placeholder["content"] == "" and placeholder["headline"] == ""
    assert placeholder["author"]["username"] == "[deleted]"
    assert "root_author" not in json.dumps(body) and "my words" not in json.dumps(body)
    replies = APIClient().get(f"/api/comments/{root.uuid}/replies/")
    assert replies.status_code == 200
    assert str(reply.uuid) in replies.content.decode()
    # Everywhere else the pending author's comments are simply gone.
    listed = APIClient().get("/api/comments/").json()
    listed = listed["results"] if isinstance(listed, dict) else listed
    assert str(root.uuid) not in {r["uuid"] for r in listed}
    # The thread page opens the placeholder itself, redacted.
    opened = APIClient().get(f"/api/comments/{root.uuid}/")
    assert opened.status_code == 200 and opened.json()["content"] == ""
    assert "root_author" not in opened.content.decode()
    assert APIClient().get(f"/api/comments/{leaf.uuid}/").status_code == 404


def test_a_purge_the_process_did_not_survive_goes_to_the_back(holder, creator_factory, monkeypatch):
    """Out of memory or killed at a timeout: nothing is caught, so only
    the attempt marker committed beforehand can move the account back."""
    other = creator_factory(username="next_in_line", password=PASSWORD)
    _schedule(other)
    Creator.objects.filter(pk=holder.pk).update(
        purge_after=timezone.now() - timezone.timedelta(days=2))   # first in line
    real = account_deletion._purge_locked

    def killed_on_holder(creator):
        if creator.pk == holder.pk:
            raise SystemExit("OOMKilled")
        return real(creator)

    monkeypatch.setattr(account_deletion, "_purge_locked", killed_on_holder)
    with pytest.raises(SystemExit):
        account_deletion.purge_due_deletions(now=_after_grace(), limit=1)
    assert account_deletion.purge_due_deletions(now=_after_grace(), limit=1)["purged"] == 1
    assert _fresh(other).deleted_at is not None and _fresh(holder).deleted_at is None


def test_a_ban_takes_the_row_lock_keep_takes(holder):
    """Ban and its record are one transaction under the Creator row lock, so
    a concurrent keep is ordered entirely before or after it."""
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    with CaptureQueriesContext(connection) as queries:
        _fresh(holder).ban_and_soft_delete()
    sql = [q["sql"] for q in queries.captured_queries]
    lock = next(i for i, q in enumerate(sql)
                if "FOR UPDATE" in q and '"g12f_creator"' in q.split("FOR UPDATE")[0])
    insert = next(i for i, q in enumerate(sql) if "INSERT INTO" in q and "accountdeletionevent" in q)
    assert lock < insert


def test_filters_never_match_a_placeholder_by_what_it_hides(creator_factory):
    from dj.apps.comments.models import Comment

    owner = creator_factory(username="filter_owner")
    page = zPage.objects.create(creator=owner, free2zaddr=str(uuid.uuid4()), title="t",
                                description="d", content="c", is_published=True,
                                vanity="filter-page")
    author = creator_factory(username="hidden_author", password=PASSWORD)
    root = Comment.objects.create(author=author, content="secret phrase here", tuzis=1,
                                  content_object=page)
    Comment.objects.create(author=owner, content="reply", tuzis=1,
                           content_object=page, parent=root)
    _schedule(author)
    client = APIClient()
    # retrieve answers the same whatever the query string
    assert client.get(f"/api/comments/{root.uuid}/").status_code == 200
    assert client.get(f"/api/comments/{root.uuid}/", {"search": "secret phrase"}).status_code == 200
    assert client.get(f"/api/comments/{root.uuid}/", {"search": "zzz-nothing"}).status_code == 200
    assert client.get(f"/api/comments/{root.uuid}/", {"author": "hidden_author"}).status_code == 200
    # the thread list never finds it by its hidden author
    by_author = client.get(f"/api/comments/zpage/{page.free2zaddr}/",
                           {"author": "hidden_author"}).json()
    rows = by_author["results"] if isinstance(by_author, dict) else by_author
    assert rows == []


def test_a_renewal_job_claimed_during_the_keep_is_re_armed_after_commit(
    holder, creator_factory, django_capture_on_commit_callbacks,
):
    """The pending job existed (AlreadyEnqueued), a worker claimed it before
    the keep committed and saw the creator inactive: the post-commit
    re-check must enqueue again."""
    from django.db import connection
    from procrastinate.contrib.django.models import ProcrastinateJob

    from dj.apps.g12f.test_renew_subscription import _make_sub, _renew_jobs

    Creator.objects.filter(pk=holder.pk).update(member_price=Decimal("5"))
    fan = creator_factory(username="member_fan_3", tuzis=Decimal("50"))
    with django_capture_on_commit_callbacks(execute=True):
        sub = _make_sub(fan, _fresh(holder), max_price=Decimal("5"),
                        expires=timezone.now() + timezone.timedelta(hours=1))
    assert _renew_jobs(sub).filter(status="todo").exists()     # the chain job
    browser, token = _pending_login("leaving_soon")
    with django_capture_on_commit_callbacks(execute=False) as callbacks:
        assert _keep(token, browser).status_code == 200
    with connection.cursor() as cursor:                      # the worker took it
        cursor.execute("UPDATE procrastinate_jobs SET status='succeeded' "
                       "WHERE task_name='g12f.renew_subscription'")
    assert not _renew_jobs(sub).filter(status="todo").exists()
    for callback in callbacks:
        callback()
    assert _renew_jobs(sub).filter(status="todo").exists()
    assert ProcrastinateJob.objects.exists()


def test_a_pending_authors_responses_leave_other_members_public_forks(
    creator_factory, api_client,
):
    """Plain deactivation keeps a response author's rows in someone else's
    public conversation; a pending DELETION hides them there too."""
    from dj.apps.openai.models import AIModel, Conversation, PromptResponse

    ai_model = AIModel.objects.create(model="gpt-test", display_name="Test",
                                      system_message="x", max_tokens=4096, is_ga=True)
    bob = creator_factory(username="fork_owner")
    alice = creator_factory(username="response_author", password=PASSWORD)
    fork = Conversation.objects.create(ai_model=ai_model, user=bob,
                                       display_name="bob's fork", is_public=True)
    row = PromptResponse.objects.create(ai_model=ai_model, user=alice,
                                        user_input="alice asks", response="an answer")
    fork.prompt_response_set.add(row)

    def served():
        detail = api_client.get(f"/api/ai/public-conversations/{fork.id}/").content.decode()
        rows = api_client.get(
            f"/api/ai/public-conversations/{fork.id}/promptresponses/").content.decode()
        return detail + rows

    assert "alice asks" in served()                       # the paths are live
    _schedule(alice)
    body = served()
    assert "alice asks" not in body and "response_author" not in body
    browser, token = _pending_login("response_author")
    assert _keep(token, browser).status_code == 200
    assert "alice asks" in served()


def test_a_pending_authors_turns_are_not_copied_by_a_new_fork(creator_factory):
    """Forking copies a transcript; a pending author's turns must not ride
    along (nor be served to the fork's owner, nor sent to the model)."""
    from dj.apps.openai.models import AIModel, Conversation, PromptResponse

    ai_model = AIModel.objects.create(model="gpt-test", display_name="Test",
                                      system_message="x", max_tokens=4096, is_ga=True)
    bob = creator_factory(username="fork_src_owner")
    alice = creator_factory(username="early_author", password=PASSWORD)
    carol = creator_factory(username="new_forker")
    source = Conversation.objects.create(ai_model=ai_model, user=bob,
                                         display_name="src", is_public=True)
    a = PromptResponse.objects.create(ai_model=ai_model, user=alice,
                                      user_input="alice private", response="r1")
    b = PromptResponse.objects.create(ai_model=ai_model, user=bob,
                                      user_input="bob asks", response="r2")
    source.prompt_response_set.add(a, b)
    _schedule(alice)

    client = APIClient()
    client.force_authenticate(carol)
    response = client.post("/api/ai/conversations/fork/",
                           {"conversation": str(source.id), "prompt_response": b.id},
                           format="json")
    assert response.status_code == 201, response.content
    fork = Conversation.objects.get(id=response.json()["id"])
    assert list(fork.prompt_response_set.all()) == [b]
    # Bob's own read of his conversation hides it too.
    owner = APIClient()
    owner.force_authenticate(bob)
    assert "alice private" not in owner.get(
        f"/api/ai/conversations/{source.id}/").content.decode()
    # Not deleted: a keep shows it again; the purge deletes it.
    assert PromptResponse._base_manager.filter(pk=a.pk).exists()
    assert account_deletion.purge_due_deletions(now=_after_grace())["purged"] == 1
    assert not PromptResponse._base_manager.filter(pk=a.pk).exists()


def test_a_standalone_converse_thread_keeps_its_placeholder(creator_factory):
    """A Converse post (no page) others replied to: the thread stays
    reachable through a redacted parent, pending and after the purge."""
    from dj.apps.comments.models import Comment

    author = creator_factory(username="converse_author", full_name="Private Author",
                             password=PASSWORD)
    bob = creator_factory(username="converse_replier")
    root = Comment.objects.create(
        author=author, headline="PRIVATE-HEADLINE", content="PRIVATE-BODY", tuzis=1)
    root.tags.add("private-converse-tag")
    reply = Comment.objects.create(author=bob, content="bob replies", tuzis=1, parent=root)
    inactive = creator_factory(username="inactive_replier")
    hidden_reply = Comment.objects.create(
        author=inactive, content="hidden inactive reply", tuzis=1, parent=root)
    banned_reply = Comment.objects.create(author=bob, content="hidden banned reply",
                                          tuzis=1, parent=root)
    Comment._base_manager.filter(pk=banned_reply.pk).update(is_banned=True)
    lonely = Comment.objects.create(author=author, content="nobody answered", tuzis=1)
    # Inactive reply authors remain hidden by the standalone-post policy even
    # though this thread's parent is a self-deletion placeholder.
    Creator.objects.filter(pk=inactive.pk).update(is_active=False)
    _schedule(author)

    def check():
        client = APIClient()
        opened = client.get(f"/api/comments/{root.uuid}/")
        assert opened.status_code == 200, opened.content
        placeholder = opened.json()
        assert placeholder["content"] == placeholder["headline"] == ""
        assert placeholder["tags"] == []
        assert placeholder["author"] == {"username": "[deleted]", "avatar_image": None}
        for hidden in ("converse_author", "Private Author", "PRIVATE-HEADLINE",
                       "PRIVATE-BODY", "private-converse-tag"):
            assert hidden not in opened.content.decode()
        replies = client.get(f"/api/comments/{root.uuid}/replies/")
        assert replies.status_code == 200 and str(reply.uuid) in replies.content.decode()
        assert "bob replies" in replies.content.decode()
        assert str(hidden_reply.uuid) not in replies.content.decode()
        assert "hidden inactive reply" not in replies.content.decode()
        assert "inactive_replier" not in replies.content.decode()
        assert str(banned_reply.uuid) not in replies.content.decode()
        assert "hidden banned reply" not in replies.content.decode()
        assert client.get(f"/api/comments/{lonely.uuid}/").status_code == 404

    check()
    assert account_deletion.purge_due_deletions(now=_after_grace())["purged"] == 1
    check()


@pytest.mark.parametrize(
    ("report_status", "held"),
    [("open", True), ("reviewing", True), ("resolved", False)],
)
def test_report_status_controls_a_standalone_deletion_placeholder(
    creator_factory, report_status, held,
):
    """Active reports hide pending parents; resolved reports do not."""
    from dj.apps.comments.models import Comment, ContentReport
    from dj.apps.comments.visibility import scope_comments_to_visible_parents

    author = creator_factory(username="reported_converse_author", password=PASSWORD)
    replier = creator_factory(username="reported_converse_replier")
    root = Comment.objects.create(author=author, content="held evidence", tuzis=1)
    reply = Comment.objects.create(author=replier, content="reply under held evidence",
                                   tuzis=1, parent=root)
    ContentReport.objects.create(
        reporter=replier, target_kind="comment", target_id=str(root.pk),
        reason=ContentReport.Reason.HARASSMENT, status=report_status,
    )
    _schedule(author)

    # Exercise the SQL predicate independently of the parent object gate:
    # active holds are excluded from placeholder-capable list querysets, but
    # a resolved report leaves the ordinary deleted-author placeholder valid.
    scoped = scope_comments_to_visible_parents(
        Comment._base_manager.filter(pk=root.pk), None, placeholders=True,
    )
    assert scoped.exists() == (not held)

    client = APIClient()
    opened = client.get(f"/api/comments/{root.uuid}/")
    replies = client.get(f"/api/comments/{root.uuid}/replies/")
    if held:
        # The pending-deletion placeholder exception does not defeat active
        # moderation holds during the grace period.
        assert opened.status_code == replies.status_code == 404
    else:
        assert opened.status_code == 200 and opened.json()["content"] == ""
        assert opened.json()["author"]["username"] == "[deleted]"
        assert replies.status_code == 200 and str(reply.uuid) in replies.content.decode()
        assert "reply under held evidence" in replies.content.decode()

    assert account_deletion.purge_due_deletions(now=_after_grace())["purged"] == 1
    if held:
        assert Comment._base_manager.filter(pk=root.pk, content="held evidence",
                                            is_banned=True).exists()
        assert client.get(f"/api/comments/{root.uuid}/").status_code == 404
        replies = client.get(f"/api/comments/{root.uuid}/replies/")
        assert replies.status_code == 404
        assert b"reply under held evidence" not in replies.content
    else:
        opened = client.get(f"/api/comments/{root.uuid}/")
        replies = client.get(f"/api/comments/{root.uuid}/replies/")
        assert opened.status_code == 200 and opened.json()["content"] == ""
        assert opened.json()["author"]["username"] == "[deleted]"
        assert replies.status_code == 200 and str(reply.uuid) in replies.content.decode()
        assert "reply under held evidence" in replies.content.decode()


def test_a_grant_that_slipped_in_during_the_grace_period_is_revoked_by_keep(
    holder, creator_factory,
):
    """A consent POST authenticated before the request can commit its grant
    after the request revoked grants; keeping must not hand it back live."""
    app = F2ZApplication.objects.create(
        name="Racing app", user=creator_factory(username="dev_race"),
        client_type=F2ZApplication.CLIENT_PUBLIC,
        redirect_uris="https://race.example.com/cb", allowed_scopes="openid")
    AppAuthorization.objects.create(user=_fresh(holder), application=app, scope="openid")
    assert AppAuthorization.objects.live().filter(user_id=holder.pk).exists()
    browser, token = _pending_login("leaving_soon")
    assert _keep(token, browser).status_code == 200
    assert not AppAuthorization.objects.live().filter(user_id=holder.pk).exists()


def test_the_preview_path_no_longer_takes_a_deletion_request(holder, creator_factory, recent_login):
    """Requesting moved to /schedule/: an old page's POST on the preview's
    path (which deleted at once before the grace period) does nothing."""
    user = creator_factory(username="old_tab", password=PASSWORD)
    client = APIClient()
    recent_login(client, user)
    response = client.post(URL, {"confirm_username": "old_tab"}, format="json")
    assert response.status_code == 405
    assert _fresh(user).is_active and _fresh(user).deletion_requested_at is None


def test_the_placeholder_author_name_can_never_be_registered():
    from django.core.exceptions import ValidationError

    from dj.apps.comments.serializers import REDACTED_AUTHOR_NAME

    field = Creator._meta.get_field("username")
    with pytest.raises(ValidationError):
        for validator in field.validators:
            validator(REDACTED_AUTHOR_NAME)


def test_a_pending_owners_series_is_not_served_under_another_creators_page(creator_factory):
    from dj.apps.g12f.models import PageOrder, Series

    bob = creator_factory(username="series_page_owner")
    page = zPage.objects.create(creator=bob, free2zaddr=str(uuid.uuid4()), title="t",
                                description="d", content="c", is_published=True,
                                vanity="series-page")
    alice = creator_factory(username="series_owner", password=PASSWORD)
    series = Series.objects.create(creator=alice, name="Alice's private series name")
    PageOrder.objects.create(series=series, page=page, order=1)
    url = f"/api/g12f/zpage/{page.free2zaddr}/series/"
    first = APIClient().get(url)
    assert first.status_code == 200 and "Alice's private series name" in first.content.decode()
    _schedule(alice)
    assert APIClient().get(url).status_code == 404


def test_a_purged_placeholder_gets_no_social_card_or_list_entry(creator_factory):
    """After the purge the username stays reserved on the row for 30 days:
    the OG card ("Comment by <author>") and lists must not serve it."""
    from dj.apps.comments.models import Comment

    owner = creator_factory(username="card_page_owner")
    page = zPage.objects.create(creator=owner, free2zaddr=str(uuid.uuid4()), title="t",
                                description="d", content="c", is_published=True,
                                vanity="card-page")
    author = creator_factory(username="card_author", password=PASSWORD)
    root = Comment.objects.create(author=author, content="x", tuzis=1, content_object=page)
    Comment.objects.create(author=owner, content="reply", tuzis=1, content_object=page,
                           parent=root)
    _schedule(author)
    assert account_deletion.purge_due_deletions(now=_after_grace())["purged"] == 1
    assert Client().get(f"/converse/{root.uuid}").status_code == 404
    listed = APIClient().get("/api/comments/").json()
    listed = listed["results"] if isinstance(listed, dict) else listed
    assert str(root.uuid) not in {r["uuid"] for r in listed}


def test_staff_still_see_a_pending_authors_ai_turns(creator_factory, admin_client):
    from dj.apps.openai.models import PromptResponse

    alice = creator_factory(username="admin_visible", password=PASSWORD)
    row = PromptResponse.objects.create(user=alice, user_input="staff can read", response="r")
    _schedule(alice)
    assert not PromptResponse.objects.filter(pk=row.pk).exists()
    from django.urls import reverse

    page = admin_client.get(reverse("admin:openai_promptresponse_changelist"),
                            {"q": "staff can read"})
    change = reverse("admin:openai_promptresponse_change", args=[row.pk])
    assert page.status_code == 200 and change in page.content.decode()


def test_a_keep_never_waits_on_or_rolls_back_for_the_page_reindex(
    holder, mocker, django_capture_on_commit_callbacks,
):
    """The reindex grows with the account's pages: it runs after the keep
    commits, and its failure is logged, never a lost keep."""
    calls = mocker.patch("dj.apps.g12f.signals.reindex_published_zpage",
                         side_effect=RuntimeError("index down"))
    browser, token = _pending_login("leaving_soon")
    with django_capture_on_commit_callbacks(execute=False) as callbacks:
        assert _keep(token, browser).status_code == 200
    assert calls.call_count == 0                       # nothing inside the keep
    assert _fresh(holder).is_active
    for callback in callbacks:
        callback()                                     # raises nothing
    assert calls.call_count == 1 and _fresh(holder).is_active


def test_the_keep_reindex_is_bounded(holder, mocker, monkeypatch, caplog,
                                     django_capture_on_commit_callbacks):
    monkeypatch.setattr(account_deletion, "KEEP_REINDEX_LIMIT", 1)
    zPage.objects.create(creator=_fresh(holder), free2zaddr=str(uuid.uuid4()), title="t2",
                         description="d", content="c", is_published=True)
    calls = mocker.patch("dj.apps.g12f.signals.reindex_published_zpage")
    browser, token = _pending_login("leaving_soon")
    with caplog.at_level(logging.WARNING, logger="dj.apps.g12f.account_deletion"):
        with django_capture_on_commit_callbacks(execute=True):
            assert _keep(token, browser).status_code == 200
    assert calls.call_count == 1
    assert any(getattr(r, "event", "") == "account_kept_reindex_truncated"
               for r in caplog.records)


def test_end_grace_now_is_stage_only_and_feeds_the_ordinary_purge(holder, monkeypatch):
    """: the stage proof of the CronJob ends ONE pending account's grace
    through a reviewed command path, never a hand-edited row."""
    from io import StringIO

    from django.core.management import call_command
    from django.core.management.base import CommandError

    before = _fresh(holder).purge_after
    for namespace in (None, "prod"):
        if namespace is None:
            monkeypatch.delenv("NAMESPACE", raising=False)
        else:
            monkeypatch.setenv("NAMESPACE", namespace)
        with pytest.raises(CommandError, match="stage only"):
            call_command("purge_scheduled_deletions", "--end-grace-now", "leaving_soon")
        assert _fresh(holder).purge_after == before
    monkeypatch.setenv("NAMESPACE", "stage")
    with pytest.raises(CommandError, match="no --dry-run"):
        call_command("purge_scheduled_deletions", "--end-grace-now", "leaving_soon", "--dry-run")
    assert _fresh(holder).purge_after == before
    out = StringIO()
    call_command("purge_scheduled_deletions", "--end-grace-now", "leaving_soon", stdout=out)
    assert "grace ended: leaving_soon" in out.getvalue()
    assert _fresh(holder).deleted_at is None              # it purges nothing itself
    assert _fresh(holder).purge_after <= timezone.now()
    run = StringIO()
    call_command("purge_scheduled_deletions", stdout=run)
    assert "purged=1" in run.getvalue() and _fresh(holder).deleted_at is not None


def test_end_grace_now_refuses_an_account_that_is_not_pending(creator_factory, monkeypatch):
    from django.core.management import call_command
    from django.core.management.base import CommandError

    creator_factory(username="still_active", password=PASSWORD)
    monkeypatch.setenv("NAMESPACE", "stage")
    with pytest.raises(CommandError, match="not an account whose deletion is pending"):
        call_command("purge_scheduled_deletions", "--end-grace-now", "still_active")
    assert _fresh(Creator.objects.get(username="still_active")).is_active
