"""
Tests for "Login with Zcash" ("ZUULI Zcash Login v1").

Run against real Postgres (see conftest):

    cd py/free2z && python -m pytest dj/apps/zauth/ -x

Covers:
  - challenge -> login happy path (verifymessage mocked True)
  - REAL in-process verification against a genuine wallet-plugin signature
    (no mock, no node) -- both the unit check and the full view path
  - a bogus signature is rejected with 401
  - Creator + ZcashIdentity creation, then reuse on a second login
  - single-use / expired / mismatched challenge rejection
  - associate flow: linking an address to an already-authenticated Creator

NOTE: pytest.ini sets ``python_files = test_*.py`` so this file (not the
conventional ``tests.py``) is what actually gets collected.
"""
import pytest

from knox.models import AuthToken

from dj.apps.g12f.models import Creator
from dj.apps.zauth.models import ZcashIdentity
from dj.apps.zauth.views import username_for_address


# Checksum-valid mainnet P2PKH fixture. The old t1Kx... value was only
# address-shaped and strict challenge admission correctly rejects its checksum.
TADDR = "t1WnCauSV6fbHzWBHtSrK2qvFRyU6J121nH"

# A REAL "ZUULI Zcash Login v1" signature produced by the wallet plugin's Rust
# `sign_challenge` (tauri-plugin-zcash) for a fixed test seed. Pinned here so the
# backend's in-process verification is exercised against the *actual* bytes the
# client emits -- the cross-language interface that a node-only, mocked test
# could never catch. (Regenerate via the plugin's
# `sign_challenge_recovers_pubkey_and_address` test if the scheme ever changes.)
VECTOR_ADDRESS = "t1f3vC5hEbAwJdheoFbwaBYssj2Hwp3MFXX"
VECTOR_PUBKEY = (
    "026e8698de2c0d8eeedf93db25c808f271a5a9bf95191d2697fef4593281f815b1"
)
VECTOR_SIGNATURE = (
    "IP5b5GpnexctRgyoCK9DH/PVCEUpU1InZOOBEiao65wUHzgc2/"
    "Q9/xZGUeLlu+5AACX1QGd/TCbbeqB3ZefwZOU="
)
VECTOR_CHALLENGE = "ZUULI login challenge: 2026-07-18T00:00:00Z nonce=deadbeef"


