"""The two email-link landings must render on GET and write only on POST.

Issue, finding 5. Both endpoints used to mutate from a ``GET`` credentialed
by a query-string token: ``/api/emails/confirm`` set ``confirmed_at``, and
``/api/emails/opt-out/<email>`` created an ``OptOutEmail`` row and **deleted**
the account's ``Email`` row. Mail clients, corporate security scanners and
link-preview bots follow URLs in messages, so a prefetch could unsubscribe (or
confirm) somebody who never clicked — a reported-in-the-wild failure mode for
unsubscribe links.

The fix keeps the emailed URLs byte-identical (links already sitting in inboxes
must keep working) and moves the write to a ``POST`` behind one button. These
tests pin both halves, plus the safety properties the old implementation
already had and must not lose: the account-first lock ordering, the re-check of
the locked row, the already-opted-out short circuit, replay behaviour, and the
``anon-link`` throttle.
"""
import re
from datetime import timedelta
from unittest import mock

import pytest
from django.core import mail
from django.db.models import QuerySet
from django.utils import timezone
from rest_framework.test import APIClient
from rest_framework.throttling import SimpleRateThrottle

from dj.apps.emails.models import Email, OptOutEmail
from dj.apps.g12f.models import Creator
from dj.apps.emails.link_origin import get_email_link_origin
from dj.apps.emails.views import (
    ONE_CLICK_FIELD,
    ONE_CLICK_VALUE,
    build_opt_out_url,
    opt_out_link_token,
    send_confirmation_email,
    send_password_reset_email,
)


CONFIRM_URL = "/api/emails/confirm"


def _opt_out_url(email):
    """The DEPRECATED shape: address in the path, token in the query.

    Kept, and kept exercised, on purpose. Every message sent before
    carries this URL and it must go on working -- these tests are the
    deprecation window's only evidence. See
    ``OPT_OUT_LEGACY_URL_SUPPORTED_UNTIL``.
    """
    return f"/api/emails/opt-out/{email}"


def _token_only_path(email_instance):
    """The current shape: one opaque signed segment, nothing else."""
    return f"/api/emails/opt-out/{opt_out_link_token(email_instance)}"


@pytest.fixture
def pending_email(creator_factory):
    """An unconfirmed address with a live confirmation token."""
    return Email.objects.create(
        user=creator_factory(),
        email="pending@example.com",
        token="live-confirm-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=None,
    )


