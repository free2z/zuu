"""Regression tests for single-use TOTP codes.

RFC 6238 section 5.2: a verifier MUST reject a second successful verification
of the same code within one time step. Before this fix,
``OTPSecret.last_used_at`` existed but was never written, so the six digits
shown by an authenticator right now could be replayed across every TOTP-gated
route -- log in, then reuse the identical code to disable MFA -- until the
step rolled over.

Real Postgres per project rule; the OTP boundary is pure ORM + pyotp, no
external service to stub.

Time control: both clocks that matter are frozen together --
``pyotp.totp.datetime`` (what mint/verify the codes) and
``dj.apps.otp.utils.timezone`` (what stamps ``last_used_at``) -- so a test can
reason about "the same step" deterministically instead of hoping two requests
land inside the same wall-clock 30s window.
"""
from datetime import datetime, timedelta, timezone as dt_timezone
from types import SimpleNamespace
import threading

import pyotp
import pyotp.totp
import pytest
from django.core.cache import cache

from dj.apps.otp.models import OTPSecret


_TEST_TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

# 2030-01-01T12:34:15Z -- 15 seconds into its 30s step, comfortably away from
# any boundary so "same step" is never ambiguous.
_FROZEN_TS = 1893458055


@pytest.fixture(autouse=True)
def _clear_throttle_history():
    # The OTP views carry a 1/second brute throttle; counters live in the
    # process-local cache and would otherwise leak between tests.
    cache.clear()
    yield
    cache.clear()


def _enable_otp(user, secret=None, **kwargs):
    if secret is None:
        secret = _TEST_TOTP_SECRET
    return OTPSecret.objects.create(
        user=user, secret=secret, is_active=True, **kwargs
    )


class _FrozenClock:
    """Independent, mutable instants for the two clocks TOTP touches.

    ``utils_ts`` is what dj.apps.otp.utils.timezone.now() returns; ``pyotp_ts``
    is what pyotp's internal datetime.now() returns. Keeping them separate is
    what makes the boundary-skew regression below possible: production runs
    them off the same wall clock, and the two-clock bug was that one
    consume_token() call could read them across a step boundary.
    """

    def __init__(self, utils_ts=_FROZEN_TS, pyotp_ts=_FROZEN_TS):
        self.utils_ts = utils_ts
        self.pyotp_ts = pyotp_ts

    def set(self, utils_ts=None, pyotp_ts=None):
        if utils_ts is not None:
            self.utils_ts = utils_ts
        if pyotp_ts is not None:
            self.pyotp_ts = pyotp_ts


def _freeze_time(monkeypatch, clock=None):
    """Freeze BOTH the pyotp clock and dj.apps.otp.utils.timezone.

    Both fakes share ONE FrozenDateTime class on purpose: pyotp.totp's
    ``datetime.datetime`` becomes this class once patched, and its
    ``isinstance(for_time, datetime.datetime)`` checks (in ``at()``/``verify()``)
    only accept instances of exactly that class. The utils fake therefore
    returns FrozenDateTime instances too -- otherwise pinned-instant
    verification would die in pyotp's isinstance gate with
    "int() argument must be... not 'datetime.datetime'".
    """
    import dj.apps.otp.utils as otp_utils

    clock = clock or _FrozenClock()

    class FrozenDateTime(datetime):
        @classmethod
        def _from_ts(cls, t, tz=None):
            """Build a FrozenDateTime from a Unix timestamp."""
            base = super().fromtimestamp(t, tz)
            return cls(base.year, base.month, base.day,
                       base.hour, base.minute, base.second,
                       base.microsecond, base.tzinfo)

        @classmethod
        def now(cls, tz=None):
            return cls._from_ts(clock.pyotp_ts, tz)

    monkeypatch.setattr(
        pyotp.totp, "datetime", SimpleNamespace(datetime=FrozenDateTime)
    )

    class FrozenTimezone:
        @staticmethod
        def now():
            # Read the mutable clock on every call; return the SAME class
            # pyotp's isinstance gate expects.
            return FrozenDateTime._from_ts(clock.utils_ts, dt_timezone.utc)

    # raising=False: on pre-fix code utils.py has no `timezone` attribute
    # yet; the freeze simply does not apply there.
    monkeypatch.setattr(otp_utils, "timezone", FrozenTimezone, raising=False)
    return clock


