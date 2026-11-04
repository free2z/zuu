"""Authentication must happen only after fixed-size Zcash client admission."""

import base64
import json
import os
import secrets
import subprocess
import sys
from pathlib import Path

import pytest
from django.conf import settings as django_settings
from django.contrib.sessions.backends.db import SessionStore
from django.core.cache import caches
from django.test import RequestFactory
from knox.auth import TokenAuthentication
from knox.models import AuthToken
from rest_framework.authentication import SessionAuthentication
from rest_framework.test import APIClient

from dj.apps.g12f.models import Creator
from dj.apps.zauth import admission
from dj.apps.zauth.models import ZcashChallengeClaim, ZcashIdentity
from dj.apps.zauth.parsers import ZCASH_AUTH_BODY_MAX_BYTES
from dj.free2z.throttling import AuthenticatedUserRateThrottle
from dj.tests.fixed_window import (
    ADMISSION_WINDOW_SECONDS,
    await_admission_window_headroom,
    fixed_window_headroom,
    redis_server_time,
    wait_for_fixed_window_headroom,
)
from dj.util.middleware import wants_atomic_request


TADDR = "t1WnCauSV6fbHzWBHtSrK2qvFRyU6J121nH"
SIGNATURE = "IHVsaWduYXR1cmU="


def _real_redis(settings, label):
    if not os.environ.get("REDIS_HOST"):
        pytest.skip("REDIS_HOST selects the real Redis security tests")
    prefix = f"zauth-predispatch-{label}-{os.getpid()}-{secrets.token_hex(4)}"
    settings.CACHES = {
        "default": {
            "BACKEND": "django_redis.cache.RedisCache",
            "LOCATION": (
                f"redis://{os.environ['REDIS_HOST']}:"
                f"{os.environ.get('REDIS_PORT', '6379')}/1"
            ),
            "KEY_PREFIX": prefix,
            "OPTIONS": {
                "CLIENT_CLASS": "django_redis.client.DefaultClient",
            },
        },
    }
    backend = caches["default"]
    return backend, backend.client.get_client(write=True), prefix


def _delete_prefixed(raw, prefix):
    keys = list(raw.scan_iter(match=f"*{prefix}*"))
    if keys:
        raw.delete(*keys)


def _body(path):
    if path.endswith("challenge/"):
        return {"address": TADDR}
    return {
        "address": TADDR,
        "challenge": "not-an-issued-challenge",
        "signature": SIGNATURE,
    }


def _client_key(backend, path, identity):
    if path.endswith("challenge/"):
        logical = admission.challenge_client_admission_key(identity)
    else:
        logical = admission.login_admission_key(identity)
    return backend.make_key(logical)


def _set_two_request_limit(settings, path):
    if path.endswith("challenge/"):
        settings.ZCASH_CHALLENGE_ADMISSION_LIMITS = {
            "window_seconds": ADMISSION_WINDOW_SECONDS,
            "client": 2,
            "address": 100,
        }
    else:
        settings.ZCASH_LOGIN_ADMISSION_LIMITS = {
            "window_seconds": ADMISSION_WINDOW_SECONDS,
            "client": 2,
        }


@pytest.mark.parametrize(
    ("now", "expected"),
    [
        (0.0, 60.0),  # exactly on a boundary: the whole new window is left
        (0.5, 59.5),
        (59.5, 0.5),
        (1786898399.75, 0.25),  # a real epoch second, a quarter before:00
    ],
)
def test_headroom_matches_the_admission_script_window_arithmetic(now, expected):
    """A sign error here would silently disable every boundary guard below."""
    assert fixed_window_headroom(now, ADMISSION_WINDOW_SECONDS) == pytest.approx(
        expected
    )


def test_headroom_guard_does_not_wait_when_the_window_has_room(mocker):
    sleep = mocker.patch("dj.tests.fixed_window.time.sleep")

    headroom = wait_for_fixed_window_headroom(60, 5.0, now_fn=lambda: 10.0)

    assert headroom == pytest.approx(50.0)
    sleep.assert_not_called()


