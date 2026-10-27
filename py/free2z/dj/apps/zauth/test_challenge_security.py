"""Security, bounded-allocation, and concurrency guards for Zcash login."""

import hashlib
import json
import os
import secrets
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from io import BytesIO

import pytest
from django.core.cache import caches
from django.db import close_old_connections, connection, connections
from django.utils import timezone
from knox.models import AuthToken
from rest_framework.request import Request
from rest_framework.test import APIClient, APIRequestFactory

from dj.apps.g12f.models import Creator
from dj.apps.zauth import admission, challenges
from dj.apps.zauth.models import ZcashChallengeClaim, ZcashIdentity
from dj.apps.zauth.parsers import (
    ZCASH_AUTH_BODY_MAX_BYTES,
    ZcashAuthJSONParser,
    ZcashAuthRequestTooLarge,
)
from dj.tests.fixed_window import (
    ADMISSION_WINDOW_SECONDS,
    await_admission_window_headroom,
)


TADDR = "t1WnCauSV6fbHzWBHtSrK2qvFRyU6J121nH"
OTHER_TADDR = "t1f3vC5hEbAwJdheoFbwaBYssj2Hwp3MFXX"
T3ADDR = "t3Wjj8bULpUe5WrW2no2oJm7NPd4eXREeJt"
SIGNATURE = "IHVsaWduYXR1cmU="
LEGACY_CHALLENGE = f"{challenges.LEGACY_CHALLENGE_PREFIX}{'A' * 32}"
OTHER_LEGACY_CHALLENGE = f"{challenges.LEGACY_CHALLENGE_PREFIX}{'B' * 32}"
BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _issue(client, address=TADDR, **extra):
    response = client.post(
        "/api/auth/zcash/challenge/",
        {"address": address},
        format="json",
        **extra,
    )
    assert response.status_code == 200, response.content
    return response.data["challenge"]


def _login(client, address, challenge, **extra):
    return client.post(
        "/api/auth/zcash/login/",
        {
            "address": address,
            "challenge": challenge,
            "signature": SIGNATURE,
        },
        format="json",
        **extra,
    )


def _valid_t1(index: int) -> str:
    payload = b"\x1c\xb8" + hashlib.sha256(str(index).encode()).digest()[:20]
    checksum = hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    number = int.from_bytes(payload + checksum, "big")
    encoded = ""
    while number:
        number, remainder = divmod(number, 58)
        encoded = BASE58_ALPHABET[remainder] + encoded
    assert len(encoded) == 35 and encoded.startswith("t1")
    return encoded


def _real_redis(settings, label: str):
    if not os.environ.get("REDIS_HOST"):
        pytest.skip("REDIS_HOST selects the real Redis security tests")
    prefix = f"zuuli-zauth-{label}-{os.getpid()}-{secrets.token_hex(4)}"
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
    raw = backend.client.get_client(write=True)
    return backend, raw, prefix


def _delete_prefixed(raw, prefix: str) -> None:
    keys = list(raw.scan_iter(match=f"*{prefix}*"))
    if keys:
        raw.delete(*keys)


def _legacy_cache_key(address: str) -> str:
    return f"{challenges.LEGACY_CHALLENGE_KEY_PREFIX}{address}"


def _set_legacy_mirror_policy(settings, writes: bool, required: bool) -> None:
    settings.ZCASH_CHALLENGE_LEGACY_MIRROR_WRITES_ENABLED = writes
    settings.ZCASH_CHALLENGE_LEGACY_MIRROR_REQUIRED = required


def _old_style_store(backend, address: str, challenge: str) -> None:
    """Exactly origin/main's v1 cache.set call."""
    backend.set(
        _legacy_cache_key(address),
        challenge,
        challenges.CHALLENGE_TTL_SECONDS,
    )


def _old_style_pop(backend, address: str):
    """Exactly origin/main's v1 shared-cache get/delete behavior."""
    key = _legacy_cache_key(address)
    value = backend.get(key)
    if value is not None:
        backend.delete(key)
    return value


@pytest.mark.django_db
@pytest.mark.parametrize(
    "address",
    [
        None,
        "",
        123,
        True,
        [],
        {},
        "not-an-address",
        TADDR[:-1] + ("i" if TADDR[-1] != "i" else "j"),
        TADDR + " ",
        " " + TADDR,
        "t1" + "A" * 200,
        T3ADDR,
    ],
)
def test_invalid_or_unsupported_address_charges_only_client_admission(
    api_client, mocker, address
):
    admit_client = mocker.patch(
        "dj.apps.zauth.admission.admit_challenge", return_value=(True, 60)
    )
    admit_address = mocker.patch(
        "dj.apps.zauth.admission.admit_challenge_address"
    )
    issue = mocker.patch("dj.apps.zauth.views.issue_challenge")
    compatibility_store = mocker.patch(
        "dj.apps.zauth.views.store_legacy_compatible_challenge"
    )

    response = api_client.post(
        "/api/auth/zcash/challenge/", {"address": address}, format="json"
    )

    assert response.status_code == 400, response.content
    admit_client.assert_called_once_with("ipv4:127.0.0.1")
    admit_address.assert_not_called()
    issue.assert_not_called()
    compatibility_store.assert_not_called()
    assert caches["default"].get(_legacy_cache_key(TADDR)) is None
    assert not ZcashChallengeClaim.objects.exists()


@pytest.mark.django_db
def test_disabled_compatibility_supports_independent_outstanding_v2_proofs(
    api_client, settings, mocker
):
    _set_legacy_mirror_policy(settings, False, False)
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    first = _issue(api_client)
    second = _issue(api_client)

    assert first != second
    assert len(first) == len(second) == 92
    assert first.startswith(challenges.CHALLENGE_PREFIX)
    assert challenges.validate_challenge(TADDR, first)
    assert challenges.validate_challenge(TADDR, second)
    assert caches["default"].get(_legacy_cache_key(TADDR)) is None

    first_login = _login(api_client, TADDR, first)
    second_login = _login(api_client, TADDR, second)
    first_replay = _login(api_client, TADDR, first)

    assert [
        first_login.status_code,
        second_login.status_code,
        first_replay.status_code,
    ] == [200, 200, 400]
    assert ZcashChallengeClaim.objects.count() == 2
    identity = ZcashIdentity.objects.get(zcash_address=TADDR)
    assert AuthToken.objects.filter(user=identity.creator).count() == 2


@pytest.mark.django_db
def test_enabled_compatibility_latest_v2_invalidates_older_and_works_once(
    api_client, settings, mocker
):
    _set_legacy_mirror_policy(settings, True, True)
    older = _issue(api_client)
    latest = _issue(api_client)
    backend = caches["default"]
    key = _legacy_cache_key(TADDR)
    assert backend.get(key) == latest
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)

    invalidated = _login(api_client, TADDR, older)
    accepted = _login(api_client, TADDR, latest)
    replay = _login(api_client, TADDR, latest)

    assert [invalidated.status_code, accepted.status_code, replay.status_code] == [
        400,
        200,
        400,
    ]
    assert backend.get(key) is None
    assert ZcashChallengeClaim.objects.count() == 1
    identity = ZcashIdentity.objects.get(zcash_address=TADDR)
    assert AuthToken.objects.filter(user=identity.creator).count() == 1


@pytest.mark.django_db
def test_legacy_v1_login_is_single_use_and_durably_claimed_before_recovery(
    api_client, mocker
):
    backend = caches["default"]
    _old_style_store(backend, TADDR, LEGACY_CHALLENGE)
    verify = mocker.patch(
        "dj.apps.zauth.views.verify_zcash_signature", return_value=True
    )

    accepted = _login(api_client, TADDR, LEGACY_CHALLENGE)
    assert accepted.status_code == 200, accepted.content
    assert backend.get(_legacy_cache_key(TADDR)) is None

    # Model a stale old writer restoring the exact same cache proof. Redis
    # compare/delete wins again, but PostgreSQL's fixed claim rejects it before
    # signature recovery or token provisioning can run a second time.
    _old_style_store(backend, TADDR, LEGACY_CHALLENGE)
    replay = _login(api_client, TADDR, LEGACY_CHALLENGE)

    assert replay.status_code == 400, replay.content
    verify.assert_called_once_with(TADDR, SIGNATURE, LEGACY_CHALLENGE)
    claim_identifier = challenges.legacy_challenge_claim_identifier(
        TADDR, LEGACY_CHALLENGE
    )
    claim = ZcashChallengeClaim.objects.get()
    assert claim.challenge_digest == challenges.challenge_digest(claim_identifier)
    identity = ZcashIdentity.objects.get(zcash_address=TADDR)
    assert AuthToken.objects.filter(user=identity.creator).count() == 1


@pytest.mark.django_db
def test_legacy_wrong_address_and_mismatch_are_read_only(api_client, mocker):
    backend = caches["default"]
    key = _legacy_cache_key(TADDR)
    _old_style_store(backend, TADDR, LEGACY_CHALLENGE)
    delete = mocker.patch.object(backend, "delete", wraps=backend.delete)
    verify = mocker.patch("dj.apps.zauth.views.verify_zcash_signature")

    wrong_address = _login(api_client, OTHER_TADDR, LEGACY_CHALLENGE)
    mismatch = challenges.consume_legacy_challenge(TADDR, OTHER_LEGACY_CHALLENGE)
    missing = challenges.consume_legacy_challenge(OTHER_TADDR, LEGACY_CHALLENGE)

    assert wrong_address.status_code == 400, wrong_address.content
    assert mismatch is False
    assert missing is False
    assert backend.get(key) == LEGACY_CHALLENGE
    delete.assert_not_called()
    verify.assert_not_called()


@pytest.mark.django_db
def test_failed_or_malformed_v2_never_enters_legacy_fallback(api_client, mocker):
    token = _issue(api_client)
    bad_hmac = token[:-1] + ("A" if token[-1] != "A" else "B")
    consume_v1 = mocker.patch("dj.apps.zauth.views.consume_legacy_challenge")
    consume_v2 = mocker.patch("dj.apps.zauth.views.consume_v2_legacy_mirror")

    responses = [
        _login(api_client, TADDR, bad_hmac),
        _login(api_client, TADDR, "ZUULI-Login:not-a-fixed-v1-token"),
    ]

    assert [response.status_code for response in responses] == [400, 400]
    consume_v1.assert_not_called()
    consume_v2.assert_not_called()


