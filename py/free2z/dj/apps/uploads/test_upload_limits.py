"""
The upload size ceiling: the tier table, the nginx enforcement point, and the
API that discloses it.

The point of these is that ONE table drives both. `upload_limit` (what nginx
asks before proxying a body) and `GET /api/uploads/limits/` (what a client asks
before picking a file) must never be able to disagree, so the enforcement tests
below are written against the *disclosed* limit rather than against a second
copy of the numbers — a table edit that broke the pairing would go red here
even though both halves are individually self-consistent.

The absolute numbers are pinned separately, once, in
`test_the_tier_table_is_the_products_and_has_not_been_rounded`: they are the
product's, and an accidental "improvement" to one of them is exactly what a
paying creator would notice before we did.
"""
from decimal import Decimal

import pytest
from django.urls import reverse

from dj.apps.uploads.limits import (
    MB,
    MAX_BUFFERED_UPLOAD_REQUEST_BYTES,
    UPLOAD_SIZE_TIERS,
    max_upload_bytes_for,
    whole_tuzis,
)


LIMITS_URL = "/api/uploads/limits/"


def _limit_subrequest(client, content_length):
    """Exactly what nginx's `auth_request` sends: no body, just the header."""
    return client.get(
        reverse("upload_limit"),
        HTTP_X_ORIGINAL_CONTENT_LENGTH=str(content_length),
    )


# --- the table itself ------------------------------------------------------


def test_the_tier_table_is_the_products_and_has_not_been_rounded():
    """
    The one place the literal numbers are asserted. They are a monetization
    decision, not an implementation detail: 5MiB free; 250MiB with any
    balance. Keep the historic 5000 2Z rung but cap it at the same request
    size, so the larger-body streamed path is never admitted by a tier.
    """
    assert UPLOAD_SIZE_TIERS == (
        (0, 5 * MB),
        (1, 250 * MB),
        (5000, 250 * MB),
    )
    assert MB == 1024 * 1024
    assert all(
        max_bytes <= MAX_BUFFERED_UPLOAD_REQUEST_BYTES
        for _, max_bytes in UPLOAD_SIZE_TIERS
    )


@pytest.mark.parametrize(
    "tuzis,expected",
    [
        ("0", 5 * MB),
        # Truncation, not rounding: 0.999 2Z has never reached the paid tier
        # and must not start to.
        ("0.999", 5 * MB),
        ("1", 250 * MB),
        ("4999.999", 250 * MB),
        ("5000", 250 * MB),
        ("123456", 250 * MB),
    ],
)
def test_max_upload_bytes_for_walks_the_ladder(tuzis, expected):
    class _User:
        pass

    user = _User()
    user.tuzis = Decimal(tuzis)
    assert max_upload_bytes_for(user) == expected


def test_an_unreadable_balance_falls_to_the_free_tier():
    """
    Never fail open. Anything we cannot read as a number is the 5MB tier, not
    an unbounded one.
    """
    class _User:
        pass

    user = _User()
    user.tuzis = None
    assert whole_tuzis(user) == 0
    assert max_upload_bytes_for(user) == 5 * MB

    user.tuzis = "not a number"
    assert whole_tuzis(user) == 0
    assert max_upload_bytes_for(user) == 5 * MB

    assert max_upload_bytes_for(object()) == 5 * MB


# --- the disclosure endpoint ----------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_limits_endpoint_reports_the_callers_own_ceiling(
        api_client, creator_factory):
    creator = creator_factory(tuzis=Decimal("0"))
    api_client.force_authenticate(user=creator)

    response = api_client.get(LIMITS_URL)

    assert response.status_code == 200
    assert response.data["max_bytes"] == 5 * MB
    assert response.data["tuzis"] == 0


@pytest.mark.django_db(transaction=True)
def test_limits_endpoint_reflects_a_paid_balance(api_client, creator_factory):
    creator = creator_factory(tuzis=Decimal("5000"))
    api_client.force_authenticate(user=creator)

    response = api_client.get(LIMITS_URL)

    assert response.status_code == 200
    assert response.data["max_bytes"] == 250 * MB
    assert response.data["tuzis"] == 5000


@pytest.mark.django_db(transaction=True)
def test_limits_endpoint_publishes_the_whole_ladder(
        api_client, creator_factory):
    """
    Not just the caller's rung. A UI that can only say "5MB" cannot say what
    would raise it, which is the half of the message that is actionable.
    """
    creator = creator_factory(tuzis=Decimal("0"))
    api_client.force_authenticate(user=creator)

    tiers = api_client.get(LIMITS_URL).data["tiers"]

    assert [(t["min_tuzis"], t["max_bytes"]) for t in tiers] == list(
        UPLOAD_SIZE_TIERS)