def _token_at(secret, timestamp=None):
    return pyotp.TOTP(secret).at(
        _FROZEN_TS if timestamp is None else timestamp
    )


def _clear_brute_throttle():
    """Reset the 1/second brute counter between back-to-back requests.

    The throttle is orthogonal to what these tests assert; without this the
    SECOND request of a replay pair would be refused with 429 for pacing
    reasons and the single-use assertion would never even be reached.
    """
    cache.clear()


# --------------------------------------------------------------------------
# Negative controls: every test below was run against the unfixed code and
# failed exactly as documented in its docstring, before the fix was written.
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_login_rejects_replayed_totp_code_within_same_step(
    api_client, creator_factory, monkeypatch
):
    """/api/otp/login/ must not accept the same code twice in one step.

    Pre-fix failure: the second POST returned 200 "Login successful." --
    the exact RFC 6238 violation under repair.
    """
    _freeze_time(monkeypatch)
    user = creator_factory(password="correct-password")
    secret = _enable_otp(user).secret
    token = _token_at(secret)

    first = api_client.post(
        "/api/otp/login/",
        {"username": user.username, "password": "correct-password",
         "token": token},
        format="json",
    )
    _clear_brute_throttle()
    replay = api_client.post(
        "/api/otp/login/",
        {"username": user.username, "password": "correct-password",
         "token": token},
        format="json",
    )

    assert first.status_code == 200, first.content
    assert replay.status_code == 400, replay.content
    assert replay.json()["message"] == "Invalid token."


@pytest.mark.django_db
def test_burned_login_code_cannot_strip_mfa_on_disable_route(
    api_client, creator_factory, monkeypatch
):
    """A code consumed at login must not also authorize DELETE /disable/.

    Pre-fix failure: stateless verification let the identical six digits
    both log the attacker in AND delete the account's MFA within the step.
    """
    _freeze_time(monkeypatch)
    user = creator_factory(password="correct-password")
    secret = _enable_otp(user).secret
    token = _token_at(secret)

    login = api_client.post(
        "/api/otp/login/",
        {"username": user.username, "password": "correct-password",
         "token": token},
        format="json",
    )
    assert login.status_code == 200, login.content
    _clear_brute_throttle()

    client = api_client.__class__()
    client.force_authenticate(user=user)
    disable = client.delete("/api/otp/disable/", {"token": token}, format="json")

    assert disable.status_code == 403, disable.content
    assert OTPSecret.objects.filter(user=user, is_active=True).exists()


@pytest.mark.django_db
def test_enable_totp_code_cannot_be_replayed(api_client, creator_factory,
                                             monkeypatch):
    """POST /api/otp/enable/ must burn the enabling code.

    Pre-fix failure: enable returned 200 twice for the same code.
    """
    _freeze_time(monkeypatch)
    user = creator_factory()
    otp_row = OTPSecret.objects.create(
        user=user, secret=_TEST_TOTP_SECRET, is_active=False
    )
    api_client.force_authenticate(user=user)
    token = _token_at(_TEST_TOTP_SECRET)

    first = api_client.post("/api/otp/enable/", {"token": token}, format="json")
    _clear_brute_throttle()
    replay = api_client.post("/api/otp/enable/", {"token": token}, format="json")

    assert first.status_code == 200, first.content
    assert replay.status_code == 400, replay.content
    otp_row.refresh_from_db()
    assert otp_row.is_active is True


@pytest.mark.django_db
def test_setup_rotation_resets_consumption_state(api_client, creator_factory):
    """Rotating a pending seed must clear any recorded consumption.

    A newly rotated enrolment must never be blocked by the OLD secret's
    timestamp. Pre-fix failure: ``last_used_at`` survived the rotation.
    """
    stale_ts = datetime.fromtimestamp(_FROZEN_TS, tz=dt_timezone.utc)
    user = creator_factory()
    old = OTPSecret.objects.create(
        user=user,
        secret=_TEST_TOTP_SECRET,
        is_active=False,
        last_used_at=stale_ts,
    )
    api_client.force_authenticate(user=user)

    response = api_client.post("/api/otp/setup/", format="json")

    assert response.status_code == 201, response.content
    old.refresh_from_db()
    assert old.secret != _TEST_TOTP_SECRET
    assert old.last_used_at is None