def test_challenge_hmac_binds_address_version_timestamp_and_nonce(settings):
    token = challenges.issue_challenge(
        TADDR, now=2_000_000_000, nonce_bytes=b"\x00" * 16
    )

    assert challenges.validate_challenge(TADDR, token, now=2_000_000_299)
    assert not challenges.validate_challenge(TADDR, token, now=2_000_000_300)
    assert not challenges.validate_challenge(TADDR, token, now=1_999_999_999)
    assert not challenges.validate_challenge(OTHER_TADDR, token, now=2_000_000_001)
    assert not challenges.validate_challenge(
        TADDR, token[:-1] + ("A" if token[-1] != "A" else "B"), now=2_000_000_001
    )
    assert not challenges.validate_challenge(
        TADDR, token.replace(":v2:", ":v3:"), now=2_000_000_001
    )


@pytest.mark.django_db
def test_invalid_server_token_allocates_no_claim(api_client, mocker):
    verify = mocker.patch("dj.apps.zauth.views.verify_zcash_signature")
    claim = mocker.patch("dj.apps.zauth.views.claim_challenge")

    invalid = _login(api_client, TADDR, "ZUULI-Login:not-server-issued")
    assert invalid.status_code == 400, invalid.content
    verify.assert_not_called()
    claim.assert_not_called()
    assert not ZcashChallengeClaim.objects.exists()


@pytest.mark.django_db
def test_invalid_signature_burns_challenge_before_replay_can_reverify(
    api_client, mocker
):
    token = _issue(api_client)
    verify = mocker.patch(
        "dj.apps.zauth.views.verify_zcash_signature", return_value=False
    )

    responses = [_login(api_client, TADDR, token) for _ in range(8)]

    assert [response.status_code for response in responses] == [401] + [400] * 7
    verify.assert_called_once_with(TADDR, SIGNATURE, token)
    assert ZcashChallengeClaim.objects.count() == 1
    assert not ZcashIdentity.objects.exists()
    assert not Creator.objects.filter(p2paddr=TADDR).exists()
    assert not AuthToken.objects.exists()


@pytest.mark.django_db
def test_wrong_address_cannot_validate_or_claim_token(api_client, mocker):
    verify = mocker.patch(
        "dj.apps.zauth.views.verify_zcash_signature", return_value=True
    )
    claim = mocker.patch("dj.apps.zauth.views.claim_challenge")
    token = _issue(api_client)

    response = _login(api_client, OTHER_TADDR, token)

    assert response.status_code == 400, response.content
    verify.assert_not_called()
    claim.assert_not_called()


@pytest.mark.django_db
def test_database_replay_claim_is_uniqueness_backed_and_single_use():
    token = challenges.issue_challenge(TADDR)

    assert challenges.claim_challenge(token) is True
    assert challenges.claim_challenge(token) is False
    row = ZcashChallengeClaim.objects.get()
    assert row.challenge_digest == challenges.challenge_digest(token)
    assert len(row.challenge_digest) == 64
    assert token not in row.challenge_digest


def _claim_concurrently(token, barrier):
    try:
        barrier.wait(timeout=10)
        return challenges.claim_challenge(token)
    finally:
        connections.close_all()


@pytest.mark.django_db(transaction=True)
def test_database_replay_claim_has_exactly_one_concurrent_winner():
    token = challenges.issue_challenge(TADDR)
    contenders = 8
    barrier = threading.Barrier(contenders)

    with ThreadPoolExecutor(max_workers=contenders) as pool:
        results = list(
            pool.map(lambda _: _claim_concurrently(token, barrier), range(contenders))
        )

    assert results.count(True) == 1
    assert results.count(False) == contenders - 1
    assert ZcashChallengeClaim.objects.count() == 1


@pytest.mark.django_db(transaction=True)
def test_database_replay_race_mints_exactly_one_token(mocker):
    """Exercise durable replay through the full login endpoint, not a stub."""
    verify = mocker.patch(
        "dj.apps.zauth.views.verify_zcash_signature", return_value=True
    )
    token = _issue(APIClient())
    contenders = 8
    barrier = threading.Barrier(contenders)

    with ThreadPoolExecutor(max_workers=contenders) as pool:
        results = list(
            pool.map(
                lambda _: _concurrent_login(TADDR, token, barrier),
                range(contenders),
            )
        )

    statuses = [status for status, _body in results]
    assert statuses.count(200) == 1
    assert statuses.count(400) == contenders - 1
    assert verify.call_count == 1
    identity = ZcashIdentity.objects.get(zcash_address=TADDR)
    assert AuthToken.objects.filter(user=identity.creator).count() == 1


@pytest.mark.django_db
def test_replay_claim_outage_returns_503_without_identity_or_token(
    api_client, mocker
):
    verify = mocker.patch(
        "dj.apps.zauth.views.verify_zcash_signature", return_value=True
    )
    claim = mocker.patch(
        "dj.apps.zauth.views.claim_challenge",
        side_effect=challenges.ChallengeClaimUnavailable,
    )
    token = _issue(api_client)
    backend = caches["default"]
    consume = mocker.patch("dj.apps.zauth.views.consume_v2_legacy_mirror")

    response = _login(api_client, TADDR, token)

    assert response.status_code == 503, response.content
    claim.assert_called_once_with(token)
    consume.assert_not_called()
    assert backend.get(_legacy_cache_key(TADDR)) == token
    verify.assert_not_called()
    assert not ZcashIdentity.objects.exists()
    assert not AuthToken.objects.exists()


@pytest.mark.django_db
def test_retryable_provisioning_failure_rolls_back_claim_and_same_proof_retries(
    api_client, settings, mocker
):
    """Claim, identity, and token are one rollback/commit outcome."""
    from dj.apps.zauth import views

    _set_legacy_mirror_policy(settings, False, False)
    token = _issue(api_client)
    verify = mocker.patch.object(
        views, "verify_zcash_signature", return_value=True
    )
    real_provision = views._provision_identity_and_token
    attempts = 0

    def fail_after_first_provision(acting_user, address, otp_token=None, **kwargs):
        nonlocal attempts
        attempts += 1
        result = real_provision(acting_user, address, otp_token, **kwargs)
        if attempts == 1:
            # Raise after all three rows exist inside the outer transaction;
            # the 503 path must roll every one of them back with the claim.
            raise views.ZcashIdentityProvisioningUnavailable
        return result

    mocker.patch.object(
        views,
        "_provision_identity_and_token",
        side_effect=fail_after_first_provision,
    )

    failed = _login(api_client, TADDR, token)
    assert failed.status_code == 503, failed.content
    assert not ZcashChallengeClaim.objects.exists()
    assert not ZcashIdentity.objects.exists()
    assert not Creator.objects.filter(p2paddr=TADDR).exists()
    assert not AuthToken.objects.exists()

    retried = _login(api_client, TADDR, token)
    assert retried.status_code == 200, retried.content
    assert verify.call_count == 2
    assert ZcashChallengeClaim.objects.count() == 1
    identity = ZcashIdentity.objects.get(zcash_address=TADDR)
    assert Creator.objects.filter(p2paddr=TADDR).count() == 1
    assert AuthToken.objects.filter(user=identity.creator).count() == 1


@pytest.mark.django_db
def test_enabled_v2_post_consume_failure_never_restores_mirror(
    api_client, settings, mocker
):
    """Compatibility favors replay safety after Redis reports consumption."""
    from dj.apps.zauth import views

    _set_legacy_mirror_policy(settings, True, True)
    backend = caches["default"]
    token = _issue(api_client)
    verify = mocker.patch.object(views, "verify_zcash_signature", return_value=True)
    original_provision = views._provision_identity_and_token

    def provision_then_fail(acting_user, address, otp_token=None, **kwargs):
        original_provision(acting_user, address, otp_token)
        raise views.ZcashIdentityProvisioningUnavailable

    mocker.patch.object(
        views,
        "_provision_identity_and_token",
        side_effect=provision_then_fail,
    )

    failed = _login(api_client, TADDR, token)
    replay = _login(api_client, TADDR, token)

    assert failed.status_code == 503, failed.content
    assert replay.status_code == 400, replay.content
    assert backend.get(_legacy_cache_key(TADDR)) is None
    verify.assert_called_once_with(TADDR, SIGNATURE, token)
    assert not ZcashChallengeClaim.objects.exists()
    assert not ZcashIdentity.objects.exists()
    assert not AuthToken.objects.exists()


@pytest.mark.django_db
def test_identity_conflict_commits_claim_and_replay_skips_verifier(
    api_client, creator_factory, mocker
):
    """A non-retryable 409 burns its proof rather than repeating recovery."""
    owner = creator_factory()
    ZcashIdentity.objects.create(creator=owner, zcash_address=TADDR)
    other_user = creator_factory()
    api_client.force_authenticate(user=other_user)
    token = _issue(api_client)
    verify = mocker.patch(
        "dj.apps.zauth.views.verify_zcash_signature", return_value=True
    )

    conflict = _login(api_client, TADDR, token)
    replay = _login(api_client, TADDR, token)

    assert conflict.status_code == 409, conflict.content
    assert replay.status_code == 400, replay.content
    verify.assert_called_once_with(TADDR, SIGNATURE, token)
    assert ZcashChallengeClaim.objects.count() == 1
    assert ZcashIdentity.objects.get(zcash_address=TADDR).creator == owner
    assert not AuthToken.objects.exists()


@pytest.mark.django_db
def test_admission_outage_fails_closed_before_challenge_generation(
    api_client, mocker
):
    mocker.patch(
        "dj.apps.zauth.admission.admit_challenge",
        side_effect=admission.ChallengeAdmissionUnavailable,
    )
    admit_address = mocker.patch(
        "dj.apps.zauth.admission.admit_challenge_address"
    )
    issue = mocker.patch("dj.apps.zauth.views.issue_challenge")

    response = api_client.post(
        "/api/auth/zcash/challenge/",
        {"address": "not-a-zcash-address"},
        format="json",
    )

    assert response.status_code == 503, response.content
    admit_address.assert_not_called()
    issue.assert_not_called()


@pytest.mark.django_db
def test_address_admission_outage_fails_closed_after_fixed_client_charge(
    api_client, mocker
):
    admit_client = mocker.patch(
        "dj.apps.zauth.admission.admit_challenge", return_value=(True, 60)
    )
    mocker.patch(
        "dj.apps.zauth.admission.admit_challenge_address",
        side_effect=admission.ChallengeAdmissionUnavailable,
    )
    issue = mocker.patch("dj.apps.zauth.views.issue_challenge")

    response = api_client.post(
        "/api/auth/zcash/challenge/", {"address": TADDR}, format="json"
    )

    assert response.status_code == 503, response.content
    admit_client.assert_called_once_with("ipv4:127.0.0.1")
    issue.assert_not_called()
    assert caches["default"].get(_legacy_cache_key(TADDR)) is None