def test_headroom_guard_crosses_the_boundary_when_the_window_is_nearly_spent(
    mocker,
):
    """Too close to a boundary: wait it out, then start with a full window."""
    clock = [1786898399.9]  # 0.1s before a minute mark
    mocker.patch(
        "dj.tests.fixed_window.time.sleep",
        side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds),
    )

    headroom = wait_for_fixed_window_headroom(
        60, 5.0, now_fn=lambda: clock[0], margin_seconds=0.05
    )

    # It waited out the 0.1s remainder plus the margin -- not a blanket sleep --
    # and returned with essentially the whole next window available.
    assert clock[0] % 60 == pytest.approx(0.05)
    assert headroom == pytest.approx(59.95)


def test_headroom_guard_refuses_a_requirement_that_cannot_fit_the_window():
    with pytest.raises(ValueError):
        wait_for_fixed_window_headroom(60, 60, now_fn=lambda: 0.0)


def test_redis_server_time_reads_the_clock_the_admission_script_uses(mocker):
    client = mocker.Mock()
    client.time.return_value = (1786898399, 250000)

    assert redis_server_time(client) == pytest.approx(1786898399.25)


@pytest.mark.parametrize(
    "path", ["/api/auth/zcash/challenge/", "/api/auth/zcash/login/"]
)
def test_exact_live_zcash_routes_opt_out_of_request_wide_atomicity(path):
    assert wants_atomic_request(RequestFactory().post(path)) is False


@pytest.mark.parametrize(
    ("path", "admit_target", "unavailable"),
    [
        (
            "/api/auth/zcash/challenge/",
            "dj.apps.zauth.admission.admit_challenge",
            admission.ChallengeAdmissionUnavailable,
        ),
        (
            "/api/auth/zcash/login/",
            "dj.apps.zauth.admission.admit_login",
            admission.LoginAdmissionUnavailable,
        ),
    ],
)
@pytest.mark.parametrize(
    ("outcome", "expected_status"),
    [("denied", 429), ("unavailable", 503), ("oversized", 413)],
)
def test_predispatch_failures_never_open_request_atomicity_or_database(
    mocker,
    path,
    admit_target,
    unavailable,
    outcome,
    expected_status,
):
    """The unmarked test fails if any path tries to acquire PostgreSQL."""
    request_atomic = mocker.patch(
        "dj.util.middleware.transaction.atomic",
        side_effect=AssertionError("AtomicMiddleware opened a transaction"),
    )
    if outcome == "denied":
        mocker.patch(admit_target, return_value=(False, 60))
        response = APIClient().post(path, {}, format="json")
    elif outcome == "unavailable":
        mocker.patch(admit_target, side_effect=unavailable)
        response = APIClient().post(path, {}, format="json")
    else:
        mocker.patch(admit_target, return_value=(True, 60))
        response = APIClient().generic(
            "POST",
            path,
            json.dumps({"address": "x" * (ZCASH_AUTH_BODY_MAX_BYTES + 1)}),
            content_type="application/json",
        )

    assert response.status_code == expected_status, response.content
    request_atomic.assert_not_called()