@pytest.fixture
def confirmed_email(creator_factory):
    """A confirmed address, i.e. one that can still be unsubscribed."""
    return Email.objects.create(
        user=creator_factory(),
        email="subscriber@example.com",
        token="live-opt-out-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )


# --- confirm: GET renders, POST writes ---------------------------------------


@pytest.mark.django_db
def test_get_confirm_renders_and_writes_nothing(api_client, pending_email):
    """The whole point: a prefetch of the emailed URL must confirm nothing."""
    response = api_client.get(CONFIRM_URL, {"token": pending_email.token})

    assert response.status_code == 200, response.content
    assert response["Content-Type"].startswith("text/html")
    pending_email.refresh_from_db()
    assert pending_email.confirmed_at is None, (
        "GET /api/emails/confirm confirmed the address — a link-prefetching "
        "mail client or security scanner can confirm a mailbox nobody opened"
    )


@pytest.mark.django_db
def test_get_confirm_offers_a_form_that_posts_the_token(
    api_client, pending_email
):
    response = api_client.get(CONFIRM_URL, {"token": pending_email.token})

    body = response.content.decode()
    assert 'method="post"' in body
    assert f'value="{pending_email.token}"' in body
    assert "csrfmiddlewaretoken" in body, (
        "the form must carry a CSRF token: a signed-in user clicking their "
        "own confirmation link is authenticated by session, and DRF's "
        "SessionAuthentication enforces CSRF on POST"
    )


@pytest.mark.django_db
def test_post_confirm_confirms(api_client, pending_email):
    response = api_client.post(
        CONFIRM_URL, {"token": pending_email.token}, format="json"
    )

    assert response.status_code == 303, response.content
    assert response["Location"] == "/profile"
    pending_email.refresh_from_db()
    assert pending_email.confirmed_at is not None


@pytest.mark.django_db
def test_post_confirm_accepts_a_form_encoded_body(api_client, pending_email):
    """The landing page submits an ordinary HTML form, not JSON."""
    response = api_client.post(
        CONFIRM_URL, {"token": pending_email.token}, format="multipart"
    )

    assert response.status_code == 303, response.content
    pending_email.refresh_from_db()
    assert pending_email.confirmed_at is not None


@pytest.mark.django_db
def test_post_confirm_replay_is_idempotent(api_client, pending_email):
    """The confirm token stays valid until it expires; replay must not error."""
    first = api_client.post(
        CONFIRM_URL, {"token": pending_email.token}, format="json"
    )
    pending_email.refresh_from_db()
    confirmed_at = pending_email.confirmed_at

    second = api_client.post(
        CONFIRM_URL, {"token": pending_email.token}, format="json"
    )

    assert (first.status_code, second.status_code) == (303, 303)
    pending_email.refresh_from_db()
    assert pending_email.confirmed_at >= confirmed_at


@pytest.mark.django_db
@pytest.mark.parametrize("method", ["get", "post"])
def test_confirm_without_a_token_is_400(api_client, method):
    """Pinned: dj/apps/test_throttling.py depends on this exact status."""
    response = getattr(api_client, method)(CONFIRM_URL)

    assert response.status_code == 400, response.content


@pytest.mark.django_db
@pytest.mark.parametrize("method", ["get", "post"])
def test_confirm_with_an_unknown_token_is_404(api_client, pending_email, method):
    response = getattr(api_client, method)(CONFIRM_URL, {"token": "nope"})

    assert response.status_code == 404, response.content
    pending_email.refresh_from_db()
    assert pending_email.confirmed_at is None


@pytest.mark.django_db
@pytest.mark.parametrize("method", ["get", "post"])
def test_confirm_with_an_expired_token_is_404(api_client, pending_email, method):
    Email.objects.filter(pk=pending_email.pk).update(
        expires_at=timezone.now() - timedelta(seconds=1)
    )

    response = getattr(api_client, method)(
        CONFIRM_URL, {"token": pending_email.token}
    )

    assert response.status_code == 404, response.content
    pending_email.refresh_from_db()
    assert pending_email.confirmed_at is None


# --- opt out: GET renders, POST writes ---------------------------------------


@pytest.mark.django_db
def test_get_opt_out_renders_and_deletes_nothing(api_client, confirmed_email):
    """The finding, pinned: the GET used to DELETE the address row."""
    response = api_client.get(
        _opt_out_url(confirmed_email.email), {"token": confirmed_email.token}
    )

    assert response.status_code == 200, response.content
    assert response["Content-Type"].startswith("text/html")
    assert Email.objects.filter(pk=confirmed_email.pk).exists(), (
        "GET on the unsubscribe link deleted the address — a prefetching mail "
        "client or link scanner can unsubscribe a user who never clicked"
    )
    assert not OptOutEmail.objects.filter(email=confirmed_email.email).exists()


@pytest.mark.django_db
def test_get_opt_out_offers_one_button(api_client, confirmed_email):
    response = api_client.get(
        _opt_out_url(confirmed_email.email), {"token": confirmed_email.token}
    )

    body = response.content.decode()
    assert 'method="post"' in body
    assert body.count("<button") == 1, (
        "one-click unsubscribe is a real user expectation: one page, one "
        "button, no multi-step flow"
    )
    assert f'value="{confirmed_email.token}"' in body
    assert "csrfmiddlewaretoken" in body


@pytest.mark.django_db
def test_post_opt_out_unsubscribes(api_client, confirmed_email):
    response = api_client.post(
        _opt_out_url(confirmed_email.email),
        {"token": confirmed_email.token},
        format="multipart",
    )

    assert response.status_code == 303, response.content
    assert response["Location"] == _opt_out_url(confirmed_email.email), (
        "post/redirect/get back to the landing page, with no token in the "
        "redirect target, so a reload cannot re-submit"
    )
    assert not Email.objects.filter(pk=confirmed_email.pk).exists()
    assert OptOutEmail.objects.filter(email=confirmed_email.email).exists()


@pytest.mark.django_db
def test_landing_after_unsubscribing_says_so(api_client, confirmed_email):
    api_client.post(
        _opt_out_url(confirmed_email.email),
        {"token": confirmed_email.token},
        format="multipart",
    )

    followed = api_client.get(_opt_out_url(confirmed_email.email))

    assert followed.status_code == 200, followed.content
    assert "unsubscribed" in followed.content.decode().lower()
    assert "<button" not in followed.content.decode()


@pytest.mark.django_db
def test_post_opt_out_one_click_uses_the_query_token(
    api_client, confirmed_email
):
    """RFC 8058: the provider POSTs a fixed body to the published URL.

    The token can only travel in that URL, so the query-string fallback is
    load-bearing for exactly this caller.
    """
    response = api_client.post(
        f"{_opt_out_url(confirmed_email.email)}?token={confirmed_email.token}",
        {ONE_CLICK_FIELD: ONE_CLICK_VALUE},
        format="multipart",
    )

    assert response.status_code == 200, response.content
    assert response["Content-Type"].startswith("text/plain"), (
        "mail providers want a plain 2xx here, not a redirect chain into HTML"
    )
    assert not Email.objects.filter(pk=confirmed_email.pk).exists()
    assert OptOutEmail.objects.filter(email=confirmed_email.email).exists()


@pytest.mark.django_db
def test_post_opt_out_replay_short_circuits(api_client, confirmed_email):
    """Replaying a spent link is a success, not an error."""
    api_client.post(
        _opt_out_url(confirmed_email.email),
        {"token": confirmed_email.token},
        format="multipart",
    )

    replay = api_client.post(
        _opt_out_url(confirmed_email.email),
        {"token": confirmed_email.token},
        format="multipart",
    )

    assert replay.status_code == 303, replay.content
    assert OptOutEmail.objects.filter(email=confirmed_email.email).count() == 1


@pytest.mark.django_db
def test_already_opted_out_short_circuits_before_any_lookup(
    api_client, confirmed_email
):
    """The pre-existing early return, on both halves."""
    OptOutEmail.objects.create(email=confirmed_email.email)

    landing = api_client.get(_opt_out_url(confirmed_email.email))
    posted = api_client.post(
        _opt_out_url(confirmed_email.email), {}, format="multipart"
    )

    assert landing.status_code == 200, landing.content
    assert posted.status_code == 303, posted.content
    assert Email.objects.filter(pk=confirmed_email.pk).exists(), (
        "the short circuit must return before the delete, even with no token"
    )


@pytest.mark.django_db
@pytest.mark.parametrize("method", ["get", "post"])
def test_opt_out_with_a_wrong_token_is_404(api_client, confirmed_email, method):
    response = getattr(api_client, method)(
        _opt_out_url(confirmed_email.email), {"token": "not-the-token"}
    )

    assert response.status_code == 404, response.content
    assert Email.objects.filter(pk=confirmed_email.pk).exists()
    assert not OptOutEmail.objects.filter(email=confirmed_email.email).exists()


@pytest.mark.django_db
@pytest.mark.parametrize("method", ["get", "post"])
def test_opt_out_without_a_token_is_404(api_client, confirmed_email, method):
    response = getattr(api_client, method)(_opt_out_url(confirmed_email.email))

    assert response.status_code == 404, response.content
    assert Email.objects.filter(pk=confirmed_email.pk).exists()


@pytest.mark.django_db
def test_a_concurrent_unsubscribe_of_the_same_address_still_reports_success(
    api_client, confirmed_email, mocker
):
    """The other codex finding on this PR, pinned.

    Two simultaneous one-click POSTs both clear the OptOutEmail check, then
    one wins the account lock and deletes the row. The loser must not tell the
    mail provider its unsubscribe failed. Simulated by committing the winner's
    effect while the loser is acquiring that lock.
    """
    original_get = QuerySet.get
    raced = False

    def unsubscribe_while_we_wait_for_the_lock(queryset, *args, **kwargs):
        nonlocal raced
        if (
            not raced
            and queryset.model is Creator
            and queryset.query.select_for_update
        ):
            raced = True
            OptOutEmail.objects.create(email=confirmed_email.email)
            Email.objects.filter(pk=confirmed_email.pk).delete()
        return original_get(queryset, *args, **kwargs)

    mocker.patch.object(QuerySet, "get", unsubscribe_while_we_wait_for_the_lock)

    response = api_client.post(
        f"{_opt_out_url(confirmed_email.email)}?token={confirmed_email.token}",
        {ONE_CLICK_FIELD: ONE_CLICK_VALUE},
        format="multipart",
    )

    assert raced, "the race never fired; this test proves nothing"
    assert response.status_code == 200, (
        "a losing concurrent unsubscribe answered "
        f"{response.status_code}; a provider records that as a failed "
        "one-click unsubscribe"
    )


@pytest.mark.django_db
def test_opt_out_token_of_one_address_cannot_delete_another(
    api_client, confirmed_email, creator_factory
):
    other = Email.objects.create(
        user=creator_factory(),
        email="someone-else@example.com",
        token="other-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )

    response = api_client.post(
        _opt_out_url(other.email),
        {"token": confirmed_email.token},
        format="multipart",
    )

    assert response.status_code == 404, response.content
    assert Email.objects.filter(pk=other.pk).exists()


# --- outgoing mail: RFC 8058 headers -----------------------------------------


@pytest.mark.django_db
def test_confirmation_mail_advertises_one_click_unsubscribe(pending_email):
    send_confirmation_email(pending_email)

    assert len(mail.outbox) == 1
    message = mail.outbox[0]
    expected = build_opt_out_url(pending_email)
    assert message.extra_headers["List-Unsubscribe"] == f"<{expected}>"
    assert message.extra_headers["List-Unsubscribe-Post"] == (
        f"{ONE_CLICK_FIELD}={ONE_CLICK_VALUE}"
    )


@pytest.mark.django_db
def test_password_reset_mail_does_not_advertise_one_click_unsubscribe(
    confirmed_email,
):
    """The codex finding on this PR, pinned.

    Unsubscribing deletes the Email row (cascading the reset token) and blocks
    every future reset. A mail client's one-click Unsubscribe button next to a
    password-reset message is therefore a warning-free account-lockout control
    offered to the one person who cannot recover from it — they have already
    lost their password, so "sign in and add the address again" is not
    available to them.
    """
    send_password_reset_email(confirmed_email)

    assert len(mail.outbox) == 1
    headers = mail.outbox[0].extra_headers
    assert "List-Unsubscribe" not in headers, (
        "account-recovery mail must not carry a one-click unsubscribe: "
        "clicking it locks the user out of recovery permanently"
    )
    assert "List-Unsubscribe-Post" not in headers


# --- the URL shape itself  --------------------------------------------


@pytest.mark.django_db
def test_opt_out_url_carries_a_token_and_never_the_address(creator_factory):
    """The address is gone from the URL, and with it three separate problems.

    It made the link unroutable for some legal addresses (see below), and it
    put the recipient's address into the access log, into the ``Referer`` of
    anything the landing page loads, and into any analytics that saw the page.
    None of that was buying anything: the token is the credential and the row
    is looked up by it either way.

    The token is still in the URL, and has to be -- an emailed one-click link
    has nowhere else to carry a credential. The property asserted here is that
    the URL no longer *also* names the person, and that the token itself says
    nothing about them: it is `secrets.token_urlsafe`, not an encoding of
    anything. The first attempt at this used `django.core.signing` over
    `{address, token}`, which is authenticated but NOT encrypted -- a base64
    decode of the first component hands back the address. That would have
    passed a naive substring check while leaking exactly what this test is
    about, which is why the regex below is on the whole path.
    """
    email = Email.objects.create(
        user=creator_factory(),
        email="odd#name?x@example.com",
        token="Aa0-_" * 17,
        expires_at=timezone.now() + timedelta(hours=1),
    )

    url = build_opt_out_url(email)
    path = url.split("/api/emails/opt-out/")[1]

    assert "?" not in path, "the token belongs in the path, not the query"
    assert path == email.token, "the path is the token and nothing else"
    assert email.email not in url
    assert "odd" not in url and "example.com" not in url, (
        "some part of the address survived into the URL"
    )
    # `secrets.token_urlsafe`'s alphabet, and nothing that could encode text
    # a reader could decode back into the address.
    assert re.fullmatch(r"[A-Za-z0-9\-_]+", path), path


@pytest.mark.django_db
def test_a_slash_in_the_address_round_trips_end_to_end(
    api_client, creator_factory
):
    """The regression this issue exists for.

    ``a/b@example.com`` is a legal address (RFC 5321 permits ``/`` in an
    unquoted local part). With the address in the path, Django's ``str``
    converter stopped at the slash, so the emailed link 404'd forever and that
    recipient could not unsubscribe by clicking — a one-click-unsubscribe
    (RFC 8058) and CAN-SPAM problem, not a cosmetic one. Percent-encoding did
    not help: Django decodes ``%2F`` before matching.
    """
    email = Email.objects.create(
        user=creator_factory(),
        email="a/b@example.com",
        token="slash-address-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )
    path = build_opt_out_url(email).split(get_email_link_origin())[1]

    landing = api_client.get(path)
    assert landing.status_code == 200, landing.content
    assert "a/b@example.com" in landing.content.decode()

    unsubscribed = api_client.post(path, {}, format="multipart")

    assert unsubscribed.status_code == 303, unsubscribed.content
    assert OptOutEmail.objects.filter(email="a/b@example.com").exists()
    assert not Email.objects.filter(pk=email.pk).exists()


@pytest.mark.django_db
def test_token_only_get_renders_and_deletes_nothing(
    api_client, confirmed_email
):
    """Same GET/POST split as the legacy shape, on the new URL."""
    path = _token_only_path(confirmed_email)

    response = api_client.get(path)

    assert response.status_code == 200, response.content
    assert Email.objects.filter(pk=confirmed_email.pk).exists()
    assert not OptOutEmail.objects.filter(
        email=confirmed_email.email).exists()
    assert response.content.decode().count("<button") == 1


@pytest.mark.django_db
def test_token_only_landing_does_not_echo_the_raw_token(
    api_client, confirmed_email
):
    """The link already carries the credential; the page need not repeat it.

    On a legacy link the form still has to post the token, because the URL
    does not contain it. On a token-only link putting it in a hidden field
    would reintroduce the raw ``Email.token`` into the page for no reason.
    """
    body = api_client.get(_token_only_path(confirmed_email)).content.decode()

    assert confirmed_email.token not in body
    assert 'method="post"' in body


@pytest.mark.django_db
def test_token_only_post_unsubscribes_with_an_empty_body(
    api_client, confirmed_email
):
    """No body token needed: the path is the credential."""
    path = _token_only_path(confirmed_email)

    response = api_client.post(path, {}, format="multipart")

    assert response.status_code == 303, response.content
    assert response["Location"] == path, (
        "post/redirect/get back to the same landing URL"
    )
    assert not Email.objects.filter(pk=confirmed_email.pk).exists()
    assert OptOutEmail.objects.filter(email=confirmed_email.email).exists()


@pytest.mark.django_db
def test_token_only_landing_still_says_unsubscribed_after_the_write(
    api_client, confirmed_email
):
    """The redirect target must resolve after the ``Email`` row is deleted.

    This is the one thing the address-in-the-path shape made easy and a
    token-only shape does not get for free: the write deletes the row the
    token belonged to. ``OptOutEmail.link_token`` is what keeps the URL
    resolving — see the model comment.
    """
    path = _token_only_path(confirmed_email)
    api_client.post(path, {}, format="multipart")

    followed = api_client.get(path)

    assert followed.status_code == 200, followed.content
    body = followed.content.decode()
    assert "unsubscribed" in body.lower()
    assert confirmed_email.email in body
    assert "<button" not in body


@pytest.mark.django_db
def test_token_only_one_click_post_unsubscribes(api_client, confirmed_email):
    """RFC 8058 with nothing in the query string at all."""
    response = api_client.post(
        _token_only_path(confirmed_email),
        {ONE_CLICK_FIELD: ONE_CLICK_VALUE},
        format="multipart",
    )

    assert response.status_code == 200, response.content
    assert response["Content-Type"].startswith("text/plain")
    assert OptOutEmail.objects.filter(email=confirmed_email.email).exists()


@pytest.mark.django_db
def test_token_only_post_replay_short_circuits(api_client, confirmed_email):
    path = _token_only_path(confirmed_email)

    assert api_client.post(path, {}, format="multipart").status_code == 303
    replay = api_client.post(path, {}, format="multipart")

    assert replay.status_code == 303, replay.content
    assert OptOutEmail.objects.filter(email=confirmed_email.email).count() == 1


@pytest.mark.django_db
@pytest.mark.parametrize("method", ["get", "post"])
def test_a_forged_link_token_is_404(api_client, confirmed_email, method):
    """A token that matches no row is not a credential.

    It falls through to the legacy reading — where it is a nonsense address
    with no token — and dies there, which is the same 404 a wrong token has
    always produced.
    """
    forged = opt_out_link_token(confirmed_email)[:-4] + "AAAA"

    response = getattr(api_client, method)(
        f"/api/emails/opt-out/{forged}", {}, format="multipart",
    )

    assert response.status_code == 404, response.content
    assert Email.objects.filter(pk=confirmed_email.pk).exists()
    assert not OptOutEmail.objects.filter(
        email=confirmed_email.email).exists()


@pytest.mark.django_db
def test_a_link_token_stops_working_when_the_address_token_rotates(
    api_client, confirmed_email
):
    """Authorisation is unchanged by the new URL shape.

    The per-address ``Email.token`` is still what the view matches, so a link
    minted before a rotation is dead afterwards exactly as it was before.
    """
    path = _token_only_path(confirmed_email)
    Email.objects.filter(pk=confirmed_email.pk).update(token="rotated-token")

    assert api_client.get(path).status_code == 404
    assert api_client.post(path, {}, format="multipart").status_code == 404
    assert not OptOutEmail.objects.filter(
        email=confirmed_email.email).exists()


@pytest.mark.django_db
def test_a_link_token_cannot_unsubscribe_a_different_address(
    api_client, confirmed_email, creator_factory
):
    """The path token wins: a body token cannot redirect the write elsewhere.

    The address is derived from the path token, so there is nothing left for a
    body or query parameter to influence.
    """
    other = Email.objects.create(
        user=creator_factory(),
        email="someone-else@example.com",
        token="other-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )

    response = api_client.post(
        _token_only_path(confirmed_email),
        {"token": other.token},
        format="multipart",
    )

    assert response.status_code == 303, response.content
    assert Email.objects.filter(pk=other.pk).exists(), (
        "a body token overrode the signed link and hit another address"
    )
    assert not OptOutEmail.objects.filter(email=other.email).exists()


@pytest.mark.django_db
def test_signed_in_user_can_submit_the_landing_form(creator_factory):
    """The 3am one: DRF enforces CSRF for session-authenticated POSTs.

    The person clicking a confirmation link is usually signed in, so the
    landing page must hand them a CSRF token AND set the cookie it is checked
    against. ``enforce_csrf_checks=True`` is what makes this test mean
    anything — the stock test client skips the check entirely.
    """
    user = creator_factory()
    user.set_password("a-long-enough-password")
    user.save()
    email = Email.objects.create(
        user=user,
        email="signed-in@example.com",
        token="signed-in-token",
        expires_at=timezone.now() + timedelta(hours=1),
    )

    client = APIClient(enforce_csrf_checks=True)
    assert client.login(
        username=user.username, password="a-long-enough-password"
    )

    landing = client.get(CONFIRM_URL, {"token": email.token})
    assert "csrftoken" in landing.cookies, (
        "the landing page did not set the CSRF cookie its own form needs"
    )
    csrf = re.search(
        r'name="csrfmiddlewaretoken" value="([^"]+)"',
        landing.content.decode(),
    )
    assert csrf, landing.content

    response = client.post(
        CONFIRM_URL,
        {"token": email.token, "csrfmiddlewaretoken": csrf.group(1)},
        format="multipart",
    )

    assert response.status_code == 303, response.content
    email.refresh_from_db()
    assert email.confirmed_at is not None


# --- throttling still applies ------------------------------------------------


@pytest.mark.django_db
def test_the_link_landings_still_share_the_anon_link_bucket(
    api_client, confirmed_email
):
    """Both methods of both views are charged to 'anon-link'."""
    tiny = dict(SimpleRateThrottle.THROTTLE_RATES, **{"anon-link": "3/minute"})

    with mock.patch.object(SimpleRateThrottle, "THROTTLE_RATES", tiny):
        statuses = [
            api_client.get(CONFIRM_URL).status_code for _ in range(3)
        ]
        statuses.append(
            api_client.post(
                _opt_out_url(confirmed_email.email),
                {"token": confirmed_email.token},
                format="multipart",
            ).status_code
        )

    assert statuses[-1] == 429, (
        f"the opt-out POST escaped the anon-link bucket: {statuses}"
    )
    assert Email.objects.filter(pk=confirmed_email.pk).exists()