@pytest.mark.django_db
def test_compatibility_write_failure_returns_503_without_returning_challenge(
    api_client, mocker
):
    mocker.patch(
        "dj.apps.zauth.views.store_legacy_compatible_challenge",
        side_effect=challenges.ChallengeCompatibilityUnavailable,
    )

    response = api_client.post(
        "/api/auth/zcash/challenge/", {"address": TADDR}, format="json"
    )

    assert response.status_code == 503, response.content
    assert response.data == {
        "detail": "Challenge service is temporarily unavailable."
    }
    assert "challenge" not in response.data


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("writes", "required"),
    [
        (None, True),
        (1, True),
        ("true", True),
        (False, True),
        (True, None),
        (True, 1),
        (True, "false"),
    ],
)
def test_ambiguous_or_unsafe_mirror_policy_fails_issuance_closed(
    api_client, settings, writes, required
):
    settings.ZCASH_CHALLENGE_LEGACY_MIRROR_WRITES_ENABLED = writes
    settings.ZCASH_CHALLENGE_LEGACY_MIRROR_REQUIRED = required

    response = api_client.post(
        "/api/auth/zcash/challenge/", {"address": TADDR}, format="json"
    )

    assert response.status_code == 503, response.content
    assert response.data == {
        "detail": "Challenge service is temporarily unavailable."
    }
    assert caches["default"].get(_legacy_cache_key(TADDR)) is None


@pytest.mark.django_db
def test_v2_compatibility_backend_failure_rolls_back_pending_pg_claim(
    api_client, settings, mocker
):
    _set_legacy_mirror_policy(settings, True, True)
    token = _issue(api_client)
    mocker.patch(
        "dj.apps.zauth.views.consume_v2_legacy_mirror",
        side_effect=challenges.ChallengeCompatibilityUnavailable,
    )
    verify = mocker.patch("dj.apps.zauth.views.verify_zcash_signature")

    response = _login(api_client, TADDR, token)

    assert response.status_code == 503, response.content
    assert response.data == {
        "detail": "Challenge service is temporarily unavailable."
    }
    verify.assert_not_called()
    assert not ZcashChallengeClaim.objects.exists()


@pytest.mark.django_db
def test_legacy_compatibility_backend_failure_fails_login_closed(
    api_client, mocker
):
    mocker.patch(
        "dj.apps.zauth.views.consume_legacy_challenge",
        side_effect=challenges.ChallengeCompatibilityUnavailable,
    )
    verify = mocker.patch("dj.apps.zauth.views.verify_zcash_signature")

    response = _login(api_client, TADDR, LEGACY_CHALLENGE)

    assert response.status_code == 503, response.content
    assert response.data == {
        "detail": "Challenge service is temporarily unavailable."
    }
    verify.assert_not_called()
    # The pending PostgreSQL-first claim shares the outer transaction and is
    # rolled back when Redis cannot safely decide compare/delete.
    assert not ZcashChallengeClaim.objects.exists()


@pytest.mark.django_db
def test_legacy_database_claim_failure_preserves_unconsumed_redis_proof(
    api_client, mocker
):
    backend = caches["default"]
    _old_style_store(backend, TADDR, LEGACY_CHALLENGE)
    consume = mocker.patch("dj.apps.zauth.views.consume_legacy_challenge")
    mocker.patch(
        "dj.apps.zauth.views.claim_challenge",
        side_effect=challenges.ChallengeClaimUnavailable,
    )
    verify = mocker.patch("dj.apps.zauth.views.verify_zcash_signature")

    response = _login(api_client, TADDR, LEGACY_CHALLENGE)

    assert response.status_code == 503, response.content
    assert backend.get(_legacy_cache_key(TADDR)) == LEGACY_CHALLENGE
    consume.assert_not_called()
    verify.assert_not_called()
    assert not ZcashChallengeClaim.objects.exists()


@pytest.mark.django_db
def test_legacy_post_consume_failure_never_restores_replayable_proof(
    api_client, mocker
):
    from dj.apps.zauth import views

    backend = caches["default"]
    _old_style_store(backend, TADDR, LEGACY_CHALLENGE)
    verify = mocker.patch.object(views, "verify_zcash_signature", return_value=True)

    original_provision = views._provision_identity_and_token

    def provision_then_fail(acting_user, address, otp_token=None, **kwargs):
        original_provision(acting_user, address, otp_token)
        raise views.ZcashIdentityProvisioningUnavailable

    mocker.patch.object(
        views,
        "_provision_identity_and_token",
        side_effect=provision_then_fail,
    )

    failed = _login(api_client, TADDR, LEGACY_CHALLENGE)
    replay = _login(api_client, TADDR, LEGACY_CHALLENGE)

    assert failed.status_code == 503, failed.content
    assert replay.status_code == 400, replay.content
    assert backend.get(_legacy_cache_key(TADDR)) is None
    verify.assert_called_once_with(TADDR, SIGNATURE, LEGACY_CHALLENGE)
    assert not ZcashChallengeClaim.objects.exists()
    assert not ZcashIdentity.objects.exists()
    assert not AuthToken.objects.exists()


@pytest.mark.django_db
def test_login_admission_outage_fails_closed_before_body_or_proof_work(
    api_client, mocker
):
    mocker.patch(
        "dj.apps.zauth.admission.admit_login",
        side_effect=admission.LoginAdmissionUnavailable,
    )
    validate = mocker.patch("dj.apps.zauth.views.validate_challenge")
    claim = mocker.patch("dj.apps.zauth.views.claim_challenge")

    response = api_client.generic(
        "POST",
        "/api/auth/zcash/login/",
        b"not-json",
        content_type="application/json",
    )

    assert response.status_code == 503, response.content
    validate.assert_not_called()
    claim.assert_not_called()


@pytest.mark.django_db
@pytest.mark.parametrize(
    "path", ["/api/auth/zcash/challenge/", "/api/auth/zcash/login/"]
)
@pytest.mark.parametrize("address", [TADDR, "not-a-zcash-address"])
def test_production_proxy_topology_failure_closes_both_wallet_endpoints(
    api_client, settings, mocker, path, address
):
    settings.ZCASH_AUTH_ALLOW_REMOTE_ADDR_FALLBACK = False
    issue = mocker.patch("dj.apps.zauth.views.issue_challenge")
    validate = mocker.patch("dj.apps.zauth.views.validate_challenge")

    response = api_client.post(path, {"address": address}, format="json")

    assert response.status_code == 503, response.content
    issue.assert_not_called()
    validate.assert_not_called()


@pytest.mark.django_db
def test_authenticated_association_is_still_charged_by_login_admission(
    api_client, creator_factory, mocker
):
    api_client.force_authenticate(user=creator_factory())
    admit = mocker.patch(
        "dj.apps.zauth.admission.admit_login", return_value=(False, 60)
    )
    validate = mocker.patch("dj.apps.zauth.views.validate_challenge")

    response = api_client.post(
        "/api/auth/zcash/login/", {"address": TADDR}, format="json"
    )

    assert response.status_code == 429, response.content
    admit.assert_called_once_with("ipv4:127.0.0.1")
    validate.assert_not_called()


@pytest.mark.django_db
def test_production_style_local_cache_misconfiguration_fails_closed(
    api_client, settings, mocker
):
    settings.ZCASH_CHALLENGE_ALLOW_LOCAL_CACHE = False
    issue = mocker.patch("dj.apps.zauth.views.issue_challenge")

    response = api_client.post(
        "/api/auth/zcash/challenge/", {"address": TADDR}, format="json"
    )

    assert response.status_code == 503, response.content
    issue.assert_not_called()


@pytest.mark.django_db
def test_oversized_fixed_length_body_is_rejected_before_admission(
    api_client, mocker
):
    admit = mocker.patch(
        "dj.apps.zauth.admission.admit_challenge", return_value=(True, 60)
    )
    admit_address = mocker.patch(
        "dj.apps.zauth.admission.admit_challenge_address"
    )
    body = json.dumps({"address": "x" * (ZCASH_AUTH_BODY_MAX_BYTES + 1)})

    response = api_client.generic(
        "POST",
        "/api/auth/zcash/challenge/",
        body,
        content_type="application/json",
    )

    assert response.status_code == 413, response.content
    assert response.data == {
        "detail": "Zcash authentication request body is too large."
    }
    assert response["Content-Type"].startswith("application/json")
    admit.assert_called_once_with("ipv4:127.0.0.1")
    admit_address.assert_not_called()


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("body", "content_type", "expected_status"),
    [
        (b"{not-json", "application/json", 400),
        (b"address=value", "application/x-www-form-urlencoded", 415),
    ],
)
def test_challenge_parser_failures_charge_only_fixed_client_admission(
    api_client, mocker, body, content_type, expected_status
):
    admit = mocker.patch(
        "dj.apps.zauth.admission.admit_challenge", return_value=(True, 60)
    )
    admit_address = mocker.patch(
        "dj.apps.zauth.admission.admit_challenge_address"
    )
    issue = mocker.patch("dj.apps.zauth.views.issue_challenge")

    response = api_client.generic(
        "POST",
        "/api/auth/zcash/challenge/",
        body,
        content_type=content_type,
    )

    assert response.status_code == expected_status, response.content
    assert response["Content-Type"].startswith("application/json")
    admit.assert_called_once_with("ipv4:127.0.0.1")
    admit_address.assert_not_called()
    issue.assert_not_called()


@pytest.mark.django_db
def test_oversized_login_body_is_413_detail_json_after_fixed_admission(
    api_client, mocker
):
    admit = mocker.patch(
        "dj.apps.zauth.admission.admit_login", return_value=(True, 60)
    )
    body = json.dumps({"signature": "x" * (ZCASH_AUTH_BODY_MAX_BYTES + 1)})

    response = api_client.generic(
        "POST",
        "/api/auth/zcash/login/",
        body,
        content_type="application/json",
    )

    assert response.status_code == 413, response.content
    assert response.data == {
        "detail": "Zcash authentication request body is too large."
    }
    assert response["Content-Type"].startswith("application/json")
    admit.assert_called_once_with("ipv4:127.0.0.1")