def test_successful_challenge_issuance_performs_no_database_work(mocker):
    """Challenge is Redis/HMAC-only; pytest's DB blocker stays engaged."""
    request_atomic = mocker.patch(
        "dj.util.middleware.transaction.atomic",
        side_effect=AssertionError("AtomicMiddleware opened a transaction"),
    )
    mocker.patch(
        "dj.apps.zauth.admission.admit_challenge", return_value=(True, 60)
    )
    mocker.patch(
        "dj.apps.zauth.admission.admit_challenge_address",
        return_value=(True, 60),
    )

    response = APIClient().post(
        "/api/auth/zcash/challenge/",
        {"address": TADDR},
        format="json",
    )

    assert response.status_code == 200, response.content
    request_atomic.assert_not_called()


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("path", "admitted_statuses"),
    [
        ("/api/auth/zcash/challenge/", [200, 200]),
        ("/api/auth/zcash/login/", [400, 400]),
    ],
)
@pytest.mark.parametrize(
    "user_exists", [True, False], ids=["existing-real-hash", "missing-dummy-hash"]
)
def test_real_redis_basic_credentials_never_authenticate_or_hash(
    settings, creator_factory, mocker, path, admitted_statuses, user_exists
):
    """A ``Basic`` header is inert on these routes, in both directions.

    This test used to assert an ORDERING property -- that the fixed client
    charge lands before Django's password hashing -- using
    ``BasicAuthentication`` as the observable password path, because
    ``DEFAULT_AUTHENTICATION_CLASSES`` made every view answer
    ``Authorization: Basic``. Removing it (a leaked password must not stand in
    for the TOTP factor that only ``CreatorLoginSerializer`` checks) makes that
    ordering vacuous, and replaces it with a stronger claim: on any request,
    there is no password path to order at all.

    Both halves are asserted, and both are load-bearing:

    * the header does not authenticate -- CORRECT credentials for a real
      account still leave the request anonymous, which is the  property;
    * the header does not buy free admission -- a request carrying it is
      charged against the same fixed client budget as any other, so it cannot
      be used to slip past the ceiling.

    Ordering-before-authentication is still covered for the two authenticators
    that remain, by the knox and session tests either side of this one.
    """
    backend, raw, prefix = _real_redis(
        settings, f"basic-{path.split('/')[-2]}-{user_exists}"
    )
    _set_two_request_limit(settings, path)
    remote_addr = "192.0.2.120"
    raw_key = _client_key(backend, path, f"ipv4:{remote_addr}")
    username = "existing-basic" if user_exists else "missing-basic"
    if user_exists:
        creator_factory(username=username, password="correct-password")

    password_checks = []
    dummy_hashes = []
    original_check_password = Creator.check_password
    original_set_password = Creator.set_password

    def observed_check_password(user, raw_password):
        password_checks.append((user.pk, raw_password))
        return original_check_password(user, raw_password)

    def observed_set_password(user, raw_password):
        dummy_hashes.append((user.pk, raw_password))
        return original_set_password(user, raw_password)

    mocker.patch.object(Creator, "check_password", observed_check_password)
    mocker.patch.object(Creator, "set_password", observed_set_password)

    seen_users = []
    original_get_cache_key = AuthenticatedUserRateThrottle.get_cache_key

    def observed_get_cache_key(throttle, request, view):
        seen_users.append(request.user.is_authenticated)
        return original_get_cache_key(throttle, request, view)

    mocker.patch.object(
        AuthenticatedUserRateThrottle, "get_cache_key", observed_get_cache_key
    )

    # Deliberately the CORRECT password: if Basic were still honoured this
    # would be a fully authenticated request with no CAPTCHA and no TOTP.
    credentials = base64.b64encode(
        f"{username}:correct-password".encode("utf-8")
    ).decode("ascii")
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Basic {credentials}")
    await_admission_window_headroom(raw)

    try:
        statuses = [
            client.post(
                path,
                _body(path),
                format="json",
                REMOTE_ADDR=remote_addr,
            ).status_code
            for _ in range(3)
        ]

        assert statuses == [*admitted_statuses, 429]
        assert seen_users == [False, False]
        assert raw.get(raw_key) == b"2"
        # Not merely refused: never considered. A password authenticator that
        # ran and then failed would still spend a hash per request and still
        # answer the "does this account exist" question by timing.
        assert password_checks == []
        assert dummy_hashes == []
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db
@pytest.mark.parametrize(
    "path", ["/api/auth/zcash/challenge/", "/api/auth/zcash/login/"]
)
def test_real_redis_invalid_knox_is_charged_before_token_lookup(
    settings, mocker, path
):
    backend, raw, prefix = _real_redis(settings, f"knox-{path.split('/')[-2]}")
    _set_two_request_limit(settings, path)
    remote_addr = "192.0.2.121"
    raw_key = _client_key(backend, path, f"ipv4:{remote_addr}")
    authentication_counts = []
    original_authenticate = TokenAuthentication.authenticate

    def observed_authenticate(authenticator, request):
        charged = int(raw.get(raw_key) or 0)
        authentication_counts.append(charged)
        assert charged == len(authentication_counts)
        return original_authenticate(authenticator, request)

    mocker.patch.object(TokenAuthentication, "authenticate", observed_authenticate)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Token {'0' * 64}")
    await_admission_window_headroom(raw)

    try:
        statuses = [
            client.post(
                path,
                _body(path),
                format="json",
                REMOTE_ADDR=remote_addr,
            ).status_code
            for _ in range(3)
        ]

        assert statuses == [401, 401, 429]
        assert authentication_counts == [1, 2]
        assert raw.get(raw_key) == b"2"
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("path", "admitted_statuses"),
    [
        ("/api/auth/zcash/challenge/", [200, 200]),
        ("/api/auth/zcash/login/", [400, 400]),
    ],
)
def test_real_redis_forged_session_lookup_happens_only_after_admission(
    settings, mocker, path, admitted_statuses
):
    backend, raw, prefix = _real_redis(settings, f"session-{path.split('/')[-2]}")
    _set_two_request_limit(settings, path)
    remote_addr = "192.0.2.122"
    raw_key = _client_key(backend, path, f"ipv4:{remote_addr}")
    load_counts = []
    original_load = SessionStore.load

    def observed_load(store):
        load_counts.append(int(raw.get(raw_key) or 0))
        return original_load(store)

    mocker.patch.object(SessionStore, "load", observed_load)
    client = APIClient()
    await_admission_window_headroom(raw)

    try:
        statuses = []
        for _ in range(3):
            client.cookies[django_settings.SESSION_COOKIE_NAME] = (
                "forged-session-key-0000000000000000"
            )
            statuses.append(
                client.post(
                    path,
                    _body(path),
                    format="json",
                    REMOTE_ADDR=remote_addr,
                ).status_code
            )

        assert statuses == [*admitted_statuses, 429]
        assert load_counts == [1, 2]
        assert raw.get(raw_key) == b"2"
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db
# "basic" was a third case here until. It is gone rather than inverted
# because a Basic-credentialled request is now simply anonymous, which is
# exactly what test_real_redis_basic_credentials_never_authenticate_or_hash
# asserts above; keeping it here would only re-test the anonymous path.
@pytest.mark.parametrize("authentication", ["session", "knox"])
def test_real_redis_valid_authentication_reaches_user_throttle_and_associates(
    settings, creator_factory, mocker, authentication,
    recent_login,
):
    backend, raw, prefix = _real_redis(settings, f"valid-{authentication}")
    settings.ZCASH_CHALLENGE_LEGACY_MIRROR_WRITES_ENABLED = False
    settings.ZCASH_CHALLENGE_LEGACY_MIRROR_REQUIRED = False
    owner = creator_factory(
        username=f"valid-{authentication}", password="correct-password"
    )
    issuer = APIClient()
    challenge = issuer.post(
        "/api/auth/zcash/challenge/",
        {"address": TADDR},
        format="json",
        REMOTE_ADDR="192.0.2.123",
    ).data["challenge"]

    client = APIClient()
    if authentication == "session":
        client.force_login(owner)
        recent_login(client, owner)
    else:
        _instance, token = AuthToken.objects.create(owner)
        from dj.apps.identity.auth_context import record_login
        record_login(None, owner, methods=["pwd"], token=_instance)
        client.credentials(HTTP_AUTHORIZATION=f"Token {token}")

    throttled_users = []
    original_get_cache_key = AuthenticatedUserRateThrottle.get_cache_key

    def observed_get_cache_key(throttle, request, view):
        key = original_get_cache_key(throttle, request, view)
        throttled_users.append((request.user.pk, key))
        return key

    mocker.patch.object(
        AuthenticatedUserRateThrottle,
        "get_cache_key",
        observed_get_cache_key,
    )
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)

    try:
        response = client.post(
            "/api/auth/zcash/login/",
            {
                "address": TADDR,
                "challenge": challenge,
                "signature": SIGNATURE,
            },
            format="json",
            REMOTE_ADDR="192.0.2.124",
        )

        assert response.status_code == 200, response.content
        assert throttled_users
        assert all(user_id == owner.pk and key for user_id, key in throttled_users)
        assert ZcashIdentity.objects.get(zcash_address=TADDR).creator == owner
        assert response.data["username"] == owner.username
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db
@pytest.mark.parametrize(
    "path", ["/api/auth/zcash/challenge/", "/api/auth/zcash/login/"]
)
def test_malformed_authorization_cannot_bypass_bounded_parser_or_create_state(
    settings, mocker, path
):
    _backend, raw, prefix = _real_redis(settings, f"bad-header-body-{path}")
    # SessionAuthentication, not Basic (removed in ): it is first in
    # DEFAULT_AUTHENTICATION_CLASSES and runs on EVERY request, so
    # `assert_not_called` here is a real statement about ordering rather than
    # a tautology about an authenticator that no longer exists.
    authenticate = mocker.patch.object(SessionAuthentication, "authenticate")
    issue = mocker.patch("dj.apps.zauth.views.issue_challenge")
    oversized = json.dumps(
        {"address": "x" * (ZCASH_AUTH_BODY_MAX_BYTES + 1)}
    )

    try:
        response = APIClient().generic(
            "POST",
            path,
            oversized,
            content_type="application/json",
            HTTP_AUTHORIZATION="Basic definitely-not-base64",
            REMOTE_ADDR="192.0.2.125",
        )

        assert response.status_code == 413, response.content
        authenticate.assert_not_called()
        issue.assert_not_called()
        keys = list(raw.scan_iter(match=f"*{prefix}*"))
        admission_keys = [
            key
            for key in keys
            if b"zcashissue" in key or b"zcashlogin" in key
        ]
        assert len(admission_keys) == 1
        assert b":client:" in admission_keys[0]
        assert all(b":address:" not in key for key in keys)
        assert all(b"zcashchallenge" not in key for key in keys)
        assert not ZcashChallengeClaim.objects.exists()
        assert not ZcashIdentity.objects.exists()
    finally:
        _delete_prefixed(raw, prefix)