def test_the_contract_says_what_max_bytes_is_measured_against():
    """
    `max_bytes` is compared against the whole multipart REQUEST, not the file:
    nginx hands the subrequest `$content_length`, which also carries the
    boundaries, part headers, filename and metadata field. So a file of
    exactly `max_bytes` is refused.

    There is no correct constant to subtract here — the envelope depends on
    the filename and the fields the client sends — so the contract has to say
    it instead, or every generated client silently promises a file-size
    allowance the server does not honour. This asserts the disclosure, which
    is the only part of that we can enforce; it flows into `f2z.yaml` and the
    generated TypeScript client. (Raised by the codex review of 's
    successor.)
    """
    from dj.apps.uploads.limits import UploadLimitSerializer

    help_text = UploadLimitSerializer().fields["max_bytes"].help_text
    assert "REQUEST" in help_text
    assert "Content-Length" in help_text
    assert "exactly `max_bytes` is therefore refused" in help_text


def test_the_contract_admits_the_uploads_are_session_only():
    """
    The generated spec advertises `knoxApiToken` on this endpoint, because it
    takes the project's default authentication classes. The endpoints the
    limit APPLIES to do not: `/uploads/handle` and `/uploads/single-public`
    are plain Django `@login_required` views, which read `request.user` from
    the session and know nothing about DRF token authentication.

    So a token-only client can read its limit and still be unable to upload —
    a promise the contract would otherwise make and not keep. Porting those
    two handlers to DRF is what closes it for real; until then the
    description has to say so. (Raised by the codex review of this PR.)
    """
    from pathlib import Path

    from dj.apps.uploads import views as uploads_views

    # Asserted against the SHIPPED contract, not the decorator: `f2z.yaml` is
    # what a generated client is built from, and the `backend` CI job already
    # proves it matches the code.
    spec = (Path(__file__).parents[5] / "py/free2z/dj/free2z/openapi/f2z.yaml").read_text()
    limits = spec.split('/api/uploads/limits/:', 1)[1].split('\n  /', 1)[0]
    assert 'knoxApiToken' in limits, (
        'the premise changed: this endpoint no longer advertises token auth, '
        'so the caveat below may be obsolete.'
    )
    assert 'Session authentication only' in limits
    assert '/uploads/handle' in limits

    # The premise, asserted rather than assumed: these really are undecorated
    # Django views behind `login_required`, not DRF ones.
    for handler in (uploads_views.uploads_handle,
                    uploads_views.single_public_upload_handle):
        assert not hasattr(handler, 'cls'), (
            f'{handler.__name__} is a DRF view now — re-check the claim in '
            'UploadLimitView.get()\'s description before shipping it.'
        )


@pytest.mark.django_db(transaction=True)
def test_limits_endpoint_requires_authentication(api_client):
    """Uploading is `@login_required`; there is no anonymous ceiling."""
    assert api_client.get(LIMITS_URL).status_code in (401, 403)


# --- the enforcement point, driven by the disclosed number -----------------


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("tuzis", ["0", "1", "5000"])
def test_nginx_subrequest_admits_exactly_what_the_api_promises(
        client, api_client, creator_factory, tuzis):
    """
    The anti-drift assertion. Read the limit from the API, then push a body of
    exactly that size and one byte more at the *enforcement* point: a table
    that moved in one place and not the other cannot pass both halves.
    """
    creator = creator_factory(tuzis=Decimal(tuzis))
    api_client.force_authenticate(user=creator)
    promised = api_client.get(LIMITS_URL).data["max_bytes"]

    client.force_login(creator)

    assert promised <= MAX_BUFFERED_UPLOAD_REQUEST_BYTES
    assert _limit_subrequest(client, promised).status_code == 204
    assert _limit_subrequest(client, promised + 1).status_code == 403
    # Even the 5000+ balance tier must refuse the first request length nginx
    # routes through @uploads_streamed. The header is the whole multipart
    # request, so this also covers its boundaries, file headers and metadata.
    assert _limit_subrequest(client, 300_000_000).status_code == 403


@pytest.mark.django_db(transaction=True)
def test_nginx_subrequest_refuses_an_unparseable_length(
        client, creator_factory):
    """
    A missing or non-numeric `X-Original-Content-Length` is a refusal, not an
    unbounded pass. nginx sets `$content_length`, which is empty for a
    chunked request.
    """
    creator = creator_factory(tuzis=Decimal("0"))
    client.force_login(creator)

    assert _limit_subrequest(client, "").status_code == 403
    assert _limit_subrequest(client, "lots").status_code == 403
    assert _limit_subrequest(client, "-1").status_code == 403
    assert client.get(reverse("upload_limit")).status_code == 403


@pytest.mark.django_db(transaction=True)
def test_nginx_subrequest_answers_anonymous_with_a_status_auth_request_knows(
        client):
    """
    : nginx's `auth_request` honours only 2xx, 401 and 403; anything
    else becomes a 500 for the whole upload. `@login_required` answered an
    anonymous caller with a 302 to LOGIN_URL, which prod logged as
    `auth request unexpected status: 302` -> `POST /uploads/single-public`
    500. A 401 lets `error_page 401 403 = @deny_upload` refuse it cleanly.
    """
    response = _limit_subrequest(client, 1024)
    assert response.status_code == 401
    assert "Location" not in response.headers