def test_parser_bounds_chunked_or_missing_content_length():
    parser = ZcashAuthJSONParser()
    request = type("Request", (), {"META": {}})()
    small = json.dumps({"address": TADDR}).encode()
    assert parser.parse(
        BytesIO(small), parser_context={"request": request}
    )["address"] == TADDR

    with pytest.raises(ZcashAuthRequestTooLarge, match="too large"):
        parser.parse(
            BytesIO(b"{" + b" " * ZCASH_AUTH_BODY_MAX_BYTES + b"}"),
            parser_context={"request": request},
        )


@pytest.mark.django_db
def test_maximum_valid_login_fields_fit_under_body_cap(api_client, mocker):
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    token = _issue(api_client)
    body = {
        "address": TADDR,
        "challenge": token,
        "signature": "s" * 128,
        "pubkey": "p" * 130,
    }
    encoded = json.dumps(body).encode()
    assert len(encoded) < ZCASH_AUTH_BODY_MAX_BYTES

    response = api_client.generic(
        "POST",
        "/api/auth/zcash/login/",
        encoded,
        content_type="application/json",
    )
    assert response.status_code == 200, response.content


@pytest.mark.django_db
@pytest.mark.parametrize(
    "path", ["/api/auth/zcash/challenge/", "/api/auth/zcash/login/"]
)
def test_zcash_auth_is_intentionally_json_only(api_client, path):
    response = api_client.post(path, {"address": TADDR})
    assert response.status_code == 415, response.content


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/api/auth/zcash/challenge/", {"address": "not-a-zcash-address"}),
        (
            "/api/auth/zcash/login/",
            {"address": TADDR, "challenge": LEGACY_CHALLENGE},
        ),
    ],
)
def test_serializer_failures_match_detail_only_error_contract(api_client, path, body):
    response = api_client.post(path, body, format="json")

    assert response.status_code == 400, response.content
    assert response.data == {"detail": "Invalid request."}
    assert response["Content-Type"].startswith("application/json")


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("address", TADDR + " "),
        ("address", [TADDR]),
        ("challenge", "x" * 129),
        ("challenge", ["challenge"]),
        ("signature", "x" * 129),
        ("signature", {"signature": "value"}),
        ("pubkey", "x" * 131),
        ("pubkey", 123),
    ],
)
def test_login_rejects_invalid_bounded_fields_before_authentication(
    api_client, mocker, field, value
):
    validate = mocker.patch("dj.apps.zauth.views.validate_challenge")
    body = {
        "address": TADDR,
        "challenge": "ZUULI-Login:v2:bounded",
        "signature": SIGNATURE,
        field: value,
    }
    response = api_client.post("/api/auth/zcash/login/", body, format="json")
    assert response.status_code == 400, response.content
    assert response.data == {"detail": "Invalid request."}
    validate.assert_not_called()


@pytest.mark.parametrize(
    ("forwarded_for", "expected"),
    [
        ("203.0.113.9,35.191.0.1", "ipv4:203.0.113.9"),
        (
            "forged,not-an-ip,2001:0db8:0:0:0:0:0:5,2001:db8::ffff",
            "ipv6-prefix:2001:db8::/64",
        ),
        (
            ",".join(["rotated-prefix"] * 14 + ["192.0.2.4", "35.191.0.2"]),
            "ipv4:192.0.2.4",
        ),
    ],
)
def test_zcash_client_identity_uses_canonical_gclb_suffix(
    settings, forwarded_for, expected
):
    settings.ZCASH_AUTH_ALLOW_REMOTE_ADDR_FALLBACK = False
    request = type(
        "Request",
        (),
        {
            "META": {
                "HTTP_X_FORWARDED_FOR": forwarded_for,
                "HTTP_X_FREE2Z_PROXY_PEER": "35.191.0.8",
                "REMOTE_ADDR": "127.0.0.1",
            }
        },
    )()

    assert admission.zcash_client_identity(request) == expected


@pytest.mark.parametrize(
    "meta",
    [
        {},
        {"HTTP_X_FORWARDED_FOR": ""},
        {"HTTP_X_FORWARDED_FOR": "203.0.113.9"},
        {"HTTP_X_FORWARDED_FOR": "prefix,not-an-ip,35.191.0.1"},
        {"HTTP_X_FORWARDED_FOR": "prefix,203.0.113.9,not-an-ip"},
        {"HTTP_X_FORWARDED_FOR": "prefix,fe80::1%eth0,35.191.0.1"},
        {"HTTP_X_FORWARDED_FOR": "prefix,,35.191.0.1"},
    ],
)
def test_zcash_client_identity_rejects_missing_or_malformed_topology(settings, meta):
    settings.ZCASH_AUTH_ALLOW_REMOTE_ADDR_FALLBACK = False
    request_meta = {
        "HTTP_X_FREE2Z_PROXY_PEER": "130.211.0.7",
        "REMOTE_ADDR": "127.0.0.1",
        **meta,
    }
    request = type("Request", (), {"META": request_meta})()

    with pytest.raises(admission.ZcashClientIdentityUnavailable):
        admission.zcash_client_identity(request)


@pytest.mark.parametrize(
    "forwarded_for",
    [
        "x" * (admission.ZCASH_XFF_MAX_CHARS + 1),
        ",".join(
            ["prefix"] * admission.ZCASH_XFF_MAX_ELEMENTS + ["192.0.2.4", "35.191.0.1"]
        ),
    ],
)
def test_zcash_client_identity_bounds_header_before_ip_parsing(
    settings, mocker, forwarded_for
):
    settings.ZCASH_AUTH_ALLOW_REMOTE_ADDR_FALLBACK = False
    parse = mocker.patch.object(admission.ipaddress, "ip_address")
    request = type(
        "Request",
        (),
        {"META": {"HTTP_X_FORWARDED_FOR": forwarded_for}},
    )()

    with pytest.raises(admission.ZcashClientIdentityUnavailable):
        admission.zcash_client_identity(request)
    parse.assert_not_called()


@pytest.mark.parametrize(
    "meta",
    [
        {
            "REMOTE_ADDR": "10.20.30.40",
            "HTTP_X_FREE2Z_PROXY_PEER": "35.191.0.8",
        },
        {
            "REMOTE_ADDR": "127.0.0.1",
            "HTTP_X_FREE2Z_PROXY_PEER": "10.20.30.40",
        },
        {
            "REMOTE_ADDR": "127.0.0.1",
            "HTTP_X_FREE2Z_PROXY_PEER": "2600:2d00:1:b029::1",
        },
        {"REMOTE_ADDR": "127.0.0.1"},
    ],
)
def test_zcash_client_identity_rejects_forged_or_non_gfe_final_hop(settings, meta):
    settings.ZCASH_AUTH_ALLOW_REMOTE_ADDR_FALLBACK = False
    request = type(
        "Request",
        (),
        {
            "META": {
                "HTTP_X_FORWARDED_FOR": "203.0.113.9,34.102.196.190",
                **meta,
            }
        },
    )()

    with pytest.raises(admission.ZcashClientIdentityUnavailable):
        admission.zcash_client_identity(request)


@pytest.mark.parametrize(
    "proxy_peer",
    ["35.191.255.255", "130.211.3.255", "2600:2d00:1:1::ffff"],
)
def test_zcash_client_identity_accepts_documented_gfe_request_ranges(
    settings, proxy_peer
):
    settings.ZCASH_AUTH_ALLOW_REMOTE_ADDR_FALLBACK = False
    request = type(
        "Request",
        (),
        {
            "META": {
                "HTTP_X_FORWARDED_FOR": "203.0.113.9,34.102.196.190",
                "HTTP_X_FREE2Z_PROXY_PEER": proxy_peer,
                "REMOTE_ADDR": "::1",
            }
        },
    )()

    assert admission.zcash_client_identity(request) == "ipv4:203.0.113.9"


def test_remote_addr_fallback_is_explicit_local_only(settings):
    request = type("Request", (), {"META": {"REMOTE_ADDR": "2001:0db8::7"}})()
    settings.ZCASH_AUTH_ALLOW_REMOTE_ADDR_FALLBACK = True
    assert (
        admission.zcash_client_identity(request)
        == "ipv6-prefix:2001:db8::/64"
    )

    settings.ZCASH_AUTH_ALLOW_REMOTE_ADDR_FALLBACK = False
    with pytest.raises(admission.ZcashClientIdentityUnavailable):
        admission.zcash_client_identity(request)


@pytest.mark.parametrize(
    ("remote_addr", "expected"),
    [
        ("192.0.2.9", "ipv4:192.0.2.9"),
        ("::ffff:192.0.2.9", "ipv4:192.0.2.9"),
        ("0:0:0:0:0:ffff:c000:209", "ipv4:192.0.2.9"),
        (
            "2001:0db8:abcd:0012:0000:0000:0000:0001",
            "ipv6-prefix:2001:db8:abcd:12::/64",
        ),
        (
            "2001:db8:abcd:12:ffff:eeee:dddd:cccc",
            "ipv6-prefix:2001:db8:abcd:12::/64",
        ),
        (
            "2001:db8:abcd:13::1",
            "ipv6-prefix:2001:db8:abcd:13::/64",
        ),
    ],
)
def test_local_client_identity_normalization_is_typed_and_stable(
    settings, remote_addr, expected
):
    settings.ZCASH_AUTH_ALLOW_REMOTE_ADDR_FALLBACK = True
    request = type("Request", (), {"META": {"REMOTE_ADDR": remote_addr}})()

    assert admission.zcash_client_identity(request) == expected