@pytest.mark.parametrize(
    ("writes", "required"),
    [("true", "true"), ("true", "false"), ("false", "false")],
    ids=["phase-a", "phase-b", "phase-c"],
)
def test_settings_import_accepts_each_staged_mirror_policy(writes, required):
    root = Path(__file__).resolve().parents[5]
    env = os.environ.copy()
    env["PYTHONPATH"] = str(root / "py" / "free2z")
    env.update(
        {
            "ZCASH_CHALLENGE_LEGACY_MIRROR_WRITES_ENABLED": writes,
            "ZCASH_CHALLENGE_LEGACY_MIRROR_REQUIRED": required,
        }
    )

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "from dj.free2z.settings import "
                "ZCASH_CHALLENGE_LEGACY_MIRROR_WRITES_ENABLED as w, "
                "ZCASH_CHALLENGE_LEGACY_MIRROR_REQUIRED as r; "
                "print(f'{w}:{r}')"
            ),
        ],
        cwd=root / "py" / "free2z",
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    assert result.stdout.strip() == f"{writes.title()}:{required.title()}"


@pytest.mark.parametrize(
    "name",
    [
        "ZCASH_CHALLENGE_LEGACY_MIRROR_WRITES_ENABLED",
        "ZCASH_CHALLENGE_LEGACY_MIRROR_REQUIRED",
    ],
)
def test_each_mirror_control_is_strictly_parsed_at_settings_import(name):
    root = Path(__file__).resolve().parents[5]
    env = os.environ.copy()
    env["PYTHONPATH"] = str(root / "py" / "free2z")
    env.update(
        {
            "ZCASH_CHALLENGE_LEGACY_MIRROR_WRITES_ENABLED": "true",
            "ZCASH_CHALLENGE_LEGACY_MIRROR_REQUIRED": "true",
            name: "maybe",
        }
    )

    result = subprocess.run(
        [sys.executable, "-c", "import dj.free2z.settings"],
        cwd=root / "py" / "free2z",
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert f"{name} must be a boolean" in result.stderr


def test_invalid_false_true_policy_refuses_manage_check_startup():
    root = Path(__file__).resolve().parents[5]
    env = os.environ.copy()
    env["PYTHONPATH"] = str(root / "py" / "free2z")
    env.update(
        {
            "ZCASH_CHALLENGE_LEGACY_MIRROR_WRITES_ENABLED": "false",
            "ZCASH_CHALLENGE_LEGACY_MIRROR_REQUIRED": "true",
        }
    )

    result = subprocess.run(
        [sys.executable, "dj/free2z/manage.py", "check"],
        cwd=root / "py" / "free2z",
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert (
        "ZCASH_CHALLENGE_LEGACY_MIRROR_REQUIRED cannot be true when "
        "ZCASH_CHALLENGE_LEGACY_MIRROR_WRITES_ENABLED is false"
    ) in result.stderr
