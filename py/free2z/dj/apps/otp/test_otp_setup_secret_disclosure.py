"""The TOTP seed leaves the server once, at enrolment, and never again.

``POST /api/otp/setup/`` was ``OTPSecret.objects.get_or_create(...)`` followed
by an unconditional ``"secret": otp_secret.secret``. For an account that had
already enrolled, ``get_or_create`` returns the EXISTING row -- so re-POSTing
to the enrolment endpoint handed back the account's live TOTP seed.

That is worse than it first reads. A stolen session or password buys access
until it is revoked; a stolen seed generates valid second-factor codes forever,
survives a password reset, and the victim gets no signal that it happened. It
is the difference between an incident and a permanent one.

Real Postgres per project rule -- the OTP boundary is ORM plus pyotp, with no
external service to stub.
"""
import pytest

from dj.apps.otp.models import OTPSecret


SETUP_URL = "/api/otp/setup/"
STATUS_URL = "/api/otp/status/"


def _secret_strings(payload):
    """Every string in a response body, so a seed cannot hide in a URI."""
    if isinstance(payload, dict):
        for value in payload.values():
            yield from _secret_strings(value)
    elif isinstance(payload, (list, tuple)):
        for value in payload:
            yield from _secret_strings(value)
    elif isinstance(payload, str):
        yield payload


def _leaks(response, secret):
    """True if `secret` appears anywhere in the response, body bytes included.

    Checking parsed fields alone is not enough: the seed also travels inside
    the ``otpauth://`` URI, which is where the QR code comes from.
    """
    if secret.encode("utf-8") in response.content:
        return True
    return any(secret in value for value in _secret_strings(response.data))


@pytest.mark.django_db
def test_first_setup_issues_a_pending_secret(api_client, creator_factory):
    user = creator_factory()
    api_client.force_authenticate(user=user)

    response = api_client.post(SETUP_URL)

    assert response.status_code == 201, response.content
    row = OTPSecret.objects.get(user=user)
    assert row.is_active is False
    assert response.data["secret"] == row.secret
    assert row.secret in response.data["otp_uri"]


@pytest.mark.django_db
def test_setup_rotates_an_abandoned_pending_enrolment(
    api_client, creator_factory
):
    """One QR code per enrolment attempt: never re-disclose a pending seed."""
    user = creator_factory()
    api_client.force_authenticate(user=user)

    first = api_client.post(SETUP_URL).data["secret"]
    second = api_client.post(SETUP_URL).data["secret"]

    assert first != second
    row = OTPSecret.objects.get(user=user)
    assert row.secret == second
    assert row.is_active is False
    assert OTPSecret.objects.filter(user=user).count() == 1


@pytest.mark.django_db
def test_setup_never_returns_an_active_seed(api_client, creator_factory):
    """THE bug. An enrolled account must not be able to read its own seed back.

    ``get_or_create`` made this a 201 carrying the live secret. It must now be
    a refusal with no seed material anywhere in the response.
    """
    user = creator_factory()
    active_secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    OTPSecret.objects.create(user=user, secret=active_secret, is_active=True)
    api_client.force_authenticate(user=user)

    response = api_client.post(SETUP_URL)

    assert response.status_code == 409, response.content
    assert not _leaks(response, active_secret)
    assert "secret" not in response.data
    assert "otp_uri" not in response.data
    # And the refusal must not have disturbed the enrolment it refused.
    row = OTPSecret.objects.get(user=user)
    assert row.secret == active_secret
    assert row.is_active is True


@pytest.mark.django_db
def test_repeated_setup_after_enrolment_never_leaks(
    api_client, creator_factory
):
    """Hammering the endpoint must not eventually produce the seed."""
    user = creator_factory()
    active_secret = "MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U"
    OTPSecret.objects.create(user=user, secret=active_secret, is_active=True)
    api_client.force_authenticate(user=user)

    for _ in range(5):
        response = api_client.post(SETUP_URL)
        assert response.status_code == 409, response.content
        assert not _leaks(response, active_secret)


@pytest.mark.django_db
def test_status_endpoint_reports_enrolment_without_the_seed(
    api_client, creator_factory
):
    user = creator_factory()
    active_secret = "NBSWY3DPFQQFO33SNRSCC5DBORUW63TT"
    OTPSecret.objects.create(user=user, secret=active_secret, is_active=True)
    api_client.force_authenticate(user=user)

    response = api_client.get(STATUS_URL)

    assert response.status_code == 200, response.content
    assert response.data == {"enabled": True}
    assert not _leaks(response, active_secret)


@pytest.mark.django_db
def test_setup_secret_is_a_fresh_random_base32_seed(
    api_client, creator_factory
):
    """Two accounts enrolling must not be handed the same seed."""
    api_client.force_authenticate(user=creator_factory())
    first = api_client.post(SETUP_URL).data["secret"]

    api_client.force_authenticate(user=creator_factory())
    second = api_client.post(SETUP_URL).data["secret"]

    assert first != second
    assert len(first) >= 16
    assert set(first) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567=")


@pytest.mark.django_db
def test_setup_requires_authentication(api_client):
    assert api_client.post(SETUP_URL).status_code in (401, 403)