@pytest.mark.django_db
def test_ipv6_privacy_addresses_share_challenge_and_login_buckets_by_64(
    settings, api_client
):
    settings.ZCASH_AUTH_ALLOW_REMOTE_ADDR_FALLBACK = True
    settings.ZCASH_AUTH_ADMISSION_NAMESPACE = "ipv6-privacy-bucket-test"
    settings.ZCASH_CHALLENGE_ADMISSION_LIMITS = {
        "window_seconds": ADMISSION_WINDOW_SECONDS,
        "client": 3,
        "address": 100,
    }
    settings.ZCASH_LOGIN_ADMISSION_LIMITS = {
        "window_seconds": ADMISSION_WINDOW_SECONDS,
        "client": 3,
    }
    same_64 = [
        "2001:db8:abcd:12::1",
        "2001:0db8:abcd:0012:1111:2222:3333:4444",
        "2001:db8:abcd:12:aaaa:bbbb:cccc:dddd",
        "2001:db8:abcd:12:ffff:ffff:ffff:fffe",
    ]
    different_64 = "2001:db8:abcd:13::1"
    await_admission_window_headroom()

    challenge_statuses = [
        api_client.post(
            "/api/auth/zcash/challenge/",
            {"address": TADDR},
            format="json",
            REMOTE_ADDR=remote_addr,
        ).status_code
        for remote_addr in same_64
    ]
    different_challenge = api_client.post(
        "/api/auth/zcash/challenge/",
        {"address": TADDR},
        format="json",
        REMOTE_ADDR=different_64,
    )
    login_statuses = [
        api_client.post(
            "/api/auth/zcash/login/",
            {},
            format="json",
            REMOTE_ADDR=remote_addr,
        ).status_code
        for remote_addr in same_64
    ]
    different_login = api_client.post(
        "/api/auth/zcash/login/",
        {},
        format="json",
        REMOTE_ADDR=different_64,
    )

    assert challenge_statuses == [200, 200, 200, 429]
    assert different_challenge.status_code == 200
    assert login_statuses == [400, 400, 400, 429]
    assert different_login.status_code == 400


@pytest.mark.django_db
def test_ipv4_mapped_variants_share_the_exact_ipv4_challenge_bucket(
    settings, api_client
):
    settings.ZCASH_AUTH_ALLOW_REMOTE_ADDR_FALLBACK = True
    settings.ZCASH_AUTH_ADMISSION_NAMESPACE = "mapped-ipv4-bucket-test"
    settings.ZCASH_CHALLENGE_ADMISSION_LIMITS = {
        "window_seconds": ADMISSION_WINDOW_SECONDS,
        "client": 2,
        "address": 100,
    }
    equivalent = [
        "192.0.2.9",
        "::ffff:192.0.2.9",
        "0:0:0:0:0:ffff:c000:209",
    ]
    await_admission_window_headroom()

    statuses = [
        api_client.post(
            "/api/auth/zcash/challenge/",
            {"address": TADDR},
            format="json",
            REMOTE_ADDR=remote_addr,
        ).status_code
        for remote_addr in equivalent
    ]
    independent = api_client.post(
        "/api/auth/zcash/challenge/",
        {"address": TADDR},
        format="json",
        REMOTE_ADDR="192.0.2.10",
    )

    assert statuses == [200, 200, 429]
    assert independent.status_code == 200


def test_client_address_and_login_keys_are_fixed_hashes_without_global_key(
    settings,
):
    settings.ZCASH_AUTH_ADMISSION_NAMESPACE = "stage-database"
    client_identity = "ipv6-prefix:2001:db8::/64"
    client_key, address_key = admission.challenge_admission_keys(client_identity, TADDR)
    login_key = admission.login_admission_key(client_identity)

    namespace_digest = hashlib.sha256(b"stage-database").hexdigest()
    assert client_key.startswith(
        f"{admission.CHALLENGE_KEY_PREFIX}{namespace_digest}:client:"
    )
    assert address_key.startswith(
        f"{admission.CHALLENGE_KEY_PREFIX}{namespace_digest}:address:"
    )
    assert login_key.startswith(
        f"{admission.LOGIN_KEY_PREFIX}{namespace_digest}:client:"
    )
    assert all(
        len(key.rsplit(":", 1)[1]) == 64
        for key in (
            client_key,
            address_key,
            login_key,
        )
    )
    assert TADDR not in address_key
    assert client_identity not in client_key
    assert all(":global" not in key for key in (client_key, address_key, login_key))
    assert all(len(key) < 160 for key in (client_key, address_key, login_key))
    assert "global" not in settings.ZCASH_CHALLENGE_ADMISSION_LIMITS


def test_admission_namespace_is_fixed_size_and_environment_specific(settings):
    def all_keys():
        return (
            *admission.challenge_admission_keys("client", TADDR),
            admission.login_admission_key("client"),
        )

    settings.ZCASH_AUTH_ADMISSION_NAMESPACE = "stage"
    stage_keys = all_keys()
    settings.ZCASH_AUTH_ADMISSION_NAMESPACE = "production"
    production_keys = all_keys()
    oversized_namespace = "operator-environment-" * 20_000
    settings.ZCASH_AUTH_ADMISSION_NAMESPACE = oversized_namespace
    oversized_keys = all_keys()

    assert stage_keys != production_keys
    assert production_keys != oversized_keys
    assert [len(key) for key in stage_keys] == [len(key) for key in production_keys]
    assert [len(key) for key in stage_keys] == [len(key) for key in oversized_keys]
    assert oversized_namespace not in "".join(oversized_keys)
    assert max(map(len, oversized_keys)) < 160


@pytest.mark.django_db
def test_challenge_throttle_ignores_forged_prefix_for_client_budget(
    settings, api_client
):
    settings.ZCASH_AUTH_ALLOW_REMOTE_ADDR_FALLBACK = False
    settings.ZCASH_CHALLENGE_ADMISSION_LIMITS = {
        "window_seconds": ADMISSION_WINDOW_SECONDS,
        "client": 2,
        "address": 100,
    }
    headers = [
        f"rotated-{index},garbage-{index},203.0.113.7,35.191.0.1" for index in range(3)
    ]
    await_admission_window_headroom()

    statuses = [
        api_client.post(
            "/api/auth/zcash/challenge/",
            {"address": TADDR},
            format="json",
            HTTP_X_FORWARDED_FOR=header,
            HTTP_X_FREE2Z_PROXY_PEER="35.191.0.9",
        ).status_code
        for header in headers
    ]

    assert statuses == [200, 200, 429]


def test_challenge_throttle_passes_only_authoritative_identity(mocker):
    raw = APIRequestFactory().post(
        "/api/auth/zcash/challenge/",
        {"address": TADDR},
        format="json",
        HTTP_X_FORWARDED_FOR=("198.51.100.1,attacker,2001:0db8::5,2001:db8::ffff"),
        HTTP_X_FREE2Z_PROXY_PEER="130.211.0.8",
    )
    request = Request(raw, parsers=[ZcashAuthJSONParser()])
    admit = mocker.patch.object(admission, "admit_challenge", return_value=(True, 60))
    admit_address = mocker.patch.object(
        admission, "admit_challenge_address", return_value=(True, 60)
    )

    assert admission.ZcashChallengeAdmissionThrottle().allow_request(request, view=None)
    assert admission.ZcashChallengeAddressAdmissionThrottle().allow_request(
        request, view=None
    )
    admit.assert_called_once_with("ipv6-prefix:2001:db8::/64")
    admit_address.assert_called_once_with(TADDR)


@pytest.mark.django_db
def test_malformed_login_body_allocates_only_fixed_authoritative_client_key(
    api_client, settings, mocker
):
    settings.ZCASH_AUTH_ALLOW_REMOTE_ADDR_FALLBACK = False
    admit = mocker.patch.object(admission, "admit_login", return_value=(True, 60))
    prefixes = ["forged-one", "forged-two,not-an-ip"]

    statuses = [
        api_client.generic(
            "POST",
            "/api/auth/zcash/login/",
            b"{not-json",
            content_type="application/json",
            HTTP_X_FORWARDED_FOR=(f"{prefix},203.0.113.44,35.191.0.1"),
            HTTP_X_FREE2Z_PROXY_PEER="35.191.0.10",
        ).status_code
        for prefix in prefixes
    ]

    assert statuses == [400, 400]
    assert [call.args for call in admit.call_args_list] == [
        ("ipv4:203.0.113.44",),
        ("ipv4:203.0.113.44",),
    ]
    key = admission.login_admission_key("ipv4:203.0.113.44")
    assert all(prefix not in key for prefix in prefixes)
    assert len(key.rsplit(":", 1)[1]) == 64


def _issue_concurrently(address, barrier, remote_addr):
    try:
        barrier.wait(timeout=10)
        return (
            APIClient()
            .post(
                "/api/auth/zcash/challenge/",
                {"address": address},
                format="json",
                REMOTE_ADDR=remote_addr,
            )
            .status_code
        )
    finally:
        connections.close_all()


def _invalid_login_concurrently(barrier, remote_addr):
    try:
        barrier.wait(timeout=10)
        return (
            APIClient()
            .post(
                "/api/auth/zcash/login/",
                {},
                format="json",
                REMOTE_ADDR=remote_addr,
            )
            .status_code
        )
    finally:
        connections.close_all()