def _get_challenge(api_client, address=TADDR):
    resp = api_client.post(
        "/api/auth/zcash/challenge/",
        {"address": address},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    challenge = resp.data["challenge"]
    assert challenge.startswith("ZUULI-Login:")
    return challenge


@pytest.mark.django_db
def test_generated_username_is_readable():
    import re
    assert re.fullmatch(r"[a-z]+-[a-z]+-[0-9]{6}", username_for_address(TADDR))


@pytest.mark.django_db
def test_login_creates_creator_and_identity_with_mocked_verify(api_client, mocker):
    """verifymessage mocked True: full node path without a real node."""
    mock_verify = mocker.patch(
        "dj.apps.zauth.views.verify_zcash_signature", return_value=True,
    )

    challenge = _get_challenge(api_client)

    resp = api_client.post(
        "/api/auth/zcash/login/",
        {
            "address": TADDR,
            "challenge": challenge,
            "signature": "IHVsaWduYXR1cmU=",  # opaque; verify is mocked
            "pubkey": "02abcdef",
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content

    body = resp.data
    assert body["token"]
    assert body["expiry"]
    assert body["did"] == f"did:zcash:{TADDR}"
    assert body["created"] is True

    mock_verify.assert_called_once_with(TADDR, "IHVsaWduYXR1cmU=", challenge)

    identity = ZcashIdentity.objects.get(zcash_address=TADDR)
    creator = identity.creator
    assert creator.username == body["username"]
    assert creator.p2paddr == TADDR
    assert not creator.has_usable_password()

    # A real knox token row exists for this user.
    assert AuthToken.objects.filter(user=creator).count() == 1


@pytest.mark.django_db
def test_second_login_reuses_same_creator(api_client, mocker):
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)

    # First login -> creates.
    challenge1 = _get_challenge(api_client)
    resp1 = api_client.post(
        "/api/auth/zcash/login/",
        {"address": TADDR, "challenge": challenge1, "signature": "sig1"},
        format="json",
    )
    assert resp1.status_code == 200, resp1.content
    assert resp1.data["created"] is True
    creator_id = ZcashIdentity.objects.get(zcash_address=TADDR).creator_id

    # Second login -> reuses.
    challenge2 = _get_challenge(api_client)
    resp2 = api_client.post(
        "/api/auth/zcash/login/",
        {"address": TADDR, "challenge": challenge2, "signature": "sig2"},
        format="json",
    )
    assert resp2.status_code == 200, resp2.content
    assert resp2.data["created"] is False

    assert ZcashIdentity.objects.filter(zcash_address=TADDR).count() == 1
    assert ZcashIdentity.objects.get(zcash_address=TADDR).creator_id == creator_id
    assert resp2.data["username"] == resp1.data["username"]


def test_verify_zcash_signature_accepts_real_wallet_signature():
    """
    The core regression guard: run the REAL, un-mocked verification against a
    genuine wallet-plugin signature. The old implementation called
    ``client.rpc.verifymessage`` -- an attribute that exists only on the
    retired zcashd proxy, not on the Zallet backend prod runs -- so this check
    returned False for every signature and every login 401'd. In-process
    verification must accept a valid signature and reject tampering.
    """
    from dj.apps.zauth.views import verify_zcash_signature

    assert verify_zcash_signature(
        VECTOR_ADDRESS, VECTOR_SIGNATURE, VECTOR_CHALLENGE) is True
    # Tampered challenge -> different digest -> recovered pubkey/address differ.
    assert verify_zcash_signature(
        VECTOR_ADDRESS, VECTOR_SIGNATURE, VECTOR_CHALLENGE + "!") is False
    # Right signature, wrong claimed address.
    assert verify_zcash_signature(
        TADDR, VECTOR_SIGNATURE, VECTOR_CHALLENGE) is False
    # Malformed signature must fail closed, never raise.
    assert verify_zcash_signature(
        VECTOR_ADDRESS, "not-base64!!", VECTOR_CHALLENGE) is False


@pytest.mark.django_db
def test_login_end_to_end_with_real_signature(api_client, settings, mocker):
    """
    Full challenge -> sign -> login path with NO verify mock and NO node: the
    server issues the (patched-to-fixed) challenge, the wallet's real signature
    verifies in-process, and a Creator + knox token are minted.
    """
    settings.ZCASH_CHALLENGE_LEGACY_MIRROR_WRITES_ENABLED = False
    settings.ZCASH_CHALLENGE_LEGACY_MIRROR_REQUIRED = False
    mocker.patch(
        "dj.apps.zauth.views.issue_challenge", return_value=VECTOR_CHALLENGE,
    )
    mocker.patch("dj.apps.zauth.views.store_legacy_compatible_challenge")
    # This pinned wallet vector predates the stateless v2 token envelope.  The
    # real HMAC format is covered in test_challenge_security; here we preserve
    # the cross-language wallet-signature regression through the full view.
    mocker.patch("dj.apps.zauth.views.validate_challenge", return_value=True)

    resp = api_client.post(
        "/api/auth/zcash/challenge/",
        {"address": VECTOR_ADDRESS},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["challenge"] == VECTOR_CHALLENGE

    resp = api_client.post(
        "/api/auth/zcash/login/",
        {
            "address": VECTOR_ADDRESS,
            "challenge": VECTOR_CHALLENGE,
            "signature": VECTOR_SIGNATURE,
            "pubkey": VECTOR_PUBKEY,
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["created"] is True
    assert resp.data["did"] == f"did:zcash:{VECTOR_ADDRESS}"
    identity = ZcashIdentity.objects.get(zcash_address=VECTOR_ADDRESS)
    assert AuthToken.objects.filter(user=identity.creator).count() == 1


@pytest.mark.django_db
def test_login_rejects_bad_signature(api_client, settings, mocker):
    """A real (issued) challenge but a bogus signature -> 401, no account."""
    settings.ZCASH_CHALLENGE_LEGACY_MIRROR_WRITES_ENABLED = False
    settings.ZCASH_CHALLENGE_LEGACY_MIRROR_REQUIRED = False
    mocker.patch(
        "dj.apps.zauth.views.issue_challenge", return_value=VECTOR_CHALLENGE,
    )
    mocker.patch("dj.apps.zauth.views.store_legacy_compatible_challenge")
    mocker.patch("dj.apps.zauth.views.validate_challenge", return_value=True)
    api_client.post(
        "/api/auth/zcash/challenge/",
        {"address": VECTOR_ADDRESS},
        format="json",
    )
    resp = api_client.post(
        "/api/auth/zcash/login/",
        {
            "address": VECTOR_ADDRESS,
            "challenge": VECTOR_CHALLENGE,
            "signature": "anything",
        },
        format="json",
    )
    assert resp.status_code == 401, resp.content
    assert not ZcashIdentity.objects.filter(
        zcash_address=VECTOR_ADDRESS).exists()


@pytest.mark.django_db
def test_challenge_is_single_use(api_client, mocker):
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)

    challenge = _get_challenge(api_client)
    ok = api_client.post(
        "/api/auth/zcash/login/",
        {"address": TADDR, "challenge": challenge, "signature": "sig"},
        format="json",
    )
    assert ok.status_code == 200, ok.content

    # Replay with the same (now consumed) challenge.
    replay = api_client.post(
        "/api/auth/zcash/login/",
        {"address": TADDR, "challenge": challenge, "signature": "sig"},
        format="json",
    )
    assert replay.status_code == 400, replay.content


@pytest.mark.django_db
def test_mismatched_challenge_rejected(api_client, mocker):
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)

    _get_challenge(api_client)
    resp = api_client.post(
        "/api/auth/zcash/login/",
        {"address": TADDR, "challenge": "ZUULI-Login:not-the-real-one", "signature": "sig"},
        format="json",
    )
    assert resp.status_code == 400, resp.content


@pytest.mark.django_db
def test_associate_links_address_to_authenticated_creator(
    api_client, creator_factory, mocker,
    recent_login,
):
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)

    user = creator_factory()
    api_client.force_authenticate(user=user)
    recent_login(api_client, user)
    before_epoch = Creator.objects.values_list(
        "kt_account_epoch", flat=True,
    ).get(pk=user.pk)

    challenge = _get_challenge(api_client)
    resp = api_client.post(
        "/api/auth/zcash/login/",
        {"address": TADDR, "challenge": challenge, "signature": "sig"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["created"] is False
    assert resp.data["username"] == user.username

    identity = ZcashIdentity.objects.get(zcash_address=TADDR)
    assert identity.creator_id == user.id

    #. Linking ADDS a principal and invalidates nothing, so the
    # ownership counter deliberately does not move. Removing a Zcash identity
    # has no self-service route; `ZcashIdentityAdmin` is what counts.
    assert Creator.objects.values_list(
        "kt_account_epoch", flat=True,
    ).get(pk=user.pk) == before_epoch


@pytest.mark.django_db
def test_associate_conflict_when_address_owned_by_other(
    api_client, creator_factory, mocker,
):
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)

    # Owner already holds the address.
    owner = creator_factory()
    ZcashIdentity.objects.create(creator=owner, zcash_address=TADDR)

    other = creator_factory()
    api_client.force_authenticate(user=other)

    challenge = _get_challenge(api_client)
    resp = api_client.post(
        "/api/auth/zcash/login/",
        {"address": TADDR, "challenge": challenge, "signature": "sig"},
        format="json",
    )
    assert resp.status_code == 409, resp.content
    assert ZcashIdentity.objects.get(zcash_address=TADDR).creator_id == owner.id


@pytest.mark.django_db
def test_challenge_requires_address(api_client):
    resp = api_client.post("/api/auth/zcash/challenge/", {}, format="json")
    assert resp.status_code == 400, resp.content


def _username_login(client, address=TADDR, **choice):
    challenge = _get_challenge(client, address)
    return client.post("/api/auth/zcash/login/", {
        "address": address, "challenge": challenge, "signature": "fixture",
        **choice,
    }, format="json")


@pytest.mark.django_db
def test_username_choice_requires_proof_and_preserves_returning_identity(api_client, mocker):
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    response = _username_login(api_client, choose_username=True)
    assert response.status_code == 409
    assert response.data["code"] == "username_required"
    assert not ZcashIdentity.objects.filter(zcash_address=TADDR).exists()
    response = _username_login(api_client, choose_username=True, desired_username="  Ａlice  ")
    assert response.status_code == 200
    assert response.data["username"] == "Alice"
    response = _username_login(api_client, choose_username=True, desired_username="different")
    assert response.status_code == 200
    assert response.data["username"] == "Alice"
    assert response.data["created"] is False


@pytest.mark.django_db
def test_username_availability_and_creation_use_same_policy(api_client, mocker):
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    Creator.objects.create(username="AlreadyTaken")
    for value, expected in [("alreadytaken", "taken"), ("API", "invalid"), ("bad/name", "invalid"), ("Fresh", "available")]:
        response = api_client.get("/api/auth/zcash/username-available/", {"username": value})
        assert response.status_code == 200
        assert response.data["status"] == expected
        if expected != "available":
            response = _username_login(api_client, choose_username=True, desired_username=value)
            assert response.status_code == 409
            assert response.data["code"] == "username_" + expected
            assert not ZcashIdentity.objects.filter(zcash_address=TADDR).exists()
    response = _username_login(api_client, choose_username=True, desired_username="")
    assert response.status_code == 200
    assert response.data["created"] is True


@pytest.mark.django_db
def test_failed_signature_cannot_probe_identity_or_create(api_client, mocker):
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=False)
    response = _username_login(api_client, choose_username=True)
    assert response.status_code == 401
    assert not ZcashIdentity.objects.filter(zcash_address=TADDR).exists()


@pytest.mark.django_db(transaction=True)
def test_concurrent_claims_for_same_name_leave_one_identity(mocker):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from django.db import close_old_connections
    from rest_framework.test import APIClient
    from dj.apps.zauth import views

    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    barrier = Barrier(2)
    original = views.username_status

    def simultaneous_status(value):
        result = original(value)
        if result[1] == "available":
            barrier.wait(timeout=10)
        return result

    mocker.patch("dj.apps.zauth.views.username_status", side_effect=simultaneous_status)

    def claim(address):
        close_old_connections()
        try:
            response = _username_login(APIClient(), address, choose_username=True, desired_username="RacingName")
            return response.status_code, response.data.get("code")
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(claim, (TADDR, VECTOR_ADDRESS)))
    assert sorted(code for code, _ in outcomes) == [200, 409]
    assert (409, "username_taken") in outcomes
    assert Creator.objects.filter(username__iexact="racingname").count() == 1
    assert ZcashIdentity.objects.filter(zcash_address__in=[TADDR, VECTOR_ADDRESS]).count() == 1
    assert Creator.objects.count() == 1
    assert AuthToken.objects.count() == 1


@pytest.mark.django_db
def test_returning_identity_ignores_invalid_desired_username(api_client, mocker):
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    created = _username_login(api_client, desired_username="Owner")
    assert created.status_code == 200
    identity = ZcashIdentity.objects.get(zcash_address=TADDR)
    response = _username_login(api_client, choose_username=True, desired_username="bad/name")
    assert response.status_code == 200
    assert response.data["username"] == "Owner"
    identity.refresh_from_db()
    assert identity.creator.username == "Owner"
    malformed = _username_login(api_client, choose_username=True, desired_username=["bad"])
    assert malformed.status_code == 400
    identity.refresh_from_db()
    assert identity.creator.username == "Owner"


@pytest.mark.django_db
def test_taken_choice_consumes_proof_and_fresh_proof_can_create(api_client, mocker):
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    Creator.objects.create(username="Taken")
    challenge = _get_challenge(api_client)
    body = {"address": TADDR, "challenge": challenge, "signature": "fixture", "choose_username": True, "desired_username": "taken"}
    assert api_client.post("/api/auth/zcash/login/", body, format="json").data["code"] == "username_taken"
    body["desired_username"] = "Fresh"
    assert api_client.post("/api/auth/zcash/login/", body, format="json").status_code != 200
    assert _username_login(api_client, choose_username=True, desired_username="Fresh").status_code == 200


@pytest.mark.django_db
def test_generated_collision_retries_and_creates_one_identity(api_client, mocker):
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    Creator.objects.create(username="amber-otter-123456")
    generator = mocker.patch("dj.apps.zauth.views.username_for_address", side_effect=["amber-otter-123456", "quiet-river-123456"])
    response = _username_login(api_client, choose_username=True, desired_username="")
    assert response.status_code == 200
    assert response.data["username"] == "quiet-river-123456"
    assert generator.call_count == 2
    assert ZcashIdentity.objects.filter(zcash_address=TADDR).count() == 1


@pytest.mark.django_db
def test_choice_prompt_consumes_proof(api_client, mocker):
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    challenge = _get_challenge(api_client)
    body = {"address": TADDR, "challenge": challenge, "signature": "fixture", "choose_username": True}
    assert api_client.post("/api/auth/zcash/login/", body, format="json").data["code"] == "username_required"
    body["desired_username"] = "Fresh"
    assert api_client.post("/api/auth/zcash/login/", body, format="json").status_code != 200
    assert _username_login(api_client, choose_username=True, desired_username="Fresh").status_code == 200


@pytest.mark.django_db
def test_generated_collision_retries_are_bounded(api_client, mocker):
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    Creator.objects.create(username="amber-otter-123456")
    generator = mocker.patch("dj.apps.zauth.views.username_for_address", return_value="amber-otter-123456")
    response = _username_login(api_client, choose_username=True, desired_username="")
    assert response.status_code == 503
    assert generator.call_count == 3
    assert not ZcashIdentity.objects.filter(zcash_address=TADDR).exists()
    assert AuthToken.objects.count() == 0