@pytest.mark.django_db
def test_creator_login_rejects_replayed_totp_code(api_client, creator_factory,
                                                  monkeypatch):
    """The /api/auth/login/ gate burns its code too.

    Pre-fix failure: the second password+captcha+code login succeeded.
    """
    _freeze_time(monkeypatch)

    def verify_captcha(_url, **_kwargs):
        # pytest runs with DEBUG=False, so the serializer's 'test' bypass is
        # off; stub siteverify like the other creator-login tests do.
        return SimpleNamespace(json=lambda: {"success": True})

    monkeypatch.setattr(
        "dj.apps.g12f.captcha.requests.post", verify_captcha
    )

    user = creator_factory(password="correct-password")
    secret = _enable_otp(user).secret
    token = _token_at(secret)
    payload = {
        "username": user.username,
        "password": "correct-password",
        "captcha_result": "ci-valid-captcha",
        "otp_token": token,
    }

    first = api_client.post("/api/auth/login/", payload, format="json")
    replay = api_client.post("/api/auth/login/", payload, format="json")

    assert first.status_code == 204, first.content
    assert replay.status_code == 400, replay.content
    assert replay.json()["non_field_errors"] == ["Invalid OTP token"]


@pytest.mark.django_db
def test_malformed_stored_secret_fails_closed_not_500(
    api_client, creator_factory, monkeypatch
):
    """An unparseable stored seed answers "invalid", never a 500.

    Pre-fix failure: binascii.Error escaped verify_token and the request
    died with a 500.
    """
    _freeze_time(monkeypatch)
    user = creator_factory(password="correct-password")
    _enable_otp(user, secret="!!!not-base32!!!")
    api_client.force_authenticate(user=user)

    response = api_client.delete(
        "/api/otp/disable/", {"token": "123456"}, format="json"
    )

    assert response.status_code < 500, response.content
    assert response.status_code == 403


# --------------------------------------------------------------------------
# Behaviour that must hold after the fix (not expected to fail pre-fix).
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_next_step_code_accepted_after_burn(api_client, creator_factory,
                                            monkeypatch):
    """Hard rejection applies ONLY to the consumed step; the next code works."""
    clock = _freeze_time(monkeypatch)
    user = creator_factory(password="correct-password")
    secret = _enable_otp(user).secret
    burned = _token_at(secret)

    first = api_client.post(
        "/api/otp/login/",
        {"username": user.username, "password": "correct-password",
         "token": burned},
        format="json",
    )
    assert first.status_code == 200, first.content

    next_ts = _FROZEN_TS + pyotp.TOTP(secret).interval
    clock.set(utils_ts=next_ts, pyotp_ts=next_ts)

    second = api_client.post(
        "/api/otp/login/",
        {"username": user.username,
         "password": "correct-password",
         "token": pyotp.TOTP(secret).at(next_ts)},
        format="json",
    )

    assert second.status_code == 200, second.content