@pytest.mark.django_db(transaction=True)
def test_real_redis_atomic_client_limit_has_no_lost_updates(settings):
    _backend, raw, prefix = _real_redis(settings, "admission-race")
    settings.ZCASH_CHALLENGE_ADMISSION_LIMITS = {
        "window_seconds": ADMISSION_WINDOW_SECONDS,
        "client": 5,
        "address": 100,
    }
    contenders = 20
    barrier = threading.Barrier(contenders)
    await_admission_window_headroom(raw)
    try:
        with ThreadPoolExecutor(max_workers=contenders) as pool:
            statuses = list(
                pool.map(
                    lambda _: _issue_concurrently(TADDR, barrier, "192.0.2.10"),
                    range(contenders),
                )
            )
        assert statuses.count(200) == 5
        assert statuses.count(429) == contenders - 5
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db(transaction=True)
def test_real_redis_atomic_address_limit_has_no_lost_updates(settings):
    _backend, raw, prefix = _real_redis(settings, "address-admission-race")
    settings.ZCASH_CHALLENGE_ADMISSION_LIMITS = {
        "window_seconds": ADMISSION_WINDOW_SECONDS,
        "client": 100,
        "address": 5,
    }
    contenders = 20
    barrier = threading.Barrier(contenders)
    await_admission_window_headroom(raw)
    try:
        with ThreadPoolExecutor(max_workers=contenders) as pool:
            statuses = list(
                pool.map(
                    lambda index: _issue_concurrently(
                        TADDR, barrier, f"192.0.2.{index + 50}"
                    ),
                    range(contenders),
                )
            )
        assert statuses.count(200) == 5
        assert statuses.count(429) == contenders - 5

        keys = list(raw.scan_iter(match=f"*{prefix}*zcashissue*"))
        assert sum(b":client:" in key for key in keys) == contenders
        assert sum(b":address:" in key for key in keys) == 1
        assert all(0 < raw.pttl(key) <= 60_000 for key in keys)
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db
@pytest.mark.parametrize(
    "invalid_address",
    [
        "not-a-zcash-address",
        TADDR[:-1] + ("J" if TADDR[-1] != "J" else "K"),
        T3ADDR,
    ],
)
def test_real_redis_invalid_addresses_hit_client_cap_without_other_state(
    settings, invalid_address
):
    _backend, raw, prefix = _real_redis(settings, "invalid-address-client-cap")
    settings.ZCASH_CHALLENGE_ADMISSION_LIMITS = {
        "window_seconds": ADMISSION_WINDOW_SECONDS,
        "client": 2,
        "address": 100,
    }
    await_admission_window_headroom(raw)
    try:
        statuses = [
            APIClient()
            .post(
                "/api/auth/zcash/challenge/",
                {"address": invalid_address},
                format="json",
                REMOTE_ADDR="192.0.2.70",
            )
            .status_code
            for _ in range(3)
        ]

        assert statuses == [400, 400, 429]
        admission_keys = list(raw.scan_iter(match=f"*{prefix}*zcashissue*"))
        assert len(admission_keys) == 1
        assert b":client:" in admission_keys[0]
        assert raw.get(admission_keys[0]) == b"2"
        assert list(raw.scan_iter(match=f"*{prefix}*zcashchallenge*")) == []
        assert not ZcashChallengeClaim.objects.exists()
        assert not ZcashIdentity.objects.exists()
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db
def test_real_redis_valid_and_invalid_issuance_share_only_their_client_bucket(
    settings,
):
    _backend, raw, prefix = _real_redis(settings, "mixed-client-admission")
    settings.ZCASH_CHALLENGE_ADMISSION_LIMITS = {
        "window_seconds": ADMISSION_WINDOW_SECONDS,
        "client": 2,
        "address": 100,
    }
    await_admission_window_headroom(raw)

    def status(address, remote_addr):
        return (
            APIClient()
            .post(
                "/api/auth/zcash/challenge/",
                {"address": address},
                format="json",
                REMOTE_ADDR=remote_addr,
            )
            .status_code
        )

    try:
        assert status("not-a-zcash-address", "192.0.2.80") == 400
        assert status(TADDR, "192.0.2.80") == 200
        assert status(T3ADDR, "192.0.2.80") == 429

        # Client B is independent: A's invalid payload cannot choose or poison
        # its identity, and B receives its own mixed invalid/valid allowance.
        assert status("not-a-zcash-address", "192.0.2.81") == 400
        assert status(TADDR, "192.0.2.81") == 200

        admission_keys = list(raw.scan_iter(match=f"*{prefix}*zcashissue*"))
        client_keys = [key for key in admission_keys if b":client:" in key]
        address_keys = [key for key in admission_keys if b":address:" in key]
        assert len(client_keys) == 2
        assert {raw.get(key) for key in client_keys} == {b"2"}
        # Both clients used the same valid address; invalid inputs made no key.
        assert len(address_keys) == 1
        assert raw.get(address_keys[0]) == b"2"
        assert not ZcashChallengeClaim.objects.exists()
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db(transaction=True)
def test_real_redis_atomic_login_limit_has_exact_cap_and_no_lost_updates(
    settings,
):
    _backend, raw, prefix = _real_redis(settings, "login-admission-race")
    settings.ZCASH_LOGIN_ADMISSION_LIMITS = {
        "window_seconds": ADMISSION_WINDOW_SECONDS,
        "client": 5,
    }
    contenders = 20
    barrier = threading.Barrier(contenders)
    await_admission_window_headroom(raw)
    try:
        with ThreadPoolExecutor(max_workers=contenders) as pool:
            statuses = list(
                pool.map(
                    lambda _: _invalid_login_concurrently(barrier, "192.0.2.11"),
                    range(contenders),
                )
            )
        # Admission runs before body validation: the exact five winners reach
        # the serializer's 400, while every other concurrent request is 429.
        assert statuses.count(400) == 5
        assert statuses.count(429) == contenders - 5
        keys = list(raw.scan_iter(match=f"*{prefix}*zcashlogin*"))
        assert len(keys) == 1
        assert 0 < raw.pttl(keys[0]) <= 60_000
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db
def test_real_redis_challenge_and_login_buckets_cannot_exhaust_each_other(
    settings,
):
    _backend, raw, prefix = _real_redis(settings, "admission-isolation")
    settings.ZCASH_CHALLENGE_ADMISSION_LIMITS = {
        "window_seconds": ADMISSION_WINDOW_SECONDS,
        "client": 2,
        "address": 100,
    }
    settings.ZCASH_LOGIN_ADMISSION_LIMITS = {
        "window_seconds": ADMISSION_WINDOW_SECONDS,
        "client": 2,
    }

    def challenge_statuses(remote_addr):
        return [
            APIClient()
            .post(
                "/api/auth/zcash/challenge/",
                {"address": TADDR},
                format="json",
                REMOTE_ADDR=remote_addr,
            )
            .status_code
            for _ in range(3)
        ]

    def login_statuses(remote_addr):
        return [
            APIClient()
            .post(
                "/api/auth/zcash/login/",
                {},
                format="json",
                REMOTE_ADDR=remote_addr,
            )
            .status_code
            for _ in range(3)
        ]

    await_admission_window_headroom(raw)

    try:
        # Client A drains issuance first; its untouched login budget still
        # admits exactly two. Client B proves the reverse direction.
        assert challenge_statuses("192.0.2.21") == [200, 200, 429]
        assert login_statuses("192.0.2.21") == [400, 400, 429]
        assert login_statuses("192.0.2.22") == [400, 400, 429]
        assert challenge_statuses("192.0.2.22") == [200, 200, 429]

        challenge_keys = list(raw.scan_iter(match=f"*{prefix}*zcashissue*"))
        login_keys = list(raw.scan_iter(match=f"*{prefix}*zcashlogin*"))
        # Two client keys; both sources intentionally share one address key.
        assert len(challenge_keys) == 3
        assert len(login_keys) == 2
        assert not set(challenge_keys) & set(login_keys)
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db
def test_real_redis_client_limit_bounds_address_key_churn_without_global(
    settings,
):
    _backend, raw, prefix = _real_redis(settings, "client-bound")
    settings.ZCASH_CHALLENGE_ADMISSION_LIMITS = {
        "window_seconds": ADMISSION_WINDOW_SECONDS,
        "client": 3,
        "address": 100,
    }
    settings.ZCASH_AUTH_ALLOW_REMOTE_ADDR_FALLBACK = False
    await_admission_window_headroom(raw)
    try:
        statuses = [
            APIClient()
            .post(
                "/api/auth/zcash/challenge/",
                {"address": _valid_t1(index)},
                format="json",
                HTTP_X_FORWARDED_FOR=(
                    f"forged-{index},junk-{index},203.0.113.8,35.191.0.1"
                ),
                HTTP_X_FREE2Z_PROXY_PEER="130.211.0.9",
            )
            .status_code
            for index in range(10)
        ]
        assert statuses == [200, 200, 200] + [429] * 7

        keys = list(raw.scan_iter(match=f"*{prefix}*zcashissue*"))
        # One authoritative client key plus at most its allowance of validated
        # address keys. Rotating forged prefixes cannot allocate another
        # client key, and there is no drainable global key.
        assert len(keys) == (
            1 + settings.ZCASH_CHALLENGE_ADMISSION_LIMITS["client"]
        )
        assert all(0 < raw.pttl(key) <= 60_000 for key in keys)
        assert all(b"forged" not in key for key in keys)
        assert all(b":global" not in key for key in keys)
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db
def test_real_redis_new_issuance_is_exactly_readable_by_old_consumer(settings):
    backend, raw, prefix = _real_redis(settings, "rollout-issuance")
    _set_legacy_mirror_policy(settings, True, True)
    try:
        token = _issue(APIClient())
        logical_key = _legacy_cache_key(TADDR)
        raw_key = backend.make_key(logical_key)

        assert logical_key == f"zcashchallenge:{TADDR}"
        assert str(raw_key) == f"{prefix}:1:zcashchallenge:{TADDR}"
        assert raw_key == backend.client.make_key(logical_key)
        assert raw.get(raw_key) == backend.client.encode(token)
        assert 295_000 <= raw.pttl(raw_key) <= 300_000
        assert backend.get(logical_key) == token

        # The old pod's exact cache.get/delete sequence can consume a token
        # minted by the new pod during the rolling deployment.
        assert _old_style_pop(backend, TADDR) == token
        assert raw.exists(raw_key) == 0
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db
def test_real_redis_unacknowledged_compatibility_write_returns_503(
    settings, mocker
):
    backend, raw, prefix = _real_redis(settings, "rollout-write-failure")
    _set_legacy_mirror_policy(settings, True, True)
    mocker.patch.object(backend.client, "set", return_value=False)
    try:
        response = APIClient().post(
            "/api/auth/zcash/challenge/",
            {"address": TADDR},
            format="json",
        )

        assert response.status_code == 503, response.content
        assert response.data == {
            "detail": "Challenge service is temporarily unavailable."
        }
        assert "challenge" not in response.data
        assert raw.exists(backend.make_key(_legacy_cache_key(TADDR))) == 0
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db
@pytest.mark.parametrize(
    "old_first",
    [True, False],
    ids=["old-then-new", "new-then-old"],
)
def test_real_redis_sequential_cross_generation_consumers_have_one_winner(
    settings, mocker, old_first
):
    backend, raw, prefix = _real_redis(settings, f"cross-store-{old_first}")
    _set_legacy_mirror_policy(settings, True, True)
    verify = mocker.patch(
        "dj.apps.zauth.views.verify_zcash_signature", return_value=True
    )
    try:
        token = _issue(APIClient())

        if old_first:
            old_allowed = _old_style_pop(backend, TADDR) == token
            new_response = _login(APIClient(), TADDR, token)
        else:
            new_response = _login(APIClient(), TADDR, token)
            old_allowed = _old_style_pop(backend, TADDR) == token

        new_allowed = new_response.status_code == 200
        assert int(old_allowed) + int(new_allowed) == 1
        assert new_response.status_code == (400 if old_first else 200)
        assert verify.call_count == (0 if old_first else 1)
        assert ZcashChallengeClaim.objects.count() == (0 if old_first else 1)
        assert AuthToken.objects.count() == (0 if old_first else 1)
        assert backend.get(_legacy_cache_key(TADDR)) is None
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db
@pytest.mark.parametrize("slot_state", ["missing", "mismatch"])
def test_real_redis_v2_missing_or_mismatched_mirror_rolls_back_pg_claim(
    settings, mocker, slot_state
):
    backend, raw, prefix = _real_redis(settings, f"v2-{slot_state}")
    _set_legacy_mirror_policy(settings, True, True)
    verify = mocker.patch("dj.apps.zauth.views.verify_zcash_signature")
    token = challenges.issue_challenge(TADDR)
    try:
        raw_key = backend.make_key(_legacy_cache_key(TADDR))
        if slot_state == "mismatch":
            other = challenges.issue_challenge(TADDR)
            _old_style_store(backend, TADDR, other)
            before = raw.get(raw_key)
            before_ttl = raw.pttl(raw_key)

        response = _login(APIClient(), TADDR, token)

        assert response.status_code == 400, response.content
        verify.assert_not_called()
        assert not ZcashChallengeClaim.objects.exists()
        if slot_state == "missing":
            assert raw.exists(raw_key) == 0
        else:
            assert raw.get(raw_key) == before
            assert before_ttl - 2_000 <= raw.pttl(raw_key) <= before_ttl
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db
def test_real_redis_v2_consume_error_fails_closed_and_rolls_back_pg_claim(
    settings, mocker
):
    backend, raw, prefix = _real_redis(settings, "v2-consume-error")
    _set_legacy_mirror_policy(settings, True, True)
    verify = mocker.patch("dj.apps.zauth.views.verify_zcash_signature")
    try:
        token = _issue(APIClient())
        raw_eval = raw.eval

        def fail_only_compatibility_consume(script, *args):
            if script == challenges._LEGACY_COMPARE_AND_DELETE_SCRIPT:
                raise ConnectionError("simulated Redis consume outage")
            return raw_eval(script, *args)

        mocker.patch.object(raw, "eval", side_effect=fail_only_compatibility_consume)
        response = _login(APIClient(), TADDR, token)

        assert response.status_code == 503, response.content
        verify.assert_not_called()
        assert not ZcashChallengeClaim.objects.exists()
        # The simulated error happened before execution. Production restores
        # nothing after an ambiguous error because execution might have won.
        assert backend.get(_legacy_cache_key(TADDR)) == token
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db
def test_real_redis_newer_v2_invalidates_older_and_latest_works_once(
    settings, mocker
):
    backend, raw, prefix = _real_redis(settings, "v2-latest-authority")
    _set_legacy_mirror_policy(settings, True, True)
    verify = mocker.patch(
        "dj.apps.zauth.views.verify_zcash_signature", return_value=True
    )
    try:
        older = _issue(APIClient())
        latest = _issue(APIClient())
        raw_key = backend.make_key(_legacy_cache_key(TADDR))
        assert raw.get(raw_key) == backend.client.encode(latest)
        assert 295_000 <= raw.pttl(raw_key) <= 300_000

        invalidated = _login(APIClient(), TADDR, older)
        accepted = _login(APIClient(), TADDR, latest)
        replay = _login(APIClient(), TADDR, latest)

        assert [
            invalidated.status_code,
            accepted.status_code,
            replay.status_code,
        ] == [400, 200, 400]
        verify.assert_called_once_with(TADDR, SIGNATURE, latest)
        assert ZcashChallengeClaim.objects.count() == 1
        assert AuthToken.objects.count() == 1
        assert raw.exists(raw_key) == 0
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db
@pytest.mark.parametrize("issuer_required", [True, False], ids=["issuer-a", "issuer-b"])
@pytest.mark.parametrize(
    "consumer_required", [True, False], ids=["consumer-a", "consumer-b"]
)
def test_real_redis_postgres_phase_b_mixed_routes_accept_latest_once(
    settings, mocker, issuer_required, consumer_required
):
    """Every A/B issuer mirrors, and either A/B consumer accepts latest."""
    if connection.vendor != "postgresql":
        pytest.skip("PostgreSQL durable-claim semantics required")
    backend, raw, prefix = _real_redis(
        settings,
        f"phase-b-{issuer_required}-{consumer_required}",
    )
    _set_legacy_mirror_policy(settings, True, issuer_required)
    verify = mocker.patch(
        "dj.apps.zauth.views.verify_zcash_signature", return_value=True
    )
    try:
        _issue(APIClient())
        latest = _issue(APIClient())
        raw_key = backend.make_key(_legacy_cache_key(TADDR))
        assert raw.get(raw_key) == backend.client.encode(latest)

        _set_legacy_mirror_policy(settings, True, consumer_required)
        accepted = _login(APIClient(), TADDR, latest)

        # Route the sequential replay to the other phase's consumer. The
        # PostgreSQL claim is common authority even when phase B left a mirror.
        _set_legacy_mirror_policy(settings, True, not consumer_required)
        replay = _login(APIClient(), TADDR, latest)

        assert [accepted.status_code, replay.status_code] == [200, 400]
        verify.assert_called_once_with(TADDR, SIGNATURE, latest)
        assert ZcashChallengeClaim.objects.count() == 1
        assert AuthToken.objects.count() == 1
        assert raw.exists(raw_key) == (0 if consumer_required else 1)
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db
def test_real_redis_postgres_phase_b_older_proof_keeps_pg_one_use_semantics(
    settings, mocker
):
    """A may reject an older proof; B can accept it once, never replay it."""
    if connection.vendor != "postgresql":
        pytest.skip("PostgreSQL durable-claim semantics required")
    backend, raw, prefix = _real_redis(settings, "phase-b-older")
    verify = mocker.patch(
        "dj.apps.zauth.views.verify_zcash_signature", return_value=True
    )
    try:
        _set_legacy_mirror_policy(settings, True, True)
        older = _issue(APIClient())
        _set_legacy_mirror_policy(settings, True, False)
        latest = _issue(APIClient())
        raw_key = backend.make_key(_legacy_cache_key(TADDR))

        _set_legacy_mirror_policy(settings, True, True)
        phase_a_rejection = _login(APIClient(), TADDR, older)
        assert phase_a_rejection.status_code == 400
        assert not ZcashChallengeClaim.objects.exists()
        assert raw.get(raw_key) == backend.client.encode(latest)

        _set_legacy_mirror_policy(settings, True, False)
        phase_b_acceptance = _login(APIClient(), TADDR, older)
        _set_legacy_mirror_policy(settings, True, True)
        cross_phase_replay = _login(APIClient(), TADDR, older)
        latest_acceptance = _login(APIClient(), TADDR, latest)
        _set_legacy_mirror_policy(settings, True, False)
        latest_replay = _login(APIClient(), TADDR, latest)

        assert [
            phase_b_acceptance.status_code,
            cross_phase_replay.status_code,
            latest_acceptance.status_code,
            latest_replay.status_code,
        ] == [200, 400, 200, 400]
        assert verify.call_args_list == [
            mocker.call(TADDR, SIGNATURE, older),
            mocker.call(TADDR, SIGNATURE, latest),
        ]
        assert ZcashChallengeClaim.objects.count() == 2
        assert AuthToken.objects.count() == 2
        assert raw.exists(raw_key) == 0
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db
def test_real_redis_postgres_phase_c_mixed_routes_ignore_optional_mirrors(
    settings, mocker
):
    """B/C consumers are PG-only whether their issuer mirrored or not."""
    if connection.vendor != "postgresql":
        pytest.skip("PostgreSQL durable-claim semantics required")
    backend, raw, prefix = _real_redis(settings, "phase-c-mixed")
    verify = mocker.patch(
        "dj.apps.zauth.views.verify_zcash_signature", return_value=True
    )
    try:
        _set_legacy_mirror_policy(settings, True, False)
        phase_b_token = _issue(APIClient())
        raw_key = backend.make_key(_legacy_cache_key(TADDR))
        assert raw.get(raw_key) == backend.client.encode(phase_b_token)

        _set_legacy_mirror_policy(settings, False, False)
        accepted_by_c = _login(APIClient(), TADDR, phase_b_token)
        _set_legacy_mirror_policy(settings, True, False)
        replay_at_b = _login(APIClient(), TADDR, phase_b_token)

        _set_legacy_mirror_policy(settings, False, False)
        phase_c_token = _issue(APIClient())
        # Phase C issuance neither overwrites nor depends on the stale mirror.
        assert raw.get(raw_key) == backend.client.encode(phase_b_token)
        _set_legacy_mirror_policy(settings, True, False)
        accepted_by_b = _login(APIClient(), TADDR, phase_c_token)
        _set_legacy_mirror_policy(settings, False, False)
        replay_at_c = _login(APIClient(), TADDR, phase_c_token)

        assert [
            accepted_by_c.status_code,
            replay_at_b.status_code,
            accepted_by_b.status_code,
            replay_at_c.status_code,
        ] == [200, 400, 200, 400]
        assert verify.call_args_list == [
            mocker.call(TADDR, SIGNATURE, phase_b_token),
            mocker.call(TADDR, SIGNATURE, phase_c_token),
        ]
        assert ZcashChallengeClaim.objects.count() == 2
        assert AuthToken.objects.count() == 2
        assert raw.get(raw_key) == backend.client.encode(phase_b_token)
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db
def test_real_redis_disabled_mode_has_no_mirror_and_v2_remains_one_use(
    settings, mocker
):
    backend, raw, prefix = _real_redis(settings, "v2-disabled")
    _set_legacy_mirror_policy(settings, False, False)
    verify = mocker.patch(
        "dj.apps.zauth.views.verify_zcash_signature", return_value=True
    )
    try:
        token = _issue(APIClient())
        raw_key = backend.make_key(_legacy_cache_key(TADDR))
        assert raw.exists(raw_key) == 0

        accepted = _login(APIClient(), TADDR, token)
        replay = _login(APIClient(), TADDR, token)

        assert [accepted.status_code, replay.status_code] == [200, 400]
        verify.assert_called_once_with(TADDR, SIGNATURE, token)
        assert ZcashChallengeClaim.objects.count() == 1
        assert AuthToken.objects.count() == 1
        assert raw.exists(raw_key) == 0
    finally:
        _delete_prefixed(raw, prefix)


