"""Regression tests for DisableOTPView requiring a second factor.

Before this fix, ``DELETE /api/otp/disable/`` deleted the user's OTPSecret on
*any* authenticated request — so a hijacked session (or a borrowed, already
logged-in browser) could strip MFA with nothing but the cookie, defeating the
whole point of the second factor. Disabling MFA must itself require proof of
the second factor: a current TOTP token or the account password.

Real Postgres per project rule; the OTP boundary is pure ORM + pyotp, no
external service to stub.
"""
from datetime import datetime, timezone
from types import SimpleNamespace

import pyotp
import pyotp.totp
import pytest
from django.core.cache import cache

from dj.apps.otp.models import OTPSecret


_TEST_TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"


@pytest.fixture(autouse=True)
def _clear_throttle_history():
    # DisableOTPView carries a 1/second brute throttle; counters live in the
    # process-local cache and would otherwise leak between tests.
    cache.clear()
    yield
    cache.clear()


def _enable_otp(user, secret=None):
    if secret is None:
        secret = pyotp.random_base32()
    OTPSecret.objects.create(user=user, secret=secret, is_active=True)
    return secret


def _freeze_pyotp_clock(monkeypatch):
    """Freeze BOTH clocks TOTP verification touches.

    Since, ``consume_token`` pins verification to ONE captured instant:
    ``dj.apps.otp.utils.timezone.now()`` is what gets compared AND handed to
    pyotp via ``for_time``. Freezing only pyotp's clock would leave the
    verifier anchored to the real wall clock, so the utils clock is frozen to
    the same timestamp here. The utils fake returns FrozenDateTime instances
    because pyotp's ``at()``/``verify()`` isinstance-check ``for_time``
    against exactly the class patched into ``pyotp.totp.datetime``.
    """
    frozen_now = datetime(2030, 1, 1, 12, 34, 15, tzinfo=timezone.utc)
    frozen_timestamp = int(frozen_now.timestamp())

    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            if tz is None:
                return cls.fromtimestamp(frozen_now.timestamp())
            return cls.fromtimestamp(frozen_now.timestamp(), tz)

    monkeypatch.setattr(
        pyotp.totp,
        "datetime",
        SimpleNamespace(datetime=FrozenDateTime),
    )

    import dj.apps.otp.utils as otp_utils

    class FrozenTimezone:
        @staticmethod
        def now():
            return FrozenDateTime.fromtimestamp(
                frozen_timestamp, tz=timezone.utc
            )

    monkeypatch.setattr(otp_utils, "timezone", FrozenTimezone)
    return frozen_timestamp


@pytest.mark.django_db
def test_disable_rejects_session_only_request(api_client, creator_factory):
    """The attack: authenticated but no second factor -> refused, secret kept."""
    user = creator_factory()
    _enable_otp(user)
    api_client.force_authenticate(user=user)

    response = api_client.delete("/api/otp/disable/")

    assert response.status_code == 403, response.content
    assert OTPSecret.objects.filter(user=user).exists()


@pytest.mark.django_db
def test_disable_rejects_wrong_token(api_client, creator_factory, monkeypatch):
    frozen_timestamp = _freeze_pyotp_clock(monkeypatch)
    user = creator_factory()
    secret = _enable_otp(user, _TEST_TOTP_SECRET)
    api_client.force_authenticate(user=user)

    current_token = pyotp.TOTP(secret).at(frozen_timestamp)
    wrong_token = str((int(current_token) + 1) % 1_000_000).zfill(6)
    assert wrong_token != current_token

    response = api_client.delete(
        "/api/otp/disable/", {"token": wrong_token}, format="json"
    )

    assert response.status_code == 403, response.content
    assert OTPSecret.objects.filter(user=user).exists()


@pytest.mark.django_db
def test_disable_accepts_valid_totp_token(api_client, creator_factory, monkeypatch):
    frozen_timestamp = _freeze_pyotp_clock(monkeypatch)
    user = creator_factory()
    secret = _enable_otp(user, _TEST_TOTP_SECRET)
    api_client.force_authenticate(user=user)

    totp = pyotp.TOTP(secret)
    token = totp.now()
    assert token == totp.at(frozen_timestamp)
    response = api_client.delete("/api/otp/disable/", {"token": token}, format="json")

    assert response.status_code == 200, response.content
    assert not OTPSecret.objects.filter(user=user).exists()


@pytest.mark.django_db
def test_disable_rejects_adjacent_totp_token(api_client, creator_factory, monkeypatch):
    frozen_timestamp = _freeze_pyotp_clock(monkeypatch)
    user = creator_factory()
    secret = _enable_otp(user, _TEST_TOTP_SECRET)
    api_client.force_authenticate(user=user)

    totp = pyotp.TOTP(secret)
    current_token = totp.at(frozen_timestamp)
    adjacent_token = totp.at(frozen_timestamp + totp.interval)
    assert adjacent_token != current_token

    response = api_client.delete(
        "/api/otp/disable/", {"token": adjacent_token}, format="json"
    )

    assert response.status_code == 403, response.content
    assert OTPSecret.objects.filter(user=user).exists()


@pytest.mark.django_db
def test_disable_accepts_account_password(api_client, creator_factory):
    user = creator_factory(password="s3cret-pw")
    _enable_otp(user)
    api_client.force_authenticate(user=user)

    response = api_client.delete(
        "/api/otp/disable/", {"password": "s3cret-pw"}, format="json"
    )

    assert response.status_code == 200, response.content
    assert not OTPSecret.objects.filter(user=user).exists()


@pytest.mark.django_db
def test_disable_when_not_enabled_is_400_not_500(api_client, creator_factory):
    user = creator_factory()
    api_client.force_authenticate(user=user)

    response = api_client.delete("/api/otp/disable/")

    assert response.status_code == 400, response.content