@pytest.mark.django_db
def test_boundary_skew_cannot_stamp_old_step_for_new_step_token(
    creator_factory, monkeypatch, db
):
    """The two-clock regression: ONE instant must govern verify AND burn.

    Production runs utils.timezone and pyotp off the same wall clock, but a
    consume_token() call that straddles a 30s boundary read them in different
    steps: the captured ``now`` lands at the end of step N while PyOTP's own
    internal datetime.now() has already rolled into step N+1. The old code
    then verified a NEW-step token (PyOTP's clock) while stamping step N
    (the captured now) -- so the same new-step token replayed seconds later
    passed the burn check and was accepted twice.

    This test pins the two clocks one step APART across a boundary, which is
    exactly what production's mid-call boundary crossing looks like:

    * Two-clock implementation: returns True and stamps step N -> FAILS here.
    * Single-instant implementation: verification is pinned to the captured
      instant, so a step-(N+1) token is simply invalid at that instant ->
      False, nothing stamped.

    A second call with both clocks aligned on step N+1 proves the token was
    fine all along -- only the skew call mis-burned.
    """
    from dj.apps.otp.utils import consume_token

    totp = pyotp.TOTP(_TEST_TOTP_SECRET)
    interval = totp.interval
    # _FROZEN_TS is 15s into its step; jump to 1s BEFORE the boundary.
    pre_boundary = (_FROZEN_TS // interval) * interval + interval - 1
    post_boundary = pre_boundary + interval

    clock = _freeze_time(monkeypatch)
    clock.set(utils_ts=pre_boundary, pyotp_ts=post_boundary)

    user = creator_factory()
    row = _enable_otp(user)
    next_step_token = totp.at(post_boundary)

    skewed = consume_token(row, next_step_token)

    assert skewed is False
    row.refresh_from_db()
    assert row.last_used_at is None, (
        "a failed verification must not stamp consumption state"
    )

    # Same token, clocks now agree INSIDE its own step (post_boundary is 29s
    # into it; +1 would already be the following step): it verifies once.
    clock.set(utils_ts=post_boundary, pyotp_ts=post_boundary)
    aligned = consume_token(row, next_step_token)
    assert aligned is True


@pytest.mark.django_db
def test_last_used_step_equal_or_later_blocks_current_step(
    creator_factory, db
):
    """Clock rollback must not reopen an already consumed step.

    last_used_at holds a FUTURE step; even so the current step's valid token
    is refused, because any stored last-used step >= the captured accepted
    step means this step is dead.
    """
    from django.utils import timezone as dj_tz

    from dj.apps.otp.utils import consume_token

    user = creator_factory()
    totp = pyotp.TOTP(_TEST_TOTP_SECRET)
    future = dj_tz.now() + timedelta(seconds=totp.interval * 5)
    row = _enable_otp(user, last_used_at=future)

    assert consume_token(row, totp.now()) is False
    row.refresh_from_db()
    assert row.last_used_at == future


@pytest.mark.django_db
def test_malformed_token_string_fails_closed(api_client, creator_factory,
                                             monkeypatch):
    _freeze_time(monkeypatch)
    user = creator_factory(password="correct-password")
    _enable_otp(user)
    api_client.force_authenticate(user=user)

    response = api_client.delete(
        "/api/otp/disable/", {"token": "12ab!@"}, format="json"
    )

    assert response.status_code == 403, response.content


def test_verify_user_totp_passes_accounts_without_active_totp(db):
    from django.contrib.auth import get_user_model
    from dj.apps.otp.utils import verify_user_totp

    user = get_user_model().objects.create(username="no-mfa-totp-user")
    assert verify_user_totp(user, "123456") is True


def test_verify_user_totp_rejects_unauthenticated_input(db):
    from dj.apps.otp.utils import verify_user_totp

    assert verify_user_totp(None, "123456") is False
    anon = SimpleNamespace(is_authenticated=False)
    assert verify_user_totp(anon, "123456") is False


# --------------------------------------------------------------------------
# Cross-process atomicity: two concurrent verifications of the SAME valid
# code in the same step must admit exactly one winner. Real Postgres row
# lock; transaction=True so worker threads on their own connections can see
# the fixture data and contend for real.
# --------------------------------------------------------------------------


def _run_concurrently(fn, n=2):
    barrier = threading.Barrier(n)
    results = [None] * n

    def worker(i):
        try:
            barrier.wait(timeout=10)
            results[i] = fn(i)
        except Exception as exc:
            results[i] = exc
        finally:
            from django.db import connection
            connection.close()

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
        assert not t.is_alive(), "worker thread deadlocked"
    return results


@pytest.mark.django_db(transaction=True)
def test_concurrent_same_step_verifications_admit_exactly_one(
    creator_factory, monkeypatch
):
    _freeze_time(monkeypatch)
    from dj.apps.otp.utils import verify_user_totp

    user = creator_factory(password="correct-password")
    secret = _enable_otp(user).secret
    token = _token_at(secret)

    results = _run_concurrently(lambda i: verify_user_totp(user, token))

    # Exact outcomes required -- not merely "one winner". A thread that
    # crashed with an exception would record the exception object here, which
    # is neither True nor False, so both counts must hold simultaneously.
    assert results.count(True) == 1, results
    assert results.count(False) == 1, results