def _consume_legacy_concurrently(address, challenge, barrier):
    barrier.wait(timeout=10)
    return challenges.consume_legacy_challenge(address, challenge)


@pytest.mark.django_db
def test_real_redis_legacy_compare_delete_has_exactly_one_winner(settings):
    backend, raw, prefix = _real_redis(settings, "rollout-consume")
    contenders = 16
    barrier = threading.Barrier(contenders)
    try:
        _old_style_store(backend, TADDR, LEGACY_CHALLENGE)
        with ThreadPoolExecutor(max_workers=contenders) as pool:
            results = list(
                pool.map(
                    lambda _: _consume_legacy_concurrently(
                        TADDR, LEGACY_CHALLENGE, barrier
                    ),
                    range(contenders),
                )
            )

        assert results.count(True) == 1
        assert results.count(False) == contenders - 1
        assert backend.get(_legacy_cache_key(TADDR)) is None
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db
def test_real_redis_legacy_miss_and_mismatch_do_not_mutate_state(settings):
    backend, raw, prefix = _real_redis(settings, "rollout-read-only")
    try:
        _old_style_store(backend, TADDR, LEGACY_CHALLENGE)
        raw_key = backend.make_key(_legacy_cache_key(TADDR))
        before_keys = set(raw.scan_iter(match=f"*{prefix}*"))
        before_ttl = raw.pttl(raw_key)

        assert not challenges.consume_legacy_challenge(
            TADDR, OTHER_LEGACY_CHALLENGE
        )
        assert not challenges.consume_legacy_challenge(
            OTHER_TADDR, LEGACY_CHALLENGE
        )

        assert raw.get(raw_key) == backend.client.encode(LEGACY_CHALLENGE)
        assert set(raw.scan_iter(match=f"*{prefix}*")) == before_keys
        assert before_ttl - 2_000 <= raw.pttl(raw_key) <= before_ttl
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db
def test_replay_claim_survives_shared_redis_state_loss(settings):
    backend, raw, prefix = _real_redis(settings, "durable-claim")
    token = challenges.issue_challenge(TADDR)
    try:
        sentinel = backend.make_key("pre-restart-state")
        raw.set(sentinel, b"present", ex=60)
        assert challenges.claim_challenge(token) is True

        # Model the complete loss of this environment's ephemeral cache keys.
        _delete_prefixed(raw, prefix)
        assert raw.exists(sentinel) == 0

        # PostgreSQL uniqueness remains authoritative after that loss.
        assert challenges.claim_challenge(token) is False
        assert ZcashChallengeClaim.objects.count() == 1
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db
def test_claim_transaction_never_performs_expired_backlog_cleanup():
    expired = ZcashChallengeClaim.objects.create(
        challenge_digest="0" * 64,
        expires=timezone.now() - timedelta(minutes=1),
    )
    token = challenges.issue_challenge(TADDR)

    assert challenges.claim_challenge(token) is True
    assert ZcashChallengeClaim.objects.filter(pk=expired.pk).exists()
    assert ZcashChallengeClaim.objects.count() == 2


def _run_claim_cleanup_in_fresh_connection():
    close_old_connections()
    try:
        return challenges.cleanup_expired_challenge_claims()
    finally:
        connections.close_all()


@pytest.mark.django_db(transaction=True)
def test_real_postgres_cleanup_try_lock_is_single_bounded_and_nonblocking(
    mocker,
):
    if connection.vendor != "postgresql":
        pytest.skip("PostgreSQL advisory-lock semantics required")

    now = timezone.now()
    backlog = challenges.CLAIM_CLEANUP_BATCH_SIZE + 5
    old_digests = [
        hashlib.sha256(f"old-expired-{index}".encode()).hexdigest()
        for index in range(backlog)
    ]
    recent_expired_digest = hashlib.sha256(b"recent-expired").hexdigest()
    live_digest = hashlib.sha256(b"live-claim").hexdigest()
    ZcashChallengeClaim.objects.bulk_create(
        [
            ZcashChallengeClaim(
                challenge_digest=digest,
                expires=now - timedelta(seconds=(backlog - index + 60)),
            )
            for index, digest in enumerate(old_digests)
        ]
        + [
            ZcashChallengeClaim(
                challenge_digest=recent_expired_digest,
                expires=now - timedelta(seconds=1),
            ),
            ZcashChallengeClaim(
                challenge_digest=live_digest,
                expires=now + timedelta(minutes=5),
            ),
        ]
    )

    original_delete = challenges._delete_expired_claim_batch
    cleanup_entered = threading.Event()
    release_cleanup = threading.Event()
    helper_threads = []
    helper_lock = threading.Lock()

    def blocked_delete(cutoff, batch_size):
        with helper_lock:
            helper_threads.append(threading.get_ident())
        cleanup_entered.set()
        if not release_cleanup.wait(timeout=10):
            raise AssertionError("cleanup test release timed out")
        return original_delete(cutoff, batch_size)

    mocker.patch.object(
        challenges, "_delete_expired_claim_batch", side_effect=blocked_delete
    )

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(_run_claim_cleanup_in_fresh_connection)
        assert cleanup_entered.wait(timeout=10)
        second = pool.submit(_run_claim_cleanup_in_fresh_connection)
        try:
            # A blocking advisory lock would remain pending behind the first
            # worker. pg_try_advisory_xact_lock returns immediately instead.
            assert second.result(timeout=2) == 0
        finally:
            release_cleanup.set()
        assert first.result(timeout=10) == challenges.CLAIM_CLEANUP_BATCH_SIZE

    assert len(helper_threads) == 1
    assert not ZcashChallengeClaim.objects.filter(
        challenge_digest=old_digests[0]
    ).exists()
    assert ZcashChallengeClaim.objects.filter(
        challenge_digest=recent_expired_digest
    ).exists()
    assert ZcashChallengeClaim.objects.filter(challenge_digest=live_digest).exists()
    assert ZcashChallengeClaim.objects.filter(expires__lte=now).count() == (
        backlog + 1 - challenges.CLAIM_CLEANUP_BATCH_SIZE
    )


@pytest.mark.django_db(transaction=True)
def test_cleanup_failure_does_not_break_valid_authentication(api_client, mocker):
    if connection.vendor != "postgresql":
        pytest.skip("PostgreSQL cleanup path required")
    delete_batch = mocker.patch.object(
        challenges,
        "_delete_expired_claim_batch",
        side_effect=RuntimeError("maintenance failure"),
    )
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    token = _issue(api_client)

    response = _login(api_client, TADDR, token)

    assert response.status_code == 200, response.content
    delete_batch.assert_called_once()
    assert ZcashChallengeClaim.objects.filter(
        challenge_digest=challenges.challenge_digest(token)
    ).exists()
    assert ZcashIdentity.objects.filter(zcash_address=TADDR).exists()


def _concurrent_login(address, token, barrier):
    try:
        barrier.wait(timeout=10)
        response = _login(APIClient(), address, token)
        return response.status_code, getattr(response, "data", {})
    finally:
        connections.close_all()


@pytest.mark.django_db(transaction=True)
def test_real_redis_legacy_login_race_mints_one_durably_claimed_token(
    settings, mocker
):
    backend, raw, prefix = _real_redis(settings, "legacy-login-race")
    settings.ZCASH_LOGIN_ADMISSION_LIMITS = {
        "window_seconds": ADMISSION_WINDOW_SECONDS,
        "client": 100,
    }
    _old_style_store(backend, TADDR, LEGACY_CHALLENGE)
    verify = mocker.patch(
        "dj.apps.zauth.views.verify_zcash_signature", return_value=True
    )
    contenders = 8
    barrier = threading.Barrier(contenders)
    try:
        with ThreadPoolExecutor(max_workers=contenders) as pool:
            results = list(
                pool.map(
                    lambda _: _concurrent_login(
                        TADDR, LEGACY_CHALLENGE, barrier
                    ),
                    range(contenders),
                )
            )

        statuses = [status for status, _body in results]
        assert statuses.count(200) == 1
        assert statuses.count(400) == contenders - 1
        verify.assert_called_once_with(TADDR, SIGNATURE, LEGACY_CHALLENGE)
        assert ZcashChallengeClaim.objects.count() == 1
        identity = ZcashIdentity.objects.get(zcash_address=TADDR)
        assert AuthToken.objects.filter(user=identity.creator).count() == 1
    finally:
        _delete_prefixed(raw, prefix)


@pytest.mark.django_db(transaction=True)
def test_two_distinct_challenges_concurrently_provision_one_identity(
    api_client, settings, mocker
):
    _set_legacy_mirror_policy(settings, False, False)
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    first = _issue(api_client)
    second = _issue(api_client)

    # Align both transactions immediately before the real PostgreSQL advisory
    # lock.  The lock itself, identity uniqueness, and commits remain real.
    from dj.apps.zauth import views

    original_lock = views._lock_identity_address
    lock_barrier = threading.Barrier(2)

    def aligned_lock(address):
        lock_barrier.wait(timeout=10)
        return original_lock(address)

    mocker.patch.object(views, "_lock_identity_address", aligned_lock)
    request_barrier = threading.Barrier(2)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                lambda token: _concurrent_login(TADDR, token, request_barrier),
                [first, second],
            )
        )

    assert [status for status, _body in results] == [200, 200]
    assert sorted(body["created"] for _status, body in results) == [False, True]
    identity = ZcashIdentity.objects.get(zcash_address=TADDR)
    assert Creator.objects.filter(p2paddr=TADDR).count() == 1
    assert AuthToken.objects.filter(user=identity.creator).count() == 2
    assert ZcashChallengeClaim.objects.count() == 2
    assert not Creator.objects.filter(p2paddr=TADDR).exclude(
        pk=identity.creator_id
    ).exists()


@pytest.mark.django_db(transaction=True)
def test_real_redis_admission_and_durable_replay_mint_one_token(
    settings, mocker
):
    _backend, raw, prefix = _real_redis(settings, "login-race")
    settings.ZCASH_CHALLENGE_ADMISSION_LIMITS = {
        "window_seconds": ADMISSION_WINDOW_SECONDS,
        "client": 100,
        "address": 100,
    }
    settings.ZCASH_LOGIN_ADMISSION_LIMITS = {
        "window_seconds": ADMISSION_WINDOW_SECONDS,
        "client": 100,
    }
    verify = mocker.patch(
        "dj.apps.zauth.views.verify_zcash_signature", return_value=True
    )
    token = _issue(APIClient())
    contenders = 8
    barrier = threading.Barrier(contenders)
    try:
        with ThreadPoolExecutor(max_workers=contenders) as pool:
            results = list(
                pool.map(
                    lambda _: _concurrent_login(TADDR, token, barrier),
                    range(contenders),
                )
            )
        statuses = [status for status, _body in results]
        assert statuses.count(200) == 1
        assert statuses.count(400) == contenders - 1
        assert verify.call_count == 1
        identity = ZcashIdentity.objects.get(zcash_address=TADDR)
        assert AuthToken.objects.filter(user=identity.creator).count() == 1
    finally:
        _delete_prefixed(raw, prefix)
